import { buildAnalytics, buildPresenceChurn } from "./core/analytics.js";
import { buildMacTimeline, compareFinals } from "./core/comparison.js";
import { enrich } from "./core/enrichment.js";
import { keyText, locationKey, normalizeMac, text } from "./core/normalize.js";
import { database } from "./data/database.js";
import { detectMapping, FIELD_LABELS, fileObservationDate, readTable } from "./data/importer.js";
import {
  comparisonContent,
  csv,
  deviceTable,
  download,
  drawBars,
  drawWeekly,
  escapeHtml,
  renderKpis,
  renderRanked,
  renderSelect,
  roomAnomalyContent,
  showDialog,
} from "./ui/render.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const TABLE_COLUMNS = [
  ["mac", "MAC"],
  ["ip", "IP устройства"],
  ["switchIp", "IP коммутатора"],
  ["switchPort", "Порт"],
  ["manufacturer", "Производитель"],
  ["model", "Модель"],
  ["deviceType", "Тип"],
  ["hostname", "Hostname"],
  ["serial", "Serial"],
  ["smartroomId", "Smartroom ID"],
  ["room", "Помещение"],
  ["address", "Адрес"],
  ["authenticationTime", "Время аутентификации"],
];

const ROLE_FIELDS = Object.freeze({
  main: ["mac", "ip", "switchIp", "switchPort", "authenticationTime", "hostname", "serial", "deviceId"],
  smartroom: ["mac", "mac2", "ip", "manufacturer", "model", "deviceType", "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress", "hostname", "serial", "deviceId", "deviceName"],
  ddio: ["reservationMac", "reservationIp", "leaseMac", "leaseIp"],
});

const state = {
  inventory: [],
  activeSnapshot: null,
  snapshotMetadata: [],
  snapshotCache: new Map(),
  sourceTables: { main: null, smartroom: null, ddio: null },
  sourceFiles: { main: null, smartroom: null, ddio: null },
  mappings: { main: {}, smartroom: {}, ddio: {} },
  search: "",
  page: 1,
  pageSize: 50,
  sort: { field: "mac", direction: 1 },
  analytics: null,
  controller: null,
  batch: { main: [], smartroom: [], ddio: [], pairs: [] },
};

function showError(error) {
  const banner = $("#errorBanner");
  banner.querySelector("span").textContent = error instanceof Error ? error.message : String(error);
  banner.hidden = false;
  console.error(error);
}

function clearError() {
  $("#errorBanner").hidden = true;
}

function progress(value, detail, title = "Обработка") {
  const panel = $("#progressPanel");
  panel.hidden = false;
  $("#progressTitle").textContent = title;
  $("#progressPercent").textContent = `${Math.round(value)}%`;
  $("#progressBar").value = value;
  $("#progressDetail").textContent = detail;
}

function finishProgress(detail = "Готово") {
  progress(100, detail);
  setTimeout(() => { $("#progressPanel").hidden = true; }, 900);
}

