import {
  firstKnown,
  hasStrongIdentity,
  keyText,
  normalizeDevice,
  normalizeIp,
  normalizeMac,
  text,
  unique,
} from "./normalize.js";
import { addIdentityToIndex, buildIdentityIndex, findIdentityMatch, stableId } from "./identity.js";

export const STRATEGIES = Object.freeze({
  NO_EXPANSION: "NO_EXPANSION",
  ALLOW_EXPANSION: "ALLOW_EXPANSION",
});

const MERGE_FIELDS = [
  "ip",
  "switchIp",
  "switchPort",
  "smartroomId",
  "businessUnit",
  "city",
  "site",
  "floor",
  "room",
  "address",
  "physicalAddress",
  "manufacturer",
  "model",
  "deviceType",
  "hostname",
  "serial",
  "deviceId",
  "deviceName",
  "authenticationTime",
];

function setKnown(target, field, value, source, { overwrite = false } = {}) {
  const next = text(value);
  if (!next) return false;
  const current = text(target[field]);
  if (!current || overwrite) {
    target[field] = next;
    target.fieldSources[field] = source;
    return current !== next;
  }
  if (keyText(current) !== keyText(next)) {
    const exists = target.conflicts.some((item) => item.field === field && item.value === next && item.source === source);
    if (!exists) target.conflicts.push({ field, selected: current, value: next, source });
  }
  return false;
}

export function mergeDevice(target, incoming, source, options = {}) {
  for (const field of MERGE_FIELDS) setKnown(target, field, incoming[field], source, options);
  target.alternateMacs = unique([
    ...(target.alternateMacs || []),
    ...(incoming.alternateMacs || []),
    incoming.mac && incoming.mac !== target.mac ? incoming.mac : "",
  ], normalizeMac).filter((mac) => mac !== target.mac);
  target.possibleIps = unique([...(target.possibleIps || []), ...(incoming.possibleIps || [])], normalizeIp);
  target.sources = unique([...(target.sources || []), ...(incoming.sources || []), source]);
  return target;
}

function mappingValue(row, mapping, field) {
  const selector = mapping?.[field];
  if (selector === undefined || selector === null || selector === "") return "";
  if (typeof selector === "number") return row[selector];
  return row[selector];
}

export function mapRow(row, mapping = {}, source = "") {
  const data = {};
  for (const field of Object.keys(mapping || {})) data[field] = mappingValue(row, mapping, field);
  return normalizeDevice(data, source);
}

export function buildDdIoIndex(rows = [], mapping = {}) {
  const index = new Map();
  const add = (macValue, ipValue, kind) => {
    const mac = normalizeMac(macValue);
    const ip = normalizeIp(ipValue);
    if (!mac || !ip) return;
    if (!index.has(mac)) index.set(mac, { ips: new Set(), evidence: [] });
    index.get(mac).ips.add(ip);
    index.get(mac).evidence.push({ kind, ip });
  };
  for (const row of rows) {
    add(mappingValue(row, mapping, "reservationMac"), mappingValue(row, mapping, "reservationIp"), "reservation");
    add(mappingValue(row, mapping, "leaseMac"), mappingValue(row, mapping, "leaseIp"), "lease");
  }
  return index;
}

export function applyDdIoIp(device, ddioIndex) {
  const macs = unique([device.mac, ...(device.alternateMacs || [])], normalizeMac);
  const ips = unique(macs.flatMap((mac) => [...(ddioIndex.get(mac)?.ips || [])]), normalizeIp);
  device.possibleIps = unique([...(device.possibleIps || []), ...ips], normalizeIp);
  if (!normalizeIp(device.ip) && ips.length === 1) {
    device.ip = ips[0];
    device.fieldSources.ip = "DDIO";
    return true;
  }
  if (!normalizeIp(device.ip) && ips.length > 1) {
    device.conflicts.push({ field: "ip", selected: "", values: ips, source: "DDIO", reason: "multiple-exact-mac-ips" });
  }
  return false;
}

function applyPreviousFinal(device, previousIndex) {
  const result = findIdentityMatch(device, previousIndex);
  if (result.status !== "matched") return false;
  mergeDevice(device, result.match, "Previous Final");
  return true;
}

function createMainDevices(rows, mapping, diagnostics) {
  const devices = [];
  let index = buildIdentityIndex(devices);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const candidate = mapRow(rows[rowIndex], mapping, "Main");
    if (!hasStrongIdentity(candidate)) {
      diagnostics.invalid.push({ source: "Main", row: rowIndex + 2, reason: "Нет MAC, serial или Device ID" });
      continue;
    }
    const resolution = findIdentityMatch(candidate, index);
    if (resolution.status === "matched") {
      mergeDevice(resolution.match, candidate, "Main");
      addIdentityToIndex(index, resolution.match, resolution.position);
      diagnostics.decisions.push({ action: "MERGED_MAIN_DUPLICATE", row: rowIndex + 2, id: resolution.match.id });
    } else {
      candidate.id = stableId(candidate);
      devices.push(candidate);
      diagnostics.decisions.push({ action: "CREATED_FROM_MAIN", row: rowIndex + 2, id: candidate.id });
      addIdentityToIndex(index, candidate, devices.length - 1);
    }
  }
  return devices;
}

