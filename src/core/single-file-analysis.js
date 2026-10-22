import { csvQuote } from "./csv-cell.js";
import { hasStrongIdentity, normalizeMac, text } from "./normalize.js";
import { addIdentityToIndex, buildIdentityIndex, findIdentityMatch, stableId } from "./identity.js";
import { mergeDevice, mapRow } from "./enrichment.js";
import { compareFinals } from "./comparison.js";
import { detectMapping } from "../data/importer.js";

const FIELDS = Object.freeze([
  "id", "mac", "mac2", "ip", "switchIp", "switchPort", "authenticationTime", "hostname",
  "serial", "deviceId", "deviceName", "locationPath", "smartroomId", "businessUnit", "city",
  "site", "floor", "room", "address", "physicalAddress", "manufacturer", "model", "deviceType",
]);

export const SINGLE_FILE_FIELDS = FIELDS;
const MAX_DIAGNOSTIC_SAMPLES = 1_000;
const MAC_FIELDS = Object.freeze(["mac", "mac2"]);
const COMPARISON_DEVICE_FIELDS = new Set([...FIELDS, "alternateMacs"]);

function appendSourceRowRange(ranges, rowNumber) {
  const last = ranges.at(-1);
  if (last && last[1] + 1 === rowNumber) last[1] = rowNumber;
  else ranges.push([rowNumber, rowNumber]);
}

export function* singleFileSourceRows(device) {
  if (Array.isArray(device?.sourceRows)) {
    yield* device.sourceRows;
    return;
  }
  for (const range of device?.sourceRowRanges || []) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
    for (let row = start; row <= end; row += 1) yield row;
  }
}

export function formatSingleFileSourceRows(device) {
  if (Array.isArray(device?.sourceRows)) return device.sourceRows.join(", ");
  const formatted = [];
  for (const range of device?.sourceRowRanges || []) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [start, end] = range.map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
    formatted.push(start === end ? String(start) : `${start}–${end}`);
  }
  return formatted.join(", ");
}

export function expandSingleFileSourceRows(device) {
  const rows = [...singleFileSourceRows(device)];
  const { sourceRowRanges, ...fields } = device || {};
  return rows.length || Array.isArray(device?.sourceRows) || Array.isArray(sourceRowRanges)
    ? { ...fields, sourceRows: rows }
    : device;
}

export function hasSingleFileMappingConflicts(report) {
  return FIELDS.some((field) => report?.details?.[field]?.conflict === true);
}

function retainDiagnosticSample(diagnostics, field, value, retainSamples = true) {
  const totalKey = `${field}Total`;
  const truncatedKey = `${field}Truncated`;
  diagnostics[totalKey] = (diagnostics[totalKey] || 0) + 1;
  if (!retainSamples) return;
  if (diagnostics[field].length < MAX_DIAGNOSTIC_SAMPLES) diagnostics[field].push(value);
  else diagnostics[truncatedKey] = (diagnostics[truncatedKey] || 0) + 1;
}

export function detectSingleFileMapping(headers = [], rows = []) {
  return detectMapping(headers, rows, "single");
}

export function compactSingleFileComparisonAnalysis(result) {
  if (!result || !Array.isArray(result.devices)) return result;
  for (const device of result.devices) {
    for (const field of Object.keys(device)) if (!COMPARISON_DEVICE_FIELDS.has(field)) delete device[field];
  }
  for (const field of ["invalid", "invalidMacs", "ambiguous", "identityConflicts"]) {
    if (Array.isArray(result.diagnostics?.[field])) result.diagnostics[field].length = 0;
  }
  result.preview = result.devices.slice(0, 20);
  result.invalidPreview = [];
  result.invalidMacPreview = [];
  result.ambiguousPreview = [];
  result.identityConflictPreview = [];
  return result;
}

