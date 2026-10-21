import { keyText, MAX_DEVICE_ALTERNATIVES, MAX_DEVICE_CONFLICTS, normalizeIp, normalizeMac, unique, uniqueLimited } from "./normalize.js";
import { assertBrowserHeapReserve } from "./import-limits.js";

function mappingValue(row, mapping, field) {
  const selector = mapping?.[field];
  if (selector === undefined || selector === null || selector === "") return "";
  return row[selector];
}

function identityKey(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  return keyText(value);
}

function addPossibleIpEntry(index, key, ipValue, kind) {
  const ip = normalizeIp(ipValue);
  if (!key || !ip) return;
  const entry = ensureEntry(index, key);
  if (!entry.ips.includes(ip)) {
    if (entry.ips.length < MAX_DEVICE_ALTERNATIVES) entry.ips.push(ip);
    else entry.ipOverflow = true;
  }
  if (entry.evidence.length < MAX_DEVICE_ALTERNATIVES) entry.evidence.push({ kind, ip });
  else entry.evidenceTruncated = true;
}

function ensureEntry(index, key) {
  if (!index.has(key)) index.set(key, { ips: [], evidence: [], ipOverflow: false, evidenceTruncated: false, customFields: {}, customFieldConflicts: {}, customFieldConflictsTruncated: {} });
  return index.get(key);
}

function appendUniqueLimited(values, value) {
  if (values.includes(value)) return false;
  if (values.length >= MAX_DEVICE_ALTERNATIVES) return true;
  values.push(value);
  return false;
}

function addDdIoEntry(index, macValue, ipValue, kind) {
  addPossibleIpEntry(index, normalizeMac(macValue), ipValue, kind);
}

function addDdIoRow(mapping, add, row) {
  add(mappingValue(row, mapping, "reservationMac"), mappingValue(row, mapping, "reservationIp"), "reservation");
  add(mappingValue(row, mapping, "leaseMac"), mappingValue(row, mapping, "leaseIp"), "lease");
  add.deviceId?.(mappingValue(row, mapping, "deviceId"), mappingValue(row, mapping, "reservationIp"), "reservation");
  add.deviceId?.(mappingValue(row, mapping, "deviceId"), mappingValue(row, mapping, "leaseIp"), "lease");
  for (const [field, selector] of Object.entries(mapping || {})) {
    if (!/^custom_[0-9a-f-]{36}$/i.test(field) || !Number.isInteger(selector)) continue;
    const value = String(row?.[selector] ?? "").trim();
    if (!value) continue;
    add.custom?.(mappingValue(row, mapping, "reservationMac"), field, value);
    add.custom?.(mappingValue(row, mapping, "leaseMac"), field, value);
  }
}

function addCustomField(index, macValue, key, value) {
  const mac = normalizeMac(macValue);
  if (!mac || !/^custom_[0-9a-f-]{36}$/i.test(key) || !value) return;
  const entry = ensureEntry(index, mac);
  const existing = entry.customFields[key];
  if (entry.customFieldConflicts[key]) {
    entry.customFieldConflictsTruncated[key] ||= appendUniqueLimited(entry.customFieldConflicts[key], value);
  } else if (!existing) entry.customFields[key] = value;
  else if (keyText(existing) !== keyText(value)) {
    const values = [];
    appendUniqueLimited(values, existing);
    entry.customFieldConflictsTruncated[key] = appendUniqueLimited(values, value);
    entry.customFieldConflicts[key] = values;
    delete entry.customFields[key];
  }
}

function attachDeviceIdIndex(index) {
  Object.defineProperty(index, "byDeviceId", { value: new Map() });
  return index;
}

export function buildDdIoIndex(rows = [], mapping = {}) {
  const index = attachDeviceIdIndex(new Map());
  const add = (macValue, ipValue, kind) => addDdIoEntry(index, macValue, ipValue, kind);
  add.custom = (mac, key, value) => addCustomField(index, mac, key, value);
  add.deviceId = (deviceId, ipValue, kind) => addPossibleIpEntry(index.byDeviceId, identityKey(deviceId), ipValue, kind);
  for (const row of rows) addDdIoRow(mapping, add, row);
  return index;
}

async function* inputRows(source = []) {
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    for await (const batch of source) {
      if (Array.isArray(batch) && (!batch.length || Array.isArray(batch[0]))) yield* batch;
      else yield batch;
    }
    return;
  }
  if (source && typeof source[Symbol.iterator] === "function") yield* source;
}

