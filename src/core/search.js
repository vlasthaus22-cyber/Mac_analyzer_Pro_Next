import { keyText, macHex, normalizeIp, normalizeMac, text } from "./normalize.js";
import { visitDeviceMacAddresses } from "./identity.js";

const SEARCH_FIELDS = Object.freeze([
  "mac", "macFormatted", "mac_formatted", "alternateMacs", "ip", "possibleIps", "switchIp", "switch_ip", "switchPort", "switch_port", "manufacturer", "vendor", "model",
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
  let matchesMac = false;
  visitDeviceMacAddresses(device, (mac) => {
    if (macHex(mac).includes(macNeedle)) {
      matchesMac = true;
      return false;
    }
  });
  return matchesMac;
}

export function searchResultDoubleClickTarget(device = {}) {
  const mac = normalizeMac(device.mac);
  if (mac) return { kind: "mac", mac };
  const model = text(device.model);
  if (model && !["-", "—", "unknown"].includes(keyText(model))) return { kind: "model", model };
  return null;
}