function createAnalyzer(headers, mapping, source, {
  retainSourceRows = true,
  retainDiagnosticSamples = true,
  compactDevices = false,
} = {}) {
  const acceptedMapping = {};
  for (const field of FIELDS) {
    const index = Number(mapping?.[field]);
    if (Number.isInteger(index) && index >= 0 && index < headers.length) acceptedMapping[field] = index;
  }
  const devices = [];
  const diagnostics = { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [], identityConflictCount: 0, duplicateRows: 0 };
  let identityIndex = buildIdentityIndex(devices);
  let nonEmptyRows = 0;
  let rowIndex = 0;
  const addRows = (rows, hasHeader = true) => {
    for (const row of rows) {
      const index = rowIndex++;
      if (!row?.some((value) => text(value))) continue;
      nonEmptyRows += 1;
      const device = mapRow(row, acceptedMapping, source);
      const rowNumber = index + (hasHeader ? 2 : 1);
      let rawMac;
      for (const field of MAC_FIELDS) {
        const value = row[acceptedMapping[field]];
        if (text(value) && !normalizeMac(value)) {
          rawMac = value;
          break;
        }
      }
      if (rawMac !== undefined) {
        retainDiagnosticSample(diagnostics, "invalidMacs", {
          row: rowNumber,
          value: text(rawMac),
          reason: "Значение MAC не соответствует допустимому формату",
          recommendation: "Проверьте адрес в источнике; MAC должен содержать 12 шестнадцатеричных цифр.",
        }, retainDiagnosticSamples);
      }
      if (!hasStrongIdentity(device)) {
        retainDiagnosticSample(diagnostics, "invalid", {
          row: rowNumber,
          rawMac: text(rawMac) || text(row[acceptedMapping.mac]),
          reason: rawMac !== undefined ? "Некорректный MAC и нет другого сильного идентификатора" : "Нет MAC, Device ID, серийного номера или внутреннего ID",
          recommendation: rawMac !== undefined ? "Исправьте MAC либо добавьте Device ID, серийный номер или внутренний ID." : "Добавьте MAC, Device ID, серийный номер или внутренний ID.",
          values: row,
        }, retainDiagnosticSamples);
        continue;
      }
      const match = findIdentityMatch(device, identityIndex);
      if (match.status === "ambiguous") {
        retainDiagnosticSample(diagnostics, "ambiguous", {
          row: rowNumber,
          device,
          candidates: match.candidates.map(({ device: candidate }) => ({
              id: candidate.id || "",
              mac: candidate.mac || "",
              deviceId: candidate.deviceId || "",
              serial: candidate.serial || "",
          })),
        }, retainDiagnosticSamples);
        continue;
      }
      if (match.status === "matched") {
        if (match.identityConflicts?.length) {
          diagnostics.identityConflictCount += match.identityConflicts.length;
          for (const conflict of match.identityConflicts) {
            if (!retainDiagnosticSamples || diagnostics.identityConflicts.length >= 1000) break;
            diagnostics.identityConflicts.push({
              row: rowNumber,
              selected: conflict.selected?.id || conflict.selected?.deviceId || conflict.selected?.serial || conflict.selected?.mac || "",
              alternative: conflict.alternative?.id || conflict.alternative?.deviceId || conflict.alternative?.serial || conflict.alternative?.mac || "",
            });
          }
        }
        mergeDevice(match.match, device, source || "Файл");
        if (retainSourceRows) {
          match.match.sourceRowRanges ||= [];
          appendSourceRowRange(match.match.sourceRowRanges, rowNumber);
        }
        diagnostics.duplicateRows += 1;
        addIdentityToIndex(identityIndex, match.match, match.position);
        continue;
      }
      device.id = device.id || stableId(device);
      if (retainSourceRows) device.sourceRowRanges = [[rowNumber, rowNumber]];
      devices.push(device);
      addIdentityToIndex(identityIndex, device, devices.length - 1);
    }
  };

  const finish = (totalRows = rowIndex) => {
    const macs = new Set();
    const fieldCounts = { manufacturer: 0, model: 0, address: 0, room: 0, switchIp: 0 };
    const rankingCounts = { manufacturer: new Map(), model: new Map(), room: new Map() };
    const countFields = Object.keys(fieldCounts);
    const rankingFields = Object.keys(rankingCounts);
    for (const device of devices) {
      if (device.mac) macs.add(device.mac);
      for (const field of countFields) if (text(device[field])) fieldCounts[field] += 1;
      for (const field of rankingFields) {
        const value = text(device[field]) || "Не указано";
        const counts = rankingCounts[field];
        counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    const top = (field) => [...rankingCounts[field].entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru", { numeric: true }))
      .slice(0, 10).map(([label, value]) => ({ label, value }));
    const summary = {
      rows: totalRows,
      nonEmptyRows,
      valid: devices.length,
      invalid: diagnostics.invalidTotal || 0,
      invalidMacs: diagnostics.invalidMacsTotal || 0,
      ambiguous: diagnostics.ambiguousTotal || 0,
      identityConflicts: diagnostics.identityConflictCount,
      duplicateRows: diagnostics.duplicateRows,
      uniqueMacs: macs.size,
      withManufacturer: fieldCounts.manufacturer,
      withModel: fieldCounts.model,
      withAddress: fieldCounts.address,
      withRoom: fieldCounts.room,
      withSwitchIp: fieldCounts.switchIp,
      manufacturers: top("manufacturer"),
      models: top("model"),
      rooms: top("room"),
      missingFields: FIELDS.filter((field) => acceptedMapping[field] === undefined),
    };
    const result = {
      source,
      mapping: acceptedMapping,
      devices,
      diagnostics,
      summary,
      preview: devices.slice(0, 20).map((device) => ({ ...device, sourceRows: formatSingleFileSourceRows(device) })),
      invalidPreview: diagnostics.invalid.slice(0, 20),
      invalidMacPreview: diagnostics.invalidMacs.slice(0, 20),
      ambiguousPreview: diagnostics.ambiguous.slice(0, 20),
      identityConflictPreview: diagnostics.identityConflicts.slice(0, 20),
    };
    return compactDevices ? compactSingleFileComparisonAnalysis(result) : result;
  };
  return { addRows, finish };
}

export function analyzeSingleFile(table, {
  mapping = detectSingleFileMapping(table?.headers, table?.rows),
  source = "",
  retainSourceRows = true,
  retainDiagnosticSamples = true,
  compactDevices = false,
} = {}) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) throw new TypeError("Ожидалась таблица с заголовками и строками");
  const analyzer = createAnalyzer(table.headers, mapping, source, { retainSourceRows, retainDiagnosticSamples, compactDevices });
  analyzer.addRows(table.rows, table.hasHeader !== false);
  return analyzer.finish(table.rows.length);
}

export async function analyzeSingleFileBatches(headers, batches, {
  mapping,
  source = "",
  totalRows,
  onProgress = () => {},
  retainSourceRows = true,
  retainDiagnosticSamples = true,
  compactDevices = false,
} = {}) {
  if (!Array.isArray(headers) || !batches?.[Symbol.asyncIterator]) throw new TypeError("Ожидались заголовки и поток пакетов строк");
  const analyzer = createAnalyzer(headers, mapping, source, { retainSourceRows, retainDiagnosticSamples, compactDevices });
  let rowsRead = 0;
  for await (const batch of batches) {
    analyzer.addRows(batch);
    rowsRead += batch.length;
    onProgress({ rowsRead, batchSize: batch.length });
  }
  return analyzer.finish(Number.isFinite(totalRows) ? totalRows : rowsRead);
}

export function compareSingleFileTables(beforeTable, afterTable, { beforeMapping, afterMapping, beforeSource = "Исходный файл", afterSource = "Новый файл" } = {}) {
  const before = analyzeSingleFile(beforeTable, { mapping: beforeMapping, source: beforeSource });
  const after = analyzeSingleFile(afterTable, { mapping: afterMapping, source: afterSource });
  return { before, after, comparison: compareFinals(before.devices, after.devices) };
}

export function countSingleFileDeviceFields(devices = []) {
  const counts = { withManufacturer: 0, withModel: 0, withAddress: 0, withRoom: 0, withSwitchIp: 0 };
  for (const device of devices) {
    if (text(device?.manufacturer)) counts.withManufacturer += 1;
    if (text(device?.model)) counts.withModel += 1;
    if (text(device?.address)) counts.withAddress += 1;
    if (text(device?.room)) counts.withRoom += 1;
    if (text(device?.switchIp)) counts.withSwitchIp += 1;
  }
  return counts;
}

export function* singleFileDevicesCsvChunks(devices = [], { bom = true } = {}) {
  const fields = [
    ["mac", "MAC"], ["ip", "IP устройства"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт"],
    ["manufacturer", "Производитель"], ["model", "Модель"], ["deviceType", "Тип"], ["hostname", "Hostname"],
    ["serial", "Серийный номер"], ["deviceId", "Device ID"], ["smartroomId", "Smartroom ID"],
    ["businessUnit", "ТБ"], ["city", "Город"], ["site", "Площадка"], ["floor", "Этаж"], ["room", "Помещение"],
    ["address", "Адрес"], ["sourceRows", "Строки источника"],
  ];
  yield `${bom ? "\uFEFF" : ""}${fields.map(([, label]) => csvQuote(label)).join(";")}`;
  for (const device of devices) {
    yield `\r\n${fields.map(([field]) => csvQuote(field === "sourceRows" ? formatSingleFileSourceRows(device) : Array.isArray(device[field]) ? device[field].join(", ") : device[field])).join(";")}`;
  }
}

export async function* singleFileDevicesCsvBatchChunks(batches, { bom = true } = {}) {
  yield singleFileDevicesCsvChunks([], { bom }).next().value;
  for await (const batch of batches || []) {
    const rows = singleFileDevicesCsvChunks(batch, { bom: false });
    rows.next();
    yield* rows;
  }
}

export function singleFileDevicesCsv(devices = []) {
  return [...singleFileDevicesCsvChunks(devices, { bom: false })].join("");
}
