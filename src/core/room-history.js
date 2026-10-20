import { buildIdentityIndex, conflictingStrongFields, findIdentityMatch } from "./identity.js";
import { text } from "./normalize.js";

const NON_HISTORICAL_FIELDS = new Set(["sources", "conflicts", "identityDiagnostics", "matchDetails"]);
const ROOM_HISTORY_FIELDS = new Set([
  "id", "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id",
  "serial", "serialNumber", "serial_number", "mac", "macFormatted", "mac_formatted", "CallingStationID",
  "alternateMacs", "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac",
  "hostname", "host", "host_name", "smartroomId", "smartroom_id", "ip", "deviceIp", "device_ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor", "room", "address",
  "manufacturer", "vendor", "model", "deviceType", "deviceName", "authenticationTime", "observedAt",
  "vendorConfidence", "vendor_confidence", "vendorSource", "vendor_source",
  "modelConfidence", "model_confidence", "modelSource", "model_source",
  "fieldSources",
]);

function blank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return !text(value);
  return false;
}

function compactRoomHistoryDevice(device = {}) {
  const compact = {};
  for (const field of ROOM_HISTORY_FIELDS) {
    const value = device[field];
    if (value === undefined) continue;
    if (field === "fieldSources" && value && typeof value === "object" && !Array.isArray(value)) {
      const sources = Object.fromEntries(Object.entries(value).filter(([key]) => ROOM_HISTORY_FIELDS.has(key)));
      if (Object.keys(sources).length) compact[field] = sources;
    } else {
      compact[field] = Array.isArray(value) ? [...value] : value;
    }
  }
  return compact;
}

export function compactRoomHistoryDevices(devices = []) {
  return devices.map(compactRoomHistoryDevice);
}

/** Fill missing analytical fields from the prior non-empty room observation.
 * The saved Final is never mutated, and uncertain identity matches are not used.
 */
export function carryForwardRoomDeviceFields(previousDevices = [], currentDevices = [], { previousIsCompact = false } = {}) {
  const index = buildIdentityIndex(previousIsCompact ? previousDevices : compactRoomHistoryDevices(previousDevices));
  const diagnostics = [];
  const used = new Set();
  const knownDevices = index.devices;
  const devices = currentDevices.map((device) => {
    const match = findIdentityMatch(device, index);
    if (match.status !== "matched") {
      if (match.status === "ambiguous") diagnostics.push({ device, candidates: match.candidates.map((item) => item.device) });
      knownDevices.push(compactRoomHistoryDevice(device));
      return device;
    }
    if (used.has(match.position)) {
      diagnostics.push({ device, candidates: [match.match] });
      knownDevices.push(compactRoomHistoryDevice(device));
      return device;
    }
    used.add(match.position);
    const previous = match.match;
    if (match.identityConflicts?.length) {
      diagnostics.push({
        device,
        candidates: [previous, ...match.identityConflicts.map((conflict) => conflict.alternative).filter(Boolean)],
        conflictingFields: ["identity"],
      });
    }
    const conflictingFields = conflictingStrongFields(previous, device);
    if (conflictingFields.length) {
      diagnostics.push({ device, candidates: [previous], conflictingFields });
      knownDevices.push(compactRoomHistoryDevice(device));
      return device;
    }
    let hydrated = null;
    for (const [field, value] of Object.entries(previous)) {
      if (NON_HISTORICAL_FIELDS.has(field) || field === "fieldSources" || blank(value) || !blank(device[field])) continue;
      hydrated ||= { ...device };
      hydrated[field] = Array.isArray(value) ? [...value] : value;
      if (previous.fieldSources?.[field]) {
        hydrated.fieldSources = { ...(hydrated.fieldSources || {}), [field]: previous.fieldSources[field] };
      }
    }
    knownDevices[match.position] = compactRoomHistoryDevice(hydrated || device);
    return hydrated || device;
  });
  return { devices, diagnostics, knownDevices };
}
