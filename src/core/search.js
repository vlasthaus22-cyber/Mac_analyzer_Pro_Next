import { keyText, macHex, normalizeIp, normalizeMac, text } from "./normalize.js";

const SEARCH_FIELDS = Object.freeze([
  "mac", "alternateMacs", "ip", "possibleIps", "switchIp", "switchPort", "manufacturer", "model",
  "deviceType", "hostname", "serial", "smartroomId", "room", "address", "authenticationTime",
  "deviceId", "deviceName", "physicalAddress", "businessUnit", "city", "site", "floor",
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
  const macNeedle = macSearchNeedle(source);
  if (!macNeedle) return false;
  return [device.mac, ...(Array.isArray(device.alternateMacs) ? device.alternateMacs : [])]
    .map(macHex)
    .some((mac) => mac.includes(macNeedle));
}