function activateView(name) {
  $$(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => {
    const active = view.id === `${name}View`;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  history.replaceState(null, "", `#${name}`);
  if (name === "analytics") renderAnalytics().catch(showError);
  if (name === "history") renderMacOptions();
  if (name === "rooms") initializeRoomFilters();
  if (name === "data") renderSnapshotList();
}

async function loadSnapshot(id) {
  if (!id) return null;
  if (!state.snapshotCache.has(id)) state.snapshotCache.set(id, await database.loadSnapshot(id));
  return state.snapshotCache.get(id);
}

async function refreshDatabaseState() {
  state.snapshotMetadata = await database.listSnapshots();
  state.activeSnapshot = await database.activeSnapshot();
  if (state.activeSnapshot) state.snapshotCache.set(state.activeSnapshot.id, state.activeSnapshot);
  state.inventory = await database.inventory();
  $("#databaseStatus").textContent = `${state.snapshotMetadata.length} Final · ${state.inventory.length.toLocaleString("ru-RU")} устройств`;
  renderDeviceTable();
  renderMacOptions();
  renderSnapshotSelectors();
}

function searchable(device) {
  if (!device._search) device._search = TABLE_COLUMNS.map(([key]) => device[key]).concat(device.deviceId, device.deviceName, device.physicalAddress, ...(device.alternateMacs || [])).map(keyText).join(" ");
  return device._search;
}

function filteredDevices() {
  const query = keyText(state.search);
  const filtered = query ? state.inventory.filter((device) => searchable(device).includes(query)) : [...state.inventory];
  const { field, direction } = state.sort;
  return filtered.sort((left, right) => String(left[field] || "").localeCompare(String(right[field] || ""), "ru", { numeric: true }) * direction);
}

function renderDeviceTable() {
  const devices = filteredDevices();
  const pages = Math.max(1, Math.ceil(devices.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * state.pageSize;
  const visible = devices.slice(start, start + state.pageSize);
  $("#searchCount").textContent = `${devices.length.toLocaleString("ru-RU")} устройств`;
  $("#pageLabel").textContent = `${state.page} / ${pages}`;
  $("#deviceTable").innerHTML = `<table class="data-table"><thead><tr>${TABLE_COLUMNS.map(([key, label]) => `<th><button class="table-sort" type="button" data-sort="${key}">${escapeHtml(label)}${state.sort.field === key ? (state.sort.direction > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("")}</tr></thead><tbody>${visible.map((device) => `<tr data-device-id="${escapeHtml(device.id)}">${TABLE_COLUMNS.map(([key]) => `<td title="${escapeHtml(device[key] || "")}">${escapeHtml(device[key] || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  $("#deviceTable").querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
    state.sort = state.sort.field === button.dataset.sort ? { field: button.dataset.sort, direction: -state.sort.direction } : { field: button.dataset.sort, direction: 1 };
    renderDeviceTable();
  }));
  $("#deviceTable").querySelectorAll("[data-device-id]").forEach((row) => row.addEventListener("dblclick", () => {
    const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
    showDialog($("#detailsDialog"), device.mac || device.hostname || "Устройство", deviceTable([device]));
  }));
}

function renderMapping(role) {
  const table = state.sourceTables[role];
  const container = $(`#${role}Mapping`);
  if (!table) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = ROLE_FIELDS[role].map((field) => `<label><span>${escapeHtml(FIELD_LABELS[field])}</span><select data-mapping-role="${role}" data-mapping-field="${field}"><option value="">Не использовать</option>${table.headers.map((header, index) => `<option value="${index}" ${Number(state.mappings[role][field]) === index ? "selected" : ""}>${escapeHtml(header || `Колонка ${index + 1}`)}</option>`).join("")}</select></label>`).join("");
  container.querySelectorAll("select").forEach((select) => select.addEventListener("change", () => {
    if (select.value === "") delete state.mappings[role][select.dataset.mappingField];
    else state.mappings[role][select.dataset.mappingField] = Number(select.value);
  }));
}

async function handleSourceFile(role, file) {
  if (!file) return;
  clearError();
  progress(5, `Чтение ${file.name}`, "Импорт файла");
  const table = await readTable(file);
  state.sourceFiles[role] = file;
  state.sourceTables[role] = table;
  state.mappings[role] = detectMapping(table.headers, table.rows, role);
  $(`#${role}FileStatus`).textContent = `${file.name} · ${table.rowCount.toLocaleString("ru-RU")} строк`;
  renderMapping(role);
  finishProgress("Файл прочитан");
}

async function executeEnrichment({ tables, mappings, files, name, strategy, progressRange = [0, 100] }) {
  const previous = await database.activeSnapshot();
  const ouiIndex = await database.ouiIndex();
  const knownModels = await database.knownModels();
  const [start, end] = progressRange;
  const result = await enrich({
    mainRows: tables.main?.rows || [],
    smartroomRows: tables.smartroom?.rows || [],
    ddioRows: tables.ddio?.rows || [],
    mappings,
    strategy,
    previousFinal: previous?.devices || [],
    ouiIndex,
    knownModels,
    signal: state.controller?.signal,
    onProgress: (value, stage) => progress(start + value / 100 * (end - start), stage, "Обогащение"),
  });
  const createdAt = fileObservationDate(files.main).date;
  const comparison = compareFinals(previous?.devices || [], result.devices, createdAt);
  progress(start + 0.96 * (end - start), "Атомарное сохранение Final", "Обогащение");
  const metadata = await database.saveFinal({
    name: name || `Final ${files.main.name}`,
    createdAt,
    devices: result.devices,
    diagnostics: result.diagnostics,
    comparison,
    sourceFiles: Object.entries(files).filter(([, file]) => file).map(([role, file]) => ({ role, name: file.name, size: file.size, date: fileObservationDate(file) })),
  });
  state.snapshotCache.clear();
  return { ...result, comparison, metadata };
}

async function runEnrichment() {
  if (!state.sourceTables.main) throw new Error("Выберите основной файл");
  state.controller = new AbortController();
  const strategy = $("input[name='strategy']:checked").value;
  const result = await executeEnrichment({
    tables: state.sourceTables,
    mappings: state.mappings,
    files: state.sourceFiles,
    name: `Final ${state.sourceFiles.main.name}`,
    strategy,
  });
  $("#enrichmentSummary").classList.remove("empty");
  $("#enrichmentSummary").innerHTML = `<h3>Final успешно сохранён</h3><p>Main raw: <strong>${result.diagnostics.counts.mainRaw}</strong> · Main unique: <strong>${result.diagnostics.counts.mainUnique}</strong> · после SmartRoom: <strong>${result.diagnostics.counts.afterSmartroom}</strong> · DDIO IP: <strong>${result.diagnostics.counts.ddioMatchedIp}</strong> · Final: <strong>${result.diagnostics.counts.finalUnique}</strong></p><p>Несопоставленных: ${result.diagnostics.unmatched.length} · конфликтов: ${result.diagnostics.conflicts.length} · некорректных: ${result.diagnostics.invalid.length}</p>`;
  await refreshDatabaseState();
  finishProgress("Final сохранён");
}

function renderSnapshotSelectors() {
  const items = state.snapshotMetadata.map((snapshot) => ({ value: snapshot.id, label: `${snapshot.name} · ${snapshot.deviceCount}` }));
  const current = state.snapshotMetadata.at(-1)?.id || "";
  const previous = state.snapshotMetadata.at(-2)?.id || "";
  renderSelect($("#baseSnapshotSelect"), items, $("#baseSnapshotSelect").value || previous, "Нет базового Final");
  renderSelect($("#currentSnapshotSelect"), items, $("#currentSnapshotSelect").value || current, "Нет текущего Final");
}

async function fullSnapshots() {
  const result = [];
  for (let index = 0; index < state.snapshotMetadata.length; index += 1) {
    progress(index / Math.max(1, state.snapshotMetadata.length) * 90, `Загрузка Final ${index + 1} из ${state.snapshotMetadata.length}`, "Аналитика");
    result.push(await loadSnapshot(state.snapshotMetadata[index].id));
  }
  return result;
}

function roomListContent(rooms, onlyAllChanged = false) {
  const filtered = onlyAllChanged ? rooms.filter((room) => room.allChanged) : rooms.filter((room) => room.changedCount);
  return filtered.length ? filtered.map((room) => `<details class="room-card"><summary><strong>${escapeHtml(room.room || room.smartroomId)}</strong><span>${room.changedCount}/${room.deviceCount} изменено</span></summary>${deviceTable(room.devices)}</details>`).join("") : '<p class="empty">Подходящих помещений нет.</p>';
}

async function renderAnalytics(force = false) {
  if (!state.snapshotMetadata.length) {
    $("#analyticsKpis").innerHTML = '<p class="empty">Сначала выполните обогащение.</p>';
    return;
  }
  if (state.analytics && !force) return paintAnalytics(state.analytics);
  const snapshots = await fullSnapshots();
  state.analytics = buildAnalytics(snapshots, $("#baseSnapshotSelect").value, $("#currentSnapshotSelect").value);
  state.analytics.churn = buildPresenceChurn(snapshots);
  paintAnalytics(state.analytics);
  finishProgress("Аналитика рассчитана");
}

function paintAnalytics(analytics) {
  renderKpis($("#analyticsKpis"), analytics.kpis, {
    modified: () => showDialog($("#detailsDialog"), "Изменённые устройства", comparisonContent(analytics.comparison)),
    absent: () => showDialog($("#detailsDialog"), "Отсутствующие устройства", deviceTable(analytics.comparison.absent)),
    withoutRoom: () => showDialog($("#detailsDialog"), "Устройства без помещения", deviceTable(analytics.devices.filter((item) => !locationKey(item)))),
    changedRooms: () => showDialog($("#detailsDialog"), "Помещения с изменениями", roomListContent(analytics.roomChanges)),
    allChangedRooms: () => showDialog($("#detailsDialog"), "Изменилось всё оборудование", roomListContent(analytics.roomChanges, true)),
    switchAnomalyRooms: () => showDialog($("#detailsDialog"), "Переговорные с разными IP коммутатора", roomAnomalyContent(analytics.roomSwitchAnomalies)),
    codecChanges: () => showDialog($("#detailsDialog"), "Изменения кодеков", comparisonContent({ modified: analytics.comparison.modified.filter((row) => keyText(row.after.deviceType) === "video conference") })),
  });
  drawWeekly($("#weeklyChart"), analytics.weekly);
  drawBars($("#presenceChart"), analytics.weekly.flatMap((item) => [
    { label: `${item.label} +`, value: item.added },
    { label: `${item.label} −`, value: -item.absent },
  ]));
  drawBars($("#totalChart"), analytics.totals);
  renderRanked($("#vendorRanking"), analytics.vendors, "Нет данных производителей");
  renderRanked($("#modelRanking"), analytics.models, "Нет данных моделей");
  renderRanked($("#churnRanking"), analytics.churn.slice(0, 12).map((item) => ({ label: item.mac, value: item.transitions })), "Повторно исчезающих MAC нет");
  $("#openChurnButton").onclick = () => showDialog($("#detailsDialog"), "MAC, которые исчезают и появляются", analytics.churn.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Переходов</th><th>Присутствовал</th><th>Отсутствовал</th></tr></thead><tbody>${analytics.churn.map((item) => `<tr><td>${escapeHtml(item.mac)}</td><td>${item.transitions}</td><td>${item.present}</td><td>${item.absent}</td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Нет данных.</p>');
  $("#changeTable").innerHTML = comparisonContent(analytics.comparison);
}

function renderMacOptions() {
  const macs = [...new Set(state.inventory.map((device) => device.mac).filter(Boolean))].sort();
  $("#macHistoryOptions").innerHTML = macs.slice(0, 20_000).map((mac) => `<option value="${escapeHtml(mac)}"></option>`).join("");
}

async function openMacHistory() {
  const mac = normalizeMac($("#macHistorySearch").value);
  if (!mac) throw new Error("Введите корректный MAC-адрес");
  const snapshots = await fullSnapshots();
  const events = buildMacTimeline(mac, snapshots);
  $("#macTimeline").classList.remove("empty");
  $("#macTimeline").innerHTML = events.length ? events.map((event) => {
    const device = event.after || event.before || {};
    return `<article class="timeline-card ${event.status}"><p class="eyebrow">${escapeHtml(new Date(event.date).toLocaleString("ru-RU"))}</p><h3>${escapeHtml(event.status === "first" ? "Первое появление" : event.status === "changed" ? "Изменение" : event.status === "absent" ? "Отсутствует" : "Без изменений")}</h3><dl>${TABLE_COLUMNS.slice(0, 12).map(([field, label]) => `<dt>${escapeHtml(label)}</dt><dd class="${event.changes.some((item) => item.field === field) ? "changed-value" : ""}">${escapeHtml(device[field] || "—")}</dd>`).join("")}</dl>${event.changes.length ? `<p>${event.changes.map((item) => `${escapeHtml(item.label)}: ${escapeHtml(item.oldValue)} → ${escapeHtml(item.newValue)}`).join("<br>")}</p>` : ""}</article>`;
  }).join("") : '<p class="empty">MAC не найден в Final-снимках.</p>';
  finishProgress("Хронология построена");
}

function roomDevices() {
  return state.activeSnapshot?.devices || [];
}

function uniqueField(devices, field) {
  return [...new Set(devices.map((device) => text(device[field])).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}

function cascadeRoomFilters(changed = "") {
  const values = {
    businessUnit: $("#businessUnitFilter").value,
    city: $("#cityFilter").value,
    site: $("#siteFilter").value,
    floor: $("#floorFilter").value,
    room: $("#roomFilter").value,
  };
  const order = ["businessUnit", "city", "site", "floor", "room"];
  const changedIndex = order.indexOf(changed);
  if (changedIndex >= 0) order.slice(changedIndex + 1).forEach((field) => { values[field] = ""; });
  order.forEach((field, index) => {
    const eligible = roomDevices().filter((device) => order.slice(0, index).every((parent) => !values[parent] || text(device[parent]) === values[parent]));
    const select = $(`#${field === "businessUnit" ? "businessUnit" : field}Filter`);
    renderSelect(select, uniqueField(eligible, field), values[field], `Все: ${FIELD_LABELS[field] || field}`);
    values[field] = select.value;
  });
}

function initializeRoomFilters() {
  cascadeRoomFilters();
}

function selectedRoomKey() {
  const query = keyText($("#roomSearch").value);
  const filters = ["businessUnit", "city", "site", "floor", "room"];
  const device = roomDevices().find((item) => filters.every((field) => !$( `#${field === "businessUnit" ? "businessUnit" : field}Filter`).value || text(item[field]) === $( `#${field === "businessUnit" ? "businessUnit" : field}Filter`).value)
    && (!query || searchable(item).includes(query)));
  return device ? locationKey(device) : "";
}

async function showRoomTimeline() {
  const key = selectedRoomKey();
  if (!key) throw new Error("Выберите помещение или уточните поиск");
  const snapshots = await fullSnapshots();
  const cards = snapshots.map((snapshot) => ({ snapshot, devices: snapshot.devices.filter((device) => locationKey(device) === key) }));
  $("#roomTimeline").classList.remove("empty");
  $("#roomTimeline").innerHTML = cards.map(({ snapshot, devices }) => `<article class="room-card"><h3>${escapeHtml(snapshot.name)}</h3><p>${escapeHtml(new Date(snapshot.createdAt).toLocaleString("ru-RU"))} · ${devices.length} устройств</p>${devices.length ? deviceTable(devices) : '<p class="empty">Помещение отсутствует в этом Final.</p>'}</article>`).join("");
  finishProgress("Хронология помещения построена");
}

async function showAllChangedRooms() {
  await renderAnalytics(true);
  showDialog($("#detailsDialog"), "Переговорные: изменилось всё оборудование", roomListContent(state.analytics.roomChanges, true));
}

function pairBatchFiles() {
  const nearest = (file, candidates) => {
    const time = Date.parse(fileObservationDate(file).date);
    return [...candidates].sort((a, b) => Math.abs(Date.parse(fileObservationDate(a).date) - time) - Math.abs(Date.parse(fileObservationDate(b).date) - time))[0] || null;
  };
  state.batch.pairs = [...state.batch.main].sort((a, b) => Date.parse(fileObservationDate(a).date) - Date.parse(fileObservationDate(b).date)).map((main) => ({
    date: fileObservationDate(main),
    main,
    smartroom: nearest(main, state.batch.smartroom),
    ddio: nearest(main, state.batch.ddio),
  }));
  $("#batchPreview").classList.remove("empty");
  $("#batchPreview").innerHTML = state.batch.pairs.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>Main</th><th>SmartRoom</th><th>DDIO</th></tr></thead><tbody>${state.batch.pairs.map((pair) => `<tr><td>${escapeHtml(pair.date.date.slice(0, 10))}</td><td>${escapeHtml(pair.main.name)}</td><td>${escapeHtml(pair.smartroom?.name || "—")}</td><td>${escapeHtml(pair.ddio?.name || "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">В папке Main нет поддерживаемых файлов.</p>';
}

async function runBatch() {
  if (!state.batch.pairs.length) pairBatchFiles();
  if (!state.batch.pairs.length) throw new Error("Не найдено файлов Main");
  state.controller = new AbortController();
  const strategy = $("input[name='strategy']:checked").value;
  for (let index = 0; index < state.batch.pairs.length; index += 1) {
    const pair = state.batch.pairs[index];
    const files = { main: pair.main, smartroom: pair.smartroom, ddio: pair.ddio };
    const tables = {};
    const mappings = {};
    for (const role of ["main", "smartroom", "ddio"]) {
      if (!files[role]) continue;
      tables[role] = await readTable(files[role]);
      mappings[role] = detectMapping(tables[role].headers, tables[role].rows, role);
    }
    const start = index / state.batch.pairs.length * 100;
    const end = (index + 1) / state.batch.pairs.length * 100;
    await executeEnrichment({ tables, mappings, files, name: `Final ${pair.main.name}`, strategy, progressRange: [start, end] });
  }
  await refreshDatabaseState();
  finishProgress(`Очередь завершена: ${state.batch.pairs.length} Final`);
}

async function exportDatabase() {
  progress(5, "Чтение локальной базы", "Экспорт базы");
  const archive = await database.exportArchive();
  download(`mac-analyzer-next-${new Date().toISOString().slice(0, 10)}.madb.json`, JSON.stringify(archive, null, 2), "application/json");
  finishProgress("Архив базы сформирован");
}

async function importDatabase(file) {
  const archive = JSON.parse(await file.text());
  await database.importArchive(archive);
  state.snapshotCache.clear();
  state.analytics = null;
  await refreshDatabaseState();
  finishProgress("База импортирована");
}

async function importOui(file) {
  const table = await readTable(file);
  const records = ouiRecords(table);
  await database.importOui(records);
  await database.setSetting("ouiSource", file.name);
  $("#ouiStatus").textContent = `Импортировано ${records.length.toLocaleString("ru-RU")} префиксов`;
}

function ouiRecords(table) {
  const prefixIndex = table.headers.findIndex((header) => /prefix|assignment|oui|hex/i.test(header));
  const vendorIndex = table.headers.findIndex((header) => /vendor|organization|manufacturer|company/i.test(header));
  return table.rows.map((row) => ({
    prefix: String(row[prefixIndex >= 0 ? prefixIndex : 0] || "").replace(/[^0-9a-f]/gi, "").toUpperCase().slice(0, 6),
    vendor: text(row[vendorIndex >= 0 ? vendorIndex : 1]),
  })).filter((item) => item.prefix.length === 6 && item.vendor);
}

async function ensureBundledOui() {
  if (await database.getSetting("bundledOuiVersion", "") === "2026.10") return;
  progress(2, "Первичная загрузка встроенного OUI", "Инициализация");
  let content = globalThis.__MAC_ANALYZER_OUI_CSV__ || "";
  if (!content) {
    const response = await fetch("assets/oui.csv");
    if (!response.ok) throw new Error(`Не удалось загрузить встроенный OUI: HTTP ${response.status}`);
    content = await response.text();
  }
  const file = new File([content], "oui.csv", { type: "text/csv" });
  const records = ouiRecords(await readTable(file));
  await database.importOui(records);
  await database.setSetting("bundledOuiVersion", "2026.10");
  await database.setSetting("ouiSource", "Встроенный IEEE OUI");
  $("#ouiStatus").textContent = `Встроенный OUI: ${records.length.toLocaleString("ru-RU")} префиксов`;
}

function renderSnapshotList() {
  $("#snapshotList").innerHTML = state.snapshotMetadata.length ? state.snapshotMetadata.map((snapshot) => `<div class="rank-row"><span><strong>${escapeHtml(snapshot.name)}</strong><br><small>${escapeHtml(new Date(snapshot.createdAt).toLocaleString("ru-RU"))}</small></span><strong>${snapshot.deviceCount.toLocaleString("ru-RU")}</strong></div>`).join("") : '<p class="empty">Final-снимков пока нет.</p>';
}

function resetFiles() {
  state.sourceTables = { main: null, smartroom: null, ddio: null };
  state.sourceFiles = { main: null, smartroom: null, ddio: null };
  state.mappings = { main: {}, smartroom: {}, ddio: {} };
  for (const role of ["main", "smartroom", "ddio"]) {
    $(`#${role}FileInput`).value = "";
    $(`#${role}FileStatus`).textContent = "Не выбран";
    renderMapping(role);
  }
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
  $("#errorBanner button").addEventListener("click", clearError);
  $("#themeButton").addEventListener("click", async () => {
    document.body.classList.toggle("dark");
    await database.setSetting("theme", document.body.classList.contains("dark") ? "dark" : "light");
  });
  $("#globalSearch").addEventListener("input", (event) => { state.search = event.target.value; state.page = 1; renderDeviceTable(); });
  $("#pageSizeSelect").addEventListener("change", (event) => { state.pageSize = Number(event.target.value); state.page = 1; renderDeviceTable(); });
  $("#previousPageButton").addEventListener("click", () => { state.page -= 1; renderDeviceTable(); });
  $("#nextPageButton").addEventListener("click", () => { state.page += 1; renderDeviceTable(); });
  $("#exportSearchCsvButton").addEventListener("click", () => download("devices.csv", `\uFEFF${csv(filteredDevices(), TABLE_COLUMNS.map(([key, label]) => ({ key, label })))}`, "text/csv;charset=utf-8"));

  for (const role of ["main", "smartroom", "ddio"]) $(`#${role}FileInput`).addEventListener("change", (event) => handleSourceFile(role, event.target.files[0]).catch(showError));
  $("#runEnrichmentButton").addEventListener("click", () => runEnrichment().catch(showError));
  $("#resetFilesButton").addEventListener("click", resetFiles);
  $("#cancelProcessButton").addEventListener("click", () => state.controller?.abort());

  $("#refreshAnalyticsButton").addEventListener("click", () => { state.analytics = null; renderAnalytics(true).catch(showError); });
  $("#applyComparisonButton").addEventListener("click", () => { state.analytics = null; renderAnalytics(true).catch(showError); });
  $("#openMacHistoryButton").addEventListener("click", () => openMacHistory().catch(showError));
  $("#macHistorySearch").addEventListener("keydown", (event) => { if (event.key === "Enter") openMacHistory().catch(showError); });

  ["businessUnit", "city", "site", "floor", "room"].forEach((field) => $(`#${field === "businessUnit" ? "businessUnit" : field}Filter`).addEventListener("change", () => cascadeRoomFilters(field)));
  $("#showRoomButton").addEventListener("click", () => showRoomTimeline().catch(showError));
  $("#showAllChangedRoomButton").addEventListener("click", () => showAllChangedRooms().catch(showError));

  for (const role of ["Main", "Smartroom", "DdIo"]) {
    $(`#batch${role}Input`).addEventListener("change", (event) => {
      const key = role === "Main" ? "main" : role === "Smartroom" ? "smartroom" : "ddio";
      state.batch[key] = [...event.target.files].filter((file) => /\.(csv|tsv|json|xlsx)$/i.test(file.name));
      $(`#batch${role}Status`).textContent = `${state.batch[key].length} файлов`;
      state.batch.pairs = [];
    });
  }
  $("#previewBatchButton").addEventListener("click", pairBatchFiles);
  $("#runBatchButton").addEventListener("click", () => runBatch().catch(showError));

  $("#exportFinalCsvButton").addEventListener("click", () => {
    if (!state.activeSnapshot) return showError(new Error("Нет активного Final"));
    download("final.csv", `\uFEFF${csv(state.activeSnapshot.devices, TABLE_COLUMNS.map(([key, label]) => ({ key, label })))}`, "text/csv;charset=utf-8");
  });
  $("#exportFinalJsonButton").addEventListener("click", () => {
    if (!state.activeSnapshot) return showError(new Error("Нет активного Final"));
    download("final.json", JSON.stringify(state.activeSnapshot, null, 2), "application/json");
  });
  $("#exportDatabaseButton").addEventListener("click", () => exportDatabase().catch(showError));
  $("#importDatabaseInput").addEventListener("change", (event) => importDatabase(event.target.files[0]).catch(showError));
  $("#ouiFileInput").addEventListener("change", (event) => importOui(event.target.files[0]).catch(showError));
  $("#detailsDialog [data-dialog-close]").addEventListener("click", () => $("#detailsDialog").close());
}

async function bootstrap() {
  bindEvents();
  await database.open();
  const theme = await database.getSetting("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.body.classList.toggle("dark", theme === "dark");
  await ensureBundledOui();
  await refreshDatabaseState();
  $("#progressPanel").hidden = true;
  const initial = location.hash.slice(1);
  activateView($( `#${initial}View`) ? initial : "search");
}

bootstrap().catch(showError);

export { executeEnrichment, pairBatchFiles };

