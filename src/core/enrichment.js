import {
  firstKnown,
  hasStrongIdentity,
  keyText,
  MAX_DEVICE_ALTERNATIVES,
  MAX_DEVICE_CONFLICTS,
  normalizeDevice,
  normalizeIp,
  normalizeMac,
  text,
  unique,
  uniqueLimited,
} from "./normalize.js";
import { addIdentityToIndex, buildIdentityIndex, buildIdentityIndexAsync, findIdentityMatch, identityLookupKeys, stableId, visitDeviceAlternateMacs } from "./identity.js";
import { lookupOuiVendor } from "./ieee-registry.js";
import { applyHistoricalAddress, applyImportedSmartroomRoom, applySmartroomRoom, buildCurrentSmartroomRoomIndexAsync } from "./historical-mapping.js";
import { compileMacModelRules, lookupMacModel } from "./model-knowledge.js";
import { applyVendorDetectionAsync, DEFAULT_VENDOR_DETECTOR_SETTINGS, normalizeVendorDetectorSettings } from "./vendor-detector.js";
import { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows } from "./ddio-overlay.js";
import { DEFAULT_ENRICHMENT_FIELD_SETTINGS, normalizeEnrichmentFieldSettings } from "./enrichment-settings.js";
import { DEFAULT_HISTORY_ENRICHMENT_SETTINGS, normalizeHistoryEnrichmentSettings } from "./history-enrichment-settings.js";
import { trimComparisonDeviceInPlace } from "./compact-final-analytics.js";
import { assertBrowserHeapReserve } from "./import-limits.js";
import { applyIpMapping, createIpMappingIndex, DEFAULT_IP_ENRICHMENT_SETTINGS, normalizeIpEnrichmentSettings } from "./ip-mapping.js";

export { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows };

export const STRATEGIES = Object.freeze({
  NO_EXPANSION: "NO_EXPANSION",
  ALLOW_EXPANSION: "ALLOW_EXPANSION",
});

const KNOWLEDGE_LOOKUP_BATCH_SIZE = 500;
const SMARTROOM_IDENTITY_PREFETCH_BATCH_SIZE = 100;
const MAX_DIAGNOSTIC_SAMPLES = 1_000;
const MAX_CURRENT_ROOM_TARGET_IDS = 10_000;

function isPagedDeviceStore(devices) {
  return !Array.isArray(devices)
    && Number.isSafeInteger(devices?.count)
    && devices.count >= 0
    && typeof devices.readPage === "function"
    && typeof devices.writePage === "function";
}

function deviceCount(devices) {
  if (Array.isArray(devices)) return devices.length;
  if (isPagedDeviceStore(devices)) return devices.count;
  throw new TypeError("Ожидался массив устройств или постраничное хранилище Final");
}

async function forEachDevicePage(devices, visit, { signal, pageSize = KNOWLEDGE_LOOKUP_BATCH_SIZE, writeBack = true } = {}) {
  const count = deviceCount(devices);
  for (let offset = 0; offset < count; offset += pageSize) {
    throwIfAborted(signal);
    const end = Math.min(count, offset + pageSize);
    const rows = Array.isArray(devices)
      ? devices.slice(offset, end)
      : await devices.readPage(offset, end - offset);
    if (!Array.isArray(rows) || rows.length !== end - offset || rows.some((row) => !row || typeof row !== "object")) {
      throw new Error(`Хранилище Final вернуло неполную страницу устройств ${offset + 1}–${end}`);
    }
    const shouldContinue = await visit(rows, offset);
    const shouldWriteBack = typeof writeBack === "function" ? writeBack(rows, shouldContinue) : writeBack;
    if (!Array.isArray(devices) && shouldWriteBack) await devices.writePage(offset, rows);
    rows.length = 0;
    if (shouldContinue === false) break;
    if (end < count) await yieldToBrowserTask(signal);
  }
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
}

async function yieldToBrowserTask(signal) {
  throwIfAborted(signal);
  if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
  else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
  else await new Promise((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

async function applyDeviceBatches(devices, apply, signal, { alwaysWriteBack = false } = {}) {
  await forEachDevicePage(devices, (rows, offset) => {
    let changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      if (apply(rows[index], offset + index) === true) changed = true;
    }
    return { changed };
  }, { signal, writeBack: (_rows, result) => alwaysWriteBack || result?.changed === true });
}

export async function collectCurrentSmartroomRoomTargets(devices, { signal, maxTargets = MAX_CURRENT_ROOM_TARGET_IDS } = {}) {
  const targetIds = new Set();
  let exceeded = false;
  await forEachDevicePage(devices, (rows) => {
    for (const device of rows) {
      const id = !text(device.room) ? keyText(device.smartroomId) : "";
      if (id && !targetIds.has(id)) {
        if (targetIds.size >= maxTargets) {
          targetIds.clear();
          exceeded = true;
          return false;
        }
        targetIds.add(id);
      }
    }
  }, { signal, writeBack: false });
  return exceeded ? null : targetIds;
}

async function deviceIdAt(devices, position, pageRows, pageOffset) {
  if (position >= pageOffset && position < pageOffset + pageRows.length) return pageRows[position - pageOffset]?.id;
  if (Array.isArray(devices)) return devices[position]?.id;
  const row = await devices.readPage(position, 1);
  if (!Array.isArray(row) || row.length !== 1 || !row[0] || typeof row[0] !== "object") {
    throw new Error(`Хранилище Final вернуло неполную запись устройства ${position + 1}`);
  }
  return row[0]?.id;
}

async function assertUniqueDeviceIds(devices, signal) {
  const count = deviceCount(devices);
  if (!count) return;
  let capacity = 1;
  while (capacity < count * 2) {
    capacity *= 2;
    if (capacity > 0x40000000) throw new RangeError("Слишком много устройств для проверки внутренних ID");
  }
  const hashes = new Uint32Array(capacity);
  const positions = new Uint32Array(capacity);
  const mask = capacity - 1;
  await forEachDevicePage(devices, async (rows, pageOffset) => {
    for (let pageIndex = 0; pageIndex < rows.length; pageIndex += 1) {
      const index = pageOffset + pageIndex;
      const id = String(rows[pageIndex]?.id || "");
      let hash = 0x811c9dc5;
      for (let offset = 0; offset < id.length; offset += 1) {
        hash ^= id.charCodeAt(offset);
        hash = Math.imul(hash, 0x01000193);
      }
      hash >>>= 0;
      let slot = hash & mask;
      while (positions[slot]) {
        const previousIndex = positions[slot] - 1;
        if (hashes[slot] === hash && await deviceIdAt(devices, previousIndex, rows, pageOffset) === id) {
          throw new Error("После обогащения обнаружены дубли внутренних ID");
        }
        slot = (slot + 1) & mask;
      }
      hashes[slot] = hash;
      positions[slot] = index + 1;
    }
  }, { signal, writeBack: false });
}

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

const ENRICHMENT_FIELD_BY_DEVICE_FIELD = Object.freeze({
  model: "model",
  address: "address",
  physicalAddress: "address",
  ip: "ip",
  manufacturer: "vendor",
  room: "room",
  switchIp: "switch_ip",
  switchPort: "switch_port",
});

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
    addDeviceConflict(target, { field, selected: current, value: next, source });
  }
  return false;
}