function enrichSmartroom(devices, rows, mapping, strategy, diagnostics) {
  let index = buildIdentityIndex(devices);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const candidate = mapRow(rows[rowIndex], mapping, "SmartRoom");
    if (!hasStrongIdentity(candidate)) {
      diagnostics.invalid.push({ source: "SmartRoom", row: rowIndex + 2, reason: "Нет сильного идентификатора" });
      continue;
    }
    const resolution = findIdentityMatch(candidate, index);
    if (resolution.status === "matched") {
      mergeDevice(resolution.match, candidate, "SmartRoom");
      addIdentityToIndex(index, resolution.match, resolution.position);
      diagnostics.decisions.push({ action: "MATCHED_SMARTROOM", row: rowIndex + 2, id: resolution.match.id });
      continue;
    }
    if (resolution.status === "ambiguous") {
      diagnostics.conflicts.push({ source: "SmartRoom", row: rowIndex + 2, reason: "Неоднозначная идентификация" });
      continue;
    }
    if (strategy === STRATEGIES.ALLOW_EXPANSION) {
      candidate.id = stableId(candidate);
      devices.push(candidate);
      diagnostics.decisions.push({ action: "CREATED_FROM_SMARTROOM", row: rowIndex + 2, id: candidate.id });
      addIdentityToIndex(index, candidate, devices.length - 1);
    } else {
      diagnostics.unmatched.push({ source: "SmartRoom", row: rowIndex + 2, reason: "NO_EXPANSION" });
      diagnostics.decisions.push({ action: "NOT_CREATED_FROM_SMARTROOM", row: rowIndex + 2, strategy });
    }
  }
}

function applyKnowledge(device, context) {
  const oui = normalizeMac(device.mac).replaceAll(":", "").slice(0, 6);
  if (!device.manufacturer && oui && context.ouiIndex?.has(oui)) {
    device.manufacturer = context.ouiIndex.get(oui);
    device.fieldSources.manufacturer = "OUI";
  }
  const model = context.knownModels?.get(normalizeMac(device.mac));
  if (!device.model && model) {
    device.model = model;
    device.fieldSources.model = "Known Models";
  }
}

export async function enrich(options = {}) {
  const {
    mainRows = [],
    smartroomRows = [],
    ddioRows = [],
    mappings = {},
    strategy = STRATEGIES.NO_EXPANSION,
    previousFinal = [],
    ouiIndex = new Map(),
    knownModels = new Map(),
    onProgress = () => {},
    signal,
  } = options;
  const diagnostics = { invalid: [], conflicts: [], unmatched: [], decisions: [], counts: {} };
  const progress = async (value, stage) => {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    onProgress(value, stage);
    if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await progress(5, "Проверка входных данных");
  if (!mainRows.length) throw new Error("Основной файл не содержит данных");
  diagnostics.counts.mainRaw = mainRows.length;
  diagnostics.counts.smartroomRaw = smartroomRows.length;
  diagnostics.counts.ddioRaw = ddioRows.length;

  await progress(20, "Формирование уникальных устройств основного файла");
  const devices = createMainDevices(mainRows, mappings.main || {}, diagnostics);
  diagnostics.counts.mainUnique = devices.length;

  await progress(40, "Сопоставление SmartRoom");
  enrichSmartroom(devices, smartroomRows, mappings.smartroom || {}, strategy, diagnostics);
  diagnostics.counts.afterSmartroom = devices.length;

  await progress(58, "Использование предыдущего Final");
  const previousIndex = buildIdentityIndex(previousFinal);
  for (const device of devices) applyPreviousFinal(device, previousIndex);

  await progress(70, "Сопоставление DDIO по MAC");
  const ddioIndex = buildDdIoIndex(ddioRows, mappings.ddio || {});
  let ddioFilled = 0;
  for (const device of devices) if (applyDdIoIp(device, ddioIndex)) ddioFilled += 1;
  diagnostics.counts.ddioMatchedIp = ddioFilled;

  await progress(82, "Производители и модели");
  for (const device of devices) applyKnowledge(device, { ouiIndex, knownModels });

  await progress(92, "Финальная валидация");
  const final = devices.map((device) => ({
    ...device,
    id: device.id || stableId(device),
    observedAt: new Date().toISOString(),
    source: firstKnown(device.sources?.join(", "), "Main"),
  }));
  if (new Set(final.map((device) => device.id)).size !== final.length) throw new Error("После обогащения обнаружены дубли внутренних ID");
  diagnostics.counts.finalUnique = final.length;
  await progress(100, "Готово");
  return { devices: final, diagnostics };
}

