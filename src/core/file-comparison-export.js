import { csvQuote } from "./csv-cell.js";
import { DEFAULT_OUI_FORMATS, OUI_FORMAT_BYTES, normalizeOuiFormats, ouiBytesForMac } from "./oui-formats.js";
import { compareFinals, createFinalComparisonEventPlan, criticalComparisonRow } from "./comparison.js";
import { streamJsonArray } from "./json-stream.js";

export const FILE_COMPARISON_COLUMNS = Object.freeze([
  { key: "status", label: "Статус" },
  { key: "mac", label: "MAC" },
  { key: "ip", label: "IP-адрес" },
  { key: "switchIp", label: "IP коммутатора" },
  { key: "switchPort", label: "Порт" },
  { key: "manufacturer", label: "Производитель" },
  { key: "model", label: "Модель" },
  { key: "deviceType", label: "Тип устройства" },
  { key: "hostname", label: "Hostname" },
  { key: "serial", label: "Серийный номер" },
  { key: "deviceId", label: "Device ID" },
  { key: "smartroomId", label: "Smartroom ID" },
  { key: "room", label: "Помещение" },
  { key: "address", label: "Адрес" },
  { key: "authenticationTime", label: "Время аутентификации" },
  { key: "changes", label: "Изменения / кандидаты" },
]);

export function fileComparisonColumns(ouiFormats = DEFAULT_OUI_FORMATS) {
  const formats = normalizeOuiFormats(ouiFormats);
  const ouiColumns = OUI_FORMAT_BYTES.filter((bytes) => formats[bytes]).map((bytes) => ({ key: `oui${bytes}`, label: `OUI (${bytes} ${bytes === 3 ? "байта" : "байт"})` }));
  const columns = [...FILE_COMPARISON_COLUMNS];
  const macIndex = columns.findIndex(({ key }) => key === "mac");
  columns.splice(macIndex + 1, 0, ...ouiColumns);
  return columns;
}

function changeSummary(changes = []) {
  return changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; ");
}

function asRow(status, device = {}, changes = "", ouiFormats = DEFAULT_OUI_FORMATS) {
  const row = {
    status,
    mac: device.mac || "",
    ip: device.ip || "",
    switchIp: device.switchIp || "",
    switchPort: device.switchPort || "",
    manufacturer: device.manufacturer || "",
    model: device.model || "",
    deviceType: device.deviceType || "",
    hostname: device.hostname || "",
    serial: device.serial || "",
    deviceId: device.deviceId || "",
    smartroomId: device.smartroomId || "",
    room: device.room || "",
    address: device.address || "",
    authenticationTime: device.authenticationTime || "",
    changes,
  };
  const formats = normalizeOuiFormats(ouiFormats);
  for (const bytes of OUI_FORMAT_BYTES) if (formats[bytes]) row[`oui${bytes}`] = ouiBytesForMac(device.mac, bytes);
  return row;
}

export function* fileComparisonExportRows(comparison, ouiFormats = DEFAULT_OUI_FORMATS) {
  for (const device of comparison.added) yield asRow("Добавлено", device, "", ouiFormats);
  for (const device of comparison.absent) yield asRow("Отсутствует", device, "", ouiFormats);
  for (const item of comparison.modified) yield asRow("Изменено", item.after, changeSummary(item.changes), ouiFormats);
  for (const item of comparison.unchanged) yield asRow("Без изменений", item.after, "", ouiFormats);
  for (const item of comparison.ambiguous) {
    const candidates = item.candidates.map((device) => device.mac || device.deviceId || device.serial || device.id).filter(Boolean).join(", ");
    yield asRow("Неоднозначно", item.after, candidates, ouiFormats);
  }
}

function* fileComparisonEventsFromResult(comparison) {
  for (const device of comparison.added) yield { type: "added", device };
  for (const device of comparison.absent) yield { type: "absent", device };
  for (const row of comparison.modified) yield { type: "modified", row };
  for (const row of comparison.unchanged) yield { type: "unchanged", row };
  for (const item of comparison.ambiguous) yield { type: "ambiguous", item };
}