function addDeviceConflict(device, conflict) {
  device.conflicts ||= [];
  const exists = device.conflicts.some((item) => item.field === conflict.field && item.source === conflict.source && (
    conflict.field === "identity"
      ? item.identifier === conflict.identifier && item.selected === conflict.selected && item.alternative === conflict.alternative
      : conflict.field === "customField"
        ? item.key === conflict.key && item.value === conflict.value
      : item.value === conflict.value
  ));
  if (exists) return;
  if (device.conflicts.length < MAX_DEVICE_CONFLICTS) device.conflicts.push(conflict);
  else device.conflictsTruncated = true;
}

function addDiagnosticConflict(diagnostics, conflict) {
  if (conflict.field === "identity") diagnostics.counts.identityConflictsTotal = (diagnostics.counts.identityConflictsTotal || 0) + 1;
  retainDiagnosticSample(diagnostics, "conflicts", conflict);
}

function retainDiagnosticSample(diagnostics, collection, item) {
  const samples = diagnostics[collection];
  const totalKey = `${collection}Total`;
  const truncatedKey = `${collection}Truncated`;
  diagnostics.counts[totalKey] = (diagnostics.counts[totalKey] || 0) + 1;
  if (samples.length < MAX_DIAGNOSTIC_SAMPLES) {
    samples.push(item);
    return;
  }
  diagnostics.counts[truncatedKey] = (diagnostics.counts[truncatedKey] || 0) + 1;
}

function recordIdentityConflicts(diagnostics, source, row, resolution) {
  for (const conflict of resolution.identityConflicts || []) {
    addDiagnosticConflict(diagnostics, {
      source,
      row,
      field: "identity",
      reason: "Конфликтующий вторичный идентификатор; выбран сильнейший стабильный идентификатор",
      selected: conflict.selected?.id || conflict.selected?.deviceId || conflict.selected?.serial || conflict.selected?.mac || "",
      alternative: conflict.alternative?.id || conflict.alternative?.deviceId || conflict.alternative?.serial || conflict.alternative?.mac || "",
      selectedEvidence: conflict.selectedEvidence,
      alternativeEvidence: conflict.alternativeEvidence,
    });
  }
}

function recordNormalizedIdentityConflicts(diagnostics, source, row, device) {
  const identityConflicts = (device.conflicts || []).filter((conflict) => conflict.field === "identity");
  for (const conflict of identityConflicts) {
    addDiagnosticConflict(diagnostics, {
      source,
      row,
      ...conflict,
      reason: conflict.reason || "Конфликтующие алиасы сильного идентификатора",
    });
  }
  return identityConflicts.length > 0;
}

function normalizedIdentityAliasConflict(device) {
  return (device?.conflicts || []).find((conflict) => conflict.field === "identity"
    && /алиас.*сильн.*идентификатор/i.test(String(conflict.reason || "")));
}

function mergeAlternateMacs(target, incoming) {
  const values = [];
  const seen = new Set();
  let truncated = false;
  const add = (mac) => {
    if (seen.has(mac)) return true;
    if (values.length >= MAX_DEVICE_ALTERNATIVES) {
      truncated = true;
      return false;
    }
    seen.add(mac);
    values.push(mac);
    return true;
  };
  visitDeviceAlternateMacs(target, add);
  visitDeviceAlternateMacs(incoming, add);
  const targetPrimary = normalizeMac(target.mac || target.macFormatted || target.mac_formatted);
  const incomingPrimary = normalizeMac(incoming.mac || incoming.macFormatted || incoming.mac_formatted);
  if (incomingPrimary && incomingPrimary !== targetPrimary) add(incomingPrimary);
  return { values: values.filter((mac) => mac !== targetPrimary), truncated };
}

