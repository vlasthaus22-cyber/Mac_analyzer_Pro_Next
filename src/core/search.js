import { keyText, macHex, normalizeIp, normalizeMac, text } from "./normalize.js";
import { identityTokens, visitDeviceMacAddresses } from "./identity.js";

const SEARCH_FIELDS = Object.freeze([
  "mac", "macFormatted", "mac_formatted", "alternateMacs", "ip", "possibleIps", "switchIp", "switch_ip", "switchPort", "switch_port", "manufacturer", "vendor", "model",
  "macAddress", "mac_address", "CallingStationID", "deviceType", "hostname", "host", "host_name",
  "serial", "serialNumber", "serial_number", "smartroomId", "smartroom_id", "room", "address", "authenticationTime",
  "id", "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id", "deviceName", "device_name",
  "deviceIp", "device_ip", "physicalAddress", "businessUnit", "city", "site", "floor",
]);

function macSearchNeedle(value) {
  const source = String(value ?? "").trim();
  if (!source || normalizeIp(source)) return "";
  const normalized = normalizeMac(source);
  if (normalized) return macHex(normalized);
  if (!/^[0-9a-f:.-]+$/i.test(source)) return "";
  const compact = source.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return compact.length >= 6 && compact.length <= 12 ? compact : "";
}

export function matchesDeviceSearch(device = {}, query = "") {
  const source = text(query);
  if (!source) return true;
  const needle = keyText(source);
  const searchable = SEARCH_FIELDS.flatMap((field) => {
    const value = device[field];
    return Array.isArray(value) ? value.map(text) : [text(value)];
  }).map(keyText).join(" ");
  if (searchable.includes(needle)) return true;
  // User-defined Inventory columns are stored in a map rather than on the
  // device root. Search both the configured column name and its value so
  // searches keep working when an installation adds its own fields. Iterate
  // in place because imported custom-field maps can be large.
  const customFields = device?.customFields;
  if (customFields && typeof customFields === "object" && !Array.isArray(customFields)) {
    for (const name in customFields) {
      if (!Object.hasOwn(customFields, name)) continue;
      const value = customFields[name];
      if (keyText(name).includes(needle) || keyText(text(value)).includes(needle)) return true;
    }
  }
  const macNeedle = macSearchNeedle(source);
  if (!macNeedle) return false;
  let matchesMac = false;
  visitDeviceMacAddresses(device, (mac) => {
    if (macHex(mac).includes(macNeedle)) {
      matchesMac = true;
      return false;
    }
  });
  return matchesMac;
}

export async function searchSavedFinalSnapshots(query, {
  snapshots = [],
  iterateSnapshotDevices,
  limit = 100,
  signal,
  onProgress,
} = {}) {
  const normalizedQuery = text(query);
  if (!normalizedQuery) return { rows: [], scanned: 0, snapshotsScanned: 0, truncated: false };
  if (typeof iterateSnapshotDevices !== "function") throw new TypeError("iterateSnapshotDevices must be a function");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be between 1 and 500");

  const rows = [];
  const seenIdentities = new Set();
  let scanned = 0;
  let snapshotsScanned = 0;
  let truncated = false;
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const error = new Error("Saved Final search was cancelled");
    error.name = "AbortError";
    throw error;
  };

  // Metadata is chronological ascending; scan newest first so one MAC resolves to its latest Final.
  for (let snapshotIndex = snapshots.length - 1; snapshotIndex >= 0; snapshotIndex -= 1) {
    throwIfAborted();
    const snapshot = snapshots[snapshotIndex];
    if (!snapshot?.id) continue;
    let deviceIndex = 0;
    for await (const device of iterateSnapshotDevices(snapshot.id)) {
      throwIfAborted();
      scanned += 1;
      if (scanned % 5_000 === 0) {
        onProgress?.({ snapshot: snapshotsScanned + 1, snapshots: snapshots.length, scanned, matches: rows.length });
      }
      const currentIndex = deviceIndex;
      deviceIndex += 1;
      if (!matchesDeviceSearch(device, normalizedQuery)) continue;
      const mac = normalizeMac(device?.mac || device?.macAddress || device?.mac_address
        || device?.macFormatted || device?.mac_formatted || device?.CallingStationID);
      const identity = identityTokens(device).find((token) => token.strong) || null;
      const identityKey = mac ? `mac:${mac}` : identity?.key || "";
      if (identityKey && seenIdentities.has(identityKey)) continue;
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      if (identityKey) seenIdentities.add(identityKey);
      const displayIdentity = mac || text(device?.id || device?.internalDeviceId || device?.internal_device_id
        || device?.deviceId || device?.device_id || device?.asset_id || device?.serial || device?.serialNumber
        || device?.serial_number) || identity?.value || text(device?.hostname) || "—";
      rows.push({
        mac,
        macFormatted: text(device?.macFormatted || device?.mac_formatted) || displayIdentity,
        manufacturer: text(device.manufacturer || device.vendor),
        model: text(device.model),
        ip: text(device.ip),
        room: text(device.room || device.address || device.physicalAddress),
        source: text(device.source || (Array.isArray(device.sources) ? device.sources.slice(0, 4).join(", ") : "")),
        snapshotId: String(snapshot.id),
        snapshotName: text(snapshot.name) || String(snapshot.id),
        snapshotCreatedAt: text(snapshot.createdAt || snapshot.date),
        deviceIndex: currentIndex,
      });
    }
    snapshotsScanned += 1;
    onProgress?.({ snapshot: snapshotsScanned, snapshots: snapshots.length, scanned, matches: rows.length });
    if (truncated) break;
  }
  return { rows, scanned, snapshotsScanned, truncated };
}

export function searchResultDoubleClickTarget(device = {}) {
  const mac = normalizeMac(device.mac);
  if (mac) return { kind: "mac", mac };
  const model = text(device.model);
  if (model && !["-", "—", "unknown"].includes(keyText(model))) return { kind: "model", model };
  return null;
}
