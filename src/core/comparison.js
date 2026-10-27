import { addIdentityToIndex, buildIdentityIndex, findIdentityMatch, identityTokens, normalizeAlternateMacValues, stableIdentity, visitDeviceAlternateMacs } from "./identity.js";
import { firstMac, keyText, locationKey, MAX_DEVICE_ALTERNATIVES, normalizeIp, normalizeMac, text } from "./normalize.js";
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
const MAC_IDENTITY_FIELDS = Object.freeze([
  "mac", "macAddress", "macFormatted", "mac_formatted", "CallingStationID",
  "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac",
]);
const MAC_TIMELINE_DEVICE_FIELDS = Object.freeze([
  "id", "mac", "alternateMacs", "ip", "switchIp", "switchPort", "manufacturer", "vendor", "model", "deviceType",
  "hostname", "serial", "deviceId", "deviceName", "smartroomId", "businessUnit", "city", "site", "floor", "room",
  "address", "physicalAddress", "authenticationTime", "observedAt", "source", "sources", "fieldSources", "possibleIps",
  "possibleIpsTruncated", "alternateMacsTruncated", "conflicts", "conflictsTruncated",
]);

function compactMacTimelineDevice(device) {
  if (!device || typeof device !== "object" || Array.isArray(device)) return null;
  const compact = {};
  for (const field of MAC_TIMELINE_DEVICE_FIELDS) if (Object.hasOwn(device, field)) compact[field] = device[field];
  return compact;
}

export function deviceContainsNormalizedMac(device = {}, normalizedMac = "") {
  if (!normalizedMac) return false;
  for (const field of MAC_IDENTITY_FIELDS) if (normalizeMac(device[field]) === normalizedMac) return true;
  const alternates = device.alternateMacs;
  if (Array.isArray(alternates)) {
    for (const value of alternates) if (normalizeMac(value) === normalizedMac) return true;
    return false;
  }
  if (typeof alternates !== "string") return false;
  let start = 0;
  while (start <= alternates.length) {
    const comma = alternates.indexOf(",", start);
    const end = comma < 0 ? alternates.length : comma;
    if (normalizeMac(alternates.slice(start, end)) === normalizedMac) return true;
    if (comma < 0) break;
    start = comma + 1;
  }
  return false;
}

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

export function comparisonChanges(before, after, timestamp) {
  const changes = [];
  for (const [field, label] of COMPARED_FIELDS) {
    const oldValue = comparableValue(before, field);
    const newValue = comparableValue(after, field);
    if (!oldValue || !newValue || keyText(oldValue) === keyText(newValue)) continue;
    changes.push({ field, label, oldValue, newValue, timestamp });
  }
  return changes;
}

function hasComparisonChanges(before, after) {
  for (const [field] of COMPARED_FIELDS) {
    const oldValue = comparableValue(before, field);
    const newValue = comparableValue(after, field);
    if (oldValue && newValue && keyText(oldValue) !== keyText(newValue)) return true;
  }
  return false;
}

export function hasFinalComparisonFieldChange(before, after, field) {
  const oldValue = comparableValue(before, field);
  const newValue = comparableValue(after, field);
  return Boolean(oldValue && newValue && keyText(oldValue) !== keyText(newValue));
}

export function criticalComparisonRow(row) {
  const changes = row.changes.filter((change) => CRITICAL_CHANGE_FIELDS.includes(change.field)
    && text(change.oldValue) && text(change.newValue) && keyText(change.oldValue) !== keyText(change.newValue));
  return changes.length ? { ...row, changes } : null;
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
  let nextFinishPosition = 0;
  let finished = false;
  const retainDiagnostic = (sample) => {
    if (diagnosticSamples.length < MAX_FINAL_HISTORY_DIAGNOSTIC_SAMPLES) diagnosticSamples.push(sample);
    else diagnosticSamplesTruncated += 1;
  };
  const identityLabel = (device) => stableIdentity(device) || identityTokens(device)[0]?.key?.slice(0, 200) || "weak-identity";
  const summary = () => ({ ambiguousCount, identityConflictCount, diagnosticSamples, diagnosticSamplesTruncated });
  const emitAbsent = (device, position, visit) => {
    if (matchedPrevious[position] !== 0 || identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) return;
    visit({ type: "absent", device });
  };

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
        emitAbsent(previous[position], position, visit);
      }
      finished = true;
      nextFinishPosition = previous.length;
      return summary();
    },
    finishChunk(devices = [], offset = 0, visit = () => {}) {
      if (finished) throw new Error("Поток History уже завершён");
      if (!Array.isArray(devices) || offset !== nextFinishPosition || offset + devices.length > previous.length) {
        throw new Error("Чанки Previous Final должны завершать поток History последовательно");
      }
      for (let index = 0; index < devices.length; index += 1) emitAbsent(devices[index], offset + index, visit);
      nextFinishPosition += devices.length;
      if (nextFinishPosition < previous.length) return null;
      finished = true;
      return summary();
    },
  };
}

