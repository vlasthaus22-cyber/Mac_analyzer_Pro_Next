import { addIdentityToIndex, buildIdentityIndex, findIdentityMatch, identityTokens, normalizeAlternateMacValues, stableIdentity } from "./identity.js";
import { firstMac, keyText, locationKey, normalizeIp, normalizeMac, text } from "./normalize.js";
import { CRITICAL_CHANGE_FIELDS, isCriticalHistoryChange } from "./change-categories.js";

export const COMPARED_FIELDS = Object.freeze([
  ["ip", "IP устройства"],
  ["switchIp", "IP коммутатора"],
  ["switchPort", "Порт"],
  ["mac", "MAC"],
  ["alternateMacs", "Дополнительные MAC"],
  ["physicalAddress", "Физический адрес"],
  ["smartroomId", "Smartroom ID"],
  ["businessUnit", "ТБ"],
  ["city", "Город"],
  ["site", "Площадка"],
  ["floor", "Этаж"],
  ["room", "Помещение"],
  ["address", "Адрес"],
  ["manufacturer", "Производитель"],
  ["model", "Модель"],
  ["deviceType", "Тип устройства"],
  ["deviceId", "Device ID"],
  ["deviceName", "Название устройства"],
  ["hostname", "Hostname"],
  ["serial", "Серийный номер"],
]);

export const CURRENT_STATUS_MASK = Object.freeze({ changed: 1, unchanged: 2 });
const MAX_FINAL_HISTORY_DIAGNOSTIC_SAMPLES = 100;

function comparableValue(device, field) {
  if (field === "mac") return normalizeMac(device[field]) || text(device[field]);
  if (field === "alternateMacs") {
    return normalizeAlternateMacValues(device[field]).sort().join(", ");
  }
  return text(device[field]);
}

function backfillTimelineState(device, lastKnown) {
  const result = { ...device };
  for (const [field] of COMPARED_FIELDS) {
    if (!comparableValue(result, field) && lastKnown.has(field)) result[field] = lastKnown.get(field);
  }
  return result;
}

function rememberTimelineState(device, lastKnown) {
  for (const [field] of COMPARED_FIELDS) {
    if (comparableValue(device, field)) lastKnown.set(field, device[field]);
  }
}

function comparisonChanges(before, after, timestamp) {
  const changes = [];
  for (const [field, label] of COMPARED_FIELDS) {
    const oldValue = comparableValue(before, field);
    const newValue = comparableValue(after, field);
    if (!oldValue || !newValue || keyText(oldValue) === keyText(newValue)) continue;
    changes.push({ field, label, oldValue, newValue, timestamp });
  }
  return changes;
}

