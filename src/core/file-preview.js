import { buildIdentityIndex, conflictingStrongFields, findIdentityMatch, stableId } from "./identity.js";
import { hasStrongIdentity, text } from "./normalize.js";

const CATALOG_FIELDS = [
  "manufacturer", "model", "deviceType", "hostname", "deviceName", "ip", "switchIp",
  "switchPort", "businessUnit", "city", "site", "floor", "room", "smartroomId",
  "address", "physicalAddress", "locationPath",
];

export function filePreviewLookupDevice(device) {
  return hasStrongIdentity(device) ? { ...device, id: device.id || stableId(device, "file-preview") } : null;
}

export function fillFromPreviewCatalog(device, records = []) {
  if (!hasStrongIdentity(device) || !records.length) return { device, match: "none" };
  const result = findIdentityMatch(device, buildIdentityIndex(records));
  if (result.status !== "matched" || result.identityConflicts?.length || conflictingStrongFields(device, result.match).length) {
    return { device, match: result.status === "none" ? "none" : "review" };
  }
  const output = { ...device, fieldSources: { ...device.fieldSources } };
  for (const field of CATALOG_FIELDS) {
    if (text(output[field]) || !text(result.match[field])) continue;
    output[field] = result.match[field];
    output.fieldSources[field] = "Локальный Inventory";
  }
  return { device: output, match: "found" };
}