/** Build compact comparison marks once; each status can then be streamed in output order. */
export function createFinalComparisonEventPlan(previous = [], current = [], timestamp = new Date().toISOString(), { previousIdentityIndex = null } = {}) {
  let previousIndex = previousIdentityIndex?.devices === previous ? previousIdentityIndex : buildIdentityIndex(previous);
  const matchedPrevious = new Uint8Array(Math.ceil(previous.length / 8));
  const markPreviousMatched = (position) => {
    if (Number.isInteger(position) && position >= 0 && position < previous.length) {
      matchedPrevious[position >> 3] |= 1 << (position & 7);
    }
  };
  const wasPreviousMatched = (position) => (matchedPrevious[position >> 3] & (1 << (position & 7))) !== 0;
  const ambiguousTokenKeys = new Set();
  const ambiguousDetails = new Map();
  const currentStatus = new Uint8Array(current.length);
  const matchedPosition = new Int32Array(current.length);
  matchedPosition.fill(-1);
  const CURRENT = { added: 1, modified: 2, unchanged: 3, ambiguous: 4 };
  const counts = { addedCount: 0, absentCount: 0, modifiedDeviceCount: 0, unchangedCount: 0, ambiguousCount: 0, identityConflictCount: 0 };

  for (let position = 0; position < current.length; position += 1) {
    const after = current[position];
    const resolution = findIdentityMatch(after, previousIndex);
    if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
      currentStatus[position] = CURRENT.ambiguous;
      counts.ambiguousCount += 1;
      for (const candidate of resolution.candidates) markPreviousMatched(candidate.position);
      for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
      ambiguousDetails.set(position, {
        candidates: resolution.candidates.map((candidate) => candidate.device),
        conflicts: [],
        insufficientStrongIdentity: false,
      });
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
      markPreviousMatched(resolution.position);
      for (const conflict of conflicts) markPreviousMatched(conflict.position);
      ambiguousDetails.set(position, {
        candidates: [resolution.match, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)],
        conflicts,
        insufficientStrongIdentity: false,
      });
      continue;
    }
    if (Number.isInteger(resolution.position)) {
      markPreviousMatched(resolution.position);
      matchedPosition[position] = resolution.position;
    }
    if (hasComparisonChanges(resolution.match, after)) {
      currentStatus[position] = CURRENT.modified;
      counts.modifiedDeviceCount += 1;
    } else {
      currentStatus[position] = CURRENT.unchanged;
      counts.unchangedCount += 1;
    }
  }

  // Ambiguous event pages can use precomputed candidate references. Release the
  // token Map now instead of retaining every identity key for the plan lifetime.
  previousIndex = null;

  for (let position = 0; position < previous.length; position += 1) {
    const device = previous[position];
    if (!wasPreviousMatched(position) && !identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) counts.absentCount += 1;
  }

  const eligibleAbsent = function* () {
    for (let position = 0; position < previous.length; position += 1) {
      const device = previous[position];
      if (wasPreviousMatched(position) || identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key))) continue;
      yield { type: "absent", device };
    }
  };
  const countModifiedWhere = (predicate = null) => {
    if (typeof predicate !== "function") return counts.modifiedDeviceCount;
    let count = 0;
    for (let position = 0; position < current.length; position += 1) {
      if (currentStatus[position] !== CURRENT.modified) continue;
      if (predicate(previous[matchedPosition[position]], current[position], position)) count += 1;
    }
    return count;
  };
  const events = function* (type, { predicate = null, includeChanges = true, offset = 0, limit = Number.POSITIVE_INFINITY } = {}) {
    let skipped = Math.max(0, Math.floor(Number(offset) || 0));
    const maximum = Math.max(0, Math.floor(Number(limit)) || 0);
    if (maximum === 0) return;
    let emitted = 0;
    const accept = () => {
      if (skipped > 0) { skipped -= 1; return false; }
      emitted += 1;
      return true;
    };
    if (type === "absent") {
      for (const event of eligibleAbsent()) {
        if (!accept()) continue;
        yield event;
        if (emitted >= maximum) return;
      }
      return;
    }
    for (let position = 0; position < current.length; position += 1) {
      if (type === "added" && currentStatus[position] === CURRENT.added) {
        const event = { type, device: current[position] };
        if (!accept(event)) continue;
        yield event;
      } else if (type === "modified" && currentStatus[position] === CURRENT.modified) {
        const after = current[position];
        const before = previous[matchedPosition[position]];
        if (predicate && !predicate(before, after, position)) continue;
        if (!accept(null)) continue;
        yield { type, row: { identity: stableIdentity(after), before, after, changes: includeChanges ? comparisonChanges(before, after, timestamp) : [] } };
      } else if (type === "unchanged" && currentStatus[position] === CURRENT.unchanged) {
        const after = current[position];
        const before = previous[matchedPosition[position]];
        if (!accept(null)) continue;
        yield { type, row: { identity: stableIdentity(after), before, after, changes: [] } };
      } else if (type === "ambiguous" && currentStatus[position] === CURRENT.ambiguous) {
        if (!accept(null)) continue;
        const after = current[position];
        const details = ambiguousDetails.get(position) || { candidates: [], conflicts: [], insufficientStrongIdentity: true };
        const { candidates, conflicts } = details;
        yield {
          type,
          item: {
            after,
            candidates,
            ...(details.insufficientStrongIdentity ? { reason: "insufficient-strong-identity" } : {}),
            ...(conflicts.length ? { reason: "conflicting-strong-identifiers" } : {}),
          },
          identityConflicts: conflicts.map((conflict) => ({ after, ...conflict })),
        };
      }
      if (emitted >= maximum) return;
    }
  };
  const critical = function* () {
    for (const event of events("modified")) {
      const row = criticalComparisonRow(event.row);
      if (row) yield row;
    }
  };
  const identityConflicts = function* () {
    for (const event of events("ambiguous")) yield* event.identityConflicts;
  };
  return { ...counts, timestamp, events, countModifiedWhere, critical, identityConflicts };
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
  includeAbsent = true,
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
  const matchedPrevious = includeAbsent ? new Uint8Array(previous.length) : null;
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
      ambiguousCount += 1;
      for (const candidate of resolution.candidates) {
        if (matchedPrevious && Number.isInteger(candidate.position)) matchedPrevious[candidate.position] = 1;
      }
      for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
      if (includeDiagnosticRows || typeof onAmbiguous === "function") {
        const candidates = resolution.candidates.map((candidate) => candidate.device);
        const item = { after, candidates, ...(!candidates.length ? { reason: "insufficient-strong-identity" } : {}) };
        if (includeDiagnosticRows) ambiguous.push(item);
        onAmbiguous?.(item);
      }
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
      if (matchedPrevious && Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
      if (matchedPrevious) for (const conflict of conflicts) if (Number.isInteger(conflict.position)) matchedPrevious[conflict.position] = 1;
      ambiguousCount += 1;
      if (includeDiagnosticRows || typeof onAmbiguous === "function") {
        const candidates = [before, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)];
        const item = { after, candidates, reason: "conflicting-strong-identifiers" };
        if (includeDiagnosticRows) ambiguous.push(item);
        onAmbiguous?.(item);
      }
      continue;
    }
    if (matchedPrevious && Number.isInteger(resolution.position)) matchedPrevious[resolution.position] = 1;
    let changes = null;
    let hasChanges = false;
    const needsModifiedRow = collectRows || typeof onModified === "function";
    for (const [field, label] of COMPARED_FIELDS) {
      const oldValue = comparableValue(before, field);
      const newValue = comparableValue(after, field);
      if (oldValue && newValue && keyText(oldValue) !== keyText(newValue)) {
        hasChanges = true;
        if (needsModifiedRow) {
          changes ||= [];
          changes.push({ field, label, oldValue, newValue, timestamp });
        }
      }
    }
    const matches = deviceMatches(after);
    if (hasChanges) {
      if (matches) {
        if (currentStatusMask) currentStatusMask[currentPosition] = CURRENT_STATUS_MASK.changed;
        modifiedDeviceCount += 1;
        if (needsModifiedRow) {
          const row = { identity: stableIdentity(after), before, after, changes };
          if (collectRows) modified.push(row);
          onModified?.(row);
        }
      }
    }
    else {
      if (matches) {
        if (currentStatusMask) currentStatusMask[currentPosition] = CURRENT_STATUS_MASK.unchanged;
        unchangedCount += 1;
        if (includeUnchangedRows || typeof onUnchanged === "function") {
          const row = { identity: stableIdentity(after), before, after, changes: [] };
          if (includeUnchangedRows) unchanged.push(row);
          onUnchanged?.(row);
        }
      }
    }
  }

  const absent = [];
  for (let position = 0; includeAbsent && position < previous.length; position += 1) {
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
  const critical = [];
  if (includeCriticalRows && collectRows) {
    for (const row of modified) {
      const changes = [];
      for (const change of row.changes) {
        if (criticalFields.has(change.field)
          && text(change.oldValue) && text(change.newValue) && keyText(change.oldValue) !== keyText(change.newValue)) changes.push(change);
      }
      if (changes.length) critical.push({ ...row, changes });
    }
  }
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
      const alternateMacs = [];
      const seenMacs = new Set();
      let alternateMacsTruncated = false;
      const addAlternateMac = (mac) => {
        if (!mac || mac === normalizeMac(record.mac) || seenMacs.has(mac)) return true;
        if (alternateMacs.length >= MAX_DEVICE_ALTERNATIVES) {
          alternateMacsTruncated = true;
          return false;
        }
        seenMacs.add(mac);
        alternateMacs.push(mac);
        return true;
      };
      visitDeviceAlternateMacs(record, addAlternateMac);
      visitDeviceAlternateMacs(device, addAlternateMac);
      addAlternateMac(normalizeMac(device.mac));
      device.alternateMacs = alternateMacs;
      device.alternateMacsTruncated = Boolean(device.alternateMacsTruncated || record.alternateMacsTruncated || alternateMacsTruncated);
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

const INVENTORY_COMPARISON_IDENTITY_FIELDS = Object.freeze([
  "id", "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id",
  "serial", "serialNumber", "serial_number", "mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID",
  "alternateMacs", "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac", "alternateMacsTruncated",
  "hostname", "host", "host_name", "smartroomId", "smartroom_id", "ip", "deviceIp", "device_ip",
]);

function compactInventoryComparisonRecord(record = {}) {
  const compact = {};
  for (const field of INVENTORY_COMPARISON_IDENTITY_FIELDS) {
    if (record[field] !== undefined) compact[field] = record[field];
  }
  for (const [field] of COMPARED_FIELDS) {
    if (record[field] !== undefined) compact[field] = record[field];
  }
  if (record.fieldSources?.mac !== undefined) compact.fieldSources = { mac: record.fieldSources.mac };
  return compact;
}

/** Collect Inventory comparison candidates a page at a time, retaining one shared identity index. */
export function createInventoryObservationComparator(current = [], timestamp = new Date().toISOString()) {
  const previous = [];
  const previousIdentityIndex = buildIdentityIndex(previous);
  const seenIds = new Set();
  let finished = false;
  let streamStarted = false;
  const totals = { addedCount: 0, modifiedDeviceCount: 0, unchangedCount: 0, ambiguousCount: 0, identityConflictCount: 0 };
  return Object.freeze({
    acceptCandidates(candidates = new Map()) {
      if (finished || streamStarted) throw new Error("Сравнение Inventory уже завершено");
      for (const candidate of candidates.values()) {
        for (const record of candidate?.records || []) {
          const id = record?.id == null ? "" : String(record.id);
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          previous.push(compactInventoryComparisonRecord(record));
          addIdentityToIndex(previousIdentityIndex, record, previous.length - 1);
        }
      }
    },
    finish() {
      if (finished || streamStarted) throw new Error("Сравнение Inventory уже завершено");
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
    comparisonStream() {
      if (finished || streamStarted) throw new Error("Сравнение Inventory уже завершено");
      streamStarted = true;
      seenIds.clear();
      let streamFinished = false;
      const result = {
        process(currentPage = [], emit = () => {}) {
          if (finished || streamFinished) throw new Error("Сравнение Inventory уже завершено");
          reconcileInventoryWithIndex(currentPage, previousIdentityIndex);
          const pageComparison = compareFinals(previous, currentPage, timestamp, {
            includeUnchangedRows: false,
            includeDiagnosticRows: false,
            includeAbsent: false,
            collectRows: false,
            previousIdentityIndex,
            onAdded: (device) => emit({ type: "added", device }),
            onModified: (row) => emit({ type: "modified", row }),
          });
          for (const key of Object.keys(totals)) totals[key] += pageComparison[key] || 0;
          return { ...pageComparison, absent: [], absentCount: 0 };
        },
        finish() {
          if (finished || streamFinished) throw new Error("Сравнение Inventory уже завершено");
          streamFinished = true;
          finished = true;
          const summary = { ...totals, absent: [], absentCount: 0, timestamp };
          seenIds.clear();
          previous.length = 0;
          previousIdentityIndex.tokens.clear();
          return summary;
        },
      };
      return Object.freeze(result);
    },
  });
}

export function createFinalComparisonSummary(previous = [], timestamp = new Date().toISOString(), {
  deviceMatches = () => true,
  deviceCount = null,
  previousCount = previous.length,
  includeAbsentPositionMask = false,
  includeCurrentStatusMask = false,
  includeAmbiguousPositionMask = false,
  includeChangeLocations = true,
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
  const resolvedPreviousCount = Math.max(0, Math.floor(Number(previousCount) || 0));
  let baselineDevices = previous;
  let index = baselineDevices.length ? buildIdentityIndex(baselineDevices) : resolvedPreviousCount === 0 ? buildIdentityIndex([]) : null;
  let matched = new Uint8Array(resolvedPreviousCount);
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
    rooms: includeChangeLocations ? new Set() : null,
    macs: includeChangeLocations ? new Set() : null,
    currentPosition: 0,
    previousPosition: 0,
    currentStatusMask: includeCurrentStatusMask ? new Uint8Array(deviceCount) : null,
    absentPositionMask,
    ambiguousPositionMask: includeAmbiguousPositionMask ? new Uint8Array(resolvedPreviousCount) : null,
    timestamp,
  };
  return Object.freeze({
    observeChunk(devices = [], chunkIdentityIndex = index) {
      if (finishedResult) throw new Error("Потоковое сравнение уже завершено");
      if (!chunkIdentityIndex) throw new Error("Для текущего чанка отсутствует identity index baseline");
      for (const after of devices) {
        const position = summary.currentPosition++;
        const resolution = findIdentityMatch(after, chunkIdentityIndex);
        if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
          summary.ambiguous += 1;
          resolution.candidates.forEach((candidate) => {
            matched[candidate.position] = 1;
            if (summary.ambiguousPositionMask && candidate.position < summary.ambiguousPositionMask.length) summary.ambiguousPositionMask[candidate.position] = 1;
          });
          for (const key of resolution.ambiguousTokenKeys || []) ambiguousTokenKeys.add(key);
          onAmbiguous?.({ after, candidates: resolution.candidates.map((candidate) => candidate.device), ...(!resolution.candidates.length ? { reason: "insufficient-strong-identity" } : {}) }, resolution.candidates.map((candidate) => candidate.position), position);
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
          matched[resolution.position] = 1;
          if (summary.ambiguousPositionMask && resolution.position < summary.ambiguousPositionMask.length) summary.ambiguousPositionMask[resolution.position] = 1;
          for (const conflict of conflicts) if (Number.isInteger(conflict.position)) {
            matched[conflict.position] = 1;
            if (summary.ambiguousPositionMask && conflict.position < summary.ambiguousPositionMask.length) summary.ambiguousPositionMask[conflict.position] = 1;
          }
          summary.ambiguous += 1;
          for (const conflict of conflicts) onIdentityConflict?.({ after, ...conflict }, position);
          onAmbiguous?.({ after, candidates: [before, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)], reason: "conflicting-strong-identifiers" }, [resolution.position, ...conflicts.map((conflict) => conflict.position).filter(Number.isInteger)], position);
          continue;
        }
        if (!deviceMatches(after)) continue;
        let changes = null;
        let changeCount = 0;
        let criticalDevice = false;
        for (const [field, label] of COMPARED_FIELDS) {
          const oldValue = comparableValue(before, field);
          const newValue = comparableValue(after, field);
          if (oldValue && newValue && keyText(oldValue) !== keyText(newValue)) {
            changeCount += 1;
            summary.fieldChanges.set(label, (summary.fieldChanges.get(label) || 0) + 1);
            if (isCriticalHistoryChange("modified", field, oldValue, newValue)) {
              summary.criticalModifiedEventCount += 1;
              criticalDevice = true;
            }
            if (typeof onModified === "function") {
              changes ||= [];
              changes.push({ field, label, oldValue, newValue, timestamp });
            }
          }
        }
        if (changeCount) {
          summary.modified += 1;
          summary.modifiedEventCount += changeCount;
          if (criticalDevice) summary.criticalModifiedDeviceCount += 1;
          if (keyText(after.deviceType) === "video conference") summary.codecChanges += 1;
          if (summary.currentStatusMask && position < summary.currentStatusMask.length) summary.currentStatusMask[position] = CURRENT_STATUS_MASK.changed;
          if (includeChangeLocations) {
            const room = locationKey(after);
            const mac = normalizeMac(after.mac);
            if (room) summary.rooms.add(room);
            if (mac) summary.macs.add(mac);
          }
          onModified?.({ identity: stableIdentity(after), before, after, changes }, position);
        } else {
          summary.unchanged += 1;
          if (summary.currentStatusMask && position < summary.currentStatusMask.length) summary.currentStatusMask[position] = CURRENT_STATUS_MASK.unchanged;
          onUnchanged?.({ identity: stableIdentity(after), before, after, changes: changes || [] }, position);
        }
      }
    },
    observePreviousChunk(devices = [], startPosition = summary.previousPosition) {
      if (finishedResult) throw new Error("Потоковое сравнение уже завершено");
      if (startPosition !== summary.previousPosition) throw new Error("Поток previous Final нарушил порядок позиций");
      for (const device of devices) {
        const position = summary.previousPosition++;
        const unresolved = identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key));
        if (matched[position] !== 0 || unresolved || !deviceMatches(device)) continue;
        summary.absent += 1;
        if (summary.absentPositionMask) summary.absentPositionMask[position] = 2;
        const vendor = String(device.manufacturer || device.vendor || "Unknown").trim() || "Unknown";
        summary.absentVendors.set(vendor, (summary.absentVendors.get(vendor) || 0) + 1);
        onAbsent?.(device, position);
      }
    },
    finish({ streamedPrevious = false } = {}) {
      if (finishedResult) return finishedResult;
      if (summary.currentStatusMask && summary.currentPosition !== summary.currentStatusMask.length) {
        throw new Error("Число строк в потоке current Final не совпало с размером маски статусов");
      }
      if (!streamedPrevious && baselineDevices.length) {
        this.observePreviousChunk(baselineDevices, 0);
      }
      if (summary.previousPosition !== resolvedPreviousCount) {
        throw new Error("Число строк в потоке previous Final не совпало с размером baseline");
      }
      if (summary.absentPositionMask) {
        for (let position = 0; position < summary.absentPositionMask.length; position += 1) {
          summary.absentPositionMask[position] = summary.absentPositionMask[position] === 2 ? 1 : 0;
        }
      }
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
        ...(summary.ambiguousPositionMask ? { ambiguousPositionMask: summary.ambiguousPositionMask } : {}),
        rooms: includeChangeLocations ? [...summary.rooms] : [],
        macs: includeChangeLocations ? [...summary.macs] : [],
        timestamp,
      };
      baselineDevices = null;
      index = null;
      matched = null;
      ambiguousTokenKeys = null;
      summary.fieldChanges.clear();
      summary.absentVendors.clear();
      summary.rooms?.clear();
      summary.macs?.clear();
      return finishedResult;
    },
  });
}

