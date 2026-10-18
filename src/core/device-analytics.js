import { buildIdentityIndex, findIdentityMatch } from "./identity.js";

const FIELDS = Object.freeze([
  ["mac", "MAC-адрес", "macFormatted", "mac_formatted"],
  ["vendor", "Производитель", "manufacturer"],
  ["model", "Модель"],
  ["ip", "IP-адрес"],
  ["address", "Физический адрес", "physicalAddress"],
  ["room", "Помещение"],
  ["smartroomId", "Smartroom ID", "smartroom_id"],
  ["switchIp", "Коммутатор", "switch_ip"],
  ["switchPort", "Порт", "switch_port"],
  ["hostname", "Hostname"],
  ["serial", "Серийный номер"],
  ["deviceId", "Device ID"],
  ["possibleIps", "Возможные IP (DDIO)"],
  ["observationCount", "Наблюдений в Final"],
]);

function value(device, keys, fallback) {
  for (const key of keys) {
    const item = device?.[key];
    if (Array.isArray(item) && item.length) return item.map((entry) => String(entry ?? "").trim()).filter(Boolean).join(", ") || fallback;
    if ((typeof item === "string" || typeof item === "number") && String(item).trim()) return String(item).trim();
  }
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function timestamp(row) {
  const date = row?.createdAt || row?.timestamp || "";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? String(date || "Без даты") : parsed.toLocaleString("ru-RU");
}

export function buildDeviceAnalytics(device = {}, appearances = [], history = [], historyPage = {}) {
  const rows = [...(Array.isArray(appearances) ? appearances : [])]
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
  const changes = [...(Array.isArray(history) ? history : [])]
    .sort((left, right) => String(left.timestamp || left.createdAt || "").localeCompare(String(right.timestamp || right.createdAt || "")));
  const manufacturerSource = value(device, ["vendorSource", "vendor_source"], device.fieldSources?.manufacturer || "Неизвестен");
  const modelSource = value(device, ["modelSource", "model_source"], device.fieldSources?.model || "Неизвестен");
  const sourceWithConfidence = (source, rawConfidence) => {
    const parsed = Number(rawConfidence);
    return Number.isFinite(parsed) && parsed > 0 ? `${source} (${Math.round(Math.max(0, Math.min(1, parsed)) * 100)}%)` : source;
  };
  const conflicts = Array.isArray(device.conflicts) ? device.conflicts : [];
  const notes = value(device, ["matchDetails", "match_details"], conflicts.map((item) => `${item?.field || "Поле"}: ${item?.value || "значение"} (${item?.source || "источник неизвестен"})`).join("; ") || "Нет");
  const sources = Array.isArray(device.sources) ? device.sources.filter((item) => typeof item === "string" || typeof item === "number") : [];
  const appearanceSources = new Set(rows.map((row) => String(row.source || row.name || "").trim()).filter(Boolean));
  const reportText = [
    "=== ДЕТАЛЬНАЯ ИНФОРМАЦИЯ ОБ УСТРОЙСТВЕ ===", "",
    ...FIELDS.map(([field, label, ...aliases]) => `${label}: ${value(device, [field, ...aliases], field === "vendor" ? "Unknown" : field === "model" ? "Не указана" : "Не указан")}`),
    ...(device.possibleIpsTruncated ? ["Возможные IP (DDIO): список сокращён"] : []),
    "", "Источники данных:", `  Производитель: ${sourceWithConfidence(manufacturerSource, device.vendorConfidence ?? device.vendor_confidence)}`, `  Модель: ${sourceWithConfidence(modelSource, device.modelConfidence ?? device.model_confidence)}`,
    `  Все источники: ${sources.join(", ") || "Не указаны"}`,
    "", `Появлений в Final: ${rows.length}`, `Файлов появлений: ${appearanceSources.size}`, `Исторических событий: ${Number(historyPage.total ?? changes.length).toLocaleString("ru-RU")}`,
    `Первое появление: ${rows[0] ? timestamp(rows[0]) : "Нет"}`,
    `Последнее появление: ${rows.at(-1) ? timestamp(rows.at(-1)) : "Нет"}`,
    "", `Примечания: ${notes}`,
  ].join("\n");
  return {
    device,
    appearances: rows,
    history: changes,
    historyTotal: Number(historyPage.total ?? changes.length),
    historyHasMore: Boolean(historyPage.hasMore),
    historyCursor: historyPage.nextCursor || null,
    reportText,
  };
}

export function deviceAnalyticsHistoryStats(payload) {
  const appearances = payload?.appearances || [];
  const sources = new Set(appearances.map((row) => String(row.source || row.name || "").trim()).filter(Boolean));
  return {
    appearances: appearances.length,
    files: sources.size,
    firstSeen: appearances[0] ? timestamp(appearances[0]) : "Нет",
    lastSeen: appearances.at(-1) ? timestamp(appearances.at(-1)) : "Нет",
  };
}

export function deviceAnalyticsTxt(payload, createdAt = new Date()) {
  const item = payload || buildDeviceAnalytics();
  const created = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || "");
  return `\uFEFF${"=".repeat(60)}\nАНАЛИТИКА УСТРОЙСТВА\nДата: ${created}\n${"=".repeat(60)}\n\n${item.reportText || "Нет данных"}\n`;
}

