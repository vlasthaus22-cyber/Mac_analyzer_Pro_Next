const COMPACT_FINAL_FIELDS = Object.freeze([
  "id", "deviceId", "serial", "mac", "alternateMacs", "hostname", "smartroomId", "ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor",
  "room", "address", "manufacturer", "vendor", "model", "deviceType", "deviceName",
  "authenticationTime", "observedAt", "possibleIps", "fieldSources", "source", "sources",
  "historicalEvidence",
]);
const COMPACT_PREVIOUS_FINAL_FIELDS = Object.freeze([
  "id", "deviceId", "serial", "mac", "alternateMacs", "hostname", "smartroomId", "ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor",
  "room", "address", "manufacturer", "model", "deviceType", "deviceName",
  "authenticationTime", "possibleIps", "sources", "conflicts",
  "alternateMacsTruncated", "possibleIpsTruncated", "conflictsTruncated",
]);
const COMPARISON_BASELINE_FIELDS = new Set([
  "id", "deviceId", "serial", "mac", "alternateMacs", "hostname", "smartroomId", "ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor",
  "room", "address", "manufacturer", "vendor", "model", "deviceType", "deviceName",
  "authenticationTime", "source",
]);

export const FINAL_ANALYTICS_INDEX_SCHEMA_VERSION = 4;

export function finalAnalyticsIndexSignature(snapshot = {}) {
  return JSON.stringify([
    "final-analytics-index",
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    String(snapshot.id || ""),
    String(snapshot.createdAt || ""),
    Number(snapshot.deviceCount || 0),
    Number(snapshot.chunkCount || 0),
    Number(snapshot.dataRevision || 0),
  ]);
}

export function compactFinalDevice(device = {}) {
  return copyCompactFields(device, COMPACT_FINAL_FIELDS);
}

export function compactPreviousFinalDevice(device = {}) {
  return copyCompactFields(device, COMPACT_PREVIOUS_FINAL_FIELDS);
}

export function compactComparisonDevice(device = {}) {
  return copyCompactFields(device, COMPARISON_BASELINE_FIELDS);
}

function copyCompactFields(device, fields) {
  const compact = {};
  for (const field of fields) {
    if (!Object.hasOwn(device, field) || device[field] === undefined) continue;
    const value = device[field];
    compact[field] = Array.isArray(value) ? [...value]
      : value && typeof value === "object" ? { ...value }
        : value;
  }
  return compact;
}

export function compactFinalDevices(devices = []) {
  return devices.map(compactFinalDevice);
}

/** Drop fields that pairwise analytics never reads after historical backfill. */
export function trimComparisonBaseline(devices = []) {
  for (const device of devices) {
    for (const field of Object.keys(device)) if (!COMPARISON_BASELINE_FIELDS.has(field)) delete device[field];
  }
  return devices;
}

export async function loadCompactSnapshot(snapshotId, visitSnapshotChunks) {
  if (!snapshotId || typeof visitSnapshotChunks !== "function") throw new TypeError("Для compact Final нужен ID снимка и обход его чанков");
  const devices = [];
  const metadata = await visitSnapshotChunks(snapshotId, (chunk) => devices.push(...chunk.map(compactPreviousFinalDevice)));
  return { ...metadata, devices };
}
