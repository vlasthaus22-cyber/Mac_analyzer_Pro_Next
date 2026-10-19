import {
  firstKnown,
  hasStrongIdentity,
  keyText,
  MAX_DEVICE_CONFLICTS,
  normalizeDevice,
  normalizeIp,
  normalizeMac,
  text,
  unique,
  uniqueLimited,
} from "./normalize.js";
import { addIdentityToIndex, buildIdentityIndex, findIdentityMatch, stableId } from "./identity.js";
import { lookupOuiVendor } from "./ieee-registry.js";
import { applyHistoricalAddress, applyImportedSmartroomRoom, applySmartroomRoom, buildCurrentSmartroomRoomIndex } from "./historical-mapping.js";
import { compileMacModelRules, lookupMacModel } from "./model-knowledge.js";
import { applyVendorDetection, DEFAULT_VENDOR_DETECTOR_SETTINGS, normalizeVendorDetectorSettings } from "./vendor-detector.js";
import { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows } from "./ddio-overlay.js";
import { DEFAULT_ENRICHMENT_FIELD_SETTINGS, normalizeEnrichmentFieldSettings } from "./enrichment-settings.js";
import { trimComparisonDeviceInPlace } from "./compact-final-analytics.js";
import { assertBrowserHeapReserve } from "./import-limits.js";

export { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows };

export const STRATEGIES = Object.freeze({
  NO_EXPANSION: "NO_EXPANSION",
  ALLOW_EXPANSION: "ALLOW_EXPANSION",
});

const KNOWLEDGE_LOOKUP_BATCH_SIZE = 500;
const MAX_DIAGNOSTIC_SAMPLES = 1_000;

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
  for (const conflict of device.conflicts || []) {
    if (conflict.field !== "identity") continue;
    addDiagnosticConflict(diagnostics, {
      source,
      row,
      ...conflict,
      reason: conflict.reason || "Конфликтующие алиасы сильного идентификатора",
    });
  }
}

