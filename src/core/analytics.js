import { compareFinals } from "./comparison.js";
import { stableIdentity } from "./identity.js";
import { keyText, locationKey, normalizeIp, normalizeMac, text } from "./normalize.js";
import { createFinalComparisonSummary } from "./comparison.js";
import { compactComparisonDevice } from "./compact-final-analytics.js";
import { dashboardDeviceMatchesFilters } from "./dashboard-filter.js";
import { isCriticalHistoryChange } from "./change-categories.js";

function ranked(devices, field, limit = 12) {
  const counts = new Map();
  for (const device of devices) {
    const value = text(device[field]) || "Unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru"))
    .slice(0, limit);
}

function rankedCounts(counts) {
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru"));
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

function reconcileRoomKeys(devices) {
  const locationToIds = new Map();
  const descriptors = devices.map((device) => roomDescriptor(device));
  descriptors.forEach((room) => {
    if (!room.room || !room.smartroomId) return;
    const location = locationKey({ ...room, smartroomId: "" });
    if (!locationToIds.has(location)) locationToIds.set(location, new Set());
    locationToIds.get(location).add(keyText(room.smartroomId));
  });
  return descriptors.map((room) => {
    if (room.smartroomId || !room.room) return room;
    const location = locationKey(room);
    const ids = [...(locationToIds.get(location) || [])];
    return ids.length === 1 ? { ...room, key: `sr:${ids[0]}`, inferredId: true } : room;
  });
}

function addRoomSmartroomEvidence(locationToIds, device) {
  const room = roomDescriptor(device);
  if (!room.room || !room.smartroomId) return;
  const location = locationKey({ ...room, smartroomId: "" });
  if (!locationToIds.has(location)) locationToIds.set(location, new Set());
  locationToIds.get(location).add(keyText(room.smartroomId));
}

function reconciledRoomDescriptor(device, locationToIds) {
  const room = roomDescriptor(device);
  if (room.smartroomId || !room.room) return room;
  const ids = locationToIds.get(locationKey(room));
  return ids?.size === 1 ? { ...room, key: `sr:${ids.values().next().value}`, inferredId: true } : room;
}

export function analyzeRoomSwitchAnomalies(devices = []) {
  const rooms = new Map();
  const descriptors = reconcileRoomKeys(devices);
  devices.forEach((device, index) => {
    const descriptor = descriptors[index];
    if (!descriptor.key || !descriptor.room) return;
    if (!rooms.has(descriptor.key)) rooms.set(descriptor.key, { ...descriptor, deviceCount: 0, switches: new Map() });
    const room = rooms.get(descriptor.key);
    room.deviceCount += 1;
    const switchIp = normalizeIp(device.switchIp) || "missing";
    room.switches.set(switchIp, (room.switches.get(switchIp) || 0) + 1);
  });

  const anomalies = [];
  for (const room of rooms.values()) {
    const known = [...room.switches.entries()].filter(([ip]) => ip !== "missing");
    const knownDeviceCount = known.reduce((sum, [, count]) => sum + count, 0);
    if (knownDeviceCount < 3 || known.length < 2) continue;
    known.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
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
    ? new Set((comparison.ambiguous || []).flatMap((row) => [row.after, ...(row.candidates || [])]))
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
    const modifiedByCurrent = new Map((comparison.modified || []).map((row) => [row.after, row]));
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

  return [...rooms.values()].map((room) => {
    const changedCount = [...room.members.values()].filter(Boolean).length;
    return {
      ...room.descriptor,
      deviceCount: room.members.size,
      rosterCount: room.rosterCount,
      changedCount,
      allChanged: room.members.size > 0 && changedCount === room.members.size,
    };
  });
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
  const dated = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.label));
  if (dated.length < 2) return rows;
  const byWeek = new Map(dated.map((row) => [row.label, row]));
  const first = new Date(`${dated[0].label}T00:00:00.000Z`);
  const last = new Date(`${dated.at(-1).label}T00:00:00.000Z`);
  const weeks = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const label = cursor.toISOString().slice(0, 10);
    weeks.push(byWeek.get(label) || { label, modified: 0, added: 0, absent: 0, rooms: 0, macs: 0 });
  }
  const undated = rows.filter((row) => row.label === "Без даты");
  return [...weeks, ...undated];
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