/** Compare current devices one batch at a time while retaining only baseline marks. */
export function createFinalHistoryComparisonStream(previous = [], timestamp = new Date().toISOString(), { previousIdentityIndex = null } = {}) {
  const previousIndex = previousIdentityIndex?.devices === previous ? previousIdentityIndex : buildIdentityIndex(previous);
  const matchedPrevious = new Uint8Array(previous.length);
  const ambiguousTokenKeys = new Set();
  const diagnosticSamples = [];
  let ambiguousCount = 0;
  let identityConflictCount = 0;
  let diagnosticSamplesTruncated = 0;
  let finished = false;
  const retainDiagnostic = (sample) => {
    if (diagnosticSamples.length < MAX_FINAL_HISTORY_DIAGNOSTIC_SAMPLES) diagnosticSamples.push(sample);
    else diagnosticSamplesTruncated += 1;
  };
  const identityLabel = (device) => stableIdentity(device) || identityTokens(device)[0]?.key?.slice(0, 200) || "weak-identity";

  return {
    process(currentBatch = [], visit = () => {}) {
      if (finished) throw new Error("Нельзя сравнивать устройства после завершения потока History");
      for (const after of currentBatch) {
        const resolution = findIdentityMatch(after, previousIndex);
        if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
          ambiguousCount += 1;
          retainDiagnostic({
            type: "ambiguous",
            identity: identityLabel(after),
            candidates: resolution.candidates.slice(0, 10).map((candidate) => identityLabel(candidate.device)),
            candidatesTruncated: Math.max(0, resolution.candidates.length - 10),
          });
          for (const candidate of resolution.candidates) if (Number.isInteger(candidate.position)) matchedPrevious[candidate.position] = 1;
          for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
          continue;
        }
        if (resolution.status !== "matched") {
          visit({ type: "added", device: after });
          continue;
        }
        const conflicts = resolution.identityConflicts || [];
        if (conflicts.length) {
          ambiguousCount += 1;
          identityConflictCount += conflicts.length;
          retainDiagnostic({
            type: "identity-conflict",
            identity: identityLabel(after),
            alternatives: conflicts.slice(0, 10).map((conflict) => identityLabel(conflict.alternative)),
            alternativesTruncated: Math.max(0, conflicts.length - 10),
          });
          if (Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
          for (const conflict of conflicts) if (Number.isInteger(conflict.position)) matchedPrevious[conflict.position] = 1;
          continue;
        }
        if (Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
        const changes = comparisonChanges(resolution.match, after, timestamp);
        if (changes.length) visit({ type: "modified", row: { identity: stableIdentity(after), before: resolution.match, after, changes } });
      }
    },
    finish(visit = () => {}) {
      if (finished) throw new Error("Поток History уже завершён");
      for (let position = 0; position < previous.length; position += 1) {
        const device = previous[position];
        if (matchedPrevious[position] !== 0 || identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) continue;
        visit({ type: "absent", device });
      }
      finished = true;
      return { ambiguousCount, identityConflictCount, diagnosticSamples, diagnosticSamplesTruncated };
    },
  };
}

/** Build compact comparison marks once; each status can then be streamed in output order. */
export function createFinalComparisonEventPlan(previous = [], current = [], timestamp = new Date().toISOString(), { previousIdentityIndex = null } = {}) {
  const previousIndex = previousIdentityIndex?.devices === previous ? previousIdentityIndex : buildIdentityIndex(previous);
  const matchedPrevious = new Uint8Array(previous.length);
  const ambiguousTokenKeys = new Set();
  const currentStatus = new Uint8Array(current.length);
  const matchedPosition = new Int32Array(current.length);
  matchedPosition.fill(-1);
  const criticalFields = new Set(CRITICAL_CHANGE_FIELDS);
  const CURRENT = { added: 1, modified: 2, unchanged: 3, ambiguous: 4 };
  const counts = { addedCount: 0, absentCount: 0, modifiedDeviceCount: 0, unchangedCount: 0, ambiguousCount: 0, identityConflictCount: 0 };

  for (let position = 0; position < current.length; position += 1) {
    const after = current[position];
    const resolution = findIdentityMatch(after, previousIndex);
    if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
      currentStatus[position] = CURRENT.ambiguous;
      counts.ambiguousCount += 1;
      for (const candidate of resolution.candidates) if (Number.isInteger(candidate.position)) matchedPrevious[candidate.position] = 1;
      for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
      continue;
    }
    if (resolution.status !== "matched") {
      currentStatus[position] = CURRENT.added;
      counts.addedCount += 1;
      continue;
    }
    const conflicts = resolution.identityConflicts || [];
    counts.identityConflictCount += conflicts.length;
    if (conflicts.length) {
      currentStatus[position] = CURRENT.ambiguous;
      counts.ambiguousCount += 1;
      if (Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
      for (const conflict of conflicts) if (Number.isInteger(conflict.position)) matchedPrevious[conflict.position] = 1;
      continue;
    }
    if (Number.isInteger(resolution.position)) {
      matchedPrevious[resolution.position] = 1;
      matchedPosition[position] = resolution.position;
    }
    if (comparisonChanges(resolution.match, after, timestamp).length) {
      currentStatus[position] = CURRENT.modified;
      counts.modifiedDeviceCount += 1;
    } else {
      currentStatus[position] = CURRENT.unchanged;
      counts.unchangedCount += 1;
    }
  }

  for (let position = 0; position < previous.length; position += 1) {
    const device = previous[position];
    if (matchedPrevious[position] === 0 && !identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) counts.absentCount += 1;
  }

  const eligibleAbsent = function* () {
    for (let position = 0; position < previous.length; position += 1) {
      const device = previous[position];
      if (matchedPrevious[position] !== 0 || identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) continue;
      yield { type: "absent", device };
    }
  };
  const events = function* (type) {
    if (type === "absent") {
      yield* eligibleAbsent();
      return;
    }
    for (let position = 0; position < current.length; position += 1) {
      if (type === "added" && currentStatus[position] === CURRENT.added) {
        yield { type, device: current[position] };
      } else if (type === "modified" && currentStatus[position] === CURRENT.modified) {
        const after = current[position];
        const before = previous[matchedPosition[position]];
        yield { type, row: { identity: stableIdentity(after), before, after, changes: comparisonChanges(before, after, timestamp) } };
      } else if (type === "unchanged" && currentStatus[position] === CURRENT.unchanged) {
        const after = current[position];
        const before = previous[matchedPosition[position]];
        yield { type, row: { identity: stableIdentity(after), before, after, changes: [] } };
      } else if (type === "ambiguous" && currentStatus[position] === CURRENT.ambiguous) {
        const after = current[position];
        const resolution = findIdentityMatch(after, previousIndex);
        const candidates = resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched
          ? resolution.candidates.map((candidate) => candidate.device)
          : resolution.status === "matched"
            ? [resolution.match, ...(resolution.identityConflicts || []).map((conflict) => conflict.alternative).filter(Boolean)]
            : [];
        const conflicts = resolution.identityConflicts || [];
        yield {
          type,
          item: {
            after,
            candidates,
            ...(!candidates.length ? { reason: "insufficient-strong-identity" } : {}),
            ...(conflicts.length ? { reason: "conflicting-strong-identifiers" } : {}),
          },
          identityConflicts: conflicts.map((conflict) => ({ after, ...conflict })),
        };
      }
    }
  };
  const critical = function* () {
    for (const event of events("modified")) {
      const changes = event.row.changes.filter((change) => criticalFields.has(change.field)
        && text(change.oldValue) && text(change.newValue) && keyText(change.oldValue) !== keyText(change.newValue));
      if (changes.length) yield { ...event.row, changes };
    }
  };
  const identityConflicts = function* () {
    for (const event of events("ambiguous")) yield* event.identityConflicts;
  };
  return { ...counts, timestamp, events, critical, identityConflicts };
}

/** Stream comparison records in the same status order as compareFinals without retaining status row arrays. */
export function* finalComparisonEvents(previous = [], current = [], timestamp = new Date().toISOString(), options = {}) {
  const plan = createFinalComparisonEventPlan(previous, current, timestamp, options);
  for (const type of ["added", "absent", "modified", "unchanged", "ambiguous"]) yield* plan.events(type);
}

export function compareFinals(previous = [], current = [], timestamp = new Date().toISOString(), {
  includeUnchangedRows = true,
  includeCriticalRows = true,
  includeDiagnosticRows = true,
  collectRows = true,
  onAdded = null,
  onAbsent = null,
  onModified = null,
  onUnchanged = null,
  onAmbiguous = null,
  deviceMatches = () => true,
  includeStatusClassifier = false,
  includeAbsentPositionMask = false,
  includeCurrentStatusMask = false,
  previousIdentityIndex = null,
} = {}) {
  const previousIndex = previousIdentityIndex?.devices === previous ? previousIdentityIndex : buildIdentityIndex(previous);
  const matchedPrevious = new Uint8Array(previous.length);
  const absentPositionMask = includeAbsentPositionMask ? matchedPrevious : null;
  const added = [];
  const modified = [];
  const unchanged = [];
  let unchangedCount = 0;
  const ambiguous = [];
  const identityConflicts = [];
  const ambiguousTokenKeys = new Set();
  let addedCount = 0;
  let modifiedDeviceCount = 0;
  let absentCount = 0;
  let ambiguousCount = 0;
  let identityConflictCount = 0;
  const currentStatusMask = includeCurrentStatusMask ? new Uint8Array(current.length) : null;

  for (let currentPosition = 0; currentPosition < current.length; currentPosition += 1) {
    const after = current[currentPosition];
    const resolution = findIdentityMatch(after, previousIndex);
    if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
      const candidates = resolution.candidates.map((candidate) => candidate.device);
      ambiguousCount += 1;
      for (const candidate of resolution.candidates) {
        if (Number.isInteger(candidate.position)) matchedPrevious[candidate.position] = 1;
      }
      for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
      const item = { after, candidates, ...(!candidates.length ? { reason: "insufficient-strong-identity" } : {}) };
      if (includeDiagnosticRows) ambiguous.push(item);
      onAmbiguous?.(item);
      continue;
    }
    if (resolution.status !== "matched") {
      if (deviceMatches(after)) {
        addedCount += 1;
        if (collectRows) added.push(after);
        onAdded?.(after);
      }
      continue;
    }
    const before = resolution.match;
    const conflicts = resolution.identityConflicts || [];
    identityConflictCount += conflicts.length;
    if (includeDiagnosticRows) for (const conflict of conflicts) identityConflicts.push({ after, ...conflict });
    if (conflicts.length) {
      const candidates = [before, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)];
      if (Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
      for (const conflict of conflicts) if (Number.isInteger(conflict.position)) matchedPrevious[conflict.position] = 1;
      ambiguousCount += 1;
      const item = { after, candidates, reason: "conflicting-strong-identifiers" };
      if (includeDiagnosticRows) ambiguous.push(item);
      onAmbiguous?.(item);
      continue;
    }
    if (Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
    const changes = comparisonChanges(before, after, timestamp);
    const row = { identity: stableIdentity(after), before, after, changes };
    const matches = deviceMatches(after);
    if (changes.length) {
      if (matches) {
        if (currentStatusMask) currentStatusMask[currentPosition] = CURRENT_STATUS_MASK.changed;
        modifiedDeviceCount += 1;
        if (collectRows) modified.push(row);
        onModified?.(row);
      }
    }
    else {
      if (matches) {
        if (currentStatusMask) currentStatusMask[currentPosition] = CURRENT_STATUS_MASK.unchanged;
        unchangedCount += 1;
        if (includeUnchangedRows) unchanged.push(row);
        onUnchanged?.(row);
      }
    }
  }

  const absent = [];
  for (let position = 0; position < previous.length; position += 1) {
    const device = previous[position];
    if (matchedPrevious[position] !== 0
      || identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))
      || !deviceMatches(device)) continue;
    absentCount += 1;
    if (absentPositionMask) absentPositionMask[position] = 2;
    if (collectRows) absent.push(device);
    onAbsent?.(device);
  }
  if (absentPositionMask) {
    for (let position = 0; position < absentPositionMask.length; position += 1) {
      absentPositionMask[position] = absentPositionMask[position] === 2 ? 1 : 0;
    }
  }
  const criticalFields = new Set(CRITICAL_CHANGE_FIELDS);
  const critical = includeCriticalRows && collectRows ? modified.map((row) => ({
    ...row,
    changes: row.changes.filter((change) => criticalFields.has(change.field)
      && text(change.oldValue) && text(change.newValue) && keyText(change.oldValue) !== keyText(change.newValue)),
  })).filter((row) => row.changes.length > 0) : [];
  const statusClassifier = includeStatusClassifier ? (device) => {
    const resolution = findIdentityMatch(device, previousIndex);
    if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) return "unresolved";
    if (resolution.status !== "matched") return "added";
    if (resolution.identityConflicts?.length) return "unresolved";
    if (!deviceMatches(device)) return "filtered";
    const before = resolution.match;
    return COMPARED_FIELDS.some(([field]) => {
      const oldValue = comparableValue(before, field);
      const newValue = comparableValue(device, field);
      return Boolean(oldValue && newValue && keyText(oldValue) !== keyText(newValue));
    }) ? "changed" : "unchanged";
  } : null;
  return { added, absent, modified, unchanged, unchangedCount, addedCount, absentCount, modifiedDeviceCount, ambiguousCount, identityConflictCount, critical, ambiguous, identityConflicts, timestamp,
    ...(absentPositionMask ? { absentPositionMask } : {}), ...(currentStatusMask ? { currentStatusMask } : {}), ...(statusClassifier ? { statusClassifier } : {}) };
}