export function mergeDevice(target, incoming, source, options = {}) {
  const enabled = options.enrichmentFieldSettings
    ? normalizeEnrichmentFieldSettings(options.enrichmentFieldSettings)
    : DEFAULT_ENRICHMENT_FIELD_SETTINGS;
  for (const field of MERGE_FIELDS) {
    const setting = ENRICHMENT_FIELD_BY_DEVICE_FIELD[field];
    if (!setting || enabled[setting]) {
      const targetWasEmpty = !text(target[field]);
      setKnown(target, field, incoming[field], source, options);
      if (targetWasEmpty && text(target[field])) {
        const vendor = field === "manufacturer";
        const model = field === "model";
        if (vendor || model) {
          const confidenceField = vendor ? "vendorConfidence" : "modelConfidence";
          const snakeConfidenceField = vendor ? "vendor_confidence" : "model_confidence";
          const sourceField = vendor ? "vendorSource" : "modelSource";
          const snakeSourceField = vendor ? "vendor_source" : "model_source";
          const rawConfidence = incoming[confidenceField] ?? incoming[snakeConfidenceField];
          if (rawConfidence !== null && rawConfidence !== undefined && rawConfidence !== "") {
            const confidence = Number(rawConfidence);
            if (Number.isFinite(confidence)) target[confidenceField] = Math.max(0, Math.min(1, confidence));
          }
          const provenance = text(incoming[sourceField] ?? incoming[snakeSourceField] ?? incoming.fieldSources?.[field]);
          if (provenance) target[sourceField] = provenance;
        }
      }
    }
  }
  target.customFields ||= {};
  target.customFieldSources ||= {};
  for (const [key, rawValue] of Object.entries(incoming.customFields || {})) {
    const value = text(rawValue);
    if (!value) continue;
    const current = text(target.customFields[key]);
    if (!current) {
      target.customFields[key] = value;
      target.customFieldSources[key] = incoming.customFieldSources?.[key] || source;
    } else if (keyText(current) !== keyText(value)) {
      addDeviceConflict(target, { field: "customField", key, selected: current, value, source });
    }
  }
  const alternateMacs = mergeAlternateMacs(target, incoming);
  target.alternateMacs = alternateMacs.values;
  target.alternateMacsTruncated = Boolean(target.alternateMacsTruncated || incoming.alternateMacsTruncated || alternateMacs.truncated);
  const possibleIps = uniqueLimited([...(target.possibleIps || []), ...(incoming.possibleIps || [])], normalizeIp);
  target.possibleIps = possibleIps.values;
  target.possibleIpsTruncated = Boolean(target.possibleIpsTruncated || incoming.possibleIpsTruncated || possibleIps.truncated);
  for (const conflict of incoming.conflicts || []) addDeviceConflict(target, conflict);
  target.conflictsTruncated = Boolean(target.conflictsTruncated || incoming.conflictsTruncated);
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
  const customFields = {};
  const customFieldSources = {};
  for (const field of Object.keys(mapping || {})) {
    const value = mappingValue(row, mapping, field);
    if (/^custom_[0-9a-f-]{36}$/i.test(field)) {
      const normalized = text(value);
      if (normalized) {
        customFields[field] = normalized;
        customFieldSources[field] = source;
      }
    } else data[field] = value;
  }
  if (Object.keys(customFields).length) Object.assign(data, { customFields, customFieldSources });
  return normalizeDevice(data, source);
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

function sourceRowArray(row) {
  // Parsed table rows are already ordinary arrays and are read-only here.
  // Reuse them instead of allocating one full-width duplicate per source row.
  return Array.isArray(row) ? row : Array.from(row);
}

function stagedIdentityPositions(candidate, identityIndex) {
  const positions = new Set();
  for (const key of identityLookupKeys(candidate)) {
    const entry = identityIndex.tokens.get(key);
    if (entry === undefined) continue;
    const count = typeof entry === "number" ? 1 : Math.min(entry[0], 2);
    for (let slot = 1; slot <= count; slot += 1) {
      const position = typeof entry === "number" ? entry : entry[slot];
      if (Number.isSafeInteger(position) && position >= 0) positions.add(position);
    }
  }
  return positions;
}

async function hydrateStagedIdentityBatch(candidates, identityIndex, deviceStore, pendingDevicesByPosition, stagedCount) {
  if (typeof deviceStore.readIdentityEntries !== "function" || typeof deviceStore.readPositions !== "function") {
    throw new TypeError("Для потокового identity matching нужен постраничный индекс идентичности Final");
  }
  const keys = new Set();
  for (const candidate of candidates) for (const key of identityLookupKeys(candidate)) keys.add(key);
  const missingKeys = [...keys].filter((key) => !identityIndex.tokens.has(key));
  const entries = stagedCount && missingKeys.length ? await deviceStore.readIdentityEntries(missingKeys) : new Map();
  for (const [key, value] of entries) identityIndex.tokens.set(key, value);
  const positions = new Set();
  for (const candidate of candidates) {
    for (const position of stagedIdentityPositions(candidate, identityIndex)) {
      if (position < stagedCount && !pendingDevicesByPosition.has(position)) positions.add(position);
    }
  }
  const loaded = new Map();
  const requested = [...positions];
  for (let offset = 0; offset < requested.length; offset += 10_000) {
    const page = await deviceStore.readPositions(requested.slice(offset, offset + 10_000));
    for (const [position, device] of page) loaded.set(position, device);
  }
  return loaded;
}

async function findStagedIdentityMatch(candidate, identityIndex, deviceStore, pendingDevicesByPosition, signal, prefetchedDevices = null) {
  const positions = stagedIdentityPositions(candidate, identityIndex);
  const loaded = new Map();
  for (const position of positions) {
    throwIfAborted(signal);
    if (prefetchedDevices?.has(position)) {
      loaded.set(position, prefetchedDevices.get(position));
      continue;
    }
    if (pendingDevicesByPosition.has(position)) {
      loaded.set(position, pendingDevicesByPosition.get(position));
      continue;
    }
    const page = await deviceStore.readPage(position, 1);
    if (!Array.isArray(page) || page.length !== 1 || !page[0] || typeof page[0] !== "object") {
      throw new Error(`Хранилище Final вернуло неполную запись устройства ${position + 1}`);
    }
    loaded.set(position, page[0]);
  }
  const devices = new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || !/^\d+$/.test(property)) return undefined;
      return loaded.get(Number(property));
    },
  });
  return findIdentityMatch(candidate, { devices, tokens: identityIndex.tokens });
}

async function createMainDevicesInStage(rows, mapping, diagnostics, enrichmentFieldSettings, deviceStore, signal) {
  if (!isPagedDeviceStore(deviceStore) || typeof deviceStore.appendPage !== "function" || deviceStore.count !== 0) {
    throw new TypeError("Для потокового формирования Main нужен пустой постраничный Final store");
  }
  if (typeof deviceStore.readIdentityEntries !== "function" || typeof deviceStore.writeIdentityEntries !== "function") {
    throw new TypeError("Для потокового формирования Main нужен сохраняемый identity index");
  }
  const index = { tokens: new Map() };
  let stagedCount = deviceStore.count;
  let rowIndex = 0;
  let inputBatch = [];
  const processBatch = async (batch) => {
    const prepared = [];
    for (const row of batch) {
      const rowNumber = rowIndex + 2;
      rowIndex += 1;
      const sourceRow = sourceRowArray(row);
      if (!sourceRow.some((value) => text(value))) { prepared.push({ rowNumber }); continue; }
      const candidate = mapRow(sourceRow, mapping, "Main");
      const hasConflictingIdentityAliases = recordNormalizedIdentityConflicts(diagnostics, "Main", rowNumber, candidate);
      if (rowIndex % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0) assertBrowserHeapReserve();
      if (hasConflictingIdentityAliases) {
        retainDiagnosticSample(diagnostics, "invalid", { source: "Main", row: rowNumber, reason: "Конфликтующие алиасы сильного идентификатора" });
        prepared.push({ rowNumber });
        continue;
      }
      if (!hasStrongIdentity(candidate)) {
        retainDiagnosticSample(diagnostics, "invalid", { source: "Main", row: rowNumber, reason: "Нет MAC, serial или Device ID" });
        prepared.push({ rowNumber });
        continue;
      }
      prepared.push({ candidate, rowNumber });
    }
    const candidates = prepared.filter((row) => row.candidate).map((row) => row.candidate);
    if (!candidates.length) return;
    const pending = [];
    const pendingDevicesByPosition = new Map();
    const changedDevicesByPosition = new Map();
    const prefetchedDevices = await hydrateStagedIdentityBatch(candidates, index, deviceStore, pendingDevicesByPosition, stagedCount);
    for (const { candidate, rowNumber } of prepared) {
      if (!candidate) continue;
      throwIfAborted(signal);
      const resolution = await findStagedIdentityMatch(candidate, index, deviceStore, pendingDevicesByPosition, signal, prefetchedDevices);
      if (resolution.status === "matched") {
        recordIdentityConflicts(diagnostics, "Main", rowNumber, resolution);
        mergeDevice(resolution.match, candidate, "Main", { enrichmentFieldSettings });
        addIdentityToIndex(index, resolution.match, resolution.position);
        if (resolution.position < stagedCount) changedDevicesByPosition.set(resolution.position, resolution.match);
        retainDiagnosticSample(diagnostics, "decisions", { action: "MERGED_MAIN_DUPLICATE", row: rowNumber, id: resolution.match.id });
      } else {
        candidate.id = stableId(candidate);
        const position = stagedCount + pending.length;
        pending.push(candidate);
        pendingDevicesByPosition.set(position, candidate);
        addIdentityToIndex(index, candidate, position);
        retainDiagnosticSample(diagnostics, "decisions", { action: "CREATED_FROM_MAIN", row: rowNumber, id: candidate.id });
      }
    }
    if (changedDevicesByPosition.size) await deviceStore.writePositions(changedDevicesByPosition);
    if (pending.length) {
      await deviceStore.appendPage(pending, { offset: stagedCount, total: null, identityEntries: index.tokens });
      stagedCount += pending.length;
    } else await deviceStore.writeIdentityEntries(index.tokens, stagedCount);
    index.tokens.clear();
    prefetchedDevices.clear();
  };
  throwIfAborted(signal);
  for await (const row of inputRows(rows)) {
    inputBatch.push(row);
    if (inputBatch.length < KNOWLEDGE_LOOKUP_BATCH_SIZE) continue;
    await processBatch(inputBatch);
    inputBatch = [];
    await yieldToBrowserTask(signal);
  }
  if (inputBatch.length) await processBatch(inputBatch);
  if (!rowIndex) throw new Error("Основной файл не содержит данных");
  return { devices: deviceStore, rowCount: rowIndex, identityIndex: { tokens: new Map() } };
}

