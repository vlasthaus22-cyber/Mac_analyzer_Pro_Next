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
          match.match.sourceRows ||= [];
          match.match.sourceRows.push(rowNumber);
        }
        diagnostics.duplicateRows += 1;
        addIdentityToIndex(identityIndex, match.match, match.position);
        continue;
      }
      device.id = device.id || stableId(device);
      if (retainSourceRows) device.sourceRows = [rowNumber];
      devices.push(device);
      addIdentityToIndex(identityIndex, device, devices.length - 1);
    }
  };

  const count = (field) => {
    let total = 0;
    for (const device of devices) if (text(device[field])) total += 1;
    return total;
  };
  const uniqueMacCount = () => {
    const macs = new Set();
    for (const device of devices) if (device.mac) macs.add(device.mac);
    return macs.size;
  };
  const top = (field) => {
    const counts = new Map();
    for (const device of devices) {
      const value = text(device[field]) || "Не указано";
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru", { numeric: true }))
      .slice(0, 10).map(([label, value]) => ({ label, value }));
  };
  const finish = (totalRows = rowIndex) => {
    const summary = {
      rows: totalRows,
      nonEmptyRows,
      valid: devices.length,
      invalid: diagnostics.invalidTotal || 0,
      invalidMacs: diagnostics.invalidMacsTotal || 0,
      ambiguous: diagnostics.ambiguousTotal || 0,
      identityConflicts: diagnostics.identityConflictCount,
      duplicateRows: diagnostics.duplicateRows,
      uniqueMacs: uniqueMacCount(),
      withManufacturer: count("manufacturer"),
      withModel: count("model"),
      withAddress: count("address"),
      withRoom: count("room"),
      withSwitchIp: count("switchIp"),
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
      preview: devices.slice(0, 20),
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

export function singleFileDevicesCsv(devices = []) {
  const fields = [
    ["mac", "MAC"], ["ip", "IP устройства"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт"],
    ["manufacturer", "Производитель"], ["model", "Модель"], ["deviceType", "Тип"], ["hostname", "Hostname"],
    ["serial", "Серийный номер"], ["deviceId", "Device ID"], ["smartroomId", "Smartroom ID"],
    ["businessUnit", "ТБ"], ["city", "Город"], ["site", "Площадка"], ["floor", "Этаж"], ["room", "Помещение"],
    ["address", "Адрес"], ["sourceRows", "Строки источника"],
  ];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [fields.map(([, label]) => quote(label)).join(";"), ...devices.map((device) => fields.map(([field]) => quote(Array.isArray(device[field]) ? device[field].join(", ") : device[field])).join(";"))].join("\r\n");
}