/** Compare an observation with only its bounded Inventory candidates; a partial file cannot imply device absences. */
export function compareInventoryObservation(current = [], candidates = new Map(), timestamp = new Date().toISOString()) {
  const previousById = new Map();
  for (const candidate of candidates.values()) {
    for (const record of candidate?.records || []) if (record?.id) previousById.set(String(record.id), record);
  }
  const comparison = compareFinals([...previousById.values()], current, timestamp, { includeUnchangedRows: false });
  comparison.absent = [];
  return comparison;
}

/** Reuse a unique Inventory identity for partial observations without letting an alternate MAC replace its canonical MAC. */
export function reconcileInventoryObservation(current = [], candidates = new Map()) {
  const inventory = new Map();
  for (const candidate of candidates.values()) {
    for (const record of candidate?.records || []) if (record?.id) inventory.set(String(record.id), record);
  }
  if (!inventory.size) return current;
  const index = buildIdentityIndex([...inventory.values()]);
  reconcileInventoryWithIndex(current, index);
  return current;
}

function reconcileInventoryWithIndex(current, index) {
  for (const device of current) {
    const resolution = findIdentityMatch(device, index);
    if (resolution.status !== "matched" || resolution.identityConflicts?.length) continue;
    const record = resolution.match;
    if (!record?.id) continue;
    if (resolution.matchPriority === 4 && normalizeMac(device.mac) && normalizeMac(record.mac)
      && normalizeMac(device.mac) !== normalizeMac(record.mac)) {
      device.alternateMacs = [...new Set([...(record.alternateMacs || []), ...(device.alternateMacs || []), device.mac]
        .map(normalizeMac).filter((mac) => mac && mac !== normalizeMac(record.mac)))];
      device.mac = record.mac;
      if (record.fieldSources?.mac) {
        device.fieldSources ||= {};
        device.fieldSources.mac = record.fieldSources.mac;
      }
    }
    device.id = String(record.id);
  }
}