function buildSelectedAnalytics(previous = { devices: [] }, current = { devices: [] }, deviceMatches) {
  const comparison = compareFinals(previous.devices || [], current.devices || [], current.createdAt, {
    includeUnchangedRows: false,
    includeStatusClassifier: true,
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
    const vendor = String(device.manufacturer || device.vendor || "Unknown").trim() || "Unknown";
    absentVendorCounts.set(vendor, (absentVendorCounts.get(vendor) || 0) + 1);
  }
  const dashboardExportSummary = {
    fieldChanges: Array.from(fieldChangeCounts, ([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru")),
    absentVendors: Array.from(absentVendorCounts, ([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "ru")),
  };
  const roomChanges = analyzeRoomChangeCoverage(comparison, previous.devices || [], devices);
  const roomSwitchAnomalies = analyzeRoomSwitchAnomalies(devices);
  const currentRoomDescriptors = reconcileRoomKeys(devices);
  const unassignedVendorCounts = new Map();
  const unassignedModelCounts = new Map();
  let unassignedCount = 0;
  devices.forEach((device, index) => {
    if (currentRoomDescriptors[index].key) return;
    unassignedCount += 1;
    const vendor = text(device.manufacturer) || "Unknown";
    const model = text(device.model) || "Unknown";
    unassignedVendorCounts.set(vendor, (unassignedVendorCounts.get(vendor) || 0) + 1);
    unassignedModelCounts.set(model, (unassignedModelCounts.get(model) || 0) + 1);
  });
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
      manufacturers: new Set(devices.map((item) => keyText(item.manufacturer)).filter(Boolean)).size,
      rooms: new Set(currentRoomDescriptors.map((item) => item.key).filter(Boolean)).size,
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

export function buildAnalyticsPair(previous = { devices: [] }, current = { devices: [] }, { deviceMatches } = {}) {
  return buildSelectedAnalytics(previous, current, deviceMatches);
}

export function releaseDashboardCurrentDevices(analytics) {
  if (!analytics?.current?.id) return analytics;
  delete analytics.current.devices;
  delete analytics.devices;
  const modifiedRows = analytics.comparison.modified || [];
  analytics.comparison.modifiedDeviceCount = modifiedRows.length;
  analytics.comparison.modifiedEventCount = modifiedRows.reduce((count, row) => count + (row.changes || []).length, 0);
  analytics.comparison.criticalModifiedEventCount = modifiedRows.reduce((count, row) => count + (row.changes || []).filter((change) =>
    ["mac", "ip", "switchIp"].includes(change.field)
      && String(change.oldValue ?? "").trim() !== ""
      && String(change.newValue ?? "").trim() !== ""
      && keyText(change.oldValue) !== keyText(change.newValue),
  ).length, 0);
  analytics.comparison.criticalModifiedDeviceCount = modifiedRows.reduce((count, row) => count + (
    (row.changes || []).some((change) => isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) ? 1 : 0
  ), 0);
  analytics.comparison.modified = [];
  analytics.comparison.addedCount = analytics.comparison.added.length;
  analytics.comparison.added = [];
  analytics.comparison.absentCount = analytics.comparison.absent.length;
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
      const rows = [...weekly.values()].map((item) => ({ ...item, rooms: item.rooms.size, macs: item.macs.size }));
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

export function createPresenceChurnTracker() {
  const records = new Map();
  let previous = new Set();
  let incoming = null;
  let snapshotCount = 0;
  const compactPresenceRecord = (device = {}) => ({
    macFormatted: normalizeMac(device.mac || device.macFormatted),
    vendor: String(device.vendor || device.manufacturer || ""),
    model: String(device.model || ""),
    ip: String(device.ip || ""),
    room: String(device.room || ""),
    address: String(device.address || ""),
    smartroomId: String(device.smartroomId || device.smartroom_id || ""),
  });
  const commit = (current, metadata = {}) => {
    for (const mac of previous) {
      if (current.has(mac)) continue;
      const record = records.get(mac);
      if (record) {
        record.transitions += 1;
        record.disappearances += 1;
        record.presentLast = false;
      }
    }
    for (const [mac, device] of current) {
      let record = records.get(mac);
      if (!record) {
        record = { mac, transitions: 0, present: 0, disappearances: 0, reappearances: 0, presentLast: false, everSeen: false, firstSeen: "", lastSeen: "" };
        records.set(mac, record);
      } else if (record.everSeen && !record.presentLast) {
        record.transitions += 1;
        record.reappearances += 1;
      }
      Object.assign(record, device);
      const observedAt = String(metadata.observedAt || "");
      if (!record.firstSeen) record.firstSeen = observedAt;
      record.lastSeen = observedAt || record.lastSeen;
      record.present += 1;
      record.presentLast = true;
      record.everSeen = true;
    }
    previous = new Set(current.keys());
    snapshotCount += 1;
  };
  return Object.freeze({
    beginSnapshot(snapshot = {}) {
      if (incoming) throw new Error("Предыдущий MAC-churn снимок ещё не завершён");
      incoming = { devices: new Map(), observedAt: String(snapshot.fileCreatedAt || snapshot.createdAt || snapshot.savedAt || "") };
    },
    observeDevice(device) {
      if (!incoming) throw new Error("Перед MAC устройством не начат churn-снимок");
      const mac = normalizeMac(typeof device === "string" ? device : device?.mac || device?.macFormatted);
      if (mac) incoming.devices.set(mac, compactPresenceRecord(typeof device === "string" ? {} : device));
    },
    endSnapshot() {
      if (!incoming) throw new Error("Нет текущего MAC-churn снимка");
      const current = incoming;
      incoming = null;
      commit(current.devices, current);
    },
    observe(_snapshot = {}, devices = []) {
      if (incoming) throw new Error("Завершите MAC-churn снимок перед прямым наблюдением");
      const current = new Map();
      if (devices instanceof Set) {
        for (const value of devices) {
          const mac = normalizeMac(value);
          if (mac) current.set(mac, compactPresenceRecord());
        }
      } else {
        for (const device of devices || []) {
          const mac = normalizeMac(typeof device === "string" ? device : device.mac || device.macFormatted);
          if (mac) current.set(mac, compactPresenceRecord(typeof device === "string" ? {} : device));
        }
      }
      commit(current, { observedAt: String(_snapshot.fileCreatedAt || _snapshot.createdAt || _snapshot.savedAt || "") });
    },
    result() {
      return [...records.values()]
        .filter((record) => record.disappearances > 0 && record.reappearances > 0)
        .map((record) => ({ ...record, absent: Math.max(0, snapshotCount - record.present), transitionCount: record.disappearances + record.reappearances }))
        .sort((left, right) => right.transitionCount - left.transitionCount || right.reappearances - left.reappearances || left.mac.localeCompare(right.mac));
    },
    uniqueCount() { return records.size; },
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
        if (normalizeMac(device?.mac || device?.macFormatted) === normalizedMac) {
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