export function mergeDevice(target, incoming, source, options = {}) {
  const enabled = options.enrichmentFieldSettings
    ? normalizeEnrichmentFieldSettings(options.enrichmentFieldSettings)
    : DEFAULT_ENRICHMENT_FIELD_SETTINGS;
  for (const field of MERGE_FIELDS) {
    const setting = ENRICHMENT_FIELD_BY_DEVICE_FIELD[field];
    if (!setting || enabled[setting]) setKnown(target, field, incoming[field], source, options);
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
  const alternateMacs = uniqueLimited([
    ...(target.alternateMacs || []),
    ...(incoming.alternateMacs || []),
    incoming.mac && incoming.mac !== target.mac ? incoming.mac : "",
  ], normalizeMac);
  target.alternateMacs = alternateMacs.values.filter((mac) => mac !== target.mac);
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

async function createMainDevices(rows, mapping, diagnostics, enrichmentFieldSettings) {
  const devices = [];
  let index = buildIdentityIndex(devices);
  let rowIndex = 0;
  for await (const row of inputRows(rows)) {
    const rowNumber = rowIndex + 2;
    rowIndex += 1;
    const candidate = mapRow(row, mapping, "Main");
    recordNormalizedIdentityConflicts(diagnostics, "Main", rowNumber, candidate);
    if (rowIndex % 500 === 0) assertBrowserHeapReserve();
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
  index.tokens.clear();
  return { devices, rowCount: rowIndex };
}

async function enrichSmartroom(devices, rows, mapping, strategy, diagnostics, enrichmentFieldSettings) {
  let index = buildIdentityIndex(devices);
  let rowIndex = 0;
  for await (const row of inputRows(rows)) {
    const rowNumber = rowIndex + 2;
    rowIndex += 1;
    const candidate = mapRow(row, mapping, "SmartRoom");
    recordNormalizedIdentityConflicts(diagnostics, "SmartRoom", rowNumber, candidate);
    if (rowIndex % 500 === 0) assertBrowserHeapReserve();
    if (!hasStrongIdentity(candidate)) {
      retainDiagnosticSample(diagnostics, "invalid", { source: "SmartRoom", row: rowNumber, reason: "Нет сильного идентификатора" });
      continue;
    }
    const resolution = findIdentityMatch(candidate, index);
    if (resolution.status === "matched") {
      recordIdentityConflicts(diagnostics, "SmartRoom", rowNumber, resolution);
      mergeDevice(resolution.match, candidate, "SmartRoom", { enrichmentFieldSettings });
      addIdentityToIndex(index, resolution.match, resolution.position);
      retainDiagnosticSample(diagnostics, "decisions", { action: "MATCHED_SMARTROOM", row: rowNumber, id: resolution.match.id });
      continue;
    }
    if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
      addDiagnosticConflict(diagnostics, { source: "SmartRoom", row: rowNumber, reason: "Неоднозначная идентификация" });
      continue;
    }
    if (strategy === STRATEGIES.ALLOW_EXPANSION) {
      candidate.id = stableId(candidate);
      devices.push(candidate);
      retainDiagnosticSample(diagnostics, "decisions", { action: "CREATED_FROM_SMARTROOM", row: rowNumber, id: candidate.id });
      addIdentityToIndex(index, candidate, devices.length - 1);
    } else {
      retainDiagnosticSample(diagnostics, "unmatched", { source: "SmartRoom", row: rowNumber, reason: "NO_EXPANSION" });
      retainDiagnosticSample(diagnostics, "decisions", { action: "NOT_CREATED_FROM_SMARTROOM", row: rowNumber, strategy });
    }
  }
  index.tokens.clear();
  return rowIndex;
}

function applyOuiKnowledge(device, ouiIndex, detectorSettings) {
  const ouiVendor = detectorSettings.enabled && detectorSettings.useOui3 ? lookupOuiVendor(device.mac, ouiIndex) : "";
  if (!device.manufacturer && ouiVendor) {
    device.manufacturer = ouiVendor;
    device.fieldSources.manufacturer = "OUI";
  }
}

function applyModelKnowledge(device, knownModels, macModelRules, detectorSettings, allowMac5 = true) {
  const model = knownModels?.get(normalizeMac(device.mac));
  if (!device.model && text(model)) {
    device.model = text(model);
    device.fieldSources.model = "Known Models";
    return;
  }
  if (allowMac5 && detectorSettings.enabled && detectorSettings.useMac5 && !device.model && device.mac) {
    const match = lookupMacModel(device.mac, macModelRules);
    if (match) {
      device.model = match.model;
      device.fieldSources.model = `MAC5 rule ${match.prefix}`;
    }
  }
}

async function applyKnowledgeLookupBatches(devices, needsLookup, loadLookup, applyLookup) {
  for (let offset = 0; offset < devices.length; offset += KNOWLEDGE_LOOKUP_BATCH_SIZE) {
    const end = Math.min(devices.length, offset + KNOWLEDGE_LOOKUP_BATCH_SIZE);
    const macs = [];
    for (let index = offset; index < end; index += 1) {
      const device = devices[index];
      if (needsLookup(device)) macs.push(device.mac);
    }
    if (!macs.length) continue;
    const lookup = await loadLookup(macs);
    assertBrowserHeapReserve();
    for (let index = offset; index < end; index += 1) applyLookup(devices[index], lookup);
  }
}

async function loadDeviceIndexInBatches(devices, needsLookup, keyFor, loadIndex, { retain = true, apply = null, pageKeyFor = null } = {}) {
  const index = retain ? new Map() : null;
  for (let offset = 0; offset < devices.length; offset += KNOWLEDGE_LOOKUP_BATCH_SIZE) {
    const end = Math.min(devices.length, offset + KNOWLEDGE_LOOKUP_BATCH_SIZE);
    const keys = new Set();
    for (let position = offset; position < end; position += 1) {
      const device = devices[position];
      if (!needsLookup(device)) continue;
      const key = keyFor(device);
      if (key) keys.add(key);
    }
    if (!keys.size) continue;
    const page = await loadIndex([...keys]);
    assertBrowserHeapReserve();
    if (retain) for (const [key, value] of page || []) index.set(key, value);
    if (apply) {
      for (let position = offset; position < end; position += 1) {
        const device = devices[position];
        const key = keyFor(device);
        const pageKey = pageKeyFor ? pageKeyFor(key) : key;
        if (key && page?.has(pageKey)) apply(device, page.get(pageKey));
      }
    }
  }
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
    historicalRoomIndex = new Map(),
    loadHistoricalRoomIndex = null,
    loadImportedSmartroomRoomIndex = null,
    retainSmartroomRoomEvidence = true,
    vendorDetectorSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS,
    enrichmentFieldSettings = DEFAULT_ENRICHMENT_FIELD_SETTINGS,
    onProgress = () => {},
    signal,
  } = options;
  const fieldSettings = normalizeEnrichmentFieldSettings(enrichmentFieldSettings);
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
  const main = Array.isArray(mainDevices)
    ? { devices: mainDevices, rowCount: mainDevices.length }
    : await createMainDevices(mainRows, mappings.main || {}, diagnostics, fieldSettings);
  if (!main.rowCount) throw new Error("Основной файл не содержит данных");
  const devices = main.devices;
  diagnostics.counts.mainRaw = main.rowCount;
  diagnostics.counts.mainUnique = devices.length;

  await progress(40, "Сопоставление SmartRoom");
  diagnostics.counts.smartroomRaw = await enrichSmartroom(devices, smartroomRows, mappings.smartroom || {}, strategy, diagnostics, fieldSettings);
  diagnostics.counts.afterSmartroom = devices.length;
  const currentRoomIndex = buildCurrentSmartroomRoomIndex(devices);
  let currentRoomFilled = 0;
  for (const device of devices) if (applySmartroomRoom(device, currentRoomIndex, "Current Smartroom ID mapping")) currentRoomFilled += 1;
  currentRoomIndex.clear();
  diagnostics.counts.currentSmartroomRoomFilled = currentRoomFilled;

  await progress(58, "Использование предыдущего Final");
  const previousIndex = previousIdentityIndex?.devices === previousFinal
    ? previousIdentityIndex
    : buildIdentityIndex(previousFinal);
  const previousUseCounts = trimConsumedPreviousFinal ? new Uint32Array(previousFinal.length) : null;
  if (previousUseCounts) {
    for (const device of devices) {
      const match = findIdentityMatch(device, previousIndex);
      if (match.status === "matched") previousUseCounts[match.position] += 1;
    }
  }
  for (const device of devices) applyPreviousFinal(device, previousIndex, diagnostics, fieldSettings, previousUseCounts);
  if (previousUseCounts) for (const device of previousFinal) trimComparisonDeviceInPlace(device);
  let historicalAddressFilled = 0;
  const effectiveHistoricalAddressIndex = typeof loadHistoricalAddressIndex === "function"
    ? await loadDeviceIndexInBatches(
      devices,
      (device) => !text(device.address) && text(device.switchIp),
      (device) => text(device.switchIp),
      loadHistoricalAddressIndex,
      {
        retain: retainHistoricalAddressIndex,
        apply: retainHistoricalAddressIndex ? null : (device, evidence) => {
          if (applyHistoricalAddress(device, new Map([[text(device.switchIp), evidence]]))) historicalAddressFilled += 1;
        },
      },
    )
    : historicalAddressIndex;
  if (retainHistoricalAddressIndex || typeof loadHistoricalAddressIndex !== "function") {
    for (const device of devices) if (applyHistoricalAddress(device, effectiveHistoricalAddressIndex)) historicalAddressFilled += 1;
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
        pageKeyFor: keyText,
        apply: retainRoomEvidence ? null : (device, suggestion) => {
          const idKey = keyText(device.smartroomId);
          if (applySmartroomRoom(device, { get: (key) => key === idKey ? suggestion : null })) historicalRoomFilled += 1;
        },
      },
    )
    : historicalRoomIndex;
  if (retainRoomEvidence || typeof loadHistoricalRoomIndex !== "function") {
    for (const device of devices) if (applySmartroomRoom(device, effectiveHistoricalRoomIndex)) historicalRoomFilled += 1;
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
        pageKeyFor: keyText,
        apply: retainRoomEvidence ? null : (device, mapping) => {
          const idKey = keyText(device.smartroomId);
          if (applyImportedSmartroomRoom(device, { get: (key) => key === idKey ? mapping : null })) importedRoomFilled += 1;
        },
      },
    )
    : new Map();
  if (retainRoomEvidence || typeof loadImportedSmartroomRoomIndex !== "function") {
    for (const device of devices) if (applyImportedSmartroomRoom(device, effectiveImportedRoomIndex)) importedRoomFilled += 1;
  }
  diagnostics.counts.importedSmartroomRoomFilled = importedRoomFilled;

  await progress(70, "Сопоставление DDIO по MAC");
  const ddio = await buildDdIoIndexFromRows(ddioRows, mappings.ddio || {}, devices);
  assertBrowserHeapReserve();
  const ddioIndex = ddio.index;
  diagnostics.counts.ddioRaw = ddio.rowCount;
  let ddioFilled = 0;
  for (const device of devices) if (applyDdIoIp(device, ddioIndex)) ddioFilled += 1;
  ddioIndex.clear();
  ddioIndex.byDeviceId.clear();
  diagnostics.counts.ddioMatchedIp = ddioFilled;

  await progress(82, "Производители и модели");
  await applyKnowledgeLookupBatches(
    devices,
    (device) => !text(device.manufacturer),
    (macs) => typeof loadOuiIndex === "function" ? loadOuiIndex(macs) : ouiIndex,
    (device, lookup) => applyOuiKnowledge(device, lookup, detectorSettings),
  );
  await applyKnowledgeLookupBatches(
    devices,
    (device) => !text(device.model),
    (macs) => typeof loadKnownModels === "function" ? loadKnownModels(macs) : knownModels,
    (device, lookup) => applyModelKnowledge(device, lookup, null, detectorSettings, false),
  );
  if (detectorSettings.enabled && detectorSettings.useMac5) {
    await applyKnowledgeLookupBatches(
      devices,
      (device) => !text(device.model),
      async (macs) => {
        const effectiveMac5Models = typeof loadMac5Models === "function" ? await loadMac5Models(macs) : mac5Models;
        return compileMacModelRules(effectiveMac5Models, { includeBuiltins: true });
      },
      (device, rules) => applyModelKnowledge(device, null, rules, detectorSettings),
    );
  }
  await applyKnowledgeLookupBatches(
    devices,
    (device) => !text(device.manufacturer) || !text(device.model),
    (macs) => detectorSettings.enabled && typeof loadLegacyVendorModelSuggestions === "function"
      ? loadLegacyVendorModelSuggestions(macs)
      : new Map(),
    (device, historicalVendorModels) => {
      const suggestion = historicalVendorModels?.get(normalizeMac(device.mac));
      if (!suggestion) return;
      const vendorConfidence = Number(suggestion.vendorConfidence ?? suggestion.confidence) || 0;
      const modelConfidence = Number(suggestion.modelConfidence ?? suggestion.confidence) || 0;
      if (!text(device.manufacturer) && text(suggestion.vendor) && vendorConfidence >= detectorSettings.confidenceThreshold) {
        device.manufacturer = text(suggestion.vendor);
        device.vendor = device.vendor || device.manufacturer;
        device.vendorConfidence = vendorConfidence;
        device.fieldSources ||= {};
        device.fieldSources.manufacturer = String(suggestion.vendorSource || suggestion.source || "vendor_model_history_exact");
      }
      if (!text(device.model) && text(suggestion.model) && modelConfidence >= detectorSettings.confidenceThreshold) {
        device.model = text(suggestion.model);
        device.modelConfidence = modelConfidence;
        device.fieldSources ||= {};
        device.fieldSources.model = String(suggestion.modelSource || suggestion.source || "vendor_model_history_exact");
      }
    },
  );
  const detectionCounts = applyVendorDetection(devices, detectorSettings);
  diagnostics.counts.vendorFromSimilarDevices = detectionCounts.vendorFromInference;
  diagnostics.counts.vendorFromText = detectionCounts.vendorFromText;
  diagnostics.counts.modelFromSimilarDevices = detectionCounts.model;

  await progress(92, "Финальная валидация");
  const observedAt = new Date().toISOString();
  // Devices created from imported rows are already owned by this pipeline. Reuse
  // the array and records here instead of retaining a second full Final copy.
  const final = devices;
  for (const device of final) {
    device.id = device.id || stableId(device);
    device.observedAt = observedAt;
    device.source = firstKnown(device.sources?.join(", "), "Main");
  }
  const finalIds = new Set();
  for (const device of final) {
    if (finalIds.has(device.id)) throw new Error("После обогащения обнаружены дубли внутренних ID");
    finalIds.add(device.id);
  }
  diagnostics.counts.finalUnique = final.length;
  await progress(100, "Готово");
  return {
    devices: final,
    diagnostics,
    historicalAddressIndex: effectiveHistoricalAddressIndex,
    historicalRoomIndex: retainSmartroomRoomEvidence ? effectiveHistoricalRoomIndex : null,
    importedSmartroomRoomIndex: retainSmartroomRoomEvidence ? effectiveImportedRoomIndex : null,
  };
}

