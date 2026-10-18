import { DEFAULT_OUI_FORMATS, OUI_FORMAT_BYTES, normalizeOuiFormats, ouiBytesForMac } from "./oui-formats.js";
import { INVENTORY_DEFAULT_COLUMNS } from "./inventory-columns.js";

export const FILE_COMPARISON_COLUMNS = Object.freeze([
  { key: "status", label: "Статус" },
  { key: "mac", label: "MAC" },
  { key: "ip", label: "IP устройства" },
  { key: "switchIp", label: "IP коммутатора" },
  { key: "switchPort", label: "Порт" },
  { key: "manufacturer", label: "Производитель" },
  { key: "model", label: "Модель" },
  { key: "deviceType", label: "Тип устройства" },
  { key: "hostname", label: "Hostname" },
  { key: "serial", label: "Серийный номер" },
  { key: "deviceId", label: "Device ID" },
  { key: "room", label: "Помещение" },
  { key: "address", label: "Адрес" },
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
    room: device.room || "",
    address: device.address || "",
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

export function* fileComparisonCsvChunks(comparison, ouiFormats = DEFAULT_OUI_FORMATS) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const deviceColumns = INVENTORY_DEFAULT_COLUMNS.filter(([key]) => key !== "authenticationTime");
  const ouiColumns = fileComparisonColumns(ouiFormats).filter(({ key }) => key.startsWith("oui"));
  const columns = [
    { key: "status", label: "Статус" },
    ...deviceColumns.flatMap(([key, label]) => [
      { key: `device_${key}`, label },
      ...(key === "mac" ? ouiColumns : []),
    ]),
    { key: "changes", label: "Изменения / кандидаты" },
  ];
  const row = (status, device = {}, changes = "") => {
    const values = [status];
    for (const [key] of deviceColumns) {
      values.push(device?.[key] ?? "");
      if (key === "mac") for (const column of ouiColumns) values.push(ouiBytesForMac(device?.mac, Number(column.key.slice(3))));
    }
    values.push(changes);
    return values.map(quote).join(";");
  };
  yield `\uFEFF${columns.map(({ label }) => quote(label)).join(";")}`;
  for (const device of comparison.added) yield `\r\n${row("Добавлено", device)}`;
  for (const device of comparison.absent) yield `\r\n${row("Отсутствует", device)}`;
  for (const item of comparison.modified) yield `\r\n${row("Изменено", item.after, changeSummary(item.changes))}`;
  for (const item of comparison.unchanged) yield `\r\n${row("Без изменений", item.after)}`;
  for (const item of comparison.ambiguous) {
    const candidates = item.candidates.map((device) => device.mac || device.id).filter(Boolean).join(", ");
    yield `\r\n${row("Неоднозначно", item.after, candidates)}`;
  }
}