/** Reconcile and compare one partial Inventory observation while releasing its candidate map before comparison. */
export function reconcileAndCompareInventoryObservation(current = [], candidates = new Map(), timestamp = new Date().toISOString()) {
  const recordsById = new Map();
  for (const candidate of candidates.values()) {
    for (const record of candidate?.records || []) if (record?.id) recordsById.set(String(record.id), record);
  }
  candidates.clear?.();
  const previous = [...recordsById.values()];
  recordsById.clear();
  const previousIdentityIndex = buildIdentityIndex(previous);
  reconcileInventoryWithIndex(current, previousIdentityIndex);
  const comparison = compareFinals(previous, current, timestamp, {
    includeUnchangedRows: false,
    previousIdentityIndex,
  });
  comparison.absent = [];
  return comparison;
}

/** Collect Inventory comparison candidates a page at a time, retaining one shared identity index. */
export function createInventoryObservationComparator(current = [], timestamp = new Date().toISOString()) {
  const previous = [];
  const previousIdentityIndex = buildIdentityIndex(previous);
  const seenIds = new Set();
  let finished = false;
  return Object.freeze({
    acceptCandidates(candidates = new Map()) {
      if (finished) throw new Error("Сравнение Inventory уже завершено");
      for (const candidate of candidates.values()) {
        for (const record of candidate?.records || []) {
          const id = record?.id == null ? "" : String(record.id);
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          previous.push(record);
          addIdentityToIndex(previousIdentityIndex, record, previous.length - 1);
        }
      }
    },
    finish() {
      if (finished) throw new Error("Сравнение Inventory уже завершено");
      finished = true;
      reconcileInventoryWithIndex(current, previousIdentityIndex);
      const comparison = compareFinals(previous, current, timestamp, {
        includeUnchangedRows: false,
        previousIdentityIndex,
      });
      comparison.absent = [];
      seenIds.clear();
      return comparison;
    },
  });
}