function* fileComparisonEventsFromDevices(previous, current, timestamp) {
  const plan = createFinalComparisonEventPlan(previous, current, timestamp);
  for (const type of ["added", "absent", "modified", "unchanged", "ambiguous"]) yield* plan.events(type);
}

function* fileComparisonRowsFromEvents(events, ouiFormats) {
  for (const event of events) {
    if (event.type === "added" || event.type === "absent") {
      yield asRow(event.type === "added" ? "Добавлено" : "Отсутствует", event.device, "", ouiFormats);
    } else if (event.type === "modified") {
      yield asRow("Изменено", event.row.after, changeSummary(event.row.changes), ouiFormats);
    } else if (event.type === "unchanged") {
      yield asRow("Без изменений", event.row.after, "", ouiFormats);
    } else if (event.type === "ambiguous") {
      const candidates = event.item.candidates.map((device) => device.mac || device.deviceId || device.serial || device.id).filter(Boolean).join(", ");
      yield asRow("Неоднозначно", event.item.after, candidates, ouiFormats);
    }
  }
}

export function* fileComparisonExportRowsFromDevices(previous, current, timestamp, ouiFormats = DEFAULT_OUI_FORMATS) {
  yield* fileComparisonRowsFromEvents(fileComparisonEventsFromDevices(previous, current, timestamp), ouiFormats);
}

export function fileComparisonJsonFromDevices(before, after, comparison) {
  const plan = createFinalComparisonEventPlan(before, after, comparison.timestamp);
  const devices = (type) => (function* () { for (const event of plan.events(type)) yield event.type === "added" || event.type === "absent" ? event.device : event.row; })();
  const ambiguous = (function* () { for (const event of plan.events("ambiguous")) yield event.item; })();
  const details = (function* () { yield* plan.critical(); })();
  const identityConflicts = (function* () { yield* plan.identityConflicts(); })();
  return {
    added: streamJsonArray(devices("added")),
    absent: streamJsonArray(devices("absent")),
    modified: streamJsonArray(devices("modified")),
    unchanged: streamJsonArray(devices("unchanged")),
    ambiguous: streamJsonArray(ambiguous),
    unchangedCount: plan.unchangedCount,
    addedCount: plan.addedCount,
    absentCount: plan.absentCount,
    modifiedDeviceCount: plan.modifiedDeviceCount,
    ambiguousCount: plan.ambiguousCount,
    identityConflictCount: plan.identityConflictCount,
    critical: streamJsonArray(details),
    identityConflicts: streamJsonArray(identityConflicts),
    timestamp: plan.timestamp,
  };
}

export function fileComparisonRowsPage(comparison, { statuses = ["Добавлено", "Отсутствует", "Изменено"], offset = 0, limit = 100, ouiFormats = DEFAULT_OUI_FORMATS } = {}) {
  const requestedLimit = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 100)));
  const segments = [
    ["Добавлено", comparison.added, (device) => asRow("Добавлено", device, "", ouiFormats)],
    ["Отсутствует", comparison.absent, (device) => asRow("Отсутствует", device, "", ouiFormats)],
    ["Изменено", comparison.modified, (item) => asRow("Изменено", item.after, changeSummary(item.changes), ouiFormats)],
    ["Без изменений", comparison.unchanged, (item) => asRow("Без изменений", item.after, "", ouiFormats)],
    ["Неоднозначно", comparison.ambiguous, (item) => asRow("Неоднозначно", item.after, item.candidates.map((device) => device.mac || device.deviceId || device.serial || device.id).filter(Boolean).join(", "), ouiFormats)],
  ].filter(([status]) => statuses.includes(status));
  const total = segments.reduce((count, [, rows]) => count + rows.length, 0);
  const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageOffset = Math.min(Math.floor(Math.max(total - 1, 0) / requestedLimit) * requestedLimit, Math.floor(requestedOffset / requestedLimit) * requestedLimit);
  const result = [];
  let skipped = pageOffset;
  for (const [, source, createRow] of segments) {
    if (skipped >= source.length) {
      skipped -= source.length;
      continue;
    }
    for (let index = skipped; index < source.length && result.length < requestedLimit; index += 1) result.push(createRow(source[index]));
    skipped = 0;
    if (result.length >= requestedLimit) break;
  }
  return {
    rows: result,
    total,
    offset: pageOffset,
    limit: requestedLimit,
    hasPrevious: pageOffset > 0,
    hasNext: pageOffset + result.length < total,
  };
}