function applyPreviousFinal(device, previousIndex, diagnostics, enrichmentFieldSettings, previousUseCounts = null) {
  const result = findIdentityMatch(device, previousIndex);
  if (result.status !== "matched") return false;
  recordIdentityConflicts(diagnostics, "Previous Final", "", result);
  device.id = result.match.id || device.id;
  mergeDevice(device, result.match, "Previous Final", { enrichmentFieldSettings });
  if (previousUseCounts) {
    previousUseCounts[result.position] -= 1;
    if (previousUseCounts[result.position] === 0) trimComparisonDeviceInPlace(result.match);
  }
  return true;
}

async function createMainDevices(rows, mapping, diagnostics, enrichmentFieldSettings, signal, retainIdentityIndex = true) {
  const devices = [];
  let index = buildIdentityIndex(devices);
  let rowIndex = 0;
  throwIfAborted(signal);
  for await (const row of inputRows(rows)) {
    const rowNumber = rowIndex + 2;
    rowIndex += 1;
    if (rowIndex % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0) await yieldToBrowserTask(signal);
    const sourceRow = sourceRowArray(row);
    if (!sourceRow.some((value) => text(value))) continue;
    const candidate = mapRow(sourceRow, mapping, "Main");
    const hasConflictingIdentityAliases = recordNormalizedIdentityConflicts(diagnostics, "Main", rowNumber, candidate);
    if (rowIndex % 500 === 0) assertBrowserHeapReserve();
    if (hasConflictingIdentityAliases) {
      retainDiagnosticSample(diagnostics, "invalid", { source: "Main", row: rowNumber, reason: "Конфликтующие алиасы сильного идентификатора" });
      continue;
    }
    if (!hasStrongIdentity(candidate)) {
      retainDiagnosticSample(diagnostics, "invalid", { source: "Main", row: rowNumber, reason: "Нет MAC, serial или Device ID" });
      continue;
    }
    const resolution = findIdentityMatch(candidate, index);
    if (resolution.status === "matched") {
      recordIdentityConflicts(diagnostics, "Main", rowNumber, resolution);
      mergeDevice(resolution.match, candidate, "Main", { enrichmentFieldSettings });
      addIdentityToIndex(index, resolution.match, resolution.position);
      retainDiagnosticSample(diagnostics, "decisions", { action: "MERGED_MAIN_DUPLICATE", row: rowNumber, id: resolution.match.id });
    } else {
      candidate.id = stableId(candidate);
      devices.push(candidate);
      retainDiagnosticSample(diagnostics, "decisions", { action: "CREATED_FROM_MAIN", row: rowNumber, id: candidate.id });
      addIdentityToIndex(index, candidate, devices.length - 1);
    }
  }
  // Keep the index built while collapsing Main duplicates; SmartRoom can reuse
  // its strong identity tokens instead of rebuilding them from every device.
  if (!retainIdentityIndex) index.tokens.clear();
  return { devices, rowCount: rowIndex, identityIndex: retainIdentityIndex ? index : null };
}