export function createFinalComparisonSummary(previous = [], timestamp = new Date().toISOString(), {
  deviceMatches = () => true,
  deviceCount = null,
  includeAbsentPositionMask = false,
  includeCurrentStatusMask = false,
  onAdded = null,
  onModified = null,
  onAbsent = null,
  onUnchanged = null,
  onAmbiguous = null,
  onIdentityConflict = null,
} = {}) {
  if (includeCurrentStatusMask && (!Number.isInteger(deviceCount) || deviceCount < 0)) {
    throw new TypeError("Для маски статуса current нужен точный размер Final");
  }
  let baselineDevices = previous;
  let index = buildIdentityIndex(baselineDevices);
  let matched = new Uint8Array(baselineDevices.length);
  const absentPositionMask = includeAbsentPositionMask ? matched : null;
  let ambiguousTokenKeys = new Set();
  let finishedResult = null;
  const summary = {
    added: 0,
    modified: 0,
    absent: 0,
    unchanged: 0,
    identityConflicts: 0,
    ambiguous: 0,
    modifiedEventCount: 0,
    criticalModifiedEventCount: 0,
    criticalModifiedDeviceCount: 0,
    codecChanges: 0,
    fieldChanges: new Map(),
    absentVendors: new Map(),
    rooms: new Set(),
    macs: new Set(),
    currentPosition: 0,
    currentStatusMask: includeCurrentStatusMask ? new Uint8Array(deviceCount) : null,
    absentPositionMask,
    timestamp,
  };
  return Object.freeze({
    observeChunk(devices = []) {
      if (finishedResult) throw new Error("Потоковое сравнение уже завершено");
      for (const after of devices) {
        const position = summary.currentPosition++;
        const resolution = findIdentityMatch(after, index);
        if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
          summary.ambiguous += 1;
          resolution.candidates.forEach((candidate) => { matched[candidate.position] = 1; });
          for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
          onAmbiguous?.({ after, candidates: resolution.candidates.map((candidate) => candidate.device), ...(!resolution.candidates.length ? { reason: "insufficient-strong-identity" } : {}) }, position);
          continue;
        }
        if (resolution.status !== "matched") {
          if (deviceMatches(after)) {
            summary.added += 1;
            onAdded?.(after, position);
          }
          continue;
        }
        matched[resolution.position] = 1;
        const before = resolution.match;
        const conflicts = resolution.identityConflicts || [];
        summary.identityConflicts += conflicts.length;
        if (conflicts.length) {
          for (const conflict of conflicts) if (Number.isInteger(conflict.position)) matched[conflict.position] = 1;
          summary.ambiguous += 1;
          for (const conflict of conflicts) onIdentityConflict?.({ after, ...conflict }, position);
          onAmbiguous?.({ after, candidates: [before, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)], reason: "conflicting-strong-identifiers" }, position);
          continue;
        }
        const changes = [];
        for (const [field, label] of COMPARED_FIELDS) {
          const oldValue = comparableValue(before, field);
          const newValue = comparableValue(after, field);
          if (oldValue && newValue && keyText(oldValue) !== keyText(newValue)) changes.push({ field, label, oldValue, newValue, timestamp });
        }
        if (!deviceMatches(after)) continue;
        if (changes.length) {
          summary.modified += 1;
          summary.modifiedEventCount += changes.length;
          let criticalDevice = false;
          for (const change of changes) {
            summary.fieldChanges.set(change.label, (summary.fieldChanges.get(change.label) || 0) + 1);
            if (isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) {
              summary.criticalModifiedEventCount += 1;
              criticalDevice = true;
            }
          }
          if (criticalDevice) summary.criticalModifiedDeviceCount += 1;
          if (keyText(after.deviceType) === "video conference") summary.codecChanges += 1;
          if (summary.currentStatusMask && position < summary.currentStatusMask.length) summary.currentStatusMask[position] = CURRENT_STATUS_MASK.changed;
          const room = locationKey(after);
          const mac = normalizeMac(after.mac);
          if (room) summary.rooms.add(room);
          if (mac) summary.macs.add(mac);
          onModified?.({ identity: stableIdentity(after), before, after, changes }, position);
        } else {
          summary.unchanged += 1;
          if (summary.currentStatusMask && position < summary.currentStatusMask.length) summary.currentStatusMask[position] = CURRENT_STATUS_MASK.unchanged;
          onUnchanged?.({ identity: stableIdentity(after), before, after, changes }, position);
        }
      }
    },
    finish() {
      if (finishedResult) return finishedResult;
      if (summary.currentStatusMask && summary.currentPosition !== summary.currentStatusMask.length) {
        throw new Error("Число строк в потоке current Final не совпало с размером маски статусов");
      }
      const absentVendors = new Map();
      summary.absent = 0;
      for (let position = 0; position < baselineDevices.length; position += 1) {
        const device = baselineDevices[position];
        const unresolved = identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key));
        if (matched[position] !== 0 || unresolved || !deviceMatches(device)) continue;
        summary.absent += 1;
        if (summary.absentPositionMask) summary.absentPositionMask[position] = 2;
        const vendor = String(device.manufacturer || device.vendor || "Unknown").trim() || "Unknown";
        absentVendors.set(vendor, (absentVendors.get(vendor) || 0) + 1);
        onAbsent?.(device, position);
      }
      if (summary.absentPositionMask) {
        for (let position = 0; position < summary.absentPositionMask.length; position += 1) {
          summary.absentPositionMask[position] = summary.absentPositionMask[position] === 2 ? 1 : 0;
        }
      }
      summary.absentVendors = absentVendors;
      finishedResult = {
        added: summary.added,
        modified: summary.modified,
        absent: summary.absent,
        unchanged: summary.unchanged,
        identityConflicts: summary.identityConflicts,
        ambiguous: summary.ambiguous,
        modifiedEventCount: summary.modifiedEventCount,
        criticalModifiedEventCount: summary.criticalModifiedEventCount,
        criticalModifiedDeviceCount: summary.criticalModifiedDeviceCount,
        codecChanges: summary.codecChanges,
        fieldChanges: Object.fromEntries(summary.fieldChanges),
        absentVendors: Object.fromEntries(summary.absentVendors),
        ...(summary.absentPositionMask ? { absentPositionMask: summary.absentPositionMask } : {}),
        ...(summary.currentStatusMask ? { currentStatusMask: summary.currentStatusMask } : {}),
        rooms: [...summary.rooms],
        macs: [...summary.macs],
        timestamp,
      };
      baselineDevices = null;
      index = null;
      matched = null;
      ambiguousTokenKeys = null;
      summary.fieldChanges.clear();
      summary.absentVendors.clear();
      summary.rooms.clear();
      summary.macs.clear();
      return finishedResult;
    },
  });
}

