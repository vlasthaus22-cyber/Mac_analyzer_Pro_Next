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

function blank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return !text(value);
  return false;
}

export function compactRoomHistoryDevice(device = {}, { cloneArrays = true } = {}) {
  const compact = {};
  for (const field in device) {
    if (!Object.hasOwn(device, field) || !ROOM_HISTORY_FIELDS.has(field)) continue;
    const value = device[field];
    if (field === "fieldSources" && value && typeof value === "object" && !Array.isArray(value)) {
      const sources = Object.fromEntries(Object.entries(value).filter(([key]) => ROOM_HISTORY_FIELDS.has(key)));
      if (Object.keys(sources).length) compact[field] = sources;
    } else {
      compact[field] = Array.isArray(value) && cloneArrays ? [...value] : value;
    }
  }
  return compact;
}

export function compactRoomHistoryDevices(devices = []) {
  return devices.map(compactRoomHistoryDevice);
}

/** Compact a disposable database page in place to avoid retaining both the
 * decoded rows and a second full array of projected room-history rows.
 */
export function compactRoomHistoryChunkInPlace(devices, matches = () => true) {
  if (!Array.isArray(devices)) throw new TypeError("Для проекции хронологии нужен массив строк");
  if (typeof matches !== "function") throw new TypeError("Для проекции хронологии нужен фильтр помещения");
  let write = 0;
  for (let read = 0; read < devices.length; read += 1) {
    const device = devices[read];
    if (!matches(device)) continue;
    // IndexedDB returned this page as detached structured clones. Trim each
    // selected object in place so a large room scan doesn't allocate another
    // compact object for every row.
    for (const field of Object.keys(device)) {
      if (!ROOM_HISTORY_FIELDS.has(field)) delete device[field];
    }
    const sources = device.fieldSources;
    if (sources && typeof sources === "object" && !Array.isArray(sources)) {
      for (const field of Object.keys(sources)) {
        if (!ROOM_HISTORY_FIELDS.has(field)) delete sources[field];
      }
      if (!Object.keys(sources).length) delete device.fieldSources;
    }
    devices[write] = device;
    write += 1;
  }
  devices.length = write;
  return devices;
}

export function roomHistoryFallbackKey(device = {}) {
  if (!text(device.room)) return "";
  return `fallback:${keyText(device.businessUnit)}|${keyText(device.city)}|${keyText(device.site)}|${keyText(device.floor)}|${keyText(device.room)}|${keyText(device.address)}`;
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
        for (const field in previous) {
          if (!Object.hasOwn(previous, field)) continue;
          const value = previous[field];
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