export async function buildDdIoIndexFromRows(rows, mapping = {}, targetDevices = null, { signal } = {}) {
  const index = attachDeviceIdIndex(new Map());
  if (Array.isArray(rows) && rows.length === 0) return { index, rowCount: 0 };
  let targetMacs = null;
  let targetDeviceIds = null;
  if (targetDevices) {
    targetMacs = new Set();
    targetDeviceIds = new Set();
    let targetCount = 0;
    for (const device of targetDevices) {
      targetCount += 1;
      if (targetCount % 500 === 0) {
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
        if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
        else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
        else await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      }
      for (const mac of unique([device.mac, ...(device.alternateMacs || [])], normalizeMac)) targetMacs.add(mac);
      const id = identityKey(device.deviceId);
      if (id) targetDeviceIds.add(id);
    }
  }
  let rowCount = 0;
  const add = (macValue, ipValue, kind) => {
    const mac = normalizeMac(macValue);
    if (targetMacs && !targetMacs.has(mac)) return;
    addDdIoEntry(index, mac, ipValue, kind);
  };
  add.custom = (macValue, key, value) => {
    const mac = normalizeMac(macValue);
    if (targetMacs && !targetMacs.has(mac)) return;
    addCustomField(index, mac, key, value);
  };
  add.deviceId = (deviceId, ipValue, kind) => {
    const key = identityKey(deviceId);
    if (targetDeviceIds && !targetDeviceIds.has(key)) return;
    addPossibleIpEntry(index.byDeviceId, key, ipValue, kind);
  };
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  for await (const row of inputRows(rows)) {
    addDdIoRow(mapping, add, row);
    rowCount += 1;
    if (rowCount % 500 === 0) {
      assertBrowserHeapReserve();
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
      else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
      else await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    }
  }
  return { index, rowCount };
}

function addDeviceConflict(device, conflict) {
  device.conflicts ||= [];
  if (device.conflicts.some((item) => item.field === conflict.field && item.source === conflict.source && item.reason === conflict.reason
    && (conflict.field !== "customField" || item.key === conflict.key))) return;
  if (device.conflicts.length < MAX_DEVICE_CONFLICTS) device.conflicts.push(conflict);
  else device.conflictsTruncated = true;
}

export function applyDdIoIp(device, ddioIndex) {
  const macs = unique([device.mac, ...(device.alternateMacs || [])], normalizeMac);
  const ips = [];
  const customValues = new Map();
  const customConflicts = new Map();
  const customConflictsTruncated = new Set();
  let ipsTruncated = false;
  for (const mac of macs) {
    const entry = ddioIndex.get(mac);
    if (!entry) continue;
    for (const [key, value] of Object.entries(entry.customFields || {})) {
      if (!customValues.has(key)) customValues.set(key, value);
      else if (keyText(customValues.get(key)) !== keyText(value)) {
        const values = customConflicts.get(key) || [];
        if (appendUniqueLimited(values, customValues.get(key))) customConflictsTruncated.add(key);
        if (appendUniqueLimited(values, value)) customConflictsTruncated.add(key);
        customConflicts.set(key, values);
      }
    }
    for (const [key, values] of Object.entries(entry.customFieldConflicts || {})) {
      const retained = customConflicts.get(key) || [];
      for (const value of values) if (appendUniqueLimited(retained, value)) customConflictsTruncated.add(key);
      if (entry.customFieldConflictsTruncated?.[key]) customConflictsTruncated.add(key);
      customConflicts.set(key, retained);
    }
    ipsTruncated ||= Boolean(entry.ipOverflow);
    for (const ip of entry.ips) {
      if (ips.includes(ip)) continue;
      if (ips.length < MAX_DEVICE_ALTERNATIVES) ips.push(ip);
      else ipsTruncated = true;
    }
  }
  const deviceIdKey = identityKey(device.deviceId);
  const deviceIdEvidence = deviceIdKey ? ddioIndex.byDeviceId?.get(deviceIdKey) : null;
  const possibleEvidenceIps = [...ips, ...(deviceIdEvidence?.ips || [])];
  const allPossibleIps = uniqueLimited([...(device.possibleIps || []), ...possibleEvidenceIps], normalizeIp);
  device.possibleIps = allPossibleIps.values;
  device.possibleIpsTruncated = Boolean(device.possibleIpsTruncated || ipsTruncated || deviceIdEvidence?.ipOverflow || allPossibleIps.truncated);
  device.customFields ||= {};
  device.customFieldSources ||= {};
  let customApplied = false;
  for (const [key, value] of customValues) {
    if (customConflicts.has(key)) continue;
    const current = String(device.customFields[key] ?? "").trim();
    if (!current) {
      device.customFields[key] = value;
      device.customFieldSources[key] = "DDIO";
      customApplied = true;
    } else if (keyText(current) !== keyText(value)) {
      addDeviceConflict(device, { field: "customField", key, selected: current, value, source: "DDIO" });
    }
  }
  for (const [key, values] of customConflicts) addDeviceConflict(device, { field: "customField", key, values, valuesTruncated: customConflictsTruncated.has(key), source: "DDIO", reason: "multiple-exact-mac-custom-values" });
  if (possibleEvidenceIps.length || customApplied || customConflicts.size) {
    device.fieldSources.possibleIps = "DDIO";
    device.sources = unique([...(device.sources || []), "DDIO"]);
  }
  if (!normalizeIp(device.ip) && ips.length === 1 && !ipsTruncated) {
    device.ip = ips[0];
    device.fieldSources.ip = "DDIO";
    return true;
  }
  if (!normalizeIp(device.ip) && (ips.length > 1 || ipsTruncated)) {
    addDeviceConflict(device, { field: "ip", selected: "", values: ips, valuesTruncated: ipsTruncated, source: "DDIO", reason: "multiple-exact-mac-ips" });
  }
  return false;
}