export async function compareFinalUnchangedPage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения неизменившихся устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks((chunk = []) => {
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status !== "matched") continue;
      if (resolution.identityConflicts?.length) continue;
      if (!deviceMatches(after)) continue;
      const before = resolution.match;
      const changed = COMPARED_FIELDS.some(([field]) => {
        const oldValue = comparableValue(before, field);
        const newValue = comparableValue(after, field);
        return Boolean(oldValue && newValue && keyText(oldValue) !== keyText(newValue));
      });
      if (changed) continue;
      total += 1;
      if (total > start && devices.length < pageSize) devices.push(after);
    }
  });
  return { devices, total, offset: start, limit: pageSize, hasPrevious: start > 0, hasNext: start + devices.length < total };
}

/** Read one bounded page of identity diagnostics without retaining every diagnostic row. */
export async function compareFinalIdentityDiagnosticPage(previous = [], visitCurrentChunks, {
  offset = 0,
  limit = 100,
  timestamp = new Date().toISOString(),
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для диагностики идентичности нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const rows = [];
  let total = 0;
  const keep = (type, row) => {
    total += 1;
    if (total > start && rows.length < pageSize) rows.push({ type, row });
  };
  const comparison = createFinalComparisonSummary(previous, timestamp, {
    onAmbiguous: (row) => keep("ambiguous", row),
    onIdentityConflict: (row) => keep("identityConflict", row),
  });
  await visitCurrentChunks((chunk = []) => comparison.observeChunk(chunk));
  const summary = comparison.finish();
  if (total !== summary.ambiguous + summary.identityConflicts) {
    throw new Error("Страницы диагностики идентичности не совпали с точными счётчиками сравнения");
  }
  return {
    rows,
    total,
    ambiguousCount: summary.ambiguous,
    identityConflictCount: summary.identityConflicts,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + rows.length < total,
  };
}

export async function compareFinalDevicePage(visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для списка устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const devices = [];
  let total = 0;
  await visitCurrentChunks((chunk = []) => {
    for (const device of chunk) {
      if (!deviceMatches(device)) continue;
      total += 1;
      if (total > start && devices.length < pageSize) devices.push(device);
    }
  });
  return { devices, total, offset: start, limit: pageSize, hasPrevious: start > 0, hasNext: start + devices.length < total };
}

export async function compareFinalAbsencePage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения отсутствующих устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const matched = new Uint8Array(previous.length);
  const ambiguousTokenKeys = new Set();
  await visitCurrentChunks((devices = []) => {
    for (const after of devices) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
        resolution.candidates.forEach((candidate) => { matched[candidate.position] = 1; });
        for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
        continue;
      }
      if (resolution.status === "matched") {
        matched[resolution.position] = 1;
        for (const conflict of resolution.identityConflicts || []) if (Number.isInteger(conflict.position)) matched[conflict.position] = 1;
      }
    }
  });

  const devices = [];
  let total = 0;
  previous.forEach((device, position) => {
    const unresolved = identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key));
    if (matched[position] !== 0 || unresolved || !deviceMatches(device)) return;
    total += 1;
    if (total > start && devices.length < pageSize) devices.push(device);
  });
  return {
    devices,
    total,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + devices.length < total,
  };
}

export async function compareFinalAdditionPage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения добавленных устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks((chunk = []) => {
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) continue;
      if (resolution.status === "matched") continue;
      if (!deviceMatches(after)) continue;
      total += 1;
      if (total > start && devices.length < pageSize) devices.push(after);
    }
  });
  return {
    devices,
    total,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + devices.length < total,
  };
}

export async function compareFinalModifiedDevicePage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для списка изменённых устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks((chunk = []) => {
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status !== "matched" || resolution.identityConflicts?.length || !deviceMatches(after)) continue;
      const before = resolution.match;
      const changed = COMPARED_FIELDS.some(([field]) => {
        const oldValue = comparableValue(before, field);
        const newValue = comparableValue(after, field);
        return Boolean(oldValue && newValue && keyText(oldValue) !== keyText(newValue));
      });
      if (!changed) continue;
      total += 1;
      if (total > start && devices.length < pageSize) devices.push(after);
    }
  });
  return { devices, total, offset: start, limit: pageSize, hasPrevious: start > 0, hasNext: start + devices.length < total };
}

