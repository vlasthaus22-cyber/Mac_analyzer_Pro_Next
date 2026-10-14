import { compareFinals } from "./comparison.js";
import { keyText, locationKey, normalizeIp, text } from "./normalize.js";

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
    const location = [room.businessUnit, room.city, room.site, room.floor, room.room, room.address].map(keyText).join("|");
    if (!locationToIds.has(location)) locationToIds.set(location, new Set());
    locationToIds.get(location).add(keyText(room.smartroomId));
  });
  return descriptors.map((room) => {
    if (room.smartroomId || !room.room) return room;
    const location = [room.businessUnit, room.city, room.site, room.floor, room.room, room.address].map(keyText).join("|");
    const ids = [...(locationToIds.get(location) || [])];
    return ids.length === 1 ? { ...room, key: `sr:${ids[0]}`, inferredId: true } : room;
  });
}

export function analyzeRoomSwitchAnomalies(devices = []) {
  const rooms = new Map();
  const descriptors = reconcileRoomKeys(devices);
  devices.forEach((device, index) => {
    const descriptor = descriptors[index];
    if (!descriptor.key || !descriptor.room) return;
    if (!rooms.has(descriptor.key)) rooms.set(descriptor.key, { ...descriptor, devices: [], switches: new Map() });
    const room = rooms.get(descriptor.key);
    room.devices.push(device);
    const switchIp = normalizeIp(device.switchIp) || "missing";
    if (!room.switches.has(switchIp)) room.switches.set(switchIp, []);
    room.switches.get(switchIp).push(device);
  });

  const anomalies = [];
  for (const room of rooms.values()) {
    const known = [...room.switches.entries()].filter(([ip]) => ip !== "missing");
    if (known.length < 2) continue;
    known.sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
    const dominantIp = known[0][0];
    const details = room.devices.map((device) => ({
      ...device,
      anomaly: normalizeIp(device.switchIp) !== dominantIp,
    }));
    anomalies.push({
      ...room,
      dominantIp,
      switchCount: known.length,
      deviceCount: room.devices.length,
      deviationCount: details.filter((device) => device.anomaly).length,
      devices: details,
      switches: Object.fromEntries(known.map(([ip, list]) => [ip, list.length])),
    });
  }
  return anomalies.sort((left, right) => right.deviationCount - left.deviationCount || left.room.localeCompare(right.room, "ru"));
}

export function analyzeRoomChangeCoverage(comparison) {
  const changedIds = new Set(comparison.modified.map((row) => row.after.id));
  const rooms = new Map();
  const devices = comparison.modified.map((row) => row.after).concat(comparison.unchanged.map((row) => row.after));
  const descriptors = reconcileRoomKeys(devices);
  devices.forEach((device, index) => {
    const key = descriptors[index].key;
    if (!key) return;
    if (!rooms.has(key)) rooms.set(key, { descriptor: descriptors[index], devices: [] });
    rooms.get(key).devices.push(device);
  });
  return [...rooms.values()].map((room) => ({
    ...room.descriptor,
    deviceCount: room.devices.length,
    changedCount: room.devices.filter((device) => changedIds.has(device.id)).length,
    allChanged: room.devices.length > 0 && room.devices.every((device) => changedIds.has(device.id)),
    devices: room.devices,
  }));
}

function weekKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Без даты";
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}

export function buildAnalytics(snapshots = [], selectedBaseId = "", selectedCurrentId = "") {
  const ordered = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const current = ordered.find((snapshot) => snapshot.id === selectedCurrentId) || ordered.at(-1) || { devices: [] };
  const currentIndex = ordered.indexOf(current);
  const previous = ordered.find((snapshot) => snapshot.id === selectedBaseId) || ordered[currentIndex - 1] || { devices: [] };
  const comparison = compareFinals(previous.devices || [], current.devices || [], current.createdAt);
  const devices = current.devices || [];
  const roomChanges = analyzeRoomChangeCoverage(comparison);
  const roomSwitchAnomalies = analyzeRoomSwitchAnomalies(devices);
  const currentRoomDescriptors = reconcileRoomKeys(devices);
  const weekly = new Map();
  for (let index = 1; index < ordered.length; index += 1) {
    const result = compareFinals(ordered[index - 1].devices || [], ordered[index].devices || [], ordered[index].createdAt);
    const key = weekKey(ordered[index].createdAt);
    const bucket = weekly.get(key) || { label: key, modified: 0, added: 0, absent: 0, rooms: new Set(), macs: new Set() };
    bucket.modified += result.modified.length;
    bucket.added += result.added.length;
    bucket.absent += result.absent.length;
    result.modified.forEach((row) => {
      const room = locationKey(row.after);
      if (room) bucket.rooms.add(room);
      if (row.after.mac) bucket.macs.add(row.after.mac);
    });
    weekly.set(key, bucket);
  }
  return {
    current,
    previous,
    comparison,
    devices,
    kpis: {
      devices: devices.length,
      modified: comparison.modified.length,
      absent: comparison.absent.length,
      unchanged: comparison.unchanged.length,
      manufacturers: new Set(devices.map((item) => keyText(item.manufacturer)).filter(Boolean)).size,
      rooms: new Set(currentRoomDescriptors.map((item) => item.key).filter(Boolean)).size,
      withoutRoom: currentRoomDescriptors.filter((item) => !item.key).length,
      changedRooms: roomChanges.filter((room) => room.changedCount).length,
      allChangedRooms: roomChanges.filter((room) => room.allChanged).length,
      switchAnomalyRooms: roomSwitchAnomalies.length,
      codecChanges: comparison.modified.filter((row) => keyText(row.after.deviceType) === "video conference").length,
    },
    vendors: ranked(devices, "manufacturer"),
    models: ranked(devices, "model"),
    roomChanges,
    roomSwitchAnomalies,
    weekly: [...weekly.values()].map((item) => ({ ...item, rooms: item.rooms.size, macs: item.macs.size })),
    totals: ordered.map((snapshot) => ({ label: snapshot.name || snapshot.createdAt, value: snapshot.deviceCount ?? snapshot.devices?.length ?? 0 })),
  };
}

export function buildPresenceChurn(snapshots = []) {
  const ordered = [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const states = new Map();
  ordered.forEach((snapshot, index) => {
    const present = new Set((snapshot.devices || []).map((device) => device.mac).filter(Boolean));
    for (const mac of present) {
      if (!states.has(mac)) states.set(mac, Array(ordered.length).fill(false));
      states.get(mac)[index] = true;
    }
  });
  return [...states.entries()].map(([mac, presence]) => {
    let transitions = 0;
    for (let index = 1; index < presence.length; index += 1) if (presence[index] !== presence[index - 1]) transitions += 1;
    return { mac, transitions, present: presence.filter(Boolean).length, absent: presence.filter((item) => !item).length, presence };
  }).filter((item) => item.transitions >= 2).sort((a, b) => b.transitions - a.transitions || a.mac.localeCompare(b.mac));
}