async function enrichSmartroom(devices, rows, mapping, strategy, diagnostics, enrichmentFieldSettings, identityIndex = null, signal) {
  if (Array.isArray(rows) && rows.length === 0) {
    await devices.finalize?.(devices.count);
    return 0;
  }
  const isStaged = isPagedDeviceStore(devices);
  const index = identityIndex || (isStaged ? { tokens: new Map() } : await buildIdentityIndexAsync(devices, { signal }));
  const pending = [];
  const pendingDevicesByPosition = new Map();
  const changedDevicesByPosition = new Map();
  let stagedCount = isStaged ? devices.count : 0;
  const flush = async () => {
    if (!pending.length) return;
    await devices.appendPage(pending, { offset: stagedCount, total: null });
    stagedCount += pending.length;
    pending.length = 0;
    pendingDevicesByPosition.clear();
  };
  let rowIndex = 0;
  let inputBatch = [];
  const applyBatch = async (batch) => {
    const prepared = [];
    for (const row of batch) {
      const rowNumber = rowIndex + 2;
      rowIndex += 1;
      const sourceRow = sourceRowArray(row);
      if (!sourceRow.some((value) => text(value))) { prepared.push({ rowNumber }); continue; }
      const candidate = mapRow(sourceRow, mapping, "SmartRoom");
      const hasConflictingIdentityAliases = recordNormalizedIdentityConflicts(diagnostics, "SmartRoom", rowNumber, candidate);
      if (hasConflictingIdentityAliases) {
        retainDiagnosticSample(diagnostics, "invalid", { source: "SmartRoom", row: rowNumber, reason: "Конфликтующие алиасы сильного идентификатора" });
        prepared.push({ rowNumber });
        continue;
      }
      if (!hasStrongIdentity(candidate)) {
        retainDiagnosticSample(diagnostics, "invalid", { source: "SmartRoom", row: rowNumber, reason: "Нет сильного идентификатора" });
        prepared.push({ rowNumber });
        continue;
      }
      prepared.push({ candidate, rowNumber });
    }
    if (rowIndex % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0) assertBrowserHeapReserve();
    const candidates = prepared.filter((row) => row.candidate).map((row) => row.candidate);
    const prefetchedDevices = isStaged
      ? await hydrateStagedIdentityBatch(candidates, index, devices, pendingDevicesByPosition, stagedCount)
      : null;
    for (const { candidate, rowNumber } of prepared) {
      if (!candidate) continue;
      throwIfAborted(signal);
      const resolution = isStaged
        ? await findStagedIdentityMatch(candidate, index, devices, pendingDevicesByPosition, signal, prefetchedDevices)
        : findIdentityMatch(candidate, index);
      if (resolution.status === "matched") {
        recordIdentityConflicts(diagnostics, "SmartRoom", rowNumber, resolution);
        mergeDevice(resolution.match, candidate, "SmartRoom", { enrichmentFieldSettings });
        addIdentityToIndex(index, resolution.match, resolution.position);
        if (isStaged && resolution.position < stagedCount) changedDevicesByPosition.set(resolution.position, resolution.match);
        retainDiagnosticSample(diagnostics, "decisions", { action: "MATCHED_SMARTROOM", row: rowNumber, id: resolution.match.id });
        continue;
      }
      if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
        addDiagnosticConflict(diagnostics, { source: "SmartRoom", row: rowNumber, reason: "Неоднозначная идентификация" });
        continue;
      }
      if (strategy === STRATEGIES.ALLOW_EXPANSION) {
        candidate.id = stableId(candidate);
        if (isStaged) {
          const position = stagedCount + pending.length;
          pending.push(candidate);
          pendingDevicesByPosition.set(position, candidate);
          addIdentityToIndex(index, candidate, position);
          if (pending.length >= KNOWLEDGE_LOOKUP_BATCH_SIZE) await flush();
        } else {
          devices.push(candidate);
          addIdentityToIndex(index, candidate, devices.length - 1);
        }
        retainDiagnosticSample(diagnostics, "decisions", { action: "CREATED_FROM_SMARTROOM", row: rowNumber, id: candidate.id });
      } else {
        retainDiagnosticSample(diagnostics, "unmatched", { source: "SmartRoom", row: rowNumber, reason: "NO_EXPANSION" });
        retainDiagnosticSample(diagnostics, "decisions", { action: "NOT_CREATED_FROM_SMARTROOM", row: rowNumber, strategy });
      }
    }
    if (changedDevicesByPosition.size) {
      if (typeof devices.writePositions === "function") await devices.writePositions(changedDevicesByPosition);
      else for (const [position, device] of changedDevicesByPosition) await devices.writePage(position, [device]);
      changedDevicesByPosition.clear();
    }
    prefetchedDevices?.clear();
    if (isStaged && pending.length >= KNOWLEDGE_LOOKUP_BATCH_SIZE) await flush();
    if (isStaged && rowIndex % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0) {
      await devices.writeIdentityEntries(index.tokens, stagedCount + pending.length);
      index.tokens.clear();
    }
    if (rowIndex % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0) await yieldToBrowserTask(signal);
  };
  throwIfAborted(signal);
  const inputBatchSize = isStaged ? SMARTROOM_IDENTITY_PREFETCH_BATCH_SIZE : KNOWLEDGE_LOOKUP_BATCH_SIZE;
  for await (const row of inputRows(rows)) {
    inputBatch.push(row);
    if (inputBatch.length >= inputBatchSize) {
      await applyBatch(inputBatch);
      inputBatch = [];
    }
  }
  if (inputBatch.length) await applyBatch(inputBatch);
  await flush();
  if (isStaged && index.tokens.size) await devices.writeIdentityEntries(index.tokens, stagedCount);
  index.tokens.clear();
  await devices.finalize?.(devices.count);
  return rowIndex;
}

function applyOuiKnowledge(device, ouiIndex, detectorSettings) {
  const ouiVendor = detectorSettings.enabled && detectorSettings.useOui3 ? lookupOuiVendor(device.mac, ouiIndex) : "";
  if (!device.manufacturer && ouiVendor) {
    device.manufacturer = ouiVendor;
    device.vendorConfidence = 0.95;
    device.vendorSource = "OUI";
    device.fieldSources.manufacturer = "OUI";
    return true;
  }
  return false;
}

function applyModelKnowledge(device, knownModels, macModelRules, detectorSettings, allowMac5 = true) {
  const model = knownModels?.get(normalizeMac(device.mac));
  if (!device.model && text(model)) {
    device.model = text(model);
    device.fieldSources.model = "Known Models";
    return true;
  }
  if (allowMac5 && detectorSettings.enabled && detectorSettings.useMac5 && !device.model && device.mac) {
    const match = lookupMacModel(device.mac, macModelRules);
    if (match) {
      device.model = match.model;
      device.fieldSources.model = `MAC5 rule ${match.prefix}`;
      return true;
    }
  }
  return false;
}

async function applyKnowledgeLookupBatches(devices, needsLookup, loadLookup, applyLookup, signal) {
  await forEachDevicePage(devices, async (rows) => {
    const macs = [];
    for (const device of rows) {
      if (needsLookup(device)) macs.push(device.mac);
    }
    if (macs.length) {
      const lookup = await loadLookup(macs);
      assertBrowserHeapReserve();
      throwIfAborted(signal);
      let changed = false;
      for (const device of rows) {
        if (applyLookup(device, lookup) === true) changed = true;
      }
      return { changed };
    }
    return { changed: false };
  }, { signal, writeBack: (_rows, result) => result?.changed === true });
}

async function applyLocalVendorModelKnowledgeBatches(devices, {
  detectorSettings,
  ouiIndex,
  loadOuiIndex,
  knownModels,
  loadKnownModels,
  loadMac5Models,
  signal,
}) {
  await forEachDevicePage(devices, async (rows) => {
    let changed = false;
    const missingVendorMacs = [];
    for (const device of rows) if (!text(device.manufacturer)) missingVendorMacs.push(device.mac);
    if (missingVendorMacs.length) {
      const lookup = typeof loadOuiIndex === "function" ? await loadOuiIndex(missingVendorMacs) : ouiIndex;
      assertBrowserHeapReserve();
      throwIfAborted(signal);
      for (const device of rows) if (applyOuiKnowledge(device, lookup, detectorSettings)) changed = true;
    }

    const missingModelMacs = [];
    for (const device of rows) if (!text(device.model)) missingModelMacs.push(device.mac);
    if (missingModelMacs.length) {
      const lookup = typeof loadKnownModels === "function" ? await loadKnownModels(missingModelMacs) : knownModels;
      assertBrowserHeapReserve();
      throwIfAborted(signal);
      for (const device of rows) if (applyModelKnowledge(device, lookup, null, detectorSettings, false)) changed = true;
    }

    if (detectorSettings.enabled && detectorSettings.useMac5) {
      const remainingModelMacs = [];
      for (const device of rows) if (!text(device.model)) remainingModelMacs.push(device.mac);
      if (remainingModelMacs.length) {
        const rules = compileMacModelRules(
          typeof loadMac5Models === "function" ? await loadMac5Models(remainingModelMacs) : [],
          { includeBuiltins: true },
        );
        assertBrowserHeapReserve();
        throwIfAborted(signal);
        for (const device of rows) if (applyModelKnowledge(device, null, rules, detectorSettings)) changed = true;
      }
    }
    return { changed };
  }, { signal, writeBack: (_rows, result) => result?.changed === true });
}