export async function compareFinalModificationEventPage(previous = [], visitCurrentChunks, {
  offset = 0,
  limit = 100,
  timestamp = new Date().toISOString(),
  criticalOnly = false,
  deviceType = "",
  deviceMatches = () => true,
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения изменений нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const events = [];
  let total = 0;
  const normalizedDeviceType = keyText(deviceType);
  await visitCurrentChunks((devices = []) => {
    for (const after of devices) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status !== "matched" || resolution.identityConflicts?.length) continue;
      if (!deviceMatches(after)) continue;
      if (normalizedDeviceType && keyText(after.deviceType) !== normalizedDeviceType) continue;
      const before = resolution.match;
      const changes = [];
      for (const [field, label] of COMPARED_FIELDS) {
        const oldValue = comparableValue(before, field);
        const newValue = comparableValue(after, field);
        if (!oldValue || !newValue || keyText(oldValue) === keyText(newValue)) continue;
        const change = { field, label, oldValue, newValue, timestamp };
        if (criticalOnly && !isCriticalHistoryChange("modified", field, oldValue, newValue)) continue;
        changes.push(change);
      }
      if (!changes.length) continue;
      for (const change of changes) {
        if (total >= start && events.length < pageSize) {
          events.push({
            type: "modified",
            severity: isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue) ? "critical" : "other",
            device: after,
            before,
            change,
            modificationOffset: total,
          });
        }
        total += 1;
      }
    }
  });
  return {
    events,
    total,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + events.length < total,
  };
}

export async function compareFinalModificationDeviceGroupPage(previous = [], visitCurrentChunks, {
  offset = 0,
  limit = 100,
  timestamp = new Date().toISOString(),
  criticalOnly = false,
  deviceMatches = () => true,
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для группировки изменений нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = buildIdentityIndex(previous);
  const groups = [];
  let total = 0;
  let totalEvents = 0;
  await visitCurrentChunks((devices = []) => {
    for (const after of devices) {
      const resolution = findIdentityMatch(after, index);
      if (resolution.status !== "matched" || resolution.identityConflicts?.length || !deviceMatches(after)) continue;
      const before = resolution.match;
      const changes = [];
      for (const [field, label] of COMPARED_FIELDS) {
        const oldValue = comparableValue(before, field);
        const newValue = comparableValue(after, field);
        if (!oldValue || !newValue || keyText(oldValue) === keyText(newValue)) continue;
        if (criticalOnly && !isCriticalHistoryChange("modified", field, oldValue, newValue)) continue;
        changes.push({ field, label, oldValue, newValue, timestamp });
      }
      if (!changes.length) continue;
      if (total >= start && groups.length < pageSize) {
        groups.push({
          type: "modified",
          severity: changes.some((change) => isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) ? "critical" : "other",
          device: after,
          before,
          changes,
        });
      }
      total += 1;
      totalEvents += changes.length;
    }
  });
  return {
    groups,
    total,
    totalEvents,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + groups.length < total,
  };
}

function timelineHistoryKey(snapshotId, field, oldValue, newValue) {
  if (!snapshotId || !field) return "";
  return JSON.stringify([String(snapshotId), String(field), String(oldValue ?? ""), String(newValue ?? "")]);
}

export function indexMacTimelineHistory(events = []) {
  const index = new Map();
  index.standaloneHistoryKeys = new Set();
  for (const event of events) {
    for (const change of event.changes || []) {
      change.historyEventIds = [];
      const key = timelineHistoryKey(event.snapshotId, change.field, change.oldValue, change.newValue);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(change);
    }
  }
  return index;
}

export function attachMacTimelineHistoryEvent(index, item) {
  const key = timelineHistoryKey(item?.snapshotId, item?.field, item?.oldValue, item?.newValue);
  if (!key) return false;
  const matches = index.get(key);
  if (!matches) return false;
  const id = String(item.id ?? "");
  if (id) for (const change of matches) if (!change.historyEventIds.includes(id)) change.historyEventIds.push(id);
  return true;
}

export function mergeMacTimelineHistoryEvent(events, index, item, snapshots = []) {
  if (attachMacTimelineHistoryEvent(index, item)) return true;
  if (!Array.isArray(events) || String(item?.type || "").toLowerCase() !== "modified") return false;
  const field = text(item.field || item.label);
  const oldValue = text(item.oldValue ?? item.before);
  const newValue = text(item.newValue ?? item.after);
  if (!field || !oldValue || !newValue || keyText(oldValue) === keyText(newValue)) return false;
  const snapshotId = String(item.snapshotId || "");
  const eventId = String(item.id ?? "");
  const historyKey = eventId || JSON.stringify([snapshotId, item.timestamp || item.createdAt || "", field, oldValue, newValue, item.mac || ""]);
  if (index?.standaloneHistoryKeys?.has(historyKey)) return true;
  const snapshot = snapshots.find((entry) => String(entry.id || "") === snapshotId);
  const exactDevice = snapshot?.devices?.filter((device) => item.deviceId && String(device.id || "") === String(item.deviceId)) || [];
  const device = exactDevice.length === 1 ? exactDevice[0] : (item.device && typeof item.device === "object" ? item.device : { mac: item.mac || "" });
  const knownField = COMPARED_FIELDS.find(([key, label]) => key === field || label === field);
  const label = item.label || knownField?.[1] || field;
  const date = item.timestamp || item.createdAt || snapshot?.createdAt || "";
  events.push({
    date,
    snapshotId,
    snapshotName: snapshot?.name || snapshotId,
    source: item.source || "История изменений",
    status: "changed",
    historyOnly: true,
    before: null,
    after: device,
    changes: [{ field: knownField?.[0] || field, label, oldValue, newValue, historyEventIds: eventId ? [eventId] : [] }],
  });
  index?.standaloneHistoryKeys?.add(historyKey);
  return true;
}

export function buildMacTimeline(mac, snapshots = [], storedHistory = []) {
  const normalized = normalizeMac(mac);
  if (!normalized) return [];
  const events = [];
  let previous = null;
  let previousSnapshot = null;
  let lastKnown = new Map();
  const orderedSnapshots = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const snapshot of orderedSnapshots) {
    const matches = (snapshot.devices || []).filter((item) => [item.mac, ...(item.alternateMacs || [])]
      .some((value) => normalizeMac(value) === normalized));
    if (matches.length > 1) {
      events.push({ date: snapshot.createdAt, snapshotId: snapshot.id, snapshotName: snapshot.name, status: "ambiguous", candidates: matches, changes: [] });
      previous = null;
      previousSnapshot = null;
      lastKnown = new Map();
      continue;
    }
    const device = matches[0];
    if (!device) {
      if (previous) events.push({ date: snapshot.createdAt, snapshotId: snapshot.id, snapshotName: snapshot.name, previousSnapshotId: previousSnapshot?.id || "", previousSnapshotName: previousSnapshot?.name || "", status: "absent", before: backfillTimelineState(previous, lastKnown), after: null, changes: [] });
      previous = null;
      previousSnapshot = null;
      continue;
    }
    const before = previous ? backfillTimelineState(previous, lastKnown) : null;
    const changes = previous ? COMPARED_FIELDS.filter(([field]) => {
      const oldValue = comparableValue(before, field);
      const after = comparableValue(device, field);
      return oldValue && after && keyText(oldValue) !== keyText(after);
    }).map(([field, label]) => ({ field, label, oldValue: comparableValue(before, field), newValue: comparableValue(device, field) })) : [];
    events.push({
      date: snapshot.createdAt,
      snapshotId: snapshot.id,
      snapshotName: snapshot.name || snapshot.id || "",
      previousSnapshotId: previousSnapshot?.id || "",
      previousSnapshotName: previousSnapshot?.name || previousSnapshot?.id || "",
      status: previous ? (changes.length ? "changed" : "present") : "first",
      before,
      after: device,
      changes,
    });
    rememberTimelineState(device, lastKnown);
    previous = device;
    previousSnapshot = snapshot;
  }
  const historyIndex = indexMacTimelineHistory(events);
  for (const item of storedHistory) mergeMacTimelineHistoryEvent(events, historyIndex, item, orderedSnapshots);
  return events;
}