/** Compare complete source rosters while retaining only the requested display page. */
export function fileComparisonRowsPagesFromDevices(previous, current, comparison, requests, { ouiFormats = DEFAULT_OUI_FORMATS } = {}) {
  const counts = new Map([
    ["Добавлено", comparison.addedCount ?? comparison.added.length],
    ["Отсутствует", comparison.absentCount ?? comparison.absent.length],
    ["Изменено", comparison.modifiedDeviceCount ?? comparison.modified.length],
    ["Без изменений", comparison.unchangedCount ?? comparison.unchanged.length],
    ["Неоднозначно", comparison.ambiguousCount ?? comparison.ambiguous.length],
  ]);
  const pages = requests.map(({ key, statuses = ["Добавлено", "Отсутствует", "Изменено"], offset = 0, limit = 100 }) => {
    const requestedLimit = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 100)));
    const segments = [...counts].filter(([status]) => statuses.includes(status));
    const total = segments.reduce((sum, [, count]) => sum + count, 0);
    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const pageOffset = Math.min(Math.floor(Math.max(total - 1, 0) / requestedLimit) * requestedLimit, Math.floor(requestedOffset / requestedLimit) * requestedLimit);
    const segmentStarts = new Map();
    let cursor = 0;
    for (const [status, count] of segments) {
      segmentStarts.set(status, cursor);
      cursor += count;
    }
    return { key, total, offset: pageOffset, limit: requestedLimit, end: pageOffset + requestedLimit, segmentStarts, rows: [] };
  });
  const visited = new Map([...counts.keys()].map((status) => [status, 0]));
  const collect = (status, device, changes = "") => {
    const index = visited.get(status) || 0;
    visited.set(status, index + 1);
    for (const page of pages) {
      if (!page.segmentStarts.has(status)) continue;
      const pageIndex = page.segmentStarts.get(status) + index;
      if (pageIndex >= page.offset && pageIndex < page.end) page.rows.push(asRow(status, device, changes, ouiFormats));
    }
  };
  compareFinals(previous, current, comparison.timestamp, {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
    onAdded: (device) => collect("Добавлено", device),
    onAbsent: (device) => collect("Отсутствует", device),
    onModified: (item) => collect("Изменено", item.after, changeSummary(item.changes)),
    onUnchanged: (item) => collect("Без изменений", item.after),
    onAmbiguous: (item) => {
      const candidates = item.candidates.map((device) => device.mac || device.deviceId || device.serial || device.id).filter(Boolean).join(", ");
      collect("Неоднозначно", item.after, candidates);
    },
  });
  return Object.fromEntries(pages.map(({ key, total, offset, limit, rows }) => [key, {
    rows,
    total,
    offset,
    limit,
    hasPrevious: offset > 0,
    hasNext: offset + rows.length < total,
  }]));
}

export function fileComparisonRowsPageFromDevices(previous, current, comparison, options = {}) {
  const { statuses, offset, limit, ouiFormats } = options;
  return fileComparisonRowsPagesFromDevices(previous, current, comparison, [{
    key: "page",
    ...(statuses ? { statuses } : {}),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  }], { ouiFormats })["page"];
}

function stagedFileComparisonSegments(plan) {
  return [
    ["Добавлено", "added", plan.addedCount, (event, ouiFormats) => asRow("Добавлено", event.device, "", ouiFormats)],
    ["Отсутствует", "absent", plan.absentCount, (event, ouiFormats) => asRow("Отсутствует", event.device, "", ouiFormats)],
    ["Изменено", "modified", plan.modifiedDeviceCount, (event, ouiFormats) => asRow("Изменено", event.row.after, changeSummary(event.row.changes), ouiFormats)],
    ["Без изменений", "unchanged", plan.unchangedCount, (event, ouiFormats) => asRow("Без изменений", event.row.after, "", ouiFormats)],
    ["Неоднозначно", "ambiguous", plan.ambiguousCount, (event, ouiFormats) => asRow("Неоднозначно", event.item.after,
      event.item.candidates.map((device) => device.mac || device.deviceId || device.serial || device.id).filter(Boolean).join(", "), ouiFormats)],
  ];
}

