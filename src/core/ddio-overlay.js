import { keyText, MAX_DEVICE_ALTERNATIVES, MAX_DEVICE_CONFLICTS, normalizeIp, normalizeMac, unique, uniqueLimited } from "./normalize.js";
import { assertBrowserHeapReserve } from "./import-limits.js";
import { visitDeviceMacAddresses } from "./identity.js";

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
  add(mappingValue(row, mapping, "mac"), mappingValue(row, mapping, "ip"), "mac/ip");
  add(mappingValue(row, mapping, "reservationMac"), mappingValue(row, mapping, "reservationIp"), "reservation");
  add(mappingValue(row, mapping, "leaseMac"), mappingValue(row, mapping, "leaseIp"), "lease");
  add.deviceId?.(mappingValue(row, mapping, "deviceId"), mappingValue(row, mapping, "ip"), "mac/ip");
  const explicitIps = String(mappingValue(row, mapping, "possibleIps") || "")
    .split(/[;,\r\n]+/).map((value) => normalizeIp(value)).filter(Boolean);
  const explicitMacs = ["mac", "reservationMac", "leaseMac"]
    .map((field) => mappingValue(row, mapping, field)).filter(Boolean);
  for (const mac of explicitMacs) for (const ip of explicitIps) add(mac, ip, "possible-ips");
  add.deviceId?.(mappingValue(row, mapping, "deviceId"), mappingValue(row, mapping, "reservationIp"), "reservation");
  add.deviceId?.(mappingValue(row, mapping, "deviceId"), mappingValue(row, mapping, "leaseIp"), "lease");
  for (const ip of explicitIps) add.deviceId?.(mappingValue(row, mapping, "deviceId"), ip, "possible-ips");
  for (const [field, selector] of Object.entries(mapping || {})) {
    if (!/^custom_[0-9a-f-]{36}$/i.test(field) || !Number.isInteger(selector)) continue;
    const value = String(row?.[selector] ?? "").trim();
    if (!value) continue;
    add.custom?.(mappingValue(row, mapping, "reservationMac"), field, value);
    add.custom?.(mappingValue(row, mapping, "leaseMac"), field, value);
  }
}

// A JS Set of formatted MAC strings duplicates a large part of the device
// identity index while DDIO rows are being filtered. MACs are fixed-width
// values, so keep exact membership in a compact open-addressed typed table.
class CompactMacSet {
  constructor() {
    this.high = new Uint32Array(16);
    this.low = new Uint32Array(16);
    this.used = new Uint8Array(16);
    this.size = 0;
  }

  #hash(high, low) {
    let value = Math.imul(high ^ low, 0x9e3779b1);
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b);
    return (value ^ (value >>> 13)) >>> 0;
  }

  #insert(high, low) {
    const mask = this.used.length - 1;
    let slot = this.#hash(high, low) & mask;
    while (this.used[slot]) {
      if (this.high[slot] === high && this.low[slot] === low) return false;
      slot = (slot + 1) & mask;
    }
    this.used[slot] = 1;
    this.high[slot] = high;
    this.low[slot] = low;
    this.size += 1;
    return true;
  }

  #grow() {
    const oldHigh = this.high;
    const oldLow = this.low;
    const oldUsed = this.used;
    const capacity = oldUsed.length * 2;
    if (!Number.isSafeInteger(capacity) || capacity > 0x40000000) {
      throw new RangeError("Слишком много MAC для индексирования DDIO");
    }
    this.high = new Uint32Array(capacity);
    this.low = new Uint32Array(capacity);
    this.used = new Uint8Array(capacity);
    this.size = 0;
    for (let slot = 0; slot < oldUsed.length; slot += 1) {
      if (oldUsed[slot]) this.#insert(oldHigh[slot], oldLow[slot]);
    }
  }

  addNormalized(mac) {
    if (!mac) return false;
    const compact = mac.replaceAll(":", "");
    const high = Number.parseInt(compact.slice(0, 8), 16) >>> 0;
    const low = Number.parseInt(compact.slice(8), 16) >>> 0;
    if ((this.size + 1) * 10 >= this.used.length * 7) this.#grow();
    return this.#insert(high, low);
  }

  hasNormalized(mac) {
    if (!mac) return false;
    const compact = mac.replaceAll(":", "");
    const high = Number.parseInt(compact.slice(0, 8), 16) >>> 0;
    const low = Number.parseInt(compact.slice(8), 16) >>> 0;
    const mask = this.used.length - 1;
    let slot = this.#hash(high, low) & mask;
    while (this.used[slot]) {
      if (this.high[slot] === high && this.low[slot] === low) return true;
      slot = (slot + 1) & mask;
    }
    return false;
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

async function* targetDeviceRows(source, { signal } = {}) {
  if (Array.isArray(source) || typeof source?.[Symbol.iterator] === "function") {
    yield* source;
    return;
  }
  if (typeof source?.[Symbol.asyncIterator] === "function") {
    for await (const batch of source) {
      if (Array.isArray(batch)) yield* batch;
      else yield batch;
    }
    return;
  }
  const count = Number(source?.count);
  if (!Number.isSafeInteger(count) || count < 0 || typeof source?.readPage !== "function") {
    throw new TypeError("Ожидался массив устройств или постраничное хранилище Final");
  }
  for (let offset = 0; offset < count; offset += 500) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const limit = Math.min(500, count - offset);
    const page = await source.readPage(offset, limit);
    if (!Array.isArray(page) || page.length !== limit || page.some((device) => !device || typeof device !== "object")) {
      throw new Error(`Хранилище Final вернуло неполную страницу устройств ${offset + 1}–${offset + limit}`);
    }
    yield* page;
    page.length = 0;
  }
}