async function loadDeviceIndexInBatches(devices, needsLookup, keyFor, loadIndex, { retain = true, apply = null, pageKeyFor = null, signal } = {}) {
  const index = retain ? new Map() : null;
  await forEachDevicePage(devices, async (rows) => {
    let changed = false;
    const keys = new Set();
    for (const device of rows) {
      if (!needsLookup(device)) continue;
      const key = keyFor(device);
      if (key) keys.add(key);
    }
    if (keys.size) {
      const page = await loadIndex([...keys]);
      assertBrowserHeapReserve();
      throwIfAborted(signal);
      if (retain) for (const [key, value] of page || []) index.set(key, value);
      if (apply) {
        for (const device of rows) {
          const key = keyFor(device);
          const pageKey = pageKeyFor ? pageKeyFor(key) : key;
          if (key && page?.has(pageKey) && apply(device, page.get(pageKey)) === true) changed = true;
        }
      }
    }
    return { changed };
    }, { signal, writeBack: (_rows, result) => Boolean(apply && result?.changed === true) });
  return index;
}

export async function enrich(options = {}) {
  const {
    mainRows = [],
    mainDevices = null,
    smartroomRows = [],
    ddioRows = [],
    mappings = {},
    strategy = STRATEGIES.NO_EXPANSION,
    previousFinal = [],
    previousIdentityIndex = null,
    loadPreviousIdentityIndex = null,
    trimConsumedPreviousFinal = false,
    ouiIndex = new Map(),
    loadOuiIndex = null,
    knownModels = new Map(),
    loadKnownModels = null,
    mac5Models = new Map(),
    loadMac5Models = null,
    loadLegacyVendorModelSuggestions = null,
    historicalAddressIndex = new Map(),
    loadHistoricalAddressIndex = null,
    retainHistoricalAddressIndex = true,
    ipAddressMappings = [],
    ipEnrichmentSettings = DEFAULT_IP_ENRICHMENT_SETTINGS,
    historicalRoomIndex = new Map(),
    loadHistoricalRoomIndex = null,
    loadImportedSmartroomRoomIndex = null,
    retainSmartroomRoomEvidence = true,
    vendorDetectorSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS,
    historyEnrichmentSettings = DEFAULT_HISTORY_ENRICHMENT_SETTINGS,
    enrichmentFieldSettings = DEFAULT_ENRICHMENT_FIELD_SETTINGS,
    deviceStore = null,
    onProgress = () => {},
    signal,
  } = options;
  const fieldSettings = normalizeEnrichmentFieldSettings(enrichmentFieldSettings);
  const historySettings = normalizeHistoryEnrichmentSettings(historyEnrichmentSettings);
  const ipSettings = normalizeIpEnrichmentSettings(ipEnrichmentSettings);
  const diagnostics = { invalid: [], conflicts: [], unmatched: [], decisions: [], counts: {} };
  const detectorSettings = normalizeVendorDetectorSettings(vendorDetectorSettings);
  const progress = async (value, stage) => {
    assertBrowserHeapReserve();
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    onProgress(value, stage);
    if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await progress(5, "Проверка входных данных");

  await progress(20, "Формирование уникальных устройств основного файла");
  if (Array.isArray(mainDevices)) {
    for (let index = 0; index < mainDevices.length; index += 1) {
      const conflict = normalizedIdentityAliasConflict(mainDevices[index]);
      if (conflict) {
        throw new Error(`Основной набор, строка ${index + 2}, содержит конфликт алиасов сильного идентификатора (${conflict.identifier || "неизвестное поле"})`);
      }
    }
  }
  const smartroomInputIsEmpty = Array.isArray(smartroomRows) && smartroomRows.length === 0;
  const main = Array.isArray(mainDevices)
    ? { devices: mainDevices, rowCount: mainDevices.length, identityIndex: smartroomInputIsEmpty ? null : await buildIdentityIndexAsync(mainDevices, { signal }) }
    : deviceStore
      ? await createMainDevicesInStage(mainRows, mappings.main || {}, diagnostics, fieldSettings, deviceStore, signal)
      : await createMainDevices(mainRows, mappings.main || {}, diagnostics, fieldSettings, signal, !smartroomInputIsEmpty);
  if (!main.rowCount) throw new Error("Основной файл не содержит данных");
  let devices = main.devices;
  let currentDeviceCount = deviceCount(devices);
  diagnostics.counts.mainRaw = main.rowCount;
  diagnostics.counts.mainUnique = currentDeviceCount;
  if (smartroomInputIsEmpty) main.identityIndex?.tokens?.clear();
  if (Array.isArray(mainDevices)) {
    for (let offset = 0; offset < currentDeviceCount; offset += KNOWLEDGE_LOOKUP_BATCH_SIZE) {
      throwIfAborted(signal);
      const end = Math.min(currentDeviceCount, offset + KNOWLEDGE_LOOKUP_BATCH_SIZE);
      for (let index = offset; index < end; index += 1) {
        if (!hasStrongIdentity(devices[index])) throw new Error("Основной набор содержит устройство без сильного идентификатора (MAC, serial или Device ID)");
      }
      await yieldToBrowserTask(signal);
    }
  }
  if (!currentDeviceCount) {
    throw new Error("В основном файле нет устройств с сильным идентификатором (MAC, serial или Device ID)");
  }

  await progress(40, "Сопоставление SmartRoom");
  diagnostics.counts.smartroomRaw = await enrichSmartroom(devices, smartroomRows, mappings.smartroom || {}, strategy, diagnostics, fieldSettings, main.identityIndex, signal);
  diagnostics.counts.afterSmartroom = deviceCount(devices);
  if (deviceStore && devices !== deviceStore) {
    if (!Array.isArray(devices) || typeof deviceStore.appendPage !== "function"
      || typeof deviceStore.readPage !== "function" || typeof deviceStore.writePage !== "function"
      || !Number.isSafeInteger(deviceStore.count) || deviceStore.count !== 0) {
      throw new TypeError("Для потокового enrichment нужен пустой постраничный Final store");
    }
    currentDeviceCount = devices.length;
    for (let offset = 0; offset < currentDeviceCount; offset += KNOWLEDGE_LOOKUP_BATCH_SIZE) {
      throwIfAborted(signal);
      const end = Math.min(currentDeviceCount, offset + KNOWLEDGE_LOOKUP_BATCH_SIZE);
      const page = devices.slice(offset, end);
      await deviceStore.appendPage(page, { offset, total: currentDeviceCount });
      page.length = 0;
      for (let index = offset; index < end; index += 1) devices[index] = null;
      await yieldToBrowserTask(signal);
    }
    devices.length = 0;
    if (deviceStore.count !== currentDeviceCount) throw new Error("Постраничное Final-хранилище подтвердило неверное число устройств");
    devices = deviceStore;
    await deviceStore.finalize?.(currentDeviceCount);
  }
  const currentRoomTargets = await collectCurrentSmartroomRoomTargets(devices, { signal });
  const currentRoomIndex = currentRoomTargets === null
    ? await buildCurrentSmartroomRoomIndexAsync(devices, { signal })
    : currentRoomTargets.size
      ? await buildCurrentSmartroomRoomIndexAsync(devices, { signal, targetIds: currentRoomTargets })
      : new Map();
  currentRoomTargets?.clear();
  let currentRoomFilled = 0;
  if (currentRoomIndex.size) {
    await applyDeviceBatches(devices, (device) => {
      const changed = Boolean(applySmartroomRoom(device, currentRoomIndex, "Current Smartroom ID mapping"));
      if (changed) currentRoomFilled += 1;
      return changed;
    }, signal);
  }
  currentRoomIndex.clear();
  diagnostics.counts.currentSmartroomRoomFilled = currentRoomFilled;

  await progress(58, "Использование предыдущего Final");
  if (typeof loadPreviousIdentityIndex === "function") {
    await forEachDevicePage(devices, async (rows) => {
      const previousIndex = await loadPreviousIdentityIndex(rows);
      if (!previousIndex?.tokens || !previousIndex.devices) throw new Error("Не удалось построить пакетный индекс предыдущего Final");
      let changed = false;
      for (let index = 0; index < rows.length; index += 1) {
        if (applyPreviousFinal(rows[index], previousIndex, diagnostics, fieldSettings)) changed = true;
      }
      previousIndex.tokens.clear();
      assertBrowserHeapReserve();
      return { changed };
    }, { signal, writeBack: (_rows, result) => result?.changed === true });
  } else if (previousFinal.length || previousIdentityIndex?.tokens?.size) {
    const ownsPreviousIndex = previousIdentityIndex?.devices !== previousFinal;
    const previousIndex = ownsPreviousIndex ? await buildIdentityIndexAsync(previousFinal, { signal }) : previousIdentityIndex;
    const previousUseCounts = trimConsumedPreviousFinal ? new Uint32Array(previousFinal.length) : null;
    if (previousUseCounts) {
      await forEachDevicePage(devices, (rows) => {
        for (const device of rows) {
          const match = findIdentityMatch(device, previousIndex);
          if (match.status === "matched") previousUseCounts[match.position] += 1;
        }
      }, { signal, writeBack: false });
    }
    await forEachDevicePage(devices, (rows) => {
      let changed = false;
      for (const device of rows) {
        if (applyPreviousFinal(device, previousIndex, diagnostics, fieldSettings, previousUseCounts)) changed = true;
      }
      return { changed };
    }, { signal, writeBack: (_rows, result) => result?.changed === true });
    if (previousUseCounts) {
      for (let index = 0; index < previousFinal.length; index += 1) {
        if (index % KNOWLEDGE_LOOKUP_BATCH_SIZE === 0 && index > 0) await yieldToBrowserTask(signal);
        trimComparisonDeviceInPlace(previousFinal[index]);
      }
      throwIfAborted(signal);
    }
    if (ownsPreviousIndex) previousIndex.tokens.clear();
  }
  const ipMappingIndex = createIpMappingIndex(ipAddressMappings, { partialMatch: ipSettings.partialMatch });
  let ipMappingFilled = 0;
  if (ipMappingIndex.exact.size || ipMappingIndex.partial.size) {
    await applyDeviceBatches(devices, (device) => {
      const changed = applyIpMapping(device, ipMappingIndex, ipSettings);
      if (changed) ipMappingFilled += 1;
      return changed;
    }, signal);
  }
  ipMappingIndex.exact.clear();
  ipMappingIndex.partial.clear();
  diagnostics.counts.ipMappingFilled = ipMappingFilled;
  let historicalAddressFilled = 0;
  let effectiveHistoricalAddressIndex = new Map();
  if (ipSettings.historicalAddress) {
    effectiveHistoricalAddressIndex = typeof loadHistoricalAddressIndex === "function"
      ? await loadDeviceIndexInBatches(
        devices,
        (device) => !text(device.address) && text(device.switchIp),
        (device) => text(device.switchIp),
        loadHistoricalAddressIndex,
        {
          retain: retainHistoricalAddressIndex,
          signal,
          apply: retainHistoricalAddressIndex ? null : (device, evidence) => {
            const switchIp = text(device.switchIp);
            const changed = Boolean(applyHistoricalAddress(device, { get: (key) => key === switchIp ? evidence : null }));
            if (changed) historicalAddressFilled += 1;
            return changed;
          },
        },
      )
      : historicalAddressIndex;
    if ((retainHistoricalAddressIndex || typeof loadHistoricalAddressIndex !== "function") && effectiveHistoricalAddressIndex.size) {
      await applyDeviceBatches(devices, (device) => {
        const changed = Boolean(applyHistoricalAddress(device, effectiveHistoricalAddressIndex));
        if (changed) historicalAddressFilled += 1;
        return changed;
      }, signal);
    }
  }
  diagnostics.counts.historicalAddressFilled = historicalAddressFilled;
  let historicalRoomFilled = 0;
  const retainRoomEvidence = Boolean(retainSmartroomRoomEvidence);
  const effectiveHistoricalRoomIndex = typeof loadHistoricalRoomIndex === "function"
    ? await loadDeviceIndexInBatches(
      devices,
      (device) => !text(device.room) && text(device.smartroomId),
      (device) => text(device.smartroomId),
      loadHistoricalRoomIndex,
      {
        retain: retainRoomEvidence,
        signal,
        pageKeyFor: keyText,
        apply: retainRoomEvidence ? null : (device, suggestion) => {
          const idKey = keyText(device.smartroomId);
          const changed = Boolean(applySmartroomRoom(device, { get: (key) => key === idKey ? suggestion : null }));
          if (changed) historicalRoomFilled += 1;
          return changed;
        },
      },
    )
    : historicalRoomIndex;
  if ((retainRoomEvidence || typeof loadHistoricalRoomIndex !== "function") && effectiveHistoricalRoomIndex?.size) {
    await applyDeviceBatches(devices, (device) => {
      const changed = Boolean(applySmartroomRoom(device, effectiveHistoricalRoomIndex));
      if (changed) historicalRoomFilled += 1;
      return changed;
    }, signal);
  }
  diagnostics.counts.historicalSmartroomRoomFilled = historicalRoomFilled;
  let importedRoomFilled = 0;
  const effectiveImportedRoomIndex = typeof loadImportedSmartroomRoomIndex === "function"
    ? await loadDeviceIndexInBatches(
      devices,
      (device) => !text(device.room) && text(device.smartroomId),
      (device) => text(device.smartroomId),
      loadImportedSmartroomRoomIndex,
      {
        retain: retainRoomEvidence,
        signal,
        pageKeyFor: keyText,
        apply: retainRoomEvidence ? null : (device, mapping) => {
          const idKey = keyText(device.smartroomId);
          const changed = Boolean(applyImportedSmartroomRoom(device, { get: (key) => key === idKey ? mapping : null }));
          if (changed) importedRoomFilled += 1;
          return changed;
        },
      },
    )
    : new Map();
  if ((retainRoomEvidence || typeof loadImportedSmartroomRoomIndex !== "function") && effectiveImportedRoomIndex?.size) {
    await applyDeviceBatches(devices, (device) => {
      const changed = Boolean(applyImportedSmartroomRoom(device, effectiveImportedRoomIndex));
      if (changed) importedRoomFilled += 1;
      return changed;
    }, signal);
  }
  diagnostics.counts.importedSmartroomRoomFilled = importedRoomFilled;

  await progress(70, "Сопоставление DDIO по MAC");
  const ddio = await buildDdIoIndexFromRows(ddioRows, mappings.ddio || {}, devices, { signal });
  assertBrowserHeapReserve();
  const ddioIndex = ddio.index;
  diagnostics.counts.ddioRaw = ddio.rowCount;
  let ddioFilled = 0;
  if (ddioIndex.size || ddioIndex.byDeviceId.size) {
    await applyDeviceBatches(devices, (device) => {
      const changed = applyDdIoIp(device, ddioIndex);
      if (changed) ddioFilled += 1;
      return changed;
    }, signal);
  }
  ddioIndex.clear();
  ddioIndex.byDeviceId.clear();
  diagnostics.counts.ddioMatchedIp = ddioFilled;

  const applyHistoricalVendorModelSuggestions = async () => {
    if (!historySettings.enabled || typeof loadLegacyVendorModelSuggestions !== "function") return;
    const applyHistoricalValue = (device, field, value, confidence, source, confidenceField, sourceField) => {
      const candidate = text(value);
      const candidateConfidence = Number(confidence) || 0;
      if (!candidate) return false;
      const current = text(device[field]);
      if (current) {
        if (!historySettings.priorityHistory) return false;
        const currentSource = text(device.fieldSources?.[field]
          || (field === "manufacturer" ? device.vendorSource : device.modelSource));
        const replaceableInference = /^Text:/i.test(currentSource)
          || currentSource === "Similar device inference"
          || currentSource.startsWith("vendor_model_history_");
        const currentConfidence = Number(device[confidenceField]) || 0;
        if (!replaceableInference || candidateConfidence <= currentConfidence) return false;
      }
      device[field] = candidate;
      device[confidenceField] = candidateConfidence;
      device[sourceField] = String(source || "vendor_model_history_exact");
      device.fieldSources ||= {};
      device.fieldSources[field] = device[sourceField];
      return true;
    };
    const hasPriorityHistoryCandidate = (device) => {
      if (!historySettings.priorityHistory) return false;
      const sources = [
        device.fieldSources?.manufacturer || device.vendorSource,
        device.fieldSources?.model || device.modelSource,
      ].map((source) => text(source));
      return sources.some((source) => source === "OUI"
        || source === "Known Models"
        || source === "Similar device inference"
        || /^Text:/i.test(source)
        || /^MAC5 rule /i.test(source)
        || source.startsWith("vendor_model_history_"));
    };
    await applyKnowledgeLookupBatches(
      devices,
      (device) => !text(device.manufacturer) || !text(device.model) || hasPriorityHistoryCandidate(device),
      (macs) => loadLegacyVendorModelSuggestions(macs, {
        useMac5Match: historySettings.useMac5Match,
        useOuiMatch: historySettings.useOuiMatch,
      }),
      (device, historicalVendorModels) => {
        const suggestion = historicalVendorModels?.get(normalizeMac(device.mac));
        if (!suggestion) return false;
        const vendorConfidence = Number(suggestion.vendorConfidence ?? suggestion.confidence) || 0;
        const modelConfidence = Number(suggestion.modelConfidence ?? suggestion.confidence) || 0;
        const vendorUpdated = applyHistoricalValue(device, "manufacturer", suggestion.vendor, vendorConfidence,
          suggestion.vendorSource || suggestion.source, "vendorConfidence", "vendorSource");
        if (vendorUpdated) device.vendor = device.vendor || device.manufacturer;
        const modelUpdated = applyHistoricalValue(device, "model", suggestion.model, modelConfidence,
          suggestion.modelSource || suggestion.source, "modelConfidence", "modelSource");
        return vendorUpdated || modelUpdated;
      },
      signal,
    );
  };

  const useWebHistoryPrecedence = historySettings.enabled
    && historySettings.priorityHistory
    && historySettings.precedenceProfile === "web";
  if (useWebHistoryPrecedence) await applyHistoricalVendorModelSuggestions();

  await progress(82, "Производители и модели");
  await applyLocalVendorModelKnowledgeBatches(devices, {
    detectorSettings,
    ouiIndex,
    loadOuiIndex,
    knownModels,
    loadKnownModels,
    loadMac5Models: typeof loadMac5Models === "function" ? loadMac5Models : () => mac5Models,
    signal,
  });
  const detectionCounts = await applyVendorDetectionAsync(devices, detectorSettings, { signal });
  diagnostics.counts.vendorFromSimilarDevices = detectionCounts.vendorFromInference;
  diagnostics.counts.vendorFromText = detectionCounts.vendorFromText;
  diagnostics.counts.modelFromSimilarDevices = detectionCounts.model;
  if (!useWebHistoryPrecedence) await applyHistoricalVendorModelSuggestions();

  await progress(92, "Финальная валидация");
  const observedAt = new Date().toISOString();
  // Devices created from imported rows are already owned by this pipeline. Reuse
  // the array and records here instead of retaining a second full Final copy.
  const final = devices;
  await applyDeviceBatches(final, (device) => {
    device.id = device.id || stableId(device);
    device.observedAt = observedAt;
    device.source = firstKnown(device.sources?.join(", "), "Main");
    return true;
  }, signal, { alwaysWriteBack: true });
  await assertUniqueDeviceIds(final, signal);
  const finalCount = deviceCount(final);
  diagnostics.counts.finalUnique = finalCount;
  await progress(100, "Готово");
  return {
    devices: Array.isArray(final) ? final : [],
    deviceCount: finalCount,
    deviceStore: isPagedDeviceStore(final) ? final : null,
    diagnostics,
    historicalAddressIndex: effectiveHistoricalAddressIndex,
    historicalRoomIndex: retainSmartroomRoomEvidence ? effectiveHistoricalRoomIndex : null,
    importedSmartroomRoomIndex: retainSmartroomRoomEvidence ? effectiveImportedRoomIndex : null,
  };
}