export function legacyObservationTimelineEvent(observation = {}) {
  const row = observation.payload && typeof observation.payload === "object" ? observation.payload : {};
  const devicePayload = row.decodedPayload && typeof row.decodedPayload === "object" ? row.decodedPayload : {};
  const value = { ...row, ...devicePayload };
  const pick = (...keys) => keys.map((key) => text(value[key])).find(Boolean) || "";
  const mac = firstMac(observation.mac, pick("mac", "mac_formatted"));
  if (!mac) return null;
  const date = String(observation.observedAt || value.recorded_at || value.observed_at || "");
  const sourceTable = String(observation.sourceTable || observation.kind || "legacy SQLite");
  return {
    date,
    status: "observation",
    observationKind: sourceTable,
    snapshotName: `SQLite · ${sourceTable}`,
    source: String(observation.source || "Импорт SQLite"),
    after: {
      id: String(observation.internalDeviceId || pick("internal_device_id", "internalDeviceId")),
      mac,
      ip: normalizeIp(pick("ip", "device_ip", "deviceIp")),
      switchIp: normalizeIp(pick("switch_ip", "switchIp")),
      switchPort: pick("switch_port", "switchPort"),
      manufacturer: pick("manufacturer", "vendor"),
      model: pick("model"),
      deviceType: pick("device_type", "deviceType"),
      hostname: pick("hostname"),
      serial: pick("serial_number", "serialNumber", "serial"),
      deviceId: pick("device_id", "deviceId"),
      deviceName: pick("device_name", "deviceName"),
      smartroomId: pick("smartroom_id", "smartroomId"),
      room: pick("room"),
      address: pick("address", "physical_address", "physicalAddress"),
      observedAt: date,
      source: String(observation.source || value.source || "Импорт SQLite"),
      fieldSources: value.field_sources_json || value.fieldSources || {},
      conflicts: value.conflicts_json || value.conflicts || {},
    },
    changes: [],
  };
}

