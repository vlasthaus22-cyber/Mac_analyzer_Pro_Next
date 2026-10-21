import { compareFinals } from "./comparison.js";
import { stableIdentity } from "./identity.js";
import { firstMac, keyText, locationKey, normalizeIp, normalizeMac, text } from "./normalize.js";
import { createFinalComparisonSummary } from "./comparison.js";
import { compactComparisonDevice } from "./compact-final-analytics.js";
import { dashboardDeviceMatchesFilters } from "./dashboard-filter.js";
import { isCriticalHistoryChange } from "./change-categories.js";

function deviceManufacturer(device = {}) {
  return text(device.manufacturer) || text(device.vendor);
}

function sortCountRows(counts, limit = null) {
  const rows = [];
  for (const [label, value] of counts) rows.push({ label, value });
  rows.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru"));
  return limit === null ? rows : rows.slice(0, limit);
}

function ranked(devices, field, limit = 12) {
  const counts = new Map();
  for (const device of devices) {
    const value = (field === "manufacturer" ? deviceManufacturer(device) : text(device[field])) || "Unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return sortCountRows(counts, limit);
}

function rankedCounts(counts) {
  return sortCountRows(counts);
}

function roomDescriptor(device) {
  return {
    key: locationKey(device),
    smartroomId: text(device.smartroomId),
    businessUnit: text(device.businessUnit),
    city: text(device.city),
    site: text(device.site),
    floor: text(device.floor),
    room: text(device.room),
    address: text(device.address),
  };
}

function roomLocationIndex(devices) {
  const locationToIds = new Map();
  for (const device of devices) addRoomSmartroomEvidence(locationToIds, device);
  return locationToIds;
}

function addRoomSmartroomEvidence(locationToIds, device) {
  const room = roomDescriptor(device);
  if (!room.room || !room.smartroomId) return;
  const location = locationKey({ ...room, smartroomId: "" });
  if (!locationToIds.has(location)) locationToIds.set(location, new Set());
  locationToIds.get(location).add(keyText(room.smartroomId));
}

function addAmbiguousDevices(target, row) {
  if (row?.after && typeof row.after === "object") target.add(row.after);
  for (const candidate of row?.candidates || []) {
    if (candidate && typeof candidate === "object") target.add(candidate);
  }
}

function collectAmbiguousDevices(rows = []) {
  const devices = new WeakSet();
  for (const row of rows) addAmbiguousDevices(devices, row);
  return devices;
}

function reconciledRoomDescriptor(device, locationToIds) {
  const room = roomDescriptor(device);
  if (room.smartroomId || !room.room) return room;
  const ids = locationToIds.get(locationKey(room));
  return ids?.size === 1 ? { ...room, key: `sr:${ids.values().next().value}`, inferredId: true } : room;
}

function knownSwitchCounts(switches) {
  const entries = [];
  let deviceCount = 0;
  for (const [ip, count] of switches) {
    if (ip === "missing") continue;
    entries.push([ip, count]);
    deviceCount += count;
  }
  entries.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return { entries, deviceCount };
}

export function analyzeRoomSwitchAnomalies(devices = [], locationToIds = roomLocationIndex(devices)) {
  const rooms = new Map();
  for (const device of devices) {
    const descriptor = reconciledRoomDescriptor(device, locationToIds);
    if (!descriptor.key || !descriptor.room) continue;
    if (!rooms.has(descriptor.key)) rooms.set(descriptor.key, { ...descriptor, deviceCount: 0, switches: new Map() });
    const room = rooms.get(descriptor.key);
    room.deviceCount += 1;
    const switchIp = normalizeIp(device.switchIp) || "missing";
    room.switches.set(switchIp, (room.switches.get(switchIp) || 0) + 1);
  }

  const anomalies = [];
  for (const room of rooms.values()) {
    const { entries: known, deviceCount: knownDeviceCount } = knownSwitchCounts(room.switches);
    if (knownDeviceCount < 3 || known.length < 2) continue;
    if (known[0][1] <= knownDeviceCount / 2) continue;
    const dominantIp = known[0][0];
    anomalies.push({
      ...room,
      dominantIp,
      switchCount: known.length,
      missingSwitchDevices: room.switches.get("missing") || 0,
      deviationCount: knownDeviceCount - known[0][1],
      switches: Object.fromEntries(known),
    });
  }
  return anomalies.sort((left, right) => right.deviationCount - left.deviationCount || left.room.localeCompare(right.room, "ru"));
}

export function analyzeRoomChangeCoverage(comparison, previousDevices = null, currentDevices = null) {
  const rooms = new Map();
  const locationToIds = new Map();
  const streamedPair = Array.isArray(previousDevices) && Array.isArray(currentDevices);
  const ambiguousDevices = streamedPair
    ? collectAmbiguousDevices(comparison.ambiguous || [])
    : null;
  const forEachRoomDevice = (visit) => {
    if (streamedPair) {
      for (const device of previousDevices) if (!ambiguousDevices.has(device)) visit(device);
      for (const device of currentDevices) if (!ambiguousDevices.has(device)) visit(device);
      return;
    }
    for (const row of comparison.modified || []) { visit(row.before); visit(row.after); }
    for (const row of comparison.unchanged || []) { visit(row.before); visit(row.after); }
    for (const device of comparison.added || []) visit(device);
    for (const device of comparison.absent || []) visit(device);
  };
  forEachRoomDevice((device) => addRoomSmartroomEvidence(locationToIds, device));
  let anonymous = 0;
  const addMember = (device, identity, changed, roster = false) => {
    const descriptor = reconciledRoomDescriptor(device, locationToIds);
    const key = descriptor.key;
    if (!key) return;
    if (!rooms.has(key)) rooms.set(key, { descriptor, members: new Map(), rosterCount: 0 });
    const room = rooms.get(key);
    const memberKey = identity || stableIdentity(device) || `anonymous:${anonymous++}`;
    room.members.set(memberKey, Boolean(room.members.get(memberKey) || changed));
    if (roster) room.rosterCount += 1;
  };

  if (streamedPair) {
    const modifiedByCurrent = new Map();
    for (const row of comparison.modified || []) modifiedByCurrent.set(row.after, row);
    const added = new Set(comparison.added || []);
    for (const device of currentDevices) {
      if (ambiguousDevices.has(device)) continue;
      const row = modifiedByCurrent.get(device);
      if (row) {
        const beforeRoom = reconciledRoomDescriptor(row.before, locationToIds);
        const afterRoom = reconciledRoomDescriptor(row.after, locationToIds);
        const identity = row.identity || stableIdentity(row.after) || stableIdentity(row.before);
        if (beforeRoom.key !== afterRoom.key) {
          addMember(row.before, identity, true);
          addMember(device, identity, true, true);
        } else {
          addMember(device, identity, true, true);
        }
      } else if (added.has(device)) {
        addMember(device, stableIdentity(device), true, true);
      } else {
        addMember(device, stableIdentity(device), false, true);
      }
    }
    for (const device of comparison.absent || []) addMember(device, stableIdentity(device), true);
  } else {
    for (const row of comparison.modified || []) {
      const beforeRoom = reconciledRoomDescriptor(row.before, locationToIds);
      const afterRoom = reconciledRoomDescriptor(row.after, locationToIds);
      const identity = row.identity || stableIdentity(row.after) || stableIdentity(row.before);
      if (beforeRoom.key !== afterRoom.key) {
        addMember(row.before, identity, true);
        addMember(row.after, identity, true, true);
      } else {
        addMember(row.after, identity, true, true);
      }
    }
    for (const row of comparison.unchanged || []) {
      const identity = row.identity || stableIdentity(row.after) || stableIdentity(row.before);
      addMember(row.after, identity, false, true);
    }
    comparison.added.forEach((device) => addMember(device, stableIdentity(device), true, true));
    comparison.absent.forEach((device) => addMember(device, stableIdentity(device), true));
  }

  const result = [];
  for (const room of rooms.values()) {
    let changedCount = 0;
    for (const changed of room.members.values()) if (changed) changedCount += 1;
    result.push({
      ...room.descriptor,
      deviceCount: room.members.size,
      rosterCount: room.rosterCount,
      changedCount,
      allChanged: room.members.size > 0 && changedCount === room.members.size,
    });
  }
  return result;
}

function weekKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Без даты";
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}