export async function compareFinalUnchangedPage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true, resolveIdentityChunk = null } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения неизменившихся устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks(async (chunk = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(chunk) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, chunkIndex);
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
  resolveIdentityChunk = null,
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
  if (resolveIdentityChunk) {
    let ambiguousCount = 0;
    let identityConflictCount = 0;
    await visitCurrentChunks(async (chunk = []) => {
      const index = await resolveIdentityChunk(chunk);
      if (!index) throw new Error("Не удалось построить индекс идентичности выбранного Final");
      for (const after of chunk) {
        const resolution = findIdentityMatch(after, index);
        if (resolution.status === "ambiguous" && !resolution.strongIdentityUnmatched) {
          ambiguousCount += 1;
          keep("ambiguous", {
            after,
            candidates: resolution.candidates.map((candidate) => candidate.device),
            ...(!resolution.candidates.length ? { reason: "insufficient-strong-identity" } : {}),
          });
          continue;
        }
        if (resolution.status !== "matched") continue;
        const conflicts = resolution.identityConflicts || [];
        if (!conflicts.length) continue;
        identityConflictCount += conflicts.length;
        for (const conflict of conflicts) keep("identityConflict", { after, ...conflict });
        ambiguousCount += 1;
        keep("ambiguous", {
          after,
          candidates: [resolution.match, ...conflicts.map((conflict) => conflict.alternative).filter(Boolean)],
          reason: "conflicting-strong-identifiers",
        });
      }
    });
    return {
      rows,
      total,
      ambiguousCount,
      identityConflictCount,
      offset: start,
      limit: pageSize,
      hasPrevious: start > 0,
      hasNext: start + rows.length < total,
    };
  }
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

export async function compareFinalAbsencePage(previous = [], visitCurrentChunks, {
  offset = 0,
  limit = 100,
  deviceMatches = () => true,
  previousCount = previous.length,
  visitPreviousChunks = null,
  resolveIdentityChunk = null,
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения отсутствующих устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const baselineCount = Number(previousCount);
  if (!Number.isInteger(baselineCount) || baselineCount < 0) throw new TypeError("Для сравнения отсутствующих устройств нужен точный размер baseline Final");
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const matched = new Uint8Array(baselineCount);
  const ambiguousTokenKeys = new Set();
  await visitCurrentChunks(async (devices = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(devices) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of devices) {
      const resolution = findIdentityMatch(after, chunkIndex);
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
  let position = 0;
  const observePreviousChunk = (chunk = []) => {
    for (const device of chunk) {
      const currentPosition = position++;
      if (currentPosition >= baselineCount) throw new Error("FinalAnalytics содержит больше устройств, чем metadata");
      const unresolved = identityTokens(device).some((token) => ambiguousTokenKeys.has(token.key));
      if (matched[currentPosition] !== 0 || unresolved || !deviceMatches(device)) continue;
      total += 1;
      if (total > start && devices.length < pageSize) devices.push(device);
    }
  };
  if (visitPreviousChunks) {
    const metadata = await visitPreviousChunks(observePreviousChunk);
    if (!metadata) throw new Error("Не удалось прочитать полный baseline FinalAnalytics");
  } else {
    observePreviousChunk(previous);
  }
  if (position !== baselineCount) throw new Error("Число baseline записей не совпало с metadata FinalAnalytics");
  return {
    devices,
    total,
    offset: start,
    limit: pageSize,
    hasPrevious: start > 0,
    hasNext: start + devices.length < total,
  };
}

export async function compareFinalAdditionPage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true, resolveIdentityChunk = null } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения добавленных устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks(async (chunk = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(chunk) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, chunkIndex);
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

export async function compareFinalModifiedDevicePage(previous = [], visitCurrentChunks, { offset = 0, limit = 100, deviceMatches = () => true, resolveIdentityChunk = null } = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для списка изменённых устройств нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const devices = [];
  let total = 0;
  await visitCurrentChunks(async (chunk = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(chunk) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of chunk) {
      const resolution = findIdentityMatch(after, chunkIndex);
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
  resolveIdentityChunk = null,
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для сравнения изменений нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const events = [];
  let total = 0;
  const normalizedDeviceType = keyText(deviceType);
  await visitCurrentChunks(async (devices = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(devices) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of devices) {
      const resolution = findIdentityMatch(after, chunkIndex);
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
  resolveIdentityChunk = null,
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для группировки изменений нужен поток чанков текущего Final");
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const index = resolveIdentityChunk ? null : buildIdentityIndex(previous);
  const groups = [];
  let total = 0;
  let totalEvents = 0;
  await visitCurrentChunks(async (devices = []) => {
    const chunkIndex = resolveIdentityChunk ? await resolveIdentityChunk(devices) : index;
    if (!chunkIndex) throw new Error("Не удалось построить индекс идентичности выбранного Final");
    for (const after of devices) {
      const resolution = findIdentityMatch(after, chunkIndex);
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

export function macTimelineHistoryLookupKey(snapshotId, field, oldValue, newValue) {
  return timelineHistoryKey(snapshotId, field, oldValue, newValue);
}

export function createMacTimelineStandaloneHistoryEvent(item, snapshot = null, snapshotEvent = null) {
  if (String(item?.type || "").toLowerCase() !== "modified") return null;
  const field = text(item.field || item.label);
  const oldValue = text(item.oldValue ?? item.before);
  const newValue = text(item.newValue ?? item.after);
  if (!field || !oldValue || !newValue || keyText(oldValue) === keyText(newValue)) return null;
  const snapshotId = String(item.snapshotId || "");
  const candidates = snapshotEvent?.status === "ambiguous" ? snapshotEvent.candidates || []
    : snapshotEvent?.after ? [snapshotEvent.after]
      : snapshot?.devices || [];
  let exactDevice = null;
  let exactMatches = 0;
  if (item.deviceId) for (const candidate of candidates) {
    if (String(candidate.id || "") !== String(item.deviceId)) continue;
    exactDevice = candidate;
    exactMatches += 1;
  }
  const device = exactMatches === 1 ? exactDevice : (compactMacTimelineDevice(item.device) || { mac: item.mac || "" });
  const knownField = COMPARED_FIELDS.find(([key, label]) => key === field || label === field);
  const eventId = String(item.id ?? "");
  return {
    date: item.timestamp || item.createdAt || snapshot?.createdAt || "",
    snapshotId,
    snapshotName: snapshot?.name || snapshotId,
    source: item.source || "История изменений",
    status: "changed",
    historyOnly: true,
    before: null,
    after: device,
    changes: [{ field: knownField?.[0] || field, label: item.label || knownField?.[1] || field, oldValue, newValue, historyEventIds: eventId ? [eventId] : [] }],
  };
}

function registerMacTimelineHistoryEvent(index, event) {
  if (!event || event.historyOnly) return;
  const snapshotId = String(event.snapshotId || "");
  if (snapshotId) {
    index.snapshotEventsById.set(snapshotId, {
      status: event.status,
      ...(event.status === "ambiguous" ? { candidates: (event.candidates || []).map(compactMacTimelineDevice) } : {}),
      ...(event.after ? { after: compactMacTimelineDevice(event.after) } : {}),
    });
  }
  for (const [changeIndex, change] of (event.changes || []).entries()) {
    if (!Array.isArray(change.historyEventIds)) change.historyEventIds = [];
    const key = timelineHistoryKey(event.snapshotId, change.field, change.oldValue, change.newValue);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ change, eventKey: event.__macTimelineKey || "", changeIndex });
  }
}

export function indexMacTimelineHistory(events = [], snapshots = [], { dedupeStableEventIds = true, onEventPatched = null } = {}) {
  const index = new Map();
  index.standaloneHistoryKeys = new Set();
  index.dedupeStableEventIds = Boolean(dedupeStableEventIds);
  index.onEventPatched = typeof onEventPatched === "function" ? onEventPatched : null;
  index.snapshotsById = new Map(snapshots.map((snapshot) => [String(snapshot?.id || ""), snapshot]).filter(([id]) => id));
  index.snapshotEventsById = new Map();
  for (const event of events) registerMacTimelineHistoryEvent(index, event);
  return index;
}

export function attachMacTimelineHistoryEvent(index, item) {
  const key = timelineHistoryKey(item?.snapshotId, item?.field, item?.oldValue, item?.newValue);
  if (!key) return false;
  const matches = index.get(key);
  if (!matches) return false;
  const id = String(item.id ?? "");
  let changed = false;
  if (id) for (const entry of matches) {
    const change = entry.change || entry;
    if (!change.historyEventIds.includes(id)) {
      change.historyEventIds.push(id);
      changed = true;
      if (entry.eventKey && typeof index.onEventPatched === "function") {
        index.onEventPatched({ eventKey: entry.eventKey, changeIndex: entry.changeIndex, historyEventIds: [...change.historyEventIds] });
      }
    }
  }
  return changed || matches.length > 0;
}

export function mergeMacTimelineHistoryEvent(events, index, item, snapshots = [], { emit = null } = {}) {
  if (attachMacTimelineHistoryEvent(index, item)) return true;
  if (!Array.isArray(events)) return false;
  const snapshotId = String(item.snapshotId || "");
  const eventId = String(item.id ?? "");
  const field = text(item.field || item.label);
  const oldValue = text(item.oldValue ?? item.before);
  const newValue = text(item.newValue ?? item.after);
  const historyKey = eventId || JSON.stringify([snapshotId, item.timestamp || item.createdAt || "", field, oldValue, newValue, item.mac || ""]);
  const canSkipStableIdDeduplication = Boolean(eventId) && index?.dedupeStableEventIds === false;
  if (!canSkipStableIdDeduplication && index?.standaloneHistoryKeys?.has(historyKey)) return true;
  const snapshot = index?.snapshotsById
    ? index.snapshotsById.get(snapshotId)
    : snapshots.find((entry) => String(entry.id || "") === snapshotId);
  const snapshotEvent = index?.snapshotEventsById
    ? index.snapshotEventsById.get(snapshotId)
    : events.find((event) => !event.historyOnly && String(event.snapshotId || "") === snapshotId);
  const event = createMacTimelineStandaloneHistoryEvent(item, snapshot, snapshotEvent);
  if (!event) return false;
  if (typeof emit === "function") emit(event);
  else events.push(event);
  if (!canSkipStableIdDeduplication) index?.standaloneHistoryKeys?.add(historyKey);
  return true;
}

export function createMacTimelineAccumulator(mac, {
  dedupeStableEventIds = true,
  retainEvents = true,
  retainHistoryIndex = true,
  retainSnapshotMetadata = true,
  onEvent = null,
  onEventPatched = null,
} = {}) {
  const normalized = normalizeMac(mac);
  const events = [];
  const historyIndex = indexMacTimelineHistory([], [], { dedupeStableEventIds, onEventPatched });
  const emit = (event) => {
    if (typeof onEvent === "function") {
      const eventKey = onEvent(event);
      if (eventKey) Object.defineProperty(event, "__macTimelineKey", { value: String(eventKey), configurable: true });
    }
    if (retainEvents) events.push(event);
    if (retainHistoryIndex && !event.historyOnly) registerMacTimelineHistoryEvent(historyIndex, event);
    return event;
  };
  let previous = null;
  let previousSnapshot = null;
  let lastKnown = new Map();
  return {
    events,
    addSnapshot(snapshot, matches = []) {
      if (!normalized) return;
      const snapshotId = String(snapshot?.id || "");
      if (retainSnapshotMetadata && snapshotId && !historyIndex.snapshotsById.has(snapshotId)) historyIndex.snapshotsById.set(snapshotId, snapshot);
      if (matches.length > 1) {
        emit({ date: snapshot.createdAt, snapshotId: snapshot.id, snapshotName: snapshot.name, status: "ambiguous", candidates: matches, changes: [] });
        previous = null;
        previousSnapshot = null;
        lastKnown = new Map();
        return;
      }
      const device = matches[0];
      if (!device) {
        if (previous) emit({ date: snapshot.createdAt, snapshotId: snapshot.id, snapshotName: snapshot.name, previousSnapshotId: previousSnapshot?.id || "", previousSnapshotName: previousSnapshot?.name || "", status: "absent", before: backfillTimelineState(previous, lastKnown), after: null, changes: [] });
        previous = null;
        previousSnapshot = null;
        return;
      }
      const before = previous ? backfillTimelineState(previous, lastKnown) : null;
      const changes = previous ? COMPARED_FIELDS.filter(([field]) => {
        const oldValue = comparableValue(before, field);
        const after = comparableValue(device, field);
        return oldValue && after && keyText(oldValue) !== keyText(after);
      }).map(([field, label]) => ({ field, label, oldValue: comparableValue(before, field), newValue: comparableValue(device, field) })) : [];
      emit({
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
    },
    addHistory(item, snapshots = []) {
      if (!normalized) return false;
      for (const snapshot of snapshots) {
        const id = String(snapshot?.id || "");
        if (retainSnapshotMetadata && id && !historyIndex.snapshotsById.has(id)) historyIndex.snapshotsById.set(id, snapshot);
      }
      return mergeMacTimelineHistoryEvent(events, historyIndex, item, snapshots, { emit });
    },
    addEvent(event) {
      if (normalized && event) emit(event);
    },
    hasSnapshotStatus(snapshotId, status) {
      const event = historyIndex.snapshotEventsById.get(String(snapshotId || ""));
      return event?.status === status;
    },
    addSnapshotStatus(snapshotId, status) {
      const id = String(snapshotId || "");
      if (!id || (status !== "first" && status !== "absent")) return;
      if (!historyIndex.snapshotEventsById.has(id)) historyIndex.snapshotEventsById.set(id, { status });
    },
    get retainedLookupCounts() {
      return { historyKeys: historyIndex.size, snapshotEvents: historyIndex.snapshotEventsById.size, snapshots: historyIndex.snapshotsById.size };
    },
    finish(storedHistory = [], snapshots = []) {
      if (!normalized) return [];
      for (const snapshot of snapshots) {
        const id = String(snapshot?.id || "");
        if (retainSnapshotMetadata && id && !historyIndex.snapshotsById.has(id)) historyIndex.snapshotsById.set(id, snapshot);
      }
      for (const item of storedHistory) mergeMacTimelineHistoryEvent(events, historyIndex, item, snapshots, { emit });
      return events;
    },
  };
}

export function createMacTimelineSnapshotStatusIndex(events = []) {
  const indexedStatuses = new Set();
  const key = (snapshotId, status) => {
    const id = String(snapshotId || "");
    return status === "first" || status === "absent" ? JSON.stringify([id, status]) : "";
  };
  for (const event of events) {
    if (!event?.historyOnly) {
      const value = key(event?.snapshotId, event?.status);
      if (value) indexedStatuses.add(value);
    }
  }
  return {
    has(snapshotId, status) {
      const value = key(snapshotId, status);
      return Boolean(value && indexedStatuses.has(value));
    },
    add(snapshotId, status) {
      const value = key(snapshotId, status);
      if (value) indexedStatuses.add(value);
    },
  };
}

export function buildMacTimeline(mac, snapshots = [], storedHistory = []) {
  const normalized = normalizeMac(mac);
  if (!normalized) return [];
  const orderedSnapshots = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const timeline = createMacTimelineAccumulator(normalized);
  for (const snapshot of orderedSnapshots) {
    const matches = (snapshot.devices || []).filter((item) => deviceContainsNormalizedMac(item, normalized));
    timeline.addSnapshot(snapshot, matches);
  }
  return timeline.finish(storedHistory, orderedSnapshots);
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