export async function fileComparisonRowsPagesFromPlan(plan, requests, { ouiFormats = DEFAULT_OUI_FORMATS } = {}) {
  if (typeof plan?.eventsPage !== "function") throw new TypeError("Для постраничного вывода нужен потоковый план сравнения");
  const pages = requests.map(({ key, statuses = ["Добавлено", "Отсутствует", "Изменено"], offset = 0, limit = 100 }) => {
    const requestedLimit = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 100)));
    const segments = stagedFileComparisonSegments(plan).filter(([status]) => statuses.includes(status));
    const total = segments.reduce((sum, [, , count]) => sum + count, 0);
    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const pageOffset = Math.min(Math.floor(Math.max(total - 1, 0) / requestedLimit) * requestedLimit, Math.floor(requestedOffset / requestedLimit) * requestedLimit);
    return { key, segments, total, offset: pageOffset, limit: requestedLimit, rows: [] };
  });
  for (const page of pages) {
    let skipped = page.offset;
    for (const [, type, count, createRow] of page.segments) {
      if (skipped >= count) { skipped -= count; continue; }
      const events = await plan.eventsPage(type, { offset: skipped, limit: page.limit - page.rows.length });
      for (const event of events) page.rows.push(createRow(event, ouiFormats));
      skipped = 0;
      if (page.rows.length >= page.limit) break;
    }
  }
  return Object.fromEntries(pages.map(({ key, rows, total, offset, limit }) => [key, {
    rows, total, offset, limit, hasPrevious: offset > 0, hasNext: offset + rows.length < total,
  }]));
}

export async function* fileComparisonExportRowsFromPlan(plan, ouiFormats = DEFAULT_OUI_FORMATS, { batchSize = 500 } = {}) {
  if (typeof plan?.eventsPage !== "function") throw new TypeError("Для экспорта нужен потоковый план сравнения");
  const size = Math.max(1, Math.min(1_000, Math.floor(Number(batchSize) || 500)));
  for (const [, type, count, createRow] of stagedFileComparisonSegments(plan)) {
    for (let offset = 0; offset < count; offset += size) {
      const events = await plan.eventsPage(type, { offset, limit: Math.min(size, count - offset) });
      for (const event of events) yield createRow(event, ouiFormats);
    }
  }
}

export function fileComparisonJsonFromPlan(plan, { signal, batchSize = 500 } = {}) {
  if (typeof plan?.eventsPage !== "function") throw new TypeError("Для JSON-экспорта нужен потоковый план сравнения");
  const size = Math.max(1, Math.min(1_000, Math.floor(Number(batchSize) || 500)));
  const counts = {
    added: plan.addedCount,
    absent: plan.absentCount,
    modified: plan.modifiedDeviceCount,
    unchanged: plan.unchangedCount,
    ambiguous: plan.ambiguousCount,
  };
  const rows = (type, select = (event) => event) => (async function* () {
    for (let offset = 0; offset < counts[type]; offset += size) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const events = await plan.eventsPage(type, { offset, limit: Math.min(size, counts[type] - offset), signal });
      for (const event of events) yield select(event);
    }
  }());
  const critical = (async function* () {
    for await (const event of rows("modified")) {
      const row = criticalComparisonRow(event.row);
      if (row) yield row;
    }
  }());
  const identityConflicts = (async function* () {
    for await (const event of rows("ambiguous")) yield* event.identityConflicts || [];
  }());
  return {
    added: streamJsonArray(rows("added", (event) => event.device)),
    absent: streamJsonArray(rows("absent", (event) => event.device)),
    modified: streamJsonArray(rows("modified", (event) => event.row)),
    unchanged: streamJsonArray(rows("unchanged", (event) => event.row)),
    ambiguous: streamJsonArray(rows("ambiguous", (event) => event.item)),
    unchangedCount: counts.unchanged,
    addedCount: counts.added,
    absentCount: counts.absent,
    modifiedDeviceCount: counts.modified,
    ambiguousCount: counts.ambiguous,
    identityConflictCount: plan.identityConflictCount,
    critical: streamJsonArray(critical),
    identityConflicts: streamJsonArray(identityConflicts),
    timestamp: plan.timestamp,
  };
}