export async function buildDdIoIndexFromRows(rows, mapping = {}, targetDevices = null, { signal, onIndexPage = null, targetIdentityKeys = null } = {}) {
  const index = attachDeviceIdIndex(new Map());
  const offloaded = typeof onIndexPage === "function";
  const lookupTargets = Boolean(targetDevices && typeof targetIdentityKeys === "function");
  let offloadedEntries = 0;
  if (Array.isArray(rows) && rows.length === 0) return { index, rowCount: 0, offloaded, offloadedEntries };
  let targetMacs = null;
  let targetDeviceIds = null;
  if (targetDevices && !lookupTargets) {
    targetMacs = new CompactMacSet();
    targetDeviceIds = new Set();
    let targetCount = 0;
    for await (const device of targetDeviceRows(targetDevices, { signal })) {
      targetCount += 1;
      if (targetCount % 500 === 0) {
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
        if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
        else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
        else await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      }
      visitDeviceMacAddresses(device, (mac) => targetMacs.addNormalized(mac));
      const id = identityKey(device.deviceId);
      if (id) targetDeviceIds.add(id);
    }
  }
  let rowCount = 0;
  const hasTargetMac = (mac) => !targetMacs || (typeof targetMacs.hasNormalized === "function" ? targetMacs.hasNormalized(mac) : targetMacs.has(mac));
  const add = (macValue, ipValue, kind) => {
    const mac = normalizeMac(macValue);
    if (!hasTargetMac(mac)) return;
    addDdIoEntry(index, mac, ipValue, kind);
  };
  add.custom = (macValue, key, value) => {
    const mac = normalizeMac(macValue);
    if (!hasTargetMac(mac)) return;
    addCustomField(index, mac, key, value);
  };
  add.deviceId = (deviceId, ipValue, kind) => {
    const key = identityKey(deviceId);
    if (targetDeviceIds && !targetDeviceIds.has(key)) return;
    addPossibleIpEntry(index.byDeviceId, key, ipValue, kind);
  };
  const flushOffloadedIndex = async () => {
    if (!offloaded || (!index.size && !index.byDeviceId.size)) return;
    const saved = await onIndexPage(index);
    offloadedEntries += Number.isSafeInteger(saved) ? saved : index.size + index.byDeviceId.size;
    index.clear();
    index.byDeviceId.clear();
  };
  const processTargetRows = async (pendingRows) => {
    if (!pendingRows.length) return;
    const candidateKeys = new Set();
    const macValues = new Set();
    const deviceIds = new Set();
    for (const row of pendingRows) {
      for (const field of ["mac", "reservationMac", "leaseMac"]) {
        const mac = normalizeMac(mappingValue(row, mapping, field));
        if (!mac) continue;
        macValues.add(mac);
        candidateKeys.add(`mac:${mac}`);
        candidateKeys.add(`alternateMac:${mac}`);
      }
      const deviceId = identityKey(mappingValue(row, mapping, "deviceId"));
      if (deviceId) {
        deviceIds.add(deviceId);
        candidateKeys.add(`deviceId:${deviceId}`);
      }
    }
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const matched = await targetIdentityKeys([...candidateKeys]);
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    targetMacs = new Set();
    targetDeviceIds = new Set();
    const hasMatch = (key) => matched instanceof Map || matched instanceof Set ? matched.has(key) : Array.isArray(matched) && matched.includes(key);
    for (const mac of macValues) {
      if (hasMatch(`mac:${mac}`) || hasMatch(`alternateMac:${mac}`)) targetMacs.add(mac);
    }
    for (const deviceId of deviceIds) if (hasMatch(`deviceId:${deviceId}`)) targetDeviceIds.add(deviceId);
    for (const row of pendingRows) addDdIoRow(mapping, add, row);
    targetMacs = null;
    targetDeviceIds = null;
    pendingRows.length = 0;
    await flushOffloadedIndex();
  };
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const pendingTargetRows = [];
  for await (const row of inputRows(rows)) {
    if (lookupTargets) pendingTargetRows.push(row);
    else addDdIoRow(mapping, add, row);
    rowCount += 1;
    if (rowCount % 500 === 0) {
      assertBrowserHeapReserve();
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
      else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
      else await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      if (lookupTargets) await processTargetRows(pendingTargetRows);
      else await flushOffloadedIndex();
    }
  }
  if (lookupTargets) await processTargetRows(pendingTargetRows);
  else await flushOffloadedIndex();
  return { index, rowCount, offloaded, offloadedEntries };
}

