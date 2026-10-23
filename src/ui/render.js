import { csvQuote } from "../core/csv-cell.js";
import { formatWeekRangeLabel } from "../core/analytics.js";
import { isCriticalHistoryChange } from "../core/change-categories.js";
import { identityTokens } from "../core/identity.js";
import { inventoryCellText, visibleInventoryColumns } from "../core/inventory-columns.js";
import { firstMac } from "../core/normalize.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const IDENTITY_CANDIDATE_FIELDS = Object.freeze([
  ["id", "Внутренний ID"], ["deviceId", "Device ID"], ["serial", "Серийный номер"],
  ["mac", "MAC"], ["alternateMacs", "Дополнительные MAC"], ["hostname", "Hostname"],
  ["manufacturer", "Производитель"], ["model", "Модель"], ["room", "Помещение"], ["address", "Адрес"],
]);

export function identityCandidateComparisonMarkup(incoming, candidates = [], { incomingLabel = "Новая запись" } = {}) {
  const candidateValue = (device, field) => {
    const value = device?.[field];
    const normalized = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "").trim();
    return normalized.length > 300 ? `${normalized.slice(0, 300)}… (показана часть)` : normalized;
  };
  const identityLabel = (device) => IDENTITY_CANDIDATE_FIELDS.slice(0, 4).map(([field]) => candidateValue(device, field)).filter(Boolean).join(" · ");
  return candidates.map((candidate, index) => {
    const candidateIdentity = identityLabel(candidate) || `Кандидат ${index + 1}`;
    const evidenceRows = IDENTITY_CANDIDATE_FIELDS.map(([field, label]) => {
      const incomingValue = candidateValue(incoming, field);
      const candidateFieldValue = candidateValue(candidate, field);
      if (!incomingValue && !candidateFieldValue) return "";
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(incomingValue || "—")}</td><td>${escapeHtml(candidateFieldValue || "—")}</td></tr>`;
    }).filter(Boolean).join("");
    return `<details class="identity-candidate"><summary>${escapeHtml(candidateIdentity)}</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Поле</th><th>${escapeHtml(incomingLabel)}</th><th>Кандидат</th></tr></thead><tbody>${evidenceRows}</tbody></table></div></details>`;
  }).join("");
}

export function identityConflictDetails(conflicts = [], totalCount = null) {
  const identityConflicts = conflicts.filter((item) => item.field === "identity");
  if (!identityConflicts.length) return "";
  const preview = identityConflicts.slice(0, 20);
  const total = Number.isFinite(Number(totalCount)) ? Math.max(identityConflicts.length, Number(totalCount)) : identityConflicts.length;
  return `<details class="notice"><summary>Конфликты идентификаторов: ${total.toLocaleString("ru-RU")}</summary><p>Для сопоставления выбран сильнейший идентификатор; проверьте конфликтующие значения. Показаны первые ${preview.length} из ${total.toLocaleString("ru-RU")}.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>Источник</th><th>Строка</th><th>Выбрано</th><th>Конфликтующее значение</th></tr></thead><tbody>${preview.map((item) => `<tr><td>${escapeHtml(item.source || "—")}</td><td>${escapeHtml(item.row || "—")}</td><td>${escapeHtml(item.selected || "—")}</td><td>${escapeHtml(item.alternative || "—")}</td></tr>`).join("")}</tbody></table></div></details>`;
}

export function finalHistoryComparisonDetails(summary = null) {
  const ambiguousCount = Math.max(0, Number(summary?.ambiguousCount) || 0);
  const identityConflictCount = Math.max(0, Number(summary?.identityConflictCount) || 0);
  if (!ambiguousCount && !identityConflictCount) return "";
  const samples = Array.isArray(summary?.diagnosticSamples) ? summary.diagnosticSamples.slice(0, 20) : [];
  const truncated = Math.max(0, Number(summary?.diagnosticSamplesTruncated) || 0);
  const sampleRows = samples.map((sample) => {
    const type = sample.type === "identity-conflict" ? "Конфликт сильных идентификаторов" : "Неоднозначное совпадение";
    const related = Array.isArray(sample.alternatives) ? sample.alternatives : Array.isArray(sample.candidates) ? sample.candidates : [];
    const relatedText = `${related.join(", ") || "—"}${Number(sample.alternativesTruncated ?? sample.candidatesTruncated) > 0 ? ` · ещё ${Number(sample.alternativesTruncated ?? sample.candidatesTruncated).toLocaleString("ru-RU")}` : ""}`;
    return `<tr><td>${escapeHtml(type)}</td><td>${escapeHtml(sample.identity || "—")}</td><td>${escapeHtml(relatedText)}</td></tr>`;
  }).join("");
  const details = sampleRows
    ? `<details><summary>Примеры unresolved identity: ${samples.length.toLocaleString("ru-RU")}${truncated ? ` · ещё ${truncated.toLocaleString("ru-RU")} не показано` : ""}</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Диагностика</th><th>Текущая запись</th><th>Кандидаты Previous Final</th></tr></thead><tbody>${sampleRows}</tbody></table></div></details>`
    : "";
  return `<section class="notice"><p>Сверка с предыдущим Final: неоднозначных идентичностей ${ambiguousCount.toLocaleString("ru-RU")}, конфликтов сильных идентификаторов ${identityConflictCount.toLocaleString("ru-RU")}. Эти строки не создали ложные события добавления или отсутствия.</p>${details}</section>`;
}

export function excelColumnLabel(index) {
  if (!Number.isInteger(index) || index < 0) return "";
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function download(name, content, type = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows, columns) {
  return [columns.map((column) => csvQuote(column.label)).join(";"), ...rows.map((row) => columns.map((column) => csvQuote(row[column.key])).join(";"))].join("\r\n");
}

export function renderSelect(select, items, selected = "", emptyLabel = "Выберите") {
  select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${items.map((item) => {
    const value = typeof item === "string" ? item : item.value;
    const label = typeof item === "string" ? item : item.label;
    return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("")}`;
}

export function paginationSummary({ page = 1, pages = 1, items = [], total = 0 } = {}) {
  return `Страница ${Number(page).toLocaleString("ru-RU")} из ${Number(pages).toLocaleString("ru-RU")} · на странице ${items.length.toLocaleString("ru-RU")} · всего найдено ${Number(total).toLocaleString("ru-RU")}`;
}

export const HISTORY_LOG_COLUMNS = Object.freeze([
  { key: "timestamp", label: "Дата и время" },
  { key: "type", label: "Тип" },
  { key: "field", label: "Поле" },
  { key: "oldValue", label: "Было" },
  { key: "newValue", label: "Стало" },
  { key: "source", label: "Источник" },
  { key: "manufacturer", label: "Производитель" },
  { key: "model", label: "Модель" },
  { key: "address", label: "Адрес" },
  { key: "room", label: "Помещение" },
  { key: "mac", label: "MAC" },
]);

const HISTORY_LOG_DEFAULT_WIDTHS = Object.freeze({
  timestamp: 165, type: 110, field: 150, oldValue: 250, newValue: 250, source: 150,
  manufacturer: 170, model: 150, address: 170, room: 130, mac: 170,
});

export function defaultHistoryLogColumnWidths() {
  return { ...HISTORY_LOG_DEFAULT_WIDTHS };
}

export function normalizedHistoryLogColumns(value) {
  const permitted = new Set(HISTORY_LOG_COLUMNS.map(({ key }) => key));
  const selected = Array.isArray(value) ? [...new Set(value.filter((key) => permitted.has(key)))] : [];
  return selected.length ? HISTORY_LOG_COLUMNS.filter(({ key }) => selected.includes(key)).map(({ key }) => key)
    : HISTORY_LOG_COLUMNS.map(({ key }) => key);
}

export function normalizedHistoryLogColumnWidths(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(HISTORY_LOG_COLUMNS.map(({ key }) => {
    const parsed = Number(source[key]);
    return [key, Number.isFinite(parsed) && parsed > 0
      ? Math.max(80, Math.min(600, Math.round(parsed)))
      : HISTORY_LOG_DEFAULT_WIDTHS[key]];
  }));
}

function historyLogDisplayValue(row = {}, key) {
  const device = row.device || {};
  return ({
    timestamp: row.timestamp || row.createdAt || "",
    type: row.type || "modified",
    field: row.label || row.field || "—",
    oldValue: row.oldValue ?? row.before ?? "—",
    newValue: row.newValue ?? row.after ?? "—",
    source: row.source || "—",
    manufacturer: device.manufacturer || device.vendor || "—",
    model: device.model || "—",
    address: device.address || device.physicalAddress || "—",
    room: device.room || "—",
    mac: firstMac(row.mac, device.mac, device.macFormatted, device.mac_formatted) || "—",
  })[key] ?? "";
}

export function createHistoryLogColumnWidthOptimizer(selectedColumns = HISTORY_LOG_COLUMNS.map(({ key }) => key)) {
  const selected = new Set(normalizedHistoryLogColumns(selectedColumns));
  const longest = Object.fromEntries(HISTORY_LOG_COLUMNS.map(({ key, label }) => [key, label.length]));
  let finished = false;
  return {
    add(row) {
      if (finished) throw new Error("Подбор ширины истории уже завершён");
      for (const key of selected) longest[key] = Math.max(longest[key], String(historyLogDisplayValue(row, key) ?? "").length);
    },
    finish() {
      finished = true;
      const widths = defaultHistoryLogColumnWidths();
      for (const key of selected) widths[key] = Math.max(80, Math.min(600, Math.ceil(longest[key] * 8 + 36)));
      return widths;
    },
  };
}

export function optimizedHistoryLogColumnWidths(rows = [], selectedColumns = HISTORY_LOG_COLUMNS.map(({ key }) => key)) {
  const optimizer = createHistoryLogColumnWidthOptimizer(selectedColumns);
  for (const row of rows) optimizer.add(row);
  return optimizer.finish();
}

export function historyLogColumnControls(selected = HISTORY_LOG_COLUMNS.map(({ key }) => key), widths = null) {
  const visible = new Set(normalizedHistoryLogColumns(selected));
  const columnWidths = normalizedHistoryLogColumnWidths(widths);
  return `<button class="button secondary" type="button" data-history-log-width-optimize>Автоширина</button><button class="button secondary" type="button" data-history-log-width-reset>Сбросить ширину</button>${HISTORY_LOG_COLUMNS.map(({ key, label }) => `<label><input type="checkbox" name="columns" value="${key}" data-history-log-column ${visible.has(key) ? "checked" : ""}> ${escapeHtml(label)}<input type="number" min="80" max="600" step="10" aria-label="Ширина столбца ${escapeHtml(label)}, пикселей" data-history-log-width="${key}" value="${columnWidths[key]}"></label>`).join("")}`;
}

export function historyLogContent(rows = [], selectedColumns = HISTORY_LOG_COLUMNS.map(({ key }) => key), selectedIds = new Set(), widths = null, canManage = false) {
  if (!rows.length) return '<p class="empty">По выбранным условиям событий нет.</p>';
  const columns = normalizedHistoryLogColumns(selectedColumns).map((key) => HISTORY_LOG_COLUMNS.find((column) => column.key === key));
  const columnWidths = normalizedHistoryLogColumnWidths(widths);
  const groups = new Map();
  for (const row of rows) {
    const device = row.device || {};
    const mac = firstMac(row.mac, device.mac, device.macFormatted, device.mac_formatted) || "MAC не указан";
    if (!groups.has(mac)) groups.set(mac, []);
    groups.get(mac).push({ row, device });
  }
  const macCell = (row, device) => {
    const mac = escapeHtml(firstMac(row.mac, device.mac, device.macFormatted, device.mac_formatted) || "—");
    const field = String(row.field || "");
    const label = String(row.label || "");
    const isSwitchIpChange = field === "switchIp" || /IP коммутатора/i.test(label);
    const possibleIps = [...new Set([...(Array.isArray(row.possibleIps) ? row.possibleIps : []), ...(Array.isArray(device.possibleIps) ? device.possibleIps : [])].map((value) => String(value || "").trim()).filter(Boolean))];
    if (!isSwitchIpChange || !possibleIps.length) return mac;
    const note = `В DDIO указаны возможные IP: ${possibleIps.join(", ")}${row.possibleIpsTruncated || device.possibleIpsTruncated ? ", список не полный" : ""}. Это подсказка для IP коммутатора, она не изменяет подтверждённый IP устройства.`;
    return `${mac} <abbr class="ddio-ip-marker" title="${escapeHtml(note)}" aria-label="${escapeHtml(note)}">?</abbr>`;
  };
  const selectionColumn = canManage ? '<col style="width:44px">' : "";
  const selectionHeader = canManage ? '<th aria-label="Выбор"></th>' : "";
  return [...groups].map(([mac, events]) => `<details class="panel history-log-group" open><summary>${escapeHtml(mac)} · ${events.length.toLocaleString("ru-RU")} событий</summary><div class="table-scroll"><table class="data-table history-log-table" data-virtual-scroll="true"><colgroup>${selectionColumn}${columns.map(({ key }) => `<col data-history-log-column-width="${key}" style="width:${columnWidths[key]}px">`).join("")}</colgroup><thead><tr>${selectionHeader}${columns.map(({ label, key }) => `<th data-history-log-column-width="${key}">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${events.map(({ row, device }) => `<tr data-history-event-row data-history-event-mac="${escapeHtml(mac)}">${canManage ? `<td><input type="checkbox" data-history-event-select="${escapeHtml(String(row.id))}" aria-label="Выбрать событие ${escapeHtml(String(row.id))}" ${selectedIds.has(String(row.id)) ? "checked" : ""}></td>` : ""}${columns.map(({ key }) => `<td data-history-log-column-width="${key}">${key === "mac" ? macCell(row, device) : escapeHtml(historyLogDisplayValue({ ...row, device }, key))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`).join("");
}

export function setHistoryLogGroupsOpen(container, open) {
  const groups = container?.querySelectorAll?.(".history-log-group") || [];
  for (const group of groups) group.open = Boolean(open);
  return groups.length;
}

export function legacyObservationLogContent(rows = [], selectedIds = new Set(), queueSummaries = new Map(), canManage = false) {
  if (!rows.length) return '<p class="empty">По выбранным условиям записей нет.</p>';
  const payloadValue = (observation, names) => {
    const payload = observation?.payload && typeof observation.payload === "object" ? observation.payload : {};
    const sources = [payload, payload.decodedPayload, payload.device, payload.current_state].filter((value) => value && typeof value === "object");
    for (const source of sources) for (const name of names) if (source[name] !== null && source[name] !== undefined && String(source[name]).trim()) return source[name];
    return "";
  };
  const cell = (value) => escapeHtml(value || "—");
  return `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr>${canManage ? "<th></th>" : ""}<th>Дата</th><th>Таблица</th><th>Задача / файл</th><th>Состояние</th><th>Детали</th><th>Действия</th><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Адрес</th><th>Помещение</th><th>Коммутатор</th><th>Источник</th></tr></thead><tbody>${rows.map((item) => {
    const id = String(item.id || "");
    const label = ({ mac_history: "MAC history", resolved_device_history: "Resolved device history", vendor_model_history: "Vendor/model history", app_logs: "Журнал приложения", history_loads: "История загрузок", analysis_history: "История анализа", performance_metrics: "Производительность", daily_stats: "Daily statistics", exports: "История экспорта", scheduled_tasks: "Scheduled tasks", task_file_queue: "Task file queue" })[item.kind] || item.kind;
    const rawName = payloadValue(item, ["name", "filename"]);
    const name = ["history_loads", "analysis_history", "exports"].includes(item.kind)
      ? String(rawName || "").split(/[\\/]/).filter(Boolean).at(-1) || ""
      : rawName;
    const status = payloadValue(item, ["status"])
      || (item.kind === "exports" ? payloadValue(item, ["formatType"]) : "")
      || (item.kind === "scheduled_tasks" ? (Boolean(payloadValue(item, ["enabled"])) ? "Включено" : "Выключено") : "");
    const queueResult = payloadValue(item, ["result"]);
    const queueResultSummary = queueResult && typeof queueResult === "object" && Number.isFinite(Number(queueResult.valid))
      ? ` · устройств: ${Number(queueResult.valid)}; строк с ошибками: ${Number(queueResult.invalid) || 0}` : "";
    const taskQueueSummary = item.kind === "scheduled_tasks" ? queueSummaries.get(String(payloadValue(item, ["id"]) || "")) : null;
    const taskQueueSummaryText = taskQueueSummary
      ? ` · очередь: ${Number(taskQueueSummary.pending || 0).toLocaleString("ru-RU")} ждёт / ${Number(taskQueueSummary.done || 0).toLocaleString("ru-RU")} готово / ${Number(taskQueueSummary.error || 0).toLocaleString("ru-RU")} ошибок`
      : "";
    const importedCount = (names) => Math.max(0, Number(payloadValue(item, names)) || 0).toLocaleString("ru-RU");
    const importedSeconds = (names) => {
      const value = Number(payloadValue(item, names));
      return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)} сек.` : "—";
    };
    const details = item.kind === "app_logs"
      ? `Действие: ${payloadValue(item, ["action"]) || "Другое действие"}`
      : item.kind === "exports"
      ? `Устройств: ${importedCount(["devicesCount"])} · формат: ${payloadValue(item, ["formatType"]) || "—"} · пользователь: ${payloadValue(item, ["user"]) || "—"}${payloadValue(item, ["notes"]) ? ` · примечание: ${payloadValue(item, ["notes"])}` : ""}`
      : item.kind === "history_loads"
      ? `Устройств: ${importedCount(["devicesCount"])} · новых производителей: ${importedCount(["newVendorsAdded"])} · новых моделей: ${importedCount(["newModelsAdded"])} · обогащено из истории: ${importedCount(["enrichedFromHistory"])}`
      : item.kind === "analysis_history"
        ? `Устройств: ${importedCount(["devicesCount"])} · стратегия: ${payloadValue(item, ["strategy"]) || "—"} · время: ${importedSeconds(["processingTime"])}`
        : item.kind === "performance_metrics"
          ? `Операция: ${payloadValue(item, ["operation"]) || "—"} · длительность: ${importedCount(["durationMs"])} мс`
          : item.kind === "daily_stats"
      ? `Устройства: ${payloadValue(item, ["totalDevices"]) || 0} · новые: ${payloadValue(item, ["newDevices"]) || 0} · производителей: ${payloadValue(item, ["vendorsCount"]) || 0} · помещений: ${payloadValue(item, ["roomsCount"]) || 0} · с адресом: ${payloadValue(item, ["devicesWithAddress"]) || 0} · с помещением: ${payloadValue(item, ["devicesWithRoom"]) || 0}`
      : item.kind === "scheduled_tasks"
      ? `Каждые ${payloadValue(item, ["intervalMinutes"]) || "—"} мин. · последний запуск: ${payloadValue(item, ["lastRunAt"]) || "ещё не было"} · следующий запуск: ${payloadValue(item, ["nextRunAt"]) || "—"}${taskQueueSummaryText}`
      : item.kind === "task_file_queue"
        ? `Задача ${payloadValue(item, ["taskId"]) || "—"} · ${Boolean(payloadValue(item, ["contentAvailable"])) ? "файл можно скачать из архива" : Boolean(payloadValue(item, ["contentRetainedInSourceDatabase"])) ? "файл читается из сохранённой SQLite базы" : Boolean(payloadValue(item, ["contentRetainedLocally"])) ? "файл хранится локально в этом браузере" : "байты файла недоступны"}${payloadValue(item, ["error"]) ? ` · ошибка: ${payloadValue(item, ["error"])}` : ""}${queueResultSummary}`
        : "";
    const actions = !canManage ? "" : item.kind === "scheduled_tasks"
      ? `<button class="button secondary" type="button" data-run-legacy-task="${escapeHtml(id)}">Запустить очередь</button><button class="button secondary" type="button" data-toggle-legacy-task="${escapeHtml(id)}">${Boolean(payloadValue(item, ["enabled"])) ? "Выключить" : "Включить"}</button><button class="button secondary" type="button" data-add-legacy-task-files="${escapeHtml(id)}">Добавить файлы</button>`
      : item.kind === "task_file_queue" && (Boolean(payloadValue(item, ["contentAvailable"])) || Boolean(payloadValue(item, ["contentRetainedInSourceDatabase"])) || Boolean(payloadValue(item, ["contentRetainedLocally"])))
        ? `<button class="button secondary" type="button" data-download-legacy-task-file="${escapeHtml(id)}">Скачать файл</button>` : "";
    const sourceValue = payloadValue(item, ["source", "source_file"]) || item.source || payloadValue(item, ["filename"]);
    const source = ["history_loads", "analysis_history", "exports"].includes(item.kind)
      ? String(sourceValue || "").split(/[\\/]/).filter(Boolean).at(-1) || ""
      : sourceValue;
    return `<tr>${canManage ? `<td><input type="checkbox" data-legacy-observation-select="${escapeHtml(id)}" aria-label="Выбрать запись ${escapeHtml(id)}" ${selectedIds.has(id) ? "checked" : ""}></td>` : ""}<td>${cell(item.observedAt)}</td><td>${cell(label)}</td><td>${cell(name)}</td><td>${cell(status)}</td><td>${cell(details)}</td><td>${actions}</td><td>${cell(item.mac)}</td><td>${cell(payloadValue(item, ["vendor", "manufacturer"]))}</td><td>${cell(payloadValue(item, ["model", "device_model"]))}</td><td>${cell(payloadValue(item, ["ip", "ip_address"]))}</td><td>${cell(payloadValue(item, ["address", "physical_address"]))}</td><td>${cell(payloadValue(item, ["room", "room_name"]))}</td><td>${cell(payloadValue(item, ["switch_ip", "switchIp"]))}</td><td>${cell(source)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export function renderKpis(container, kpis, actions = {}, visibleWidgetKeys = null, displayValues = {}) {
  const definitions = [
    ["devices", "Устройства"],
    ["modified", "Изменённые"],
    ["absent", "Отсутствуют"],
    ["unchanged", "Без изменений"],
    ["manufacturers", "Производители"],
    ["rooms", "Помещения"],
    ["withoutRoom", "Без помещения"],
    ["changedRooms", "Помещения с изменениями"],
    ["allChangedRooms", "Изменилось всё оборудование"],
    ["switchAnomalyRooms", "Разные IP коммутатора", "NEW"],
    ["codecChanges", "Изменения кодеков"],
  ];
  container.innerHTML = definitions.map(([key, label, badge]) => visibleWidgetKeys?.get(`kpi:${key}`) === false ? "" : `
    <button class="kpi" type="button" data-kpi="${key}" data-dashboard-widget-kpi="kpi:${key}">
      <span>${escapeHtml(label)} ${badge ? `<b class="new-badge">${badge}</b>` : ""}</span>
      <strong>${escapeHtml(displayValues[key] ?? Number(kpis[key] || 0).toLocaleString("ru-RU"))}</strong>
    </button>`).join("");
  container.onclick = (event) => {
    const key = event.target.closest("[data-kpi]")?.dataset.kpi;
    if (key && actions[key]) actions[key]();
  };
}

export function dashboardFleetDialogContent(fleet, { offset = 0, limit = 100 } = {}) {
  const series = Array.isArray(fleet?.series) ? fleet.series : [];
  const start = Math.max(0, Math.min(series.length, Math.floor(Number(offset) || 0)));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const rows = series.slice(start, start + pageSize);
  const body = rows.map((item) => `<tr><td>${escapeHtml(item.date ? item.date.replace("T", " ").slice(0, 19) : "—")}</td><td>${escapeHtml(item.name)}</td><td>${Number(item.count).toLocaleString("ru-RU")}</td><td>${item.delta === null ? "—" : `<span class="${item.delta < 0 ? "negative-delta" : "positive-delta"}">${item.delta > 0 ? "+" : ""}${Number(item.delta).toLocaleString("ru-RU")}</span>`}</td></tr>`).join("");
  const end = Math.min(series.length, start + rows.length);
  const pager = series.length > pageSize
    ? `<div class="action-row"><span class="muted">Показано ${start + 1}–${end} из ${series.length.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-dashboard-fleet-page="${Math.max(0, start - pageSize)}" ${start ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-dashboard-fleet-page="${start + pageSize}" ${end < series.length ? "" : "disabled"}>Дальше</button></div>`
    : `<p class="muted">Выгрузок: ${series.length.toLocaleString("ru-RU")}</p>`;
  return `<div class="kpi-grid"><article class="kpi"><span>Уникальных MAC во всех Final</span><strong>${Number(fleet?.uniqueMacs || 0).toLocaleString("ru-RU")}</strong></article><article class="kpi"><span>Устройств в последнем Final</span><strong>${Number(fleet?.latestCount || 0).toLocaleString("ru-RU")}</strong></article></div><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Дата</th><th>Final</th><th>Устройств</th><th>Изменение к предыдущему</th></tr></thead><tbody>${body || '<tr><td colspan="4" class="empty">Сохранённых Final пока нет.</td></tr>'}</tbody></table></div>${series.length ? pager : ""}`;
}

export function renderRanked(container, items, empty = "Нет данных") {
  container.innerHTML = items.length
    ? items.map((item) => `<div class="rank-row"><span>${escapeHtml(item.label)}</span><strong>${Number(item.value).toLocaleString("ru-RU")}</strong></div>`).join("")
    : `<p class="empty">${escapeHtml(empty)}</p>`;
}

export function dashboardAggregateDialogContent(items = [], { field, offset = 0, limit = 100, total: requestedTotal = null, hasPrevious: requestedPrevious = null, hasNext: requestedNext = null } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const pagedTotal = Number(requestedTotal);
  const remotePage = requestedTotal !== null && Number.isSafeInteger(pagedTotal) && pagedTotal >= 0;
  const start = remotePage
    ? Math.max(0, Math.floor(Number(offset) || 0))
    : Math.max(0, Math.min(rows.length, Math.floor(Number(offset) || 0)));
  const page = remotePage ? rows.slice(0, pageSize) : rows.slice(start, start + pageSize);
  const total = remotePage ? pagedTotal : rows.length;
  const end = start + page.length;
  const body = page.map((item) => `<tr><td><button class="link-button" type="button" data-dashboard-aggregate-filter="${escapeHtml(field)}" data-dashboard-aggregate-value="${escapeHtml(item.label)}">${escapeHtml(item.label || "Не указано")}</button></td><td>${Number(item.value ?? item.count ?? 0).toLocaleString("ru-RU")}</td></tr>`).join("");
  const hasPrevious = remotePage ? Boolean(requestedPrevious) : start > 0;
  const hasNext = remotePage ? Boolean(requestedNext) : end < total;
  const pager = hasPrevious || hasNext
    ? `<nav class="table-pagination" aria-label="Страницы списка"><span>${start + 1}–${end} из ${total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-dashboard-aggregate-page="${Math.max(0, start - pageSize)}" ${hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-dashboard-aggregate-page="${start + pageSize}" ${hasNext ? "" : "disabled"}>Дальше</button></nav>`
    : `<p class="muted">Всего: ${total.toLocaleString("ru-RU")}</p>`;
  return `${rows.length ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>${field === "manufacturer" ? "Производитель" : "Помещение"}</th><th>Устройств</th></tr></thead><tbody>${body}</tbody></table></div>${pager}` : '<p class="empty">Нет данных для выбранного статуса и фильтров.</p>'}`;
}

export function dashboardChangeDeviceGroups(events = []) {
  const groups = new Map();
  for (const [index, event] of events.entries()) {
    const device = event?.device || {};
    const identity = identityTokens(device).find((token) => token.strong)?.key || "";
    const key = `${event?.type || "modified"}:${identity || `event-${index}`}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: event?.type || "modified", severity: event?.severity || "other", device, changes: [], source: event?.source || "" };
      groups.set(key, group);
    }
    if (event?.severity === "critical") group.severity = "critical";
    const changes = Array.isArray(event?.changes) ? event.changes : event?.change ? [event.change] : [];
    for (const change of changes) {
      const critical = isCriticalHistoryChange(event?.type, change.field, change.oldValue, change.newValue);
      const severity = critical ? "critical" : change.severity === "low" || event?.severity === "low" ? "low" : "other";
      group.changes.push({ ...change, severity, source: change.source || event.source || device.fieldSources?.[change.field] || group.source });
    }
    if (!changes.length && event?.source && !group.source) group.source = event.source;
  }
  return [...groups.values()];
}

export function dashboardChangeDeviceGroupsContent(events = []) {
  const labels = { added: "Добавлено", absent: "Отсутствует", modified: "Изменено" };
  const severityLabels = { critical: "Критическое", low: "Низкое", other: "Другое" };
  return dashboardChangeDeviceGroups(events).map((group) => {
    const { device, type, severity, changes, source } = group;
    const identity = device.mac || device.deviceId || device.serial || device.id || "Устройство без идентификатора";
    const location = [device.model, device.address, device.room].filter((value) => String(value ?? "").trim()).map(escapeHtml);
    const detailRows = changes.map((change) => {
      const field = change.label || change.field || "Изменение";
      const before = change.oldValue ?? "—";
      const after = change.newValue ?? "—";
      const origin = change.source ? ` · Источник: ${escapeHtml(change.source)}` : "";
      return `<li><span class="severity-badge severity-${isSafeSeverity(change.severity) ? change.severity : severity}">${escapeHtml(severityLabels[change.severity] || severityLabels[severity] || severityLabels.other)}</span> ${escapeHtml(field)}: ${escapeHtml(before)} → ${escapeHtml(after)}${origin}</li>`;
    }).join("");
    const fallback = type === "added" ? "Устройство добавлено" : type === "absent" ? "Устройство отсутствует в текущем Final" : `Источник: ${escapeHtml(source || "История Final")}`;
    return `<details class="change-device-group"><summary><span class="severity-badge severity-${isSafeSeverity(severity) ? severity : "other"}">${escapeHtml(severityLabels[severity] || severityLabels.other)}</span> <strong>${escapeHtml(labels[type] || labels.modified)}</strong> · ${escapeHtml(identity)} <span class="muted">${changes.length ? `· ${changes.length} пол.` : ""}</span></summary><div class="change-device-context">${location.length ? location.join(" · ") : "Модель и местоположение не указаны"}</div><ul class="change-device-fields">${detailRows || `<li>${fallback}</li>`}</ul></details>`;
  }).join("");
}

function isSafeSeverity(value) {
  return value === "critical" || value === "low" || value === "other";
}

export function churnContent(items = [], { query = "", page = 1, pageSize = 100 } = {}) {
  const needle = String(query).trim().toLocaleLowerCase("ru-RU");
  const matches = (item) => !needle || [item.mac, item.macFormatted, item.vendor, item.model, item.ip, item.room, item.address, item.smartroomId]
    .some((value) => String(value ?? "").toLocaleLowerCase("ru-RU").includes(needle));
  let total = 0;
  for (const item of items) if (matches(item)) total += 1;
  if (!total) return '<tr><td colspan="9" class="empty">MAC с исчезновением и последующим возвращением не найдены.</td></tr>';
  const size = Math.max(1, Math.min(100, Number(pageSize) || 100));
  const pages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (currentPage - 1) * size;
  const end = Math.min(total, start + size);
  const rows = [];
  let matched = 0;
  for (const item of items) {
    if (!matches(item)) continue;
    if (matched >= start && matched < end) {
      const normalizedMac = firstMac(item.mac, item.macFormatted);
      const displayMac = normalizedMac || item.macFormatted || item.mac || "MAC не указан";
      const mac = escapeHtml(displayMac);
      rows.push(`<tr><td><button class="link-button" type="button" data-search-mac="${mac}">${escapeHtml(displayMac)}</button></td><td>${escapeHtml(item.vendor || "—")}</td><td>${escapeHtml(item.model || "—")}</td><td>${escapeHtml(item.ip || "—")}</td><td>${escapeHtml(item.room || item.address || item.smartroomId || "—")}</td><td>${Number(item.present || 0)}</td><td>${Number(item.disappearances || 0)}</td><td>${Number(item.reappearances || 0)}</td><td><strong>${Number(item.transitionCount || 0)}</strong> <button class="button secondary" type="button" data-churn-transitions="${mac}">Детали</button></td></tr><tr data-churn-transition-detail="${mac}" hidden><td colspan="9" class="churn-transition-detail"></td></tr>`);
    }
    matched += 1;
    if (matched >= end) break;
  }
  rows.push(`<tr class="summary-row"><td colspan="9"><div class="button-row"><span class="muted">Устройства ${start + 1}–${end} из ${total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-churn-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""}>Назад</button><span class="muted">Страница ${currentPage} из ${pages}</span><button class="button secondary" type="button" data-churn-page="${currentPage + 1}" ${currentPage >= pages ? "disabled" : ""}>Дальше</button></div></td></tr>`);
  return rows.join("");
}

export function modelPrefixAnalyticsContent(result) {
  const metrics = result?.metrics || {};
  const prefixes = result?.prefixes || [];
  return `<p class="muted">Правила определения модели по точному имени или совпадению по названию. Число вхождений подсчитано по всем сохранённым Final.</p><div class="action-row"><button class="button secondary" type="button" data-export-model-prefix-analytics-xlsx>Экспорт префиксов XLSX</button></div>
    <div class="kpi-grid"><article class="kpi"><span>Префиксов</span><strong>${Number(metrics.prefixes || 0).toLocaleString("ru-RU")}</strong></article><article class="kpi"><span>Устройств в выбранном Final</span><strong>${Number(metrics.matchedDevices || 0).toLocaleString("ru-RU")}</strong></article><article class="kpi"><span>Производителей</span><strong>${Number(metrics.vendors || 0).toLocaleString("ru-RU")}</strong></article></div>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Префикс MAC</th><th>Форматированный</th><th>Модель</th><th>Источник</th><th>Количество вхождений</th></tr></thead><tbody>${prefixes.length
      ? prefixes.map((item) => `<tr><td>${escapeHtml(item.prefix)}</td><td>${escapeHtml(item.formattedPrefix)}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.source)}</td><td>${Number(item.occurrences || 0).toLocaleString("ru-RU")}</td></tr>`).join("")
      : '<tr><td colspan="5" class="empty">Префиксы для этой модели не найдены.</td></tr>'}</tbody></table></div>`;
}

const chartInstances = new WeakMap();

function setChartState(canvas, message = "", error = false) {
  if (message) {
    chartInstances.get(canvas)?.destroy?.();
    chartInstances.delete(canvas);
    globalThis.Chart?.getChart?.(canvas)?.destroy?.();
  }
  const state = canvas?.parentElement?.querySelector?.(`[data-chart-state="${canvas.id}"]`);
  if (canvas) canvas.hidden = Boolean(message);
  if (state) {
    state.hidden = !message;
    state.textContent = message;
    state.classList?.toggle("error", error);
  }
}

export function drawBars(canvas, items, { positive = "#087f5b", negative = "#c92a2a", label = "value", datasetLabel = "Значение", afterLabel } = {}) {
  if (!canvas) return false;
  if (!Array.isArray(items)) {
    setChartState(canvas, "Ошибка: данные графика имеют неверный формат.", true);
    return false;
  }
  if (!items.length) {
    setChartState(canvas, "Нет данных для построения графика.");
    return false;
  }
  const rows = items.map((item, index) => {
    const value = Number(item?.[label] ?? item?.value);
    const title = String(item?.label ?? `Запись ${index + 1}`).trim();
    return title && Number.isFinite(value) ? { label: title, value } : null;
  });
  if (rows.some((row) => !row)) {
    setChartState(canvas, "Ошибка: график содержит пустые подписи или нечисловые значения.", true);
    return false;
  }
  const ChartConstructor = globalThis.Chart;
  if (typeof ChartConstructor !== "function") {
    setChartState(canvas, "Ошибка: библиотека Chart.js не загружена.", true);
    return false;
  }
  let context;
  try {
    context = canvas.getContext?.("2d");
    if (!context) throw new Error("Canvas 2D недоступен");
    chartInstances.get(canvas)?.destroy?.();
    ChartConstructor.getChart?.(canvas)?.destroy?.();
    setChartState(canvas);
    const colors = rows.map(({ value }) => value < 0 ? negative : positive);
    const chart = new ChartConstructor(context, {
      type: "bar",
      data: {
        labels: rows.map((row) => row.label),
        datasets: [{ label: datasetLabel, data: rows.map((row) => row.value), backgroundColor: colors, borderColor: colors, borderWidth: 1 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        ...(typeof afterLabel === "function" ? { plugins: { tooltip: { callbacks: { afterLabel } } } } : {}),
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
    chartInstances.set(canvas, chart);
    return true;
  } catch (error) {
    chartInstances.get(canvas)?.destroy?.();
    setChartState(canvas, `Не удалось построить график: ${error.message || error}`, true);
    return false;
  }
}

function chartThemeColors() {
  const defaults = { text: "#172326", muted: "#66777b", border: "#d6e0e2", primary: "#087f8c", danger: "#c92a2a" };
  try {
    const style = globalThis.getComputedStyle?.(globalThis.document?.body);
    if (!style) return defaults;
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      text: read("--text", defaults.text),
      muted: read("--muted", defaults.muted),
      border: read("--border", defaults.border),
      primary: read("--primary", defaults.primary),
      danger: read("--danger", defaults.danger),
    };
  } catch {
    return defaults;
  }
}

function drawLineChart(canvas, labels, datasets, title = "", chartType = "line") {
  if (!canvas) return false;
  if (Array.isArray(labels) && !labels.length) {
    setChartState(canvas, "Нет данных для построения графика.");
    return false;
  }
  if (!Array.isArray(labels) || !labels.length || !Array.isArray(datasets) || !datasets.length
    || datasets.some((dataset) => !String(dataset?.label || "").trim() || !Array.isArray(dataset.data)
      || dataset.data.length !== labels.length || dataset.data.some((value) => !Number.isFinite(Number(value))))) {
    setChartState(canvas, "Ошибка: данные графика имеют неверный формат.", true);
    return false;
  }
  const ChartConstructor = globalThis.Chart;
  if (typeof ChartConstructor !== "function") {
    setChartState(canvas, "Ошибка: библиотека Chart.js не загружена.", true);
    return false;
  }
  try {
    const context = canvas.getContext?.("2d");
    if (!context) throw new Error("Canvas 2D недоступен");
    chartInstances.get(canvas)?.destroy?.();
    ChartConstructor.getChart?.(canvas)?.destroy?.();
    setChartState(canvas);
    const colors = chartThemeColors();
    const chart = new ChartConstructor(context, {
      type: chartType,
      data: {
        labels,
        datasets: datasets.map((dataset) => ({
          type: dataset.type || chartType,
          label: dataset.label,
          data: dataset.data,
          borderColor: dataset.color || (dataset.tone === "danger" ? colors.danger : colors.primary),
          backgroundColor: dataset.backgroundColor || dataset.color || (dataset.tone === "danger" ? colors.danger : colors.primary),
          pointRadius: (dataset.type || chartType) === "line" ? 3 : 0,
          tension: 0,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: colors.text } },
          title: { display: Boolean(title), text: title, color: colors.text },
        },
        scales: {
          x: { ticks: { color: colors.muted }, grid: { color: colors.border } },
          y: { beginAtZero: true, ticks: { precision: 0, color: colors.muted }, grid: { color: colors.border } },
        },
      },
    });
    chartInstances.set(canvas, chart);
    return true;
  } catch (error) {
    chartInstances.get(canvas)?.destroy?.();
    setChartState(canvas, `Не удалось построить график: ${error.message || error}`, true);
    return false;
  }
}

export function drawFinalChangeTrend(canvas, items = []) {
  const rows = Array.isArray(items) ? items : [];
  return drawLineChart(canvas, rows.map((item) => String(item?.label || "Без даты")), [
    { label: "Добавлено", data: rows.map((item) => Number(item?.added || 0)) },
    { label: "Отсутствовало", data: rows.map((item) => {
      const count = Math.abs(Number(item?.absent || 0));
      return count > 0 ? -count : 0;
    }), tone: "danger" },
  ]);
}

export function drawFinalTotalsTrend(canvas, items = []) {
  const rows = Array.isArray(items) ? items : [];
  const previous = Number(rows.at(-2)?.value || 0);
  const current = Number(rows.at(-1)?.value || 0);
  const percentage = previous ? ((current - previous) / previous) * 100 : current ? 100 : 0;
  const title = `Было ${previous.toLocaleString("ru-RU")}, стало ${current.toLocaleString("ru-RU")} (${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%)`;
  return drawLineChart(canvas, rows.map((item) => String(item?.label || "Без даты")), [
    { label: "Устройств", data: rows.map((item) => Number(item?.value || 0)) },
  ], title);
}

export function drawLegacyDailyStatistics(canvas, rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  return drawLineChart(canvas, items.map((row) => String(row?.date || "Без даты")), [
    { label: "Всего устройств", type: "line", data: items.map((row) => Number(row?.totalDevices || 0)) },
    { label: "Новых устройств", data: items.map((row) => Number(row?.newDevices || 0)), tone: "danger", backgroundColor: "rgba(201,42,42,0.5)" },
  ], "Импортированная статистика SQLite · последние 30 дней", "bar");
}

export function drawWeekly(canvas, items) {
  if (!Array.isArray(items)) return drawBars(canvas, items);
  if (canvas) canvas.title = items.map((item) => `${formatWeekRangeLabel(item?.label)}: ${item?.modified ?? "—"} изменений, ${item?.rooms ?? "—"} помещений, ${item?.macs ?? "—"} MAC`).join("\n");
  return drawBars(canvas, items.map((item) => ({ label: formatWeekRangeLabel(item?.label), value: item?.modified })), {
    datasetLabel: "Изменений",
    afterLabel: ({ dataIndex }) => {
      const row = items[dataIndex];
      return `Переговорных: ${Number(row?.rooms || 0).toLocaleString("ru-RU")} · MAC-адресов: ${Number(row?.macs || 0).toLocaleString("ru-RU")}`;
    },
  });
}

export function showDialog(dialog, title, content) {
  dialog.querySelector("[data-dialog-title]").textContent = title;
  dialog.querySelector("[data-dialog-content]").innerHTML = content;
  if (!dialog.open) dialog.showModal();
}

export const DEVICE_COLUMNS = Object.freeze([
  ["mac", "MAC"],
  ["ip", "IP устройства"],
  ["switchIp", "IP коммутатора"],
  ["switchPort", "Порт"],
  ["manufacturer", "Производитель"],
  ["model", "Модель"],
  ["deviceType", "Тип"],
  ["hostname", "Hostname"],
  ["serial", "Serial"],
  ["deviceId", "Device ID"],
  ["smartroomId", "Smartroom ID"],
  ["room", "Помещение"],
  ["address", "Адрес"],
  ["authenticationTime", "Время аутентификации"],
  ["source", "Источник"],
]);

export function deviceTable(devices, { anomaly = false, columnConfig = null, rowNumberOffset = 0 } = {}) {
  const columns = columnConfig
    ? visibleInventoryColumns(columnConfig).map(({ key, label }) => ({ key, label, value: (device, index) => inventoryCellText(device, key, Math.max(0, Number(rowNumberOffset) || 0) + index + 1) }))
    : DEVICE_COLUMNS.map(([key, label]) => ({ key, label, value: (device) => device[key] || "—" }));
  return `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr>${anomaly ? "<th>Статус</th>" : ""}${columns.map(({ key, label }) => `<th data-device-column="${escapeHtml(key)}">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${devices.map((device, index) => `<tr data-device-context-row data-device-id="${escapeHtml(device.id || "")}" tabindex="0" aria-label="Контекстные действия для ${escapeHtml(device.mac || device.deviceId || device.serial || "устройства")}" class="${device.anomaly ? "danger-row" : ""}">${anomaly ? `<td>${device.anomaly ? "Отклонение" : escapeHtml(device.anomalyStatus || "Основной")}</td>` : ""}${columns.map(({ key, value }) => {
    const cell = value(device, index);
    return `<td data-device-field="${escapeHtml(key)}">${key === "mac" && anomaly && device.mac ? `<a href="#search" data-search-mac="${escapeHtml(device.mac)}">${escapeHtml(cell || "—")}</a>` : escapeHtml(cell || "—")}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function unassignedDevicesContent({ devices = [], count = devices.length, vendors = [], models = [], page = 1, pageCount = 1 } = {}) {
  const ranking = (title, items) => `<section class="detail-section"><h3>${escapeHtml(title)}</h3>${items.length
    ? `<ul class="ranked-list">${items.map((item) => `<li><span>${escapeHtml(item.label)}</span><strong>${Number(item.value).toLocaleString("ru-RU")}</strong></li>`).join("")}</ul>`
    : '<p class="empty">Нет данных</p>'}</section>`;
  const pagination = pageCount > 1
    ? `<div class="action-row"><span class="muted">Страница ${Number(page).toLocaleString("ru-RU")} из ${Number(pageCount).toLocaleString("ru-RU")} · показано ${devices.length.toLocaleString("ru-RU")} из ${Number(count).toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-unassigned-device-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Назад</button><button class="button secondary" type="button" data-unassigned-device-page="${page + 1}" ${page >= pageCount ? "disabled" : ""}>Дальше</button></div>`
    : "";
  return `<p class="detail-count">Устройств без помещения: <strong>${Number(count).toLocaleString("ru-RU")}</strong></p>
    <div class="detail-grid">${ranking("Производители", vendors)}${ranking("Модели", models)}</div>
    <h3>Список устройств</h3>${devices.length ? deviceTable(devices) : '<p class="empty">Устройств без помещения нет.</p>'}${pagination}`;
}

export function absentDevicesPageContent({ devices = [], total = 0, offset = 0, limit = 100 } = {}) {
  const count = Math.max(0, Number(total) || 0);
  const start = Math.max(0, Number(offset) || 0);
  const pageSize = Math.max(1, Number(limit) || 100);
  const end = Math.min(start + devices.length, count);
  const pagination = count > pageSize
    ? `<p class="muted">Показано ${count ? (start + 1).toLocaleString("ru-RU") : 0}–${end.toLocaleString("ru-RU")} из ${count.toLocaleString("ru-RU")}</p><div class="action-row"><button class="button secondary" type="button" data-analytics-absence-page="${Math.max(0, start - pageSize)}" ${start <= 0 ? "disabled" : ""}>Назад</button><button class="button secondary" type="button" data-analytics-absence-page="${start + pageSize}" ${end >= count ? "disabled" : ""}>Дальше</button></div>`
    : `<p class="muted">Устройств: ${count.toLocaleString("ru-RU")}</p>`;
  return `<p class="detail-count">Отсутствующие устройства: <strong>${count.toLocaleString("ru-RU")}</strong></p>${devices.length ? deviceTable(devices) : '<p class="empty">Отсутствующих устройств нет.</p>'}${pagination}`;
}

export function roomCoverageContent(rooms, onlyAllChanged = false, pages = {}) {
  const filtered = onlyAllChanged ? rooms.filter((room) => room.allChanged) : rooms.filter((room) => room.changedCount);
  if (!filtered.length) return '<p class="empty">Подходящих помещений нет.</p>';
  return filtered.map((room) => {
    const details = {
      key: room.key,
      smartroomId: room.smartroomId,
      businessUnit: room.businessUnit,
      city: room.city,
      site: room.site,
      floor: room.floor,
      room: room.room,
      address: room.address,
    };
    const page = pages[room.key];
    const roster = page?.devices;
    const rosterContent = Array.isArray(roster)
      ? `<p class="muted">Состав Final · страница ${Number(page.page).toLocaleString("ru-RU")} из ${Number(page.pageCount).toLocaleString("ru-RU")} · ${Number(page.total).toLocaleString("ru-RU")} устройств</p>${roomPageControls(page.page, page.total, 100, `data-room-coverage-page="${escapeHtml(room.key)}"`)}${deviceTable(roster)}`
      : Number(room.rosterCount || 0) > 0
        ? `<button class="button secondary" type="button" data-room-coverage-page="${escapeHtml(room.key)}" data-page="1" ${page?.loading ? "disabled" : ""}>${page?.loading ? "Загрузка состава…" : `Загрузить состав Final · ${Number(room.rosterCount).toLocaleString("ru-RU")} устройств`}</button>`
        : '<p class="muted">В текущем Final устройств этого помещения нет.</p>';
    return `<details class="room-card" ${page?.loading || Array.isArray(roster) ? "open" : ""}><summary><strong>${escapeHtml(room.room || room.smartroomId)}</strong><span>${room.changedCount}/${room.deviceCount} изменено</span><span>${escapeHtml(room.address || "Адрес не указан")}</span></summary>
      <p>${escapeHtml([room.businessUnit, room.city, room.site, room.floor].filter(Boolean).join(", "))}</p>
      <button class="button secondary" type="button" data-open-room-history="${escapeHtml(JSON.stringify(details))}">Открыть хронологию помещения</button>
      ${rosterContent}</details>`;
  }).join("");
}

function roomPageControls(page, total, pageSize, attributes = "") {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount < 2) return "";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `<p class="muted">Строки ${first.toLocaleString("ru-RU")}–${last.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}</p><div class="action-row"><button class="button secondary" type="button" ${attributes} data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Назад</button><button class="button secondary" type="button" ${attributes} data-page="${page + 1}" ${page >= pageCount ? "disabled" : ""}>Дальше</button></div>`;
}

export function roomTimelineObservationContent(snapshot, devices, comparison = null, room = {}, pages = {}) {
  const snapshotId = String(snapshot.id || "");
  const validPage = (page, total) => Math.max(1, Math.min(Math.max(1, Math.ceil(total / 20)), Number(page) || 1));
  const rosterPage = validPage(pages.roster, devices.length);
  const changeCount = (comparison?.modified?.length || 0) + (comparison?.ambiguous?.length || 0) + (comparison?.identityConflicts?.length || 0);
  const changesPage = validPage(pages.changes, changeCount);
  const addedPage = validPage(pages.added, comparison?.added?.length || 0);
  const absentPage = validPage(pages.absent, comparison?.absent?.length || 0);
  const rosterStart = (rosterPage - 1) * 20;
  const changesStart = (changesPage - 1) * 20;
  const roster = devices.slice(rosterStart, rosterStart + 20);
  const title = [room.smartroomId, room.businessUnit, room.city, room.site, room.floor, room.room, room.address].filter(Boolean).join(" · ");
  const time = new Date(snapshot.createdAt).toLocaleString("ru-RU");
  const transitionSummary = comparison
    ? `<p>Сравнение с ${escapeHtml(comparison.previousName)}: изменено ${comparison.modified.length}, добавлено ${comparison.added.length}, отсутствует ${comparison.absent.length}, без изменений ${comparison.unchanged.length}, неоднозначно ${comparison.ambiguous?.length || 0}.</p>
      ${changeCount ? `<h4>Изменения и диагностика идентичности</h4>${comparisonContent({ ...comparison, absent: [] }, { offset: changesStart, limit: 20, viewId: `room-${snapshotId}`, showMore: false })}${roomPageControls(changesPage, changeCount, 20, `data-room-timeline-snapshot="${escapeHtml(snapshotId)}" data-room-timeline-section="changes"`)}` : ""}
      ${comparison.added.length ? `<details ${pages.added ? "open" : ""}><summary>Добавлены (${comparison.added.length})</summary>${deviceTable(comparison.added.slice((addedPage - 1) * 20, addedPage * 20))}${roomPageControls(addedPage, comparison.added.length, 20, `data-room-timeline-snapshot="${escapeHtml(snapshotId)}" data-room-timeline-section="added"`)}</details>` : ""}
      ${comparison.absent.length ? `<details ${pages.absent ? "open" : ""}><summary>Отсутствуют (${comparison.absent.length})</summary>${deviceTable(comparison.absent.slice((absentPage - 1) * 20, absentPage * 20))}${roomPageControls(absentPage, comparison.absent.length, 20, `data-room-timeline-snapshot="${escapeHtml(snapshotId)}" data-room-timeline-section="absent"`)}</details>` : ""}`
    : '<p>Первый сохранённый Final для выбранной комнаты.</p>';
  return `<article class="room-card" data-room-timeline-id="${escapeHtml(snapshotId)}"><h3>${escapeHtml(snapshot.name || "Final")}</h3>${title ? `<p>${escapeHtml(title)}</p>` : ""}<p>${devices.length.toLocaleString("ru-RU")} устройств · ${escapeHtml(time)}</p>
    ${transitionSummary}<h4>Состав комнаты в этом Final</h4>${devices.length ? `${roomPageControls(rosterPage, devices.length, 20, `data-room-timeline-snapshot="${escapeHtml(snapshotId)}" data-room-timeline-section="roster"`)}${deviceTable(roster)}` : '<p class="empty">Помещение отсутствует в этом Final.</p>'}</article>`;
}

export function roomPairComparisonContent(comparison, baseSnapshot, currentSnapshot, requestedPage = 1) {
  const added = comparison.added || [];
  const absent = comparison.absent || [];
  const modified = comparison.modified || [];
  const ambiguous = comparison.ambiguous || [];
  const unchanged = comparison.unchanged || [];
  const comparedDeviceCount = added.length + absent.length + modified.length + unchanged.length;
  const allChanged = comparedDeviceCount > 0 && unchanged.length === 0 && ambiguous.length === 0;
  const allChangedStatus = ambiguous.length
    ? `Не подтверждено · неоднозначных: ${ambiguous.length.toLocaleString("ru-RU")}`
    : comparedDeviceCount === 0 ? "Нет данных" : allChanged ? "Да" : "Нет";
  const dateLabel = (snapshot) => `${escapeHtml(snapshot?.name || "Final")} · ${escapeHtml(snapshot?.createdAt ? new Date(snapshot.createdAt).toLocaleString("ru-RU") : "Без даты")}`;
  const rows = [
    ...added.map((device) => ({ status: "Добавлено", before: null, after: device, changes: [] })),
    ...absent.map((device) => ({ status: "Отсутствует", before: device, after: null, changes: [] })),
    ...modified.map((row) => ({ status: "Изменено", before: row.before, after: row.after, changes: row.changes || [] })),
    ...ambiguous.map((row) => ({ status: "Неоднозначно", before: null, after: row.after, changes: [], candidates: row.candidates || [] })),
  ];
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Number(requestedPage) || 1));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const table = rows.length
    ? `${roomPageControls(page, rows.length, pageSize, 'data-room-pair-page')}<div class="table-scroll"><table class="data-table"><thead><tr><th>Статус</th><th>Устройство</th><th>Smartroom ID</th><th>Помещение</th><th>Подтверждённые изменения</th><th>Кандидаты</th></tr></thead><tbody>${pageRows.map((row) => {
      const device = row.after || row.before || {};
      const identity = device.mac || device.deviceId || device.serial || device.id || "Без идентификатора";
      const changes = row.changes.map((change) => `${change.label || change.field}: ${change.oldValue ?? change.before ?? "—"} → ${change.newValue ?? change.after ?? "—"}`).join("; ");
      const candidates = (row.candidates || []).map((candidate) => candidate.mac || candidate.deviceId || candidate.serial || candidate.id || "Без идентификатора").join(", ");
      return `<tr><td>${escapeHtml(row.status)}</td><td>${escapeHtml(identity)}</td><td>${escapeHtml(device.smartroomId || "—")}</td><td>${escapeHtml(device.room || device.address || "—")}</td><td>${escapeHtml(changes || "—")}</td><td>${escapeHtml(candidates || "—")}</td></tr>`;
    }).join("")}</tbody></table></div>`
    : '<p class="empty">Подтверждённых изменений и неоднозначных совпадений нет.</p>';
  return `<p class="muted">${dateLabel(baseSnapshot)} → ${dateLabel(currentSnapshot)}</p><div class="kpi-grid"><article class="kpi"><span>Изменилось всё оборудование</span><strong>${escapeHtml(allChangedStatus)}</strong></article><article class="kpi"><span>Добавлено</span><strong>${added.length}</strong></article><article class="kpi"><span>Отсутствует</span><strong>${absent.length}</strong></article><article class="kpi"><span>Изменено</span><strong>${modified.length}</strong></article><article class="kpi"><span>Без изменений</span><strong>${unchanged.length}</strong></article><article class="kpi"><span>Неоднозначно</span><strong>${ambiguous.length}</strong></article></div>${table}`;
}

export function roomAnomalyContent(anomalies, pages = {}) {
  if (!anomalies.length) return '<p class="empty">Отклонений IP коммутатора не найдено.</p>';
  return anomalies.map((room) => {
    const page = pages[room.key];
    const hasPage = Array.isArray(page?.devices);
    const pageSummary = hasPage
      ? `<p class="muted">Устройства ${((page.page - 1) * 100 + 1).toLocaleString("ru-RU")}–${Math.min(page.page * 100, page.total).toLocaleString("ru-RU")} из ${Number(page.total).toLocaleString("ru-RU")}</p>
        <div class="button-row"><button class="button secondary" type="button" data-room-anomaly-page="${escapeHtml(room.key)}" data-page="${page.page - 1}" ${page.page <= 1 || page.loading ? "disabled" : ""}>Назад</button><button class="button secondary" type="button" data-room-anomaly-page="${escapeHtml(room.key)}" data-page="${page.page + 1}" ${!page.hasNext || page.loading ? "disabled" : ""}>Дальше</button></div>`
      : `<button class="button secondary" type="button" data-room-anomaly-page="${escapeHtml(room.key)}" data-page="1" ${page?.loading ? "disabled" : ""}>${page?.loading ? "Загрузка состава…" : `Загрузить полный состав · ${Number(room.deviceCount).toLocaleString("ru-RU")} устройств`}</button>`;
    const devices = hasPage ? page.devices.map((device) => {
      const switchIp = String(device.switchIp || device.switch_ip || "").trim();
      const dominantIp = String(room.dominantIp || "").trim();
      const anomaly = Boolean(switchIp && dominantIp && switchIp !== dominantIp);
      return {
        ...device,
        anomaly,
        anomalyStatus: switchIp ? (anomaly ? "Отклонение" : "Основной") : "IP не указан",
      };
    }) : [];
    return `
    <details class="room-card">
      <summary>
        <strong>${escapeHtml(room.room)}</strong>
        <span>${escapeHtml(room.smartroomId || "Нет Smartroom ID")}</span>
        <span>${Number(room.deviceCount).toLocaleString("ru-RU")} устройств · ${room.switchCount} IP · ${room.deviationCount} отклонений · ${Number(room.missingSwitchDevices || 0).toLocaleString("ru-RU")} без IP коммутатора</span>
      </summary>
      <p>${escapeHtml([room.businessUnit, room.city, room.site, room.floor, room.address].filter(Boolean).join(", "))}</p>
      <p>Основной IP коммутатора: <strong>${escapeHtml(room.dominantIp)}</strong></p>
      <p>Распределение IP: ${Object.entries(room.switches || {}).map(([ip, count]) => `<span>${escapeHtml(ip)} — ${Number(count)}</span>`).join(" · ")}</p>
      ${hasPage ? `${deviceTable(devices, { anomaly: true })}${pageSummary}` : pageSummary}
    </details>`;
  }).join("");
}

const MAC_TIMELINE_FIELDS = Object.freeze([
  ["id", "Внутренний ID"], ["mac", "MAC"], ["alternateMacs", "Дополнительные MAC"],
  ["ip", "IP устройства"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт коммутатора"],
  ["manufacturer", "Производитель"], ["model", "Модель"], ["deviceType", "Тип устройства"],
  ["hostname", "Hostname"], ["serial", "Серийный номер"], ["deviceId", "Device ID"],
  ["deviceName", "Название устройства"], ["smartroomId", "Smartroom ID"],
  ["businessUnit", "ТБ"], ["city", "Город"], ["site", "Площадка"], ["floor", "Этаж"],
  ["room", "Помещение"], ["address", "Адрес"], ["physicalAddress", "Физический адрес"],
  ["authenticationTime", "Время аутентификации"], ["observedAt", "Время наблюдения"],
  ["source", "Источник"], ["sources", "Источники"], ["fieldSources", "Источники полей"],
  ["possibleIps", "Возможные IP"], ["possibleIpsTruncated", "Есть другие IP"],
  ["alternateMacsTruncated", "Есть другие MAC"], ["conflicts", "Конфликты"], ["conflictsTruncated", "Есть другие конфликты"],
]);

function timelineValue(value) {
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") : "—";
  if (value && typeof value === "object") return JSON.stringify(value);
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function formatUtcTimelineDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Дата не указана";
  return `${new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date)} UTC`;
}

function timelineTimestamp(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chronologicalMacEvents(events) {
  const timestamp = (event) => timelineTimestamp(event.date) ?? Number.MAX_SAFE_INTEGER;
  let previous = timestamp(events[0]);
  for (let index = 1; index < events.length; index += 1) {
    const current = timestamp(events[index]);
    if (current < previous) return [...events].sort((left, right) => timestamp(left) - timestamp(right));
    previous = current;
  }
  return events;
}

function formatTimelineDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин.`;
  const days = Math.floor(hours / 24);
  return `${days} дн. ${hours % 24} ч`;
}

export function macTimelineContent(events = [], { page = 1, pageSize = 100 } = {}) {
  if (!events.length) return '<p class="empty">MAC не найден в Final-снимках.</p>';
  const ordered = chronologicalMacEvents(events);
  const size = Math.max(1, Math.min(100, Number(pageSize) || 100));
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const currentPage = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (currentPage - 1) * size;
  const end = Math.min(ordered.length, start + size);
  let previousTimestamp = start > 0 ? timelineTimestamp(ordered[start - 1].date) : null;
  const cards = ordered.slice(start, end).map((event) => {
    const currentTimestamp = timelineTimestamp(event.date);
    const interval = previousTimestamp !== null && currentTimestamp !== null
      ? `<small class="timeline-duration">Интервал: ${escapeHtml(formatTimelineDuration(Math.abs(currentTimestamp - previousTimestamp)))}</small>`
      : "";
    if (currentTimestamp !== null) previousTimestamp = currentTimestamp;
    if (event.status === "ambiguous") {
      const candidates = (event.candidates || []).map((device) => `<li>${escapeHtml([device.mac, device.deviceId, device.serial, device.hostname].filter(Boolean).join(" · ") || "Без различимых идентификаторов")}</li>`).join("");
      return `<article class="timeline-card mac-timeline-item mac-timeline-ambiguous"><p class="eyebrow">${escapeHtml(formatUtcTimelineDate(event.date))}</p>${interval}<h3>Неоднозначно: MAC найден у нескольких устройств</h3><ul>${candidates}</ul></article>`;
    }
    const device = event.after || event.before || {};
    const changesList = Array.isArray(event.changes) ? event.changes : [];
    const changed = new Set(changesList.map((item) => item.field));
    const title = event.observationKind === "optional-host-added" ? "Появление · SQLite optional host"
      : event.observationKind === "optional-host-absent" ? "Отсутствие · SQLite optional host"
        : event.status === "observation" ? "Наблюдение SQLite" : event.historyOnly ? "Изменение из журнала" : event.status === "first" ? "Первое появление" : event.status === "changed" ? "Изменение" : event.status === "absent" ? "Отсутствует" : "Без изменений";
    const tone = event.status === "observation" ? "observed" : event.status === "first" ? "added" : event.status === "absent" ? "removed" : event.status === "changed" ? "changed" : "snapshot";
    const details = MAC_TIMELINE_FIELDS.map(([field, label]) => `<div class="${changed.has(field) ? "mac-context-changed" : ""}"><dt>${escapeHtml(label)}</dt><dd class="${changed.has(field) ? "changed-value" : ""}">${escapeHtml(timelineValue(device[field]))}</dd></div>`).join("");
    const changes = changesList.length ? `<div class="mac-timeline-change-list">${changesList.map((item) => `<p><strong>${escapeHtml(item.label || item.field || "Изменение")}</strong>: <span class="mac-value-before">${escapeHtml(item.oldValue || "Не заполнено")}</span> → <span class="mac-value-after">${escapeHtml(item.newValue || "Не заполнено")}</span>${item.historyEventIds?.length ? ` <small>· сохранённых событий: ${item.historyEventIds.length}</small>` : ""}</p>`).join("")}</div>` : "";
    const finalComparison = event.status === "changed" && event.before && event.after
      ? `<details class="timeline-final-comparison"><summary>Сравнить Final: «${escapeHtml(event.previousSnapshotName || "Final")}» → «${escapeHtml(event.snapshotName || "Final")}»</summary><div class="timeline-final-comparison-grid"><section><h4>Было в предыдущем Final «${escapeHtml(event.previousSnapshotName || "Final")}»</h4><dl>${MAC_TIMELINE_FIELDS.map(([field, label]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(timelineValue(event.before[field]))}</dd>`).join("")}</dl></section><section><h4>Стало в новом Final «${escapeHtml(event.snapshotName || "Final")}»</h4><dl>${MAC_TIMELINE_FIELDS.map(([field, label]) => `<dt>${escapeHtml(label)}</dt><dd class="${changed.has(field) ? "changed-value" : ""}">${escapeHtml(timelineValue(event.after[field]))}</dd>`).join("")}</dl></section></div></details>`
      : "";
    const finalLabels = [event.snapshotName ? `Final: ${event.snapshotName}` : "", event.source || ""].filter(Boolean).map(escapeHtml).join(" · ") || "Источник не указан";
    return `<details class="timeline-card mac-timeline-item mac-timeline-${tone}"><summary title="Открыть полную информацию о событии"><span class="mac-timeline-marker" aria-hidden="true"></span><span class="mac-timeline-card"><header><time datetime="${escapeHtml(event.date || "")}">${escapeHtml(formatUtcTimelineDate(event.date))}</time>${interval}<span class="mac-event-badge">${escapeHtml(title)}</span></header><div class="mac-timeline-title"><strong>${escapeHtml(device.mac || device.hostname || "Событие")}</strong><span>${finalLabels}</span></div>${changes}</span></summary><div class="mac-timeline-details"><strong>Полная информация</strong>${finalComparison}<dl class="mac-timeline-context">${details}</dl></div></details>`;
  }).join("");
  if (pages === 1) return cards;
  return `${cards}<div class="button-row mac-timeline-pagination"><span class="muted">События ${start + 1}–${end} из ${ordered.length.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-mac-timeline-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""}>Назад</button><span class="muted">Страница ${currentPage} из ${pages}</span><button class="button secondary" type="button" data-mac-timeline-page="${currentPage + 1}" ${currentPage >= pages ? "disabled" : ""}>Дальше</button></div>`;
}

export function macTimelineSummaryContent(events = []) {
  if (!events.length) return "";
  const ordered = chronologicalMacEvents(events);
  const appearances = ordered.filter((event) => !event.historyOnly && ["first", "present", "changed", "observation"].includes(event.status));
  const sources = new Set(ordered.filter((event) => event.status !== "absent" && event.status !== "ambiguous")
    .map((event) => String(event.source || event.snapshotName || "").trim()).filter(Boolean));
  const movementCount = ordered.reduce((sum, event) => sum + (Array.isArray(event.changes) ? event.changes.length : 0), 0);
  let firstTimestamp = null;
  let lastTimestamp = null;
  for (const event of appearances) {
    const timestamp = timelineTimestamp(event.date);
    if (timestamp === null) continue;
    if (firstTimestamp === null) firstTimestamp = timestamp;
    lastTimestamp = timestamp;
  }
  const metrics = [
    ["Событий", ordered.length],
    ["Выгрузок", appearances.length],
    ["Изменений", movementCount],
    ["Источников", sources.size],
    ["Первое появление", firstTimestamp !== null ? formatUtcTimelineDate(new Date(firstTimestamp).toISOString()) : "—"],
    ["Последнее появление", lastTimestamp !== null ? formatUtcTimelineDate(new Date(lastTimestamp).toISOString()) : "—"],
  ];
  return `<div class="kpi-grid mac-timeline-summary" aria-label="Сводка истории MAC">${metrics.map(([label, value]) => `<article class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("")}</div>`;
}

export function macTimelineAppearancesContent(events = [], { page = 1, pageSize = 100 } = {}) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 100));
  let total = 0;
  for (const event of events) if (!event.historyOnly && ["first", "present", "changed", "observation"].includes(event.status)) total += 1;
  if (!total) return '<p class="empty">История появлений MAC пока пуста.</p>';
  const pages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (currentPage - 1) * size;
  const end = Math.min(total, start + size);
  const pageEvents = [];
  let appearanceIndex = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.historyOnly || !["first", "present", "changed", "observation"].includes(event.status)) continue;
    if (appearanceIndex >= start && appearanceIndex < end) pageEvents.push(event);
    appearanceIndex += 1;
  }
  const rows = pageEvents.map((event) => {
    const device = event.after || event.device || {};
    const source = event.snapshotName || event.source || "Выгрузка";
    return `<tr><td>${escapeHtml(formatUtcTimelineDate(event.date))}</td><td>${escapeHtml(source)}</td><td>${escapeHtml(device.manufacturer || device.vendor || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.ip || "—")}</td><td>${escapeHtml(device.address || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.smartroomId || "—")}</td></tr>`;
  }).join("");
  return `<p class="muted">Появления ${start + 1}–${end} из ${total.toLocaleString("ru-RU")}</p><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Дата</th><th>Выгрузка</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Адрес</th><th>Помещение</th><th>Smartroom ID</th></tr></thead><tbody>${rows}</tbody></table></div><div class="button-row"><button class="button secondary" type="button" data-mac-appearance-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""}>Назад</button><span class="muted">Страница ${currentPage} из ${pages}</span><button class="button secondary" type="button" data-mac-appearance-page="${currentPage + 1}" ${currentPage >= pages ? "disabled" : ""}>Дальше</button></div>`;
}

export function comparisonContent(comparison, { offset = 0, limit = 100, viewId = "", showMore = Boolean(viewId) } = {}) {
  const modified = Array.isArray(comparison.modified) ? comparison.modified : [];
  const ambiguousRows = Array.isArray(comparison.ambiguous) ? comparison.ambiguous : [];
  const identityConflicts = Array.isArray(comparison.identityConflicts) ? comparison.identityConflicts : [];
  const absent = Array.isArray(comparison.absent) ? comparison.absent : [];
  const total = modified.length + ambiguousRows.length + identityConflicts.length + absent.length;
  const pageSize = viewId ? Math.max(1, Math.min(100, Number(limit) || 100)) : Math.max(1, total);
  const pageOffset = Math.max(0, Math.min(total, Number(offset) || 0));
  const modifiedStart = Math.min(pageOffset, modified.length);
  const modifiedEnd = Math.min(modified.length, pageOffset + pageSize);
  const modifiedPage = modified.slice(modifiedStart, modifiedEnd);
  const ambiguousStart = Math.max(0, pageOffset - modified.length);
  const ambiguousPage = ambiguousRows.slice(ambiguousStart, Math.max(ambiguousStart, pageOffset + pageSize - modified.length));
  const identityConflictStart = Math.max(0, pageOffset - modified.length - ambiguousRows.length);
  const identityConflictPage = identityConflicts.slice(identityConflictStart, Math.max(identityConflictStart, pageOffset + pageSize - modified.length - ambiguousRows.length));
  const absentStart = Math.max(0, pageOffset - modified.length - ambiguousRows.length - identityConflicts.length);
  const absentPage = absent.slice(absentStart, Math.max(absentStart, pageOffset + pageSize - modified.length - ambiguousRows.length - identityConflicts.length));
  const changes = modifiedPage.flatMap((device) => (device.changes || []).map((change) => ({ ...change, mac: device.after?.mac, room: device.after?.room })));
  const changeTable = changes.length
    ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>MAC</th><th>Помещение</th><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>${changes.map((row) => `<tr><td>${escapeHtml(row.mac)}</td><td>${escapeHtml(row.room)}</td><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.oldValue)}</td><td>${escapeHtml(row.newValue)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const ambiguousSummary = viewId
    ? `Неоднозначные соответствия · показано ${ambiguousStart + 1}–${ambiguousStart + ambiguousPage.length} из ${ambiguousRows.length}`
    : `Неоднозначные соответствия (${ambiguousRows.length})`;
  const ambiguous = ambiguousPage.length
    ? `<details open><summary>${ambiguousSummary}</summary><ul>${ambiguousPage.map((item) => {
      const candidates = item.candidates || [];
      const identity = IDENTITY_CANDIDATE_FIELDS.slice(0, 4).map(([field]) => {
        const value = item.after?.[field];
        const normalized = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "").trim();
        return normalized.length > 300 ? `${normalized.slice(0, 300)}… (показана часть)` : normalized;
      }).filter(Boolean).join(" · ");
      return `<li><strong>${escapeHtml(identity || "Устройство")}</strong><p class="muted">Соответствие не выбрано: проверьте различия между исходной записью и кандидатами.</p>${identityCandidateComparisonMarkup(item.after, candidates) || "Кандидаты не найдены"}</li>`;
    }).join("")}</ul></details>`
    : "";
  const identityConflictSummary = viewId
    ? `Конфликты вторичных идентификаторов · показано ${identityConflictStart + 1}–${identityConflictStart + identityConflictPage.length} из ${identityConflicts.length}`
    : `Конфликты вторичных идентификаторов (${identityConflicts.length})`;
  const identityConflictMarkup = identityConflictPage.length
    ? `<details open><summary>${identityConflictSummary}</summary><ul>${identityConflictPage.map((item) => {
      const describe = (device) => [device?.id, device?.deviceId, device?.serial, device?.mac].filter(Boolean).join(" · ") || "Без сильного идентификатора";
      return `<li>${escapeHtml(describe(item.after || item.selected))} — выбран: ${escapeHtml(describe(item.selected))}; конфликтующий alias: ${escapeHtml(describe(item.alternative))}</li>`;
    }).join("")}</ul></details>`
    : "";
  const absentSummary = viewId
    ? `Отсутствующие устройства · показано ${absentStart + 1}–${absentStart + absentPage.length} из ${absent.length}`
    : `Отсутствующие устройства (${absent.length})`;
  const absentMarkup = absentPage.length
    ? `<details open><summary>${absentSummary}</summary>${deviceTable(absentPage)}</details>`
    : "";
  const nextOffset = pageOffset + pageSize;
  const more = nextOffset < total && viewId && showMore
    ? `<button class="button secondary" type="button" data-comparison-more="${escapeHtml(viewId)}" data-next-offset="${nextOffset}">Показать следующие ${Math.min(pageSize, total - nextOffset)} из ${total - nextOffset} устройств</button>`
    : "";
  const summary = total && viewId
    ? `<p class="detail-count">Изменения, отсутствующие устройства и диагностика идентичности: <strong>${total.toLocaleString("ru-RU")}</strong> · показано ${Math.min(pageOffset + pageSize, total).toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}</p>`
    : "";
  const empty = total ? "" : '<p class="empty">Подтверждённых изменений нет.</p>';
  return `<section ${viewId ? `data-comparison-page="${escapeHtml(viewId)}"` : ""}>${summary}${changeTable}${ambiguous}${identityConflictMarkup}${absentMarkup}${empty}${more}</section>`;
}

export function comparisonDiagnosticsPageContent(page) {
  const rows = Array.isArray(page?.rows) ? page.rows : [];
  const total = Math.max(0, Number(page?.total) || 0);
  const offset = Math.max(0, Number(page?.offset) || 0);
  const limit = Math.max(1, Number(page?.limit) || 100);
  const rendered = rows.map(({ type, row }) => {
    if (type === "ambiguous") {
      const candidates = row.candidates || [];
      const identity = IDENTITY_CANDIDATE_FIELDS.slice(0, 4).map(([field]) => {
        const value = row.after?.[field];
        const normalized = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "").trim();
        return normalized.length > 300 ? `${normalized.slice(0, 300)}… (показана часть)` : normalized;
      }).filter(Boolean).join(" · ");
      return `<li><strong>${escapeHtml(identity || "Устройство")}</strong><p class="muted">Соответствие не выбрано: проверьте различия между исходной записью и кандидатами.</p>${identityCandidateComparisonMarkup(row.after, candidates) || "Кандидаты не найдены"}</li>`;
    }
    const describe = (device) => [device?.id, device?.deviceId, device?.serial, device?.mac].filter(Boolean).join(" · ") || "Без сильного идентификатора";
    return `<li>${escapeHtml(describe(row.after || row.selected))} — выбран: ${escapeHtml(describe(row.selected))}; конфликтующий alias: ${escapeHtml(describe(row.alternative))}</li>`;
  }).join("");
  if (!total) return "";
  const shownEnd = Math.min(total, offset + rows.length);
  const pager = total > limit
    ? `<div class="action-row"><span class="muted">Диагностика идентичности ${offset + 1}–${shownEnd} из ${total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-comparison-diagnostic-page="${Math.max(0, offset - limit)}" ${page.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-comparison-diagnostic-page="${offset + limit}" ${page.hasNext ? "" : "disabled"}>Дальше</button></div>`
    : `<p class="muted">Диагностика идентичности: ${total.toLocaleString("ru-RU")}</p>`;
  return `<section data-comparison-diagnostics><details open><summary>Неоднозначности и конфликты идентичности · ${total.toLocaleString("ru-RU")}</summary><ul>${rendered}</ul>${pager}</details></section>`;
}