export async function* fileComparisonCsvChunksFromPlan(plan, ouiFormats = DEFAULT_OUI_FORMATS, { batchSize = 500 } = {}) {
  if (typeof plan?.eventsPage !== "function") throw new TypeError("Для CSV-экспорта нужен потоковый план сравнения");
  const columns = fileComparisonColumns(ouiFormats);
  const csvRow = (status, device = {}, changes = "") => columns.map(({ key }) => {
    if (key === "status") return status;
    if (key === "changes") return changes;
    if (key.startsWith("oui")) return ouiBytesForMac(device?.mac, Number(key.slice(3)));
    return device?.[key] ?? "";
  }).map(csvQuote).join(";");
  const size = Math.max(1, Math.min(1_000, Math.floor(Number(batchSize) || 500)));
  yield `\uFEFF${columns.map(({ label }) => csvQuote(label)).join(";")}`;
  for (const [, type, count] of stagedFileComparisonSegments(plan)) {
    for (let offset = 0; offset < count; offset += size) {
      const events = await plan.eventsPage(type, { offset, limit: Math.min(size, count - offset) });
      for (const event of events) {
        if (type === "added" || type === "absent") {
          yield `\r\n${csvRow(type === "added" ? "Добавлено" : "Отсутствует", event.device)}`;
        } else if (type === "modified") {
          yield `\r\n${csvRow("Изменено", event.row.after, changeSummary(event.row.changes))}`;
        } else if (type === "unchanged") {
          yield `\r\n${csvRow("Без изменений", event.row.after)}`;
        } else {
          const candidates = event.item.candidates.map((device) => device.mac || device.id).filter(Boolean).join(", ");
          yield `\r\n${csvRow("Неоднозначно", event.item.after, candidates)}`;
        }
      }
    }
  }
}

export function* fileComparisonCsvChunks(comparison, ouiFormats = DEFAULT_OUI_FORMATS) {
  yield* fileComparisonCsvChunksFromEvents(fileComparisonEventsFromResult(comparison), ouiFormats);
}

export function* fileComparisonCsvChunksFromDevices(previous, current, timestamp, ouiFormats = DEFAULT_OUI_FORMATS) {
  yield* fileComparisonCsvChunksFromEvents(fileComparisonEventsFromDevices(previous, current, timestamp), ouiFormats);
}

function* fileComparisonCsvChunksFromEvents(events, ouiFormats) {
  const columns = fileComparisonColumns(ouiFormats);
  const row = (status, device = {}, changes = "") => {
    const values = columns.map(({ key }) => {
      if (key === "status") return status;
      if (key === "changes") return changes;
      if (key.startsWith("oui")) return ouiBytesForMac(device?.mac, Number(key.slice(3)));
      return device?.[key] ?? "";
    });
    return values.map(csvQuote).join(";");
  };
  yield `\uFEFF${columns.map(({ label }) => csvQuote(label)).join(";")}`;
  for (const event of events) {
    if (event.type === "added" || event.type === "absent") {
      yield `\r\n${row(event.type === "added" ? "Добавлено" : "Отсутствует", event.device)}`;
    } else if (event.type === "modified") {
      yield `\r\n${row("Изменено", event.row.after, changeSummary(event.row.changes))}`;
    } else if (event.type === "unchanged") {
      yield `\r\n${row("Без изменений", event.row.after)}`;
    } else if (event.type === "ambiguous") {
      const candidates = event.item.candidates.map((device) => device.mac || device.id).filter(Boolean).join(", ");
      yield `\r\n${row("Неоднозначно", event.item.after, candidates)}`;
    }
  }
}