function addDeviceConflict(device, conflict) {
  device.conflicts ||= [];
  if (device.conflicts.some((item) => item.field === conflict.field && item.source === conflict.source && item.reason === conflict.reason
    && (conflict.field !== "customField" || item.key === conflict.key))) return;
  if (device.conflicts.length < MAX_DEVICE_CONFLICTS) device.conflicts.push(conflict);
  else device.conflictsTruncated = true;
}

export function applyDdIoIpWithChanges(device, ddioIndex) {
  const ips = [];
  const customValues = new Map();
  const customConflicts = new Map();
  const customConflictsTruncated = new Set();
  let ipsTruncated = false;
  const applyMacEntry = (rawMac) => {
    const mac = normalizeMac(rawMac);
    if (!mac) return;
    const entry = ddioIndex.get(mac);
    if (!entry) return;
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
  };
  visitDeviceMacAddresses(device, applyMacEntry);
  const deviceIdKey = identityKey(device.deviceId);
  const deviceIdEvidence = deviceIdKey ? ddioIndex.byDeviceId?.get(deviceIdKey) : null;
  const possibleEvidenceIps = [...ips, ...(deviceIdEvidence?.ips || [])];
  const allPossibleIps = uniqueLimited([...(device.possibleIps || []), ...possibleEvidenceIps], normalizeIp);
  let changed = false;
  const currentPossibleIps = Array.isArray(device.possibleIps) ? device.possibleIps : [];
  if (currentPossibleIps.length !== allPossibleIps.values.length
    || currentPossibleIps.some((ip, index) => ip !== allPossibleIps.values[index])) {
    device.possibleIps = allPossibleIps.values;
    changed = true;
  }
  const possibleIpsTruncated = Boolean(device.possibleIpsTruncated || ipsTruncated || deviceIdEvidence?.ipOverflow || allPossibleIps.truncated);
  if (device.possibleIpsTruncated !== possibleIpsTruncated) {
    device.possibleIpsTruncated = possibleIpsTruncated;
    changed = true;
  }
  if (!device.customFields) {
    device.customFields = {};
    changed = true;
  }
  if (!device.customFieldSources) {
    device.customFieldSources = {};
    changed = true;
  }
  const previousConflictCount = device.conflicts?.length || 0;
  const previousConflictsTruncated = Boolean(device.conflictsTruncated);
  let customApplied = false;
  for (const [key, value] of customValues) {
    if (customConflicts.has(key)) continue;
    const current = String(device.customFields[key] ?? "").trim();
    if (!current) {
      device.customFields[key] = value;
      device.customFieldSources[key] = "DDIO";
      customApplied = true;
      changed = true;
    } else if (keyText(current) !== keyText(value)) {
      addDeviceConflict(device, { field: "customField", key, selected: current, value, source: "DDIO" });
    }
  }
  for (const [key, values] of customConflicts) addDeviceConflict(device, { field: "customField", key, values, valuesTruncated: customConflictsTruncated.has(key), source: "DDIO", reason: "multiple-exact-mac-custom-values" });
  if (possibleEvidenceIps.length || customApplied || customConflicts.size) {
    if (!device.fieldSources) {
      device.fieldSources = {};
      changed = true;
    }
    if (device.fieldSources.possibleIps !== "DDIO") {
      device.fieldSources.possibleIps = "DDIO";
      changed = true;
    }
    const sources = Array.isArray(device.sources) ? device.sources : [];
    if (!sources.includes("DDIO")) {
      device.sources = unique([...sources, "DDIO"]);
      changed = true;
    }
  }
  let assignedIp = false;
  if (!normalizeIp(device.ip) && ips.length === 1 && !ipsTruncated) {
    device.ip = ips[0];
    if (!device.fieldSources) device.fieldSources = {};
    device.fieldSources.ip = "DDIO";
    assignedIp = true;
    changed = true;
  }
  if (!normalizeIp(device.ip) && (ips.length > 1 || ipsTruncated)) {
    addDeviceConflict(device, { field: "ip", selected: "", values: ips, valuesTruncated: ipsTruncated, source: "DDIO", reason: "multiple-exact-mac-ips" });
  }
  if ((device.conflicts?.length || 0) !== previousConflictCount
    || Boolean(device.conflictsTruncated) !== previousConflictsTruncated) changed = true;
  return { assignedIp, changed };
}

export function applyDdIoIp(device, ddioIndex) {
  return applyDdIoIpWithChanges(device, ddioIndex).assignedIp;
}