export function sharesStrongDeviceIdentity(target, candidate) {
  return findIdentityMatch(target, buildIdentityIndex([candidate])).status === "matched";
}

export function resolveDeviceAppearance(target, candidates = [], candidateCount = candidates.length) {
  if (!candidateCount) return { status: "absent", device: null, candidates: [] };
  if (candidateCount !== 1 || candidates.length !== 1) return { status: "ambiguous", device: null, candidates };
  const result = findIdentityMatch(target, buildIdentityIndex(candidates));
  if (result.status !== "matched") return { status: "ambiguous", device: null, candidates: result.candidates.map((item) => item.device) };
  return { status: "matched", device: result.match, candidates: [] };
}

export function deviceAnalyticsHtml(payload) {
  const item = payload || buildDeviceAnalytics();
  const appearances = item.appearances.map((row) => {
    const device = row.device || {};
    return `<tr><td>${escapeHtml(timestamp(row))}</td><td>${escapeHtml(row.source || row.name || row.id || "Final")}</td><td>${escapeHtml(device.manufacturer || device.vendor || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.ip || "—")}</td><td>${escapeHtml(device.address || device.physicalAddress || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.smartroomId || "—")}</td></tr>`;
  }).join("");
  const history = deviceAnalyticsHtmlHistoryRows(item.history);
  const stats = deviceAnalyticsHistoryStats(item);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Аналитика устройства</title><style>body{font:14px Arial,sans-serif;margin:32px;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:18px;border-radius:8px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef2f7}h1,h2{color:#0f766e}</style></head><body><h1>Аналитика устройства</h1><pre>${escapeHtml(item.reportText)}</pre><h2>История появлений</h2><p>Появлений: ${stats.appearances} · файлов: ${stats.files} · первое: ${escapeHtml(stats.firstSeen)} · последнее: ${escapeHtml(stats.lastSeen)}</p><table><thead><tr><th>Дата</th><th>Файл</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Адрес</th><th>Помещение</th><th>Smartroom ID</th></tr></thead><tbody>${appearances || '<tr><td colspan="8">История появлений MAC пока пуста.</td></tr>'}</tbody></table><h2>Изменения параметров (${Number(item.historyTotal ?? item.history.length).toLocaleString("ru-RU")})</h2><table><thead><tr><th>Дата</th><th>Поле</th><th>Было</th><th>Стало</th><th>Файл и устройство</th></tr></thead><tbody>${history || '<tr><td colspan="5">Изменения параметров MAC пока отсутствуют.</td></tr>'}</tbody></table></body></html>`;
}

export function deviceAnalyticsHtmlHeader(payload) {
  const item = payload || buildDeviceAnalytics();
  const appearances = item.appearances.map((row) => {
    const device = row.device || {};
    return `<tr><td>${escapeHtml(timestamp(row))}</td><td>${escapeHtml(row.source || row.name || row.id || "Final")}</td><td>${escapeHtml(device.manufacturer || device.vendor || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.ip || "—")}</td><td>${escapeHtml(device.address || device.physicalAddress || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.smartroomId || "—")}</td></tr>`;
  }).join("");
  const stats = deviceAnalyticsHistoryStats(item);
  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Аналитика устройства</title><style>body{font:14px Arial,sans-serif;margin:32px;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:18px;border-radius:8px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef2f7}h1,h2{color:#0f766e}</style></head><body><h1>Аналитика устройства</h1><pre>',
    escapeHtml(item.reportText),
    '</pre><h2>История появлений</h2><p>Появлений: ' + stats.appearances + ' · файлов: ' + stats.files + ' · первое: ' + escapeHtml(stats.firstSeen) + ' · последнее: ' + escapeHtml(stats.lastSeen) + '</p><table><thead><tr><th>Дата</th><th>Файл</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Адрес</th><th>Помещение</th><th>Smartroom ID</th></tr></thead><tbody>',
    appearances || '<tr><td colspan="8">История появлений MAC пока пуста.</td></tr>',
    '</tbody></table><h2>Изменения параметров (' + Number(item.historyTotal ?? item.history.length).toLocaleString("ru-RU") + ')</h2><table><thead><tr><th>Дата</th><th>Поле</th><th>Было</th><th>Стало</th><th>Файл и устройство</th></tr></thead><tbody>',
  ].join("");
}

export function deviceAnalyticsHtmlHistoryRows(events = []) {
  return events.map((row) => {
    const device = row.device || {};
    const field = row.label || row.field || (row.type === "added" ? "Появление" : row.type === "absent" ? "Отсутствие" : "—");
    const context = [
      row.source || "—",
      `Производитель: ${device.manufacturer || device.vendor || "—"}`,
      `Модель: ${device.model || "—"}`,
      `Адрес: ${device.address || device.physicalAddress || "—"}`,
      `Помещение: ${device.room || "—"}`,
    ].map(escapeHtml).join("<br>");
    return '<tr><td>' + escapeHtml(timestamp(row)) + '</td><td>' + escapeHtml(field) + '</td><td>'
      + escapeHtml(row.oldValue ?? row.before ?? "—") + '</td><td>'
      + escapeHtml(row.newValue ?? row.after ?? "—") + '</td><td>' + context + '</td></tr>';
  }).join("");
}

export function deviceAnalyticsHtmlFooter() {
  return '</tbody></table></body></html>';
}

export function deviceAnalyticsContent(payload) {
  const item = payload || buildDeviceAnalytics();
  const escape = escapeHtml;
  const appearances = item.appearances.map((row) => {
    const observed = row.device || {};
    return `<tr><td>${escape(timestamp(row))}</td><td>${escape(row.source || row.name || row.id || "Final")}</td><td>${escape(observed.manufacturer || observed.vendor || "—")}</td><td>${escape(observed.model || "—")}</td><td>${escape(observed.ip || "—")}</td><td>${escape(observed.address || observed.physicalAddress || "—")}</td><td>${escape(observed.room || "—")}</td><td>${escape(observed.smartroomId || "—")}</td></tr>`;
  }).join("");
  const history = deviceAnalyticsHtmlHistoryRows(item.history);
  const total = Number(item.historyTotal ?? item.history.length);
  const stats = deviceAnalyticsHistoryStats(item);
  const statsHtml = `<div class="kpi-grid"><article class="kpi"><span>Появлений</span><strong>${stats.appearances}</strong></article><article class="kpi"><span>Файлов</span><strong>${stats.files}</strong></article><article class="kpi"><span>Первое появление</span><strong>${escape(stats.firstSeen)}</strong></article><article class="kpi"><span>Последнее появление</span><strong>${escape(stats.lastSeen)}</strong></article></div>`;
  const showMore = item.historyHasMore
    ? '<button class="button secondary" type="button" data-load-device-history>Показать следующие 100 событий</button>'
    : "";
  const deleteHistory = item.device?.id && total > 0
    ? `<button class="button secondary danger" type="button" data-delete-device-history>Удалить ${total.toLocaleString("ru-RU")} событий истории устройства</button>`
    : "";
  return `<div class="action-row"><button class="button secondary" type="button" data-export-device-analytics-txt>Экспорт TXT</button><button class="button secondary" type="button" data-export-device-analytics>Экспорт HTML</button><button class="button secondary" type="button" data-export-device-analytics-xlsx>Экспорт XLSX</button><button class="button secondary" type="button" data-open-device-timeline>Открыть хронологию MAC</button>${deleteHistory}</div><p class="muted">Удаление затрагивает только журнал событий; снимки Final, записи Inventory и появления по снимкам сохраняются.</p><pre class="report-preview">${escape(item.reportText)}</pre><h3>История появлений</h3>${statsHtml}<div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>Файл</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Адрес</th><th>Помещение</th><th>Smartroom ID</th></tr></thead><tbody>${appearances || '<tr><td colspan="8">История появлений MAC пока пуста.</td></tr>'}</tbody></table></div><h3>Изменения параметров (${total.toLocaleString("ru-RU")}) · показано ${item.history.length.toLocaleString("ru-RU")}</h3><div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>Поле</th><th>Было</th><th>Стало</th><th>Файл и устройство</th></tr></thead><tbody>${history || '<tr><td colspan="5">Исторических изменений MAC пока нет.</td></tr>'}</tbody></table></div>${showMore}`;
}

export function deviceAnalyticsXlsxSheets(payload, historyEvents) {
  const item = payload || buildDeviceAnalytics();
  const device = item.device || {};
  const appearances = (async function* appearanceRows() {
    for (const row of item.appearances) {
      const observed = row.device || {};
      yield [
        row.createdAt || "", row.source || row.name || row.id || "Final", observed.manufacturer || observed.vendor || "",
        observed.model || "", observed.ip || "", observed.address || observed.physicalAddress || "",
        observed.room || "", observed.smartroomId || "",
      ];
    }
  }());
  const changes = (async function* changeRows() {
    for await (const event of historyEvents || []) {
      yield [
        event.timestamp || event.createdAt || "", event.label || event.field || (event.type === "added" ? "Появление" : event.type === "absent" ? "Отсутствие" : ""),
        event.oldValue ?? event.before ?? "", event.newValue ?? event.after ?? "", event.source || "",
        device.mac || "", device.manufacturer || device.vendor || "", device.model || "",
        device.address || device.physicalAddress || "", device.room || "",
      ];
    }
  }());
  return [
    { name: "Появления", headings: ["Дата", "Файл", "Производитель", "Модель", "IP", "Адрес", "Помещение", "Smartroom ID"], rows: appearances },
    { name: "Изменения", headings: ["Дата", "Поле", "Было", "Стало", "Файл", "MAC", "Производитель", "Модель", "Адрес", "Помещение"], rows: changes },
  ];
}
