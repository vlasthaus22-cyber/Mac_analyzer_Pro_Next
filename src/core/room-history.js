import { buildIdentityIndex, conflictingStrongFields, findIdentityMatch } from "./identity.js";
import { keyText, text } from "./normalize.js";

const NON_HISTORICAL_FIELDS = new Set(["sources", "conflicts", "identityDiagnostics", "matchDetails"]);
const ROOM_HISTORY_FIELDS = new Set([
  "id", "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id",
  "serial", "serialNumber", "serial_number", "mac", "macAddress", "mac_address",
  "macFormatted", "mac_formatted", "CallingStationID",
  "alternateMacs", "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac",
  "hostname", "host", "host_name", "smartroomId", "smartroom_id", "ip", "deviceIp", "device_ip",
  "switchIp", "switchPort", "physicalAddress", "businessUnit", "city", "site", "floor", "room", "address",
  "manufacturer", "vendor", "model", "deviceType", "deviceName", "authenticationTime", "observedAt",
  "source", "vendorConfidence", "vendor_confidence", "vendorSource", "vendor_source",
  "modelConfidence", "model_confidence", "modelSource", "model_source",
  "fieldSources",
]);
const ROOM_LOCATION_FIELDS = Object.freeze(["businessUnit", "city", "site", "floor", "room", "address"]);

function blank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return !text(value);
  return false;
}

export function compactRoomHistoryDevice(device = {}) {
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

export function roomHistoryFallbackKey(device = {}) {
  if (!text(device.room)) return "";
  let key = "fallback:";
  for (let index = 0; index < ROOM_LOCATION_FIELDS.length; index += 1) {
    if (index) key += "|";
    key += keyText(device[ROOM_LOCATION_FIELDS[index]]);
  }
  return key;
}

/** Fill missing analytical fields from the prior non-empty room observation.
 * The saved Final is never mutated, and uncertain identity matches are not used.
 */
export function createRoomHistoryCarryForwardStream(previousDevices = [], {
  previousIsCompact = false,
  currentIsCompact = false,
  collectDiagnostics = true,
  retainKnownDevices = true,
} = {}) {
  const index = buildIdentityIndex(previousIsCompact ? previousDevices : compactRoomHistoryDevices(previousDevices));
  const used = new Uint8Array(index.devices.length);
  const knownDevices = retainKnownDevices ? index.devices : [];
  return Object.freeze({
    process(currentBatch = []) {
      const diagnostics = [];
      let diagnosticCount = 0;
      const recordDiagnostic = (createDiagnostic) => {
        diagnosticCount += 1;
        if (collectDiagnostics) diagnostics.push(createDiagnostic());
      };
      // Reuse compact database batches and keep the identity-used bitmap across
      // calls so duplicate identities in separate chunks cannot match twice.
      const devices = currentIsCompact ? currentBatch : [];
      for (let currentIndex = 0; currentIndex < currentBatch.length; currentIndex += 1) {
        const device = currentBatch[currentIndex];
        const match = findIdentityMatch(device, index);
        if (match.status !== "matched") {
          if (match.status === "ambiguous") recordDiagnostic(() => ({ device, candidates: match.candidates.map((item) => item.device) }));
          if (retainKnownDevices) knownDevices.push(currentIsCompact ? device : compactRoomHistoryDevice(device));
          if (!currentIsCompact) devices.push(device);
          continue;
        }
        if (used[match.position]) {
          recordDiagnostic(() => ({ device, candidates: [match.match] }));
          if (retainKnownDevices) knownDevices.push(currentIsCompact ? device : compactRoomHistoryDevice(device));
          if (!currentIsCompact) devices.push(device);
          continue;
        }
        used[match.position] = 1;
        const previous = match.match;
        if (match.identityConflicts?.length) {
          recordDiagnostic(() => ({
            device,
            candidates: [previous, ...match.identityConflicts.map((conflict) => conflict.alternative).filter(Boolean)],
            conflictingFields: ["identity"],
          }));
        }
        const conflictingFields = conflictingStrongFields(previous, device);
        if (conflictingFields.length) {
          recordDiagnostic(() => ({ device, candidates: [previous], conflictingFields }));
          if (retainKnownDevices) knownDevices.push(currentIsCompact ? device : compactRoomHistoryDevice(device));
          if (!currentIsCompact) devices.push(device);
          continue;
        }
        let hydrated = null;
        for (const [field, value] of Object.entries(previous)) {
          if (NON_HISTORICAL_FIELDS.has(field) || field === "fieldSources" || blank(value) || !blank(device[field])) continue;
          hydrated ||= currentIsCompact ? device : { ...device };
          hydrated[field] = Array.isArray(value) && !currentIsCompact ? [...value] : value;
          if (previous.fieldSources?.[field]) {
            hydrated.fieldSources = { ...(hydrated.fieldSources || {}), [field]: previous.fieldSources[field] };
          }
        }
        if (retainKnownDevices) {
          knownDevices[match.position] = currentIsCompact ? hydrated || device : compactRoomHistoryDevice(hydrated || device);
        }
        if (!currentIsCompact) devices.push(hydrated || device);
      }
      return { devices, diagnostics, diagnosticCount, knownDevices };
    },
    get knownDevices() { return knownDevices; },
  });
}

export function carryForwardRoomDeviceFields(previousDevices = [], currentDevices = [], options = {}) {
  return createRoomHistoryCarryForwardStream(previousDevices, options).process(currentDevices);
}