export function formatWeekRangeLabel(value) {
  const label = String(value || "Без даты");
  const match = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return label;
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== label) return label;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const format = (date) => `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const year = start.getUTCFullYear() === end.getUTCFullYear()
    ? String(start.getUTCFullYear())
    : `${start.getUTCFullYear()}/${end.getUTCFullYear()}`;
  return `${format(start)}–${format(end)}.${year}`;
}

function fillWeeklyGaps(rows) {
  let datedCount = 0;
  let firstLabel = "";
  let lastLabel = "";
  const byWeek = new Map();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.label)) continue;
    datedCount += 1;
    if (!firstLabel || row.label < firstLabel) firstLabel = row.label;
    if (!lastLabel || row.label > lastLabel) lastLabel = row.label;
    byWeek.set(row.label, row);
  }
  if (datedCount < 2) return rows;
  const first = new Date(`${firstLabel}T00:00:00.000Z`);
  const last = new Date(`${lastLabel}T00:00:00.000Z`);
  const weeks = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const label = cursor.toISOString().slice(0, 10);
    weeks.push(byWeek.get(label) || { label, modified: 0, added: 0, absent: 0, rooms: 0, macs: 0 });
  }
  for (const row of rows) if (row.label === "Без даты") weeks.push(row);
  return weeks;
}

export function defaultSnapshotSelection(snapshots = []) {
  const ordered = [...snapshots].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  return { baseId: ordered.at(-2)?.id || "", currentId: ordered.at(-1)?.id || "" };
}

function filterDevicesInPlace(devices, predicate) {
  if (typeof predicate !== "function") return devices;
  let kept = 0;
  for (let index = 0; index < devices.length; index += 1) {
    if (predicate(devices[index])) devices[kept++] = devices[index];
  }
  devices.length = kept;
  return devices;
}

function buildSelectedAnalytics(previous = { devices: [] }, current = { devices: [] }, deviceMatches, includeAbsentPositionMask = false, includeCurrentStatusMask = false, includeStatusClassifier = true) {
  const comparison = compareFinals(previous.devices || [], current.devices || [], current.createdAt, {
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeStatusClassifier,
    includeAbsentPositionMask,
    includeCurrentStatusMask,
    ...(typeof deviceMatches === "function" ? { deviceMatches } : {}),
  });
  filterDevicesInPlace(previous.devices || [], deviceMatches);
  filterDevicesInPlace(current.devices || [], deviceMatches);
  const devices = current.devices || [];
  const fieldChangeCounts = new Map();
  for (const row of comparison.modified || []) {
    for (const change of row.changes || []) {
      const label = String(change.label || change.field || "Изменение").trim() || "Изменение";
      fieldChangeCounts.set(label, (fieldChangeCounts.get(label) || 0) + 1);
    }
  }
  const absentVendorCounts = new Map();
  for (const device of comparison.absent || []) {
    const vendor = deviceManufacturer(device) || "Unknown";
    absentVendorCounts.set(vendor, (absentVendorCounts.get(vendor) || 0) + 1);
  }
  const dashboardExportSummary = {
    fieldChanges: Array.from(fieldChangeCounts, ([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru")),
    absentVendors: Array.from(absentVendorCounts, ([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru")),
  };
  const roomChanges = analyzeRoomChangeCoverage(comparison, previous.devices || [], devices);
  const currentRoomLocations = roomLocationIndex(devices);
  const roomSwitchAnomalies = analyzeRoomSwitchAnomalies(devices, currentRoomLocations);
  const unassignedVendorCounts = new Map();
  const unassignedModelCounts = new Map();
  const currentRoomKeys = new Set();
  const manufacturerKeys = new Set();
  let unassignedCount = 0;
  for (const device of devices) {
    const manufacturer = deviceManufacturer(device);
    if (manufacturer) manufacturerKeys.add(keyText(manufacturer));
    const room = reconciledRoomDescriptor(device, currentRoomLocations);
    if (room.key) currentRoomKeys.add(room.key);
    else {
      unassignedCount += 1;
      const vendor = manufacturer || "Unknown";
      const model = text(device.model) || "Unknown";
      unassignedVendorCounts.set(vendor, (unassignedVendorCounts.get(vendor) || 0) + 1);
      unassignedModelCounts.set(model, (unassignedModelCounts.get(model) || 0) + 1);
    }
  }
  const { devices: _previousDevices, ...previousMetadata } = previous;
  return {
    current,
    previous: previousMetadata,
    comparison,
    dashboardExportSummary,
    devices,
    kpis: {
      devices: devices.length,
      modified: comparison.modified.length,
      absent: comparison.absent.length,
      unchanged: comparison.unchangedCount,
      manufacturers: manufacturerKeys.size,
      rooms: currentRoomKeys.size,
      withoutRoom: unassignedCount,
      changedRooms: roomChanges.filter((room) => room.changedCount).length,
      allChangedRooms: roomChanges.filter((room) => room.allChanged).length,
      switchAnomalyRooms: roomSwitchAnomalies.length,
      codecChanges: comparison.modified.filter((row) => keyText(row.after.deviceType) === "video conference").length,
    },
    vendors: ranked(devices, "manufacturer"),
    models: ranked(devices, "model"),
    unassignedVendors: rankedCounts(unassignedVendorCounts),
    unassignedModels: rankedCounts(unassignedModelCounts),
    roomChanges,
    roomSwitchAnomalies,
    weekly: [],
    totals: [],
  };
}

export function buildAnalyticsPair(previous = { devices: [] }, current = { devices: [] }, { deviceMatches, includeAbsentPositionMask = false, includeCurrentStatusMask = false, includeStatusClassifier = true } = {}) {
  return buildSelectedAnalytics(previous, current, deviceMatches, includeAbsentPositionMask, includeCurrentStatusMask, includeStatusClassifier);
}

export const MAX_COMPARISON_DIAGNOSTIC_PREVIEW = 100;

/** Build selected Dashboard aggregates by rereading current Final chunks instead of retaining its full projection. */
export async function buildAnalyticsPairFromChunks(previous = { devices: [] }, current = {}, visitCurrentChunks, {
  deviceMatches = () => true,
  includeAbsentPositionMask = false,
  includeCurrentStatusMask = false,
  resolveIdentityChunk = null,
  visitPreviousChunks = null,
  previousDeviceCount = null,
  releasePreviousDevices = false,
  isCurrent = () => true,
  onProgress = () => {},
} = {}) {
  if (typeof visitCurrentChunks !== "function") throw new TypeError("Для расчёта Dashboard нужен поток чанков current Final");
  let baseline = previous.devices || [];
  if (resolveIdentityChunk !== null && typeof resolveIdentityChunk !== "function") throw new TypeError("Для расчёта Dashboard нужен resolver identity index baseline");
  if (visitPreviousChunks !== null && typeof visitPreviousChunks !== "function") throw new TypeError("Для расчёта Dashboard нужен поток чанков baseline");
  const resolvedPreviousCount = Math.max(0, Math.floor(Number(previousDeviceCount ?? previous.deviceCount ?? baseline.length) || 0));
  if (visitPreviousChunks && baseline.length) throw new Error("Потоковый baseline не должен одновременно удерживать полный массив devices");
  const currentDeviceCount = Math.max(0, Math.floor(Number(current.deviceCount) || 0));
  const timestamp = current.createdAt || new Date().toISOString();
  let observedSnapshotSignature = "";
  let pass = 0;
  const scan = async (label, visit) => {
    pass += 1;
    let processed = 0;
    onProgress({ phase: "start", pass, passes: 3, label, processed, total: currentDeviceCount });
    const metadata = await visitCurrentChunks(async (chunk = []) => {
      if (!isCurrent()) return false;
      await visit(chunk);
      processed += chunk.length;
      onProgress({ phase: "progress", pass, passes: 3, label, processed, total: currentDeviceCount });
      return true;
    });
    if (!isCurrent()) return false;
    if (current.id && metadata?.id) {
      if (metadata.id !== current.id) throw new Error("Во время расчёта изменился выбранный Final");
      const signature = JSON.stringify([metadata.id, metadata.createdAt || "", Number(metadata.deviceCount || 0), Number(metadata.chunkCount || 0), Number(metadata.dataRevision || 0)]);
      if (observedSnapshotSignature && observedSnapshotSignature !== signature) throw new Error("Выбранный Final изменился во время потокового расчёта. Обновите Dashboard и повторите.");
      observedSnapshotSignature = signature;
    }
    onProgress({ phase: "complete", pass, passes: 3, label, processed, total: currentDeviceCount });
    return true;
  };
  const createSummary = (options = {}) => createFinalComparisonSummary(baseline, timestamp, {
    deviceMatches,
    includeChangeLocations: false,
    previousCount: resolvedPreviousCount,
    deviceCount: includeCurrentStatusMask ? currentDeviceCount : null,
    includeAbsentPositionMask,
    includeCurrentStatusMask,
    ...options,
  });

  const comparisonPassOptions = { includeAmbiguousPositionMask: Boolean(visitPreviousChunks) };
  const observeSummaryChunk = async (summary, chunk) => {
    const projectedChunk = chunk.map(compactComparisonDevice);
    const identityIndex = resolveIdentityChunk ? await resolveIdentityChunk(projectedChunk) : undefined;
    if (resolveIdentityChunk && !identityIndex) throw new Error("Не удалось разрешить identity index baseline для чанка Dashboard");
    summary.observeChunk(projectedChunk, identityIndex);
  };
  const finishSummary = async (summary) => {
    if (!visitPreviousChunks) return summary.finish();
    let previousOffset = 0;
    await visitPreviousChunks((chunk = []) => {
      summary.observePreviousChunk(chunk, previousOffset);
      previousOffset += chunk.length;
    });
    return summary.finish({ streamedPrevious: true });
  };

  const ambiguous = [];
  const identityConflicts = [];
  const ambiguousDevices = new WeakSet();
  const comparisonPass = createSummary({
    ...comparisonPassOptions,
    onAmbiguous: (row) => {
      if (ambiguous.length < MAX_COMPARISON_DIAGNOSTIC_PREVIEW) ambiguous.push(row);
      addAmbiguousDevices(ambiguousDevices, row);
    },
    onIdentityConflict: (row) => {
      if (identityConflicts.length < MAX_COMPARISON_DIAGNOSTIC_PREVIEW) identityConflicts.push(row);
    },
  });
  if (!await scan("Сверка идентичности и статусов", (chunk) => observeSummaryChunk(comparisonPass, chunk))) return null;
  const compared = await finishSummary(comparisonPass);

  const currentRoomLocations = new Map();
  const comparisonRoomLocations = new Map();
  if (visitPreviousChunks) {
    let previousOffset = 0;
    await visitPreviousChunks((chunk = []) => {
      for (let index = 0; index < chunk.length; index += 1) {
        const device = chunk[index];
        if (deviceMatches(device) && !compared.ambiguousPositionMask[previousOffset + index]) addRoomSmartroomEvidence(comparisonRoomLocations, device);
      }
      previousOffset += chunk.length;
    });
  } else {
    for (const device of baseline) {
      if (deviceMatches(device) && !ambiguousDevices.has(device)) addRoomSmartroomEvidence(comparisonRoomLocations, device);
    }
  }
  const manufacturerOptions = new Set();
  const roomOptions = new Set();
  const evidencePass = createSummary({
    onAdded: (after) => addRoomSmartroomEvidence(comparisonRoomLocations, after),
    onModified: (row) => {
      addRoomSmartroomEvidence(comparisonRoomLocations, row.before);
      addRoomSmartroomEvidence(comparisonRoomLocations, row.after);
    },
    onUnchanged: (row) => {
      addRoomSmartroomEvidence(comparisonRoomLocations, row.before);
      addRoomSmartroomEvidence(comparisonRoomLocations, row.after);
    },
    onAbsent: (before) => addRoomSmartroomEvidence(comparisonRoomLocations, before),
  });
  if (!await scan("Индексы помещений и фильтров", async (chunk) => {
    const projectedChunk = chunk.map(compactComparisonDevice);
    for (const device of projectedChunk) {
      const manufacturer = deviceManufacturer(device);
      const room = text(device.room);
      if (manufacturer) manufacturerOptions.add(manufacturer);
      if (room) roomOptions.add(room);
      if (deviceMatches(device)) addRoomSmartroomEvidence(currentRoomLocations, device);
    }
    const identityIndex = resolveIdentityChunk ? await resolveIdentityChunk(projectedChunk) : undefined;
    if (resolveIdentityChunk && !identityIndex) throw new Error("Не удалось разрешить identity index baseline для чанка Dashboard");
    evidencePass.observeChunk(projectedChunk, identityIndex);
  })) return null;
  await finishSummary(evidencePass);

  const vendorCounts = new Map();
  const modelCounts = new Map();
  const manufacturerKeys = new Set();
  const currentRoomKeys = new Set();
  const unassignedVendorCounts = new Map();
  const unassignedModelCounts = new Map();
  const anomalyRooms = new Map();
  const changeRooms = new Map();
  let deviceCount = 0;
  let unassignedCount = 0;
  let anonymous = 0;
  const addCount = (counts, value) => counts.set(value, (counts.get(value) || 0) + 1);
  const addChangeMember = (device, identity, changed, roster = false) => {
    const descriptor = reconciledRoomDescriptor(device, comparisonRoomLocations);
    if (!descriptor.key) return;
    if (!changeRooms.has(descriptor.key)) changeRooms.set(descriptor.key, { descriptor, members: new Map(), deviceCount: 0, changedCount: 0, rosterCount: 0 });
    const room = changeRooms.get(descriptor.key);
    const memberKey = identity || stableIdentity(device) || `anonymous:${anonymous++}`;
    if (!room.members.has(memberKey)) {
      room.members.set(memberKey, Boolean(changed));
      room.deviceCount += 1;
      if (changed) room.changedCount += 1;
    } else if (changed && !room.members.get(memberKey)) {
      room.members.set(memberKey, true);
      room.changedCount += 1;
    }
    if (roster) room.rosterCount += 1;
  };
  const analyticsPass = createSummary({
    onAdded: (after) => addChangeMember(after, stableIdentity(after), true, true),
    onModified: (row) => {
      const beforeRoom = reconciledRoomDescriptor(row.before, comparisonRoomLocations);
      const afterRoom = reconciledRoomDescriptor(row.after, comparisonRoomLocations);
      const identity = row.identity || stableIdentity(row.after) || stableIdentity(row.before);
      if (beforeRoom.key !== afterRoom.key) {
        addChangeMember(row.before, identity, true);
        addChangeMember(row.after, identity, true, true);
      } else addChangeMember(row.after, identity, true, true);
    },
    onUnchanged: (row) => addChangeMember(row.after, row.identity || stableIdentity(row.after) || stableIdentity(row.before), false, true),
    onAbsent: (before) => addChangeMember(before, stableIdentity(before), true),
  });
  if (!await scan("KPI, рейтинги и coverage", async (chunk) => {
    const projectedChunk = chunk.map(compactComparisonDevice);
    for (const device of projectedChunk) {
      if (!deviceMatches(device)) continue;
      deviceCount += 1;
      const manufacturer = deviceManufacturer(device);
      const model = text(device.model);
      addCount(vendorCounts, manufacturer || "Unknown");
      addCount(modelCounts, model || "Unknown");
      if (manufacturer) manufacturerKeys.add(keyText(manufacturer));
      const room = reconciledRoomDescriptor(device, currentRoomLocations);
      if (room.key) currentRoomKeys.add(room.key);
      else {
        unassignedCount += 1;
        addCount(unassignedVendorCounts, manufacturer || "Unknown");
        addCount(unassignedModelCounts, model || "Unknown");
      }
      if (!room.key || !room.room) continue;
      if (!anomalyRooms.has(room.key)) anomalyRooms.set(room.key, { ...room, deviceCount: 0, switches: new Map() });
      const anomaly = anomalyRooms.get(room.key);
      anomaly.deviceCount += 1;
      const switchIp = normalizeIp(device.switchIp) || "missing";
      addCount(anomaly.switches, switchIp);
    }
    const identityIndex = resolveIdentityChunk ? await resolveIdentityChunk(projectedChunk) : undefined;
    if (resolveIdentityChunk && !identityIndex) throw new Error("Не удалось разрешить identity index baseline для чанка Dashboard");
    analyticsPass.observeChunk(projectedChunk, identityIndex);
  })) return null;
  await finishSummary(analyticsPass);

  const roomSwitchAnomalies = [];
  for (const room of anomalyRooms.values()) {
    const { entries: known, deviceCount: knownDeviceCount } = knownSwitchCounts(room.switches);
    if (knownDeviceCount < 3 || known.length < 2) continue;
    if (known[0][1] <= knownDeviceCount / 2) continue;
    roomSwitchAnomalies.push({
      ...room,
      dominantIp: known[0][0],
      switchCount: known.length,
      missingSwitchDevices: room.switches.get("missing") || 0,
      deviationCount: knownDeviceCount - known[0][1],
      switches: Object.fromEntries(known),
    });
  }
  roomSwitchAnomalies.sort((left, right) => right.deviationCount - left.deviationCount || left.room.localeCompare(right.room, "ru"));
  const roomChanges = [];
  for (const room of changeRooms.values()) {
    roomChanges.push({ ...room.descriptor, deviceCount: room.deviceCount, rosterCount: room.rosterCount, changedCount: room.changedCount, allChanged: room.deviceCount > 0 && room.changedCount === room.deviceCount });
  }
  const sortCounts = (counts) => sortCountRows(counts);
  const optionOrder = (left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }) || left.localeCompare(right);
  const comparison = {
    added: [], absent: [], modified: [], unchanged: [], critical: [],
    ambiguous,
    identityConflicts,
    timestamp,
    addedCount: compared.added,
    absentCount: compared.absent,
    modifiedDeviceCount: compared.modified,
    unchangedCount: compared.unchanged,
    modifiedEventCount: compared.modifiedEventCount,
    criticalModifiedEventCount: compared.criticalModifiedEventCount,
    criticalModifiedDeviceCount: compared.criticalModifiedDeviceCount,
    ambiguousCount: compared.ambiguous,
    identityConflictCount: compared.identityConflicts,
    codecChanges: compared.codecChanges,
    ...(compared.absentPositionMask ? { absentPositionMask: compared.absentPositionMask } : {}),
    ...(compared.currentStatusMask ? { currentStatusMask: compared.currentStatusMask } : {}),
  };
  const previousMetadata = { ...previous };
  delete previousMetadata.devices;
  const dashboardExportSummary = {
    fieldChanges: sortCounts(new Map(Object.entries(compared.fieldChanges))),
    absentVendors: sortCounts(new Map(Object.entries(compared.absentVendors))),
  };
  let changedRoomCount = 0;
  let allChangedRoomCount = 0;
  for (const room of roomChanges) {
    if (room.changedCount) changedRoomCount += 1;
    if (room.allChanged) allChangedRoomCount += 1;
  }
  if (releasePreviousDevices) {
    previous.devices = [];
    baseline = null;
  }
  return {
    current: { ...current },
    previous: previousMetadata,
    comparison,
    dashboardExportSummary,
    devices: [],
    dashboardFilterOptions: {
      manufacturers: [...manufacturerOptions].sort(optionOrder),
      rooms: [...roomOptions].sort(optionOrder),
    },
    kpis: {
      devices: deviceCount,
      modified: compared.modified,
      absent: compared.absent,
      unchanged: compared.unchanged,
      manufacturers: manufacturerKeys.size,
      rooms: currentRoomKeys.size,
      withoutRoom: unassignedCount,
      changedRooms: changedRoomCount,
      allChangedRooms: allChangedRoomCount,
      switchAnomalyRooms: roomSwitchAnomalies.length,
      codecChanges: compared.codecChanges,
    },
    vendors: sortCounts(vendorCounts).slice(0, 12),
    models: sortCounts(modelCounts).slice(0, 12),
    unassignedVendors: sortCounts(unassignedVendorCounts),
    unassignedModels: sortCounts(unassignedModelCounts),
    roomChanges,
    roomSwitchAnomalies,
    weekly: [],
    totals: [],
  };
}

export function releaseDashboardCurrentDevices(analytics) {
  if (!analytics?.current?.id) return analytics;
  delete analytics.current.devices;
  delete analytics.devices;
  const modifiedRows = analytics.comparison.modified || [];
  if (!Number.isFinite(Number(analytics.comparison.modifiedDeviceCount))) analytics.comparison.modifiedDeviceCount = modifiedRows.length;
  const needsModifiedEventCount = !Number.isFinite(Number(analytics.comparison.modifiedEventCount));
  const needsCriticalEventCount = !Number.isFinite(Number(analytics.comparison.criticalModifiedEventCount));
  const needsCriticalDeviceCount = !Number.isFinite(Number(analytics.comparison.criticalModifiedDeviceCount));
  if (needsModifiedEventCount || needsCriticalEventCount || needsCriticalDeviceCount) {
    let modifiedEventCount = 0;
    let criticalModifiedEventCount = 0;
    let criticalModifiedDeviceCount = 0;
    for (const row of modifiedRows) {
      let criticalDevice = false;
      for (const change of row.changes || []) {
        modifiedEventCount += 1;
        const before = String(change.oldValue ?? "").trim();
        const after = String(change.newValue ?? "").trim();
        if (["mac", "ip", "switchIp"].includes(change.field) && before && after && keyText(before) !== keyText(after)) {
          criticalModifiedEventCount += 1;
        }
        if (isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) criticalDevice = true;
      }
      if (criticalDevice) criticalModifiedDeviceCount += 1;
    }
    if (needsModifiedEventCount) analytics.comparison.modifiedEventCount = modifiedEventCount;
    if (needsCriticalEventCount) analytics.comparison.criticalModifiedEventCount = criticalModifiedEventCount;
    if (needsCriticalDeviceCount) analytics.comparison.criticalModifiedDeviceCount = criticalModifiedDeviceCount;
  }
  analytics.comparison.modified = [];
  analytics.comparison.addedCount = Math.max(analytics.comparison.added.length, Math.floor(Number(analytics.comparison.addedCount) || 0));
  analytics.comparison.added = [];
  analytics.comparison.absentCount = Math.max(analytics.comparison.absent.length, Math.floor(Number(analytics.comparison.absentCount) || 0));
  analytics.comparison.absent = [];
  return analytics;
}

export function createWeeklyComparisonAccumulator() {
  const weekly = new Map();
  const observeSummary = (current, comparison) => {
    const key = weekKey(current.createdAt);
    const bucket = weekly.get(key) || { label: key, modified: 0, added: 0, absent: 0, rooms: new Set(), macs: new Set() };
    bucket.modified += comparison.modified;
    bucket.added += comparison.added;
    bucket.absent += comparison.absent;
    comparison.rooms.forEach((room) => bucket.rooms.add(room));
    comparison.macs.forEach((mac) => bucket.macs.add(mac));
    weekly.set(key, bucket);
  };
  return Object.freeze({
    observe(previous, current, comparison = compareFinals(previous.devices || [], current.devices || [], current.createdAt)) {
      const key = weekKey(current.createdAt);
      const bucket = weekly.get(key) || { label: key, modified: 0, added: 0, absent: 0, rooms: new Set(), macs: new Set() };
      bucket.modified += comparison.modified.length;
      bucket.added += comparison.added.length;
      bucket.absent += comparison.absent.length;
      comparison.modified.forEach((row) => {
        const room = locationKey(row.after);
        if (room) bucket.rooms.add(room);
        if (row.after.mac) bucket.macs.add(row.after.mac);
      });
      weekly.set(key, bucket);
    },
    observeSummary(current, comparison) { observeSummary(current, comparison); },
    result() {
      const rows = [];
      for (const item of weekly.values()) rows.push({ ...item, rooms: item.rooms.size, macs: item.macs.size });
      rows.sort((left, right) => left.label.localeCompare(right.label));
      return fillWeeklyGaps(rows);
    },
  });
}

export function buildAnalytics(snapshots = [], selectedBaseId = "", selectedCurrentId = "") {
  const ordered = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const current = ordered.find((snapshot) => snapshot.id === selectedCurrentId) || ordered.at(-1) || { devices: [] };
  const currentIndex = ordered.indexOf(current);
  const previous = ordered.find((snapshot) => snapshot.id === selectedBaseId) || ordered[currentIndex - 1] || { devices: [] };
  const analytics = buildSelectedAnalytics(previous, current);
  const weekly = createWeeklyComparisonAccumulator();
  const snapshotChanges = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const before = ordered[index - 1];
    const after = ordered[index];
    const comparison = compareFinals(before.devices || [], after.devices || [], after.createdAt);
    weekly.observe(before, after, comparison);
    snapshotChanges.push({ label: after.name || after.createdAt, added: comparison.added.length, absent: comparison.absent.length });
  }
  analytics.weekly = weekly.result();
  analytics.snapshotChanges = snapshotChanges;
  analytics.totals = buildSnapshotTotalSeries(ordered);
  return analytics;
}

function presenceMac(device) {
  if (typeof device === "string") return firstMac(device);
  return firstMac(device?.mac, device?.macFormatted);
}

export function createPresenceChurnTracker() {
  const indexes = new Map();
  const macByIndex = [];
  const details = new Map();
  const snapshotDates = [];
  let capacity = 0;
  let transitions = new Uint32Array(0);
  let present = new Uint32Array(0);
  let disappearances = new Uint32Array(0);
  let reappearances = new Uint32Array(0);
  let presentLast = new Uint8Array(0);
  let everSeen = new Uint8Array(0);
  let firstSeenIndex = new Int32Array(0);
  let lastSeenIndex = new Int32Array(0);
  let seenInSnapshot = new Uint32Array(0);
  let previousPositions = new Uint32Array(0);
  let previousPositionCount = 0;
  let incoming = null;
  let snapshotCount = 0;
  let snapshotGeneration = 0;
  const ensureCapacity = (required) => {
    if (required <= capacity) return;
    const nextCapacity = Math.max(16, capacity ? capacity * 2 : 16, required);
    const grow = (array, Type, fill = 0) => {
      const next = new Type(nextCapacity);
      next.set(array);
      if (fill !== 0) next.fill(fill, array.length);
      return next;
    };
    transitions = grow(transitions, Uint32Array);
    present = grow(present, Uint32Array);
    disappearances = grow(disappearances, Uint32Array);
    reappearances = grow(reappearances, Uint32Array);
    presentLast = grow(presentLast, Uint8Array);
    everSeen = grow(everSeen, Uint8Array);
    firstSeenIndex = grow(firstSeenIndex, Int32Array, -1);
    lastSeenIndex = grow(lastSeenIndex, Int32Array, -1);
    seenInSnapshot = grow(seenInSnapshot, Uint32Array);
    capacity = nextCapacity;
  };
  const indexFor = (mac) => {
    let index = indexes.get(mac);
    if (index === undefined) {
      index = indexes.size;
      ensureCapacity(index + 1);
      indexes.set(mac, index);
      macByIndex.push(mac);
    }
    return index;
  };
  const hasDisappeared = (macOrIndex) => {
    const index = typeof macOrIndex === "number" ? macOrIndex : indexes.get(macOrIndex);
    return index !== undefined && disappearances[index] > 0;
  };
  const compactPresenceRecord = (device = {}) => ({
    macFormatted: presenceMac(device),
    vendor: String(device.vendor || device.manufacturer || ""),
    model: String(device.model || ""),
    ip: String(device.ip || ""),
    room: String(device.room || ""),
    address: String(device.address || ""),
    smartroomId: String(device.smartroomId || device.smartroom_id || ""),
  });
  const commit = (current) => {
    const observedAt = current.observedAt;
    const observedAtIndex = snapshotDates.length;
    snapshotDates.push(observedAt);
    for (let position = 0; position < previousPositionCount; position += 1) {
      const index = previousPositions[position];
      if (seenInSnapshot[index] === current.generation) continue;
      transitions[index] += 1;
      disappearances[index] += 1;
      presentLast[index] = 0;
    }
    for (let position = 0; position < current.count; position += 1) {
      const index = current.positions[position];
      const mac = macByIndex[index];
      const device = current.details.get(mac);
      if (everSeen[index] && !presentLast[index]) {
        transitions[index] += 1;
        reappearances[index] += 1;
      }
      if (device && disappearances[index] > 0 && reappearances[index] > 0) {
        details.set(mac, { mac, ...device });
      }
      if (observedAt && firstSeenIndex[index] < 0) firstSeenIndex[index] = observedAtIndex;
      if (observedAt) lastSeenIndex[index] = observedAtIndex;
      present[index] += 1;
      presentLast[index] = 1;
      everSeen[index] = 1;
    }
    previousPositions = current.positions;
    previousPositionCount = current.count;
    snapshotCount += 1;
  };
  const beginSnapshot = (snapshot = {}) => {
    if (incoming) throw new Error("Предыдущий MAC-churn снимок ещё не завершён");
    if (snapshotGeneration === 0xffffffff) {
      seenInSnapshot.fill(0);
      snapshotGeneration = 1;
    } else snapshotGeneration += 1;
    incoming = {
      generation: snapshotGeneration,
      positions: new Uint32Array(0),
      count: 0,
      details: new Map(),
      observedAt: String(snapshot.fileCreatedAt || snapshot.createdAt || snapshot.savedAt || ""),
    };
  };
  const observeDevice = (device) => {
    if (!incoming) throw new Error("Перед MAC устройством не начат churn-снимок");
    const mac = presenceMac(device);
    if (!mac) return;
    const index = indexFor(mac);
    if (seenInSnapshot[index] !== incoming.generation) {
      seenInSnapshot[index] = incoming.generation;
      if (incoming.count === incoming.positions.length) {
        const next = new Uint32Array(Math.max(16, incoming.positions.length * 2));
        next.set(incoming.positions);
        incoming.positions = next;
      }
      incoming.positions[incoming.count++] = index;
    }
    if (hasDisappeared(index)) {
      incoming.details.set(mac, compactPresenceRecord(typeof device === "string" ? {} : device));
    }
  };
  const endSnapshot = () => {
    if (!incoming) throw new Error("Нет текущего MAC-churn снимка");
    const current = incoming;
    incoming = null;
    commit(current);
  };
  return Object.freeze({
    beginSnapshot,
    observeDevice,
    endSnapshot,
    observe(_snapshot = {}, devices = []) {
      if (incoming) throw new Error("Завершите MAC-churn снимок перед прямым наблюдением");
      beginSnapshot(_snapshot);
      for (const device of devices || []) observeDevice(device);
      endSnapshot();
    },
    result() {
      const result = [];
      for (const [mac, index] of indexes) {
        if (disappearances[index] === 0 || reappearances[index] === 0) continue;
        result.push({
          ...details.get(mac),
          transitions: transitions[index],
          present: present[index],
          disappearances: disappearances[index],
          reappearances: reappearances[index],
          presentLast: Boolean(presentLast[index]),
          everSeen: Boolean(everSeen[index]),
          firstSeen: firstSeenIndex[index] >= 0 ? snapshotDates[firstSeenIndex[index]] : "",
          lastSeen: lastSeenIndex[index] >= 0 ? snapshotDates[lastSeenIndex[index]] : "",
          absent: Math.max(0, snapshotCount - present[index]),
          transitionCount: transitions[index],
        });
      }
      return result
        .sort((left, right) => right.transitionCount - left.transitionCount || right.reappearances - left.reappearances || left.mac.localeCompare(right.mac));
    },
    uniqueCount() { return indexes.size; },
  });
}

export async function collectPresenceTransitions(mac, snapshots = [], visitSnapshotChunks, { filters = {} } = {}) {
  const normalizedMac = normalizeMac(mac);
  if (!normalizedMac) return [];
  if (typeof visitSnapshotChunks !== "function") throw new Error("Требуется потоковое чтение чанков Final");
  const orderedSnapshots = [...snapshots].sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
  const transitions = [];
  let everSeen = false;
  let previousPresent = false;
  for (const snapshot of orderedSnapshots) {
    let present = false;
    await visitSnapshotChunks(snapshot.id, (devices = []) => {
      for (const device of devices) {
        if (!dashboardDeviceMatchesFilters(device, filters)) continue;
        if (presenceMac(device) === normalizedMac) {
          present = true;
          break;
        }
      }
    });
    const date = String(snapshot.fileCreatedAt || snapshot.createdAt || snapshot.savedAt || "");
    const details = { snapshotId: String(snapshot.id || ""), name: String(snapshot.name || ""), date };
    if (previousPresent && !present) transitions.push({ type: "absent", ...details });
    else if (present && everSeen && !previousPresent) transitions.push({ type: "present", ...details });
    if (present) everSeen = true;
    previousPresent = present;
  }
  return transitions;
}

export function snapshotHistorySignature(snapshots = []) {
  return JSON.stringify(["snapshot-history-v2", [...snapshots]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)))
    .map((snapshot) => [snapshot.id, snapshot.createdAt, Number(snapshot.deviceCount || 0), Number(snapshot.chunkCount || 0), Number(snapshot.dataRevision || 0)])]);
}

export function buildSnapshotTotalSeries(snapshots = []) {
  return [...snapshots]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .map((snapshot) => ({
      label: snapshot.name || snapshot.createdAt,
      value: Math.max(0, Number(snapshot.deviceCount ?? snapshot.devices?.length ?? 0) || 0),
    }));
}

export async function aggregateSnapshotHistory(snapshots = [], visitSnapshotChunks, { filters = {}, deviceMatches = (device) => dashboardDeviceMatchesFilters(device, filters) } = {}) {
  if (typeof visitSnapshotChunks !== "function") throw new Error("Требуется функция последовательного чтения чанков Final");
  const ordered = [...snapshots].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const weekly = createWeeklyComparisonAccumulator();
  const churn = createPresenceChurnTracker();
  const snapshotChanges = [];
  const snapshotTotals = [];
  let deviceTotal = 0;
  let previousDevices = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const snapshot = ordered[index];
    const comparison = index > 0 ? createFinalComparisonSummary(previousDevices, snapshot.createdAt, { deviceMatches }) : null;
    const currentDevices = [];
    let filteredDeviceCount = 0;
    churn.beginSnapshot(snapshot);
    await visitSnapshotChunks(snapshot.id, (devices) => {
      for (const device of devices) {
        currentDevices.push(compactComparisonDevice(device));
        if (deviceMatches(device)) filteredDeviceCount += 1;
      }
      comparison?.observeChunk(devices);
      for (const device of devices) if (deviceMatches(device)) churn.observeDevice(device);
    }, snapshot, index);
    churn.endSnapshot();
    if (comparison) {
      const summary = comparison.finish();
      weekly.observeSummary(snapshot, summary);
      snapshotChanges.push({ label: snapshot.name || snapshot.createdAt, added: summary.added, absent: summary.absent });
    }
    previousDevices = currentDevices;
    snapshotTotals.push({ label: snapshot.name || snapshot.createdAt, value: filteredDeviceCount });
    deviceTotal += filteredDeviceCount;
  }
  return {
    weekly: weekly.result(),
    snapshotChanges,
    totals: snapshotTotals,
    churn: churn.result(),
    history: {
      snapshots: ordered.length,
      deviceTotal,
      uniqueMacs: churn.uniqueCount(),
    },
  };
}

export function buildPresenceChurn(snapshots = []) {
  const ordered = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const tracker = createPresenceChurnTracker();
  for (const snapshot of ordered) tracker.observe(snapshot, snapshot.devices || []);
  return tracker.result();
}

