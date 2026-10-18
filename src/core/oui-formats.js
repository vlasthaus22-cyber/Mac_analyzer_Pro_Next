import { normalizeMac } from "./normalize.js";

export const OUI_FORMAT_BYTES = Object.freeze([3, 4, 5, 6]);
export const DEFAULT_OUI_FORMATS = Object.freeze({ 3: true, 4: false, 5: false, 6: false });

export function normalizeOuiFormats(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(OUI_FORMAT_BYTES.map((bytes) => [
    bytes,
    typeof source[bytes] === "boolean" ? source[bytes] : DEFAULT_OUI_FORMATS[bytes],
  ]));
}

export function ouiBytesForMac(mac, bytes) {
  const count = Number(bytes);
  if (!OUI_FORMAT_BYTES.includes(count)) return "";
  const normalized = normalizeMac(mac).replaceAll(":", "");
  if (!/^[0-9A-F]{12}$/.test(normalized)) return "";
  const prefix = normalized.slice(0, count * 2);
  return prefix.match(/.{2}/g).join(":");
}
