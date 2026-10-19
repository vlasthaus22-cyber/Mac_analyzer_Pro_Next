import { text } from "./normalize.js";

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
  "authenticationTime", "possibleIps", "customFields", "customFieldSources", "sources", "conflicts",
  "alternateMacsTruncated", "possibleIpsTruncated", "conflictsTruncated",
]);
const COMPACT_PREVIOUS_FINAL_FIELD_SET = new Set(COMPACT_PREVIOUS_FINAL_FIELDS);
const COMPARISON_BASELINE_FIELDS = new Set([
  "id", "deviceId", "serial", "mac", "alternateMacs", "hostname", "smartroomId", "ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor",
  "room", "address", "manufacturer", "vendor", "model", "deviceType", "deviceName",
  "authenticationTime", "source",
]);

export const FINAL_ANALYTICS_INDEX_SCHEMA_VERSION = 5;

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
  // Previous Final rows are read from disposable IndexedDB chunks. Their
  // evidence arrays are read-only during enrichment/comparison, so retain those
  // references instead of cloning every nested array into the compact projection.
  return copyCompactFields(device, COMPACT_PREVIOUS_FINAL_FIELDS, { cloneCollections: false });
}

export function trimPreviousFinalDeviceInPlace(device = {}) {
  for (const field of Object.keys(device)) {
    if (!COMPACT_PREVIOUS_FINAL_FIELD_SET.has(field)) delete device[field];
  }
  return device;
}

export function compactComparisonDevice(device = {}) {
  // Comparison only reads alternate MACs; keep their reference instead of
  // cloning a nested array for every compact baseline/current row.
  const compact = copyCompactFields(device, COMPARISON_BASELINE_FIELDS);
  if (Array.isArray(device.alternateMacs)) compact.alternateMacs = device.alternateMacs;
  return compact;
}

function copyCompactFields(device, fields, { cloneCollections = true } = {}) {
  const compact = {};
  for (const field of fields) {
    if (!Object.hasOwn(device, field) || device[field] === undefined) continue;
    const value = device[field];
    compact[field] = Array.isArray(value) ? (cloneCollections ? [...value] : value)
      : value && typeof value === "object" ? (cloneCollections ? { ...value } : value)
        : value;
  }
  return compact;
}

export function compactFinalDevices(devices = []) {
  return devices.map(compactFinalDevice);
}

/** Drop fields that pairwise analytics never reads after historical backfill. */
export function trimComparisonBaseline(devices = []) {
  for (const device of devices) trimComparisonDeviceInPlace(device);
  return devices;
}

export function trimComparisonDeviceInPlace(device = {}) {
  for (const field of Object.keys(device)) {
    if (!COMPARISON_BASELINE_FIELDS.has(field) || !text(device[field])) delete device[field];
  }
  return device;
}

export async function loadCompactSnapshot(snapshotId, visitSnapshotChunks, { mutateDetachedChunks = false } = {}) {
  if (!snapshotId || typeof visitSnapshotChunks !== "function") throw new TypeError("Для compact Final нужен ID снимка и обход его чанков");
  const devices = [];
  const metadata = await visitSnapshotChunks(snapshotId, (chunk) => {
    if (mutateDetachedChunks) {
      for (const device of chunk) devices.push(trimPreviousFinalDeviceInPlace(device));
    } else devices.push(...chunk.map(compactPreviousFinalDevice));
  });
  return { ...metadata, devices };
}
