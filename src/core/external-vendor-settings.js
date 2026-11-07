import { normalizeMac, text } from "./normalize.js";

export const LEGACY_EXTERNAL_VENDOR_PROVIDERS = Object.freeze(["macvendors", "maclookup", "mac2vendor"]);
export const EXTERNAL_VENDOR_PROVIDERS = Object.freeze([...LEGACY_EXTERNAL_VENDOR_PROVIDERS, "macadress"]);

export const DEFAULT_EXTERNAL_VENDOR_SETTINGS = Object.freeze({
  enabled: false,
  provider: "macvendors",
  rateLimit: 25,
  cacheTtlDays: 30,
  onlyUnknown: true,
});

export function normalizeExternalVendorSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const providerKey = String(settings.provider || "").trim().toLowerCase();
  const provider = EXTERNAL_VENDOR_PROVIDERS.includes(providerKey)
    ? providerKey
    : DEFAULT_EXTERNAL_VENDOR_SETTINGS.provider;
  const boundedInteger = (input, fallback, maximum) => {
    const parsed = input === null || typeof input === "number" || typeof input === "string" || typeof input === "boolean"
      ? Number(input)
      : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), maximum)) : fallback;
  };
  return {
    enabled: settings.enabled === true,
    provider,
    rateLimit: boundedInteger(settings.rateLimit, DEFAULT_EXTERNAL_VENDOR_SETTINGS.rateLimit, 500),
    cacheTtlDays: boundedInteger(settings.cacheTtlDays, DEFAULT_EXTERNAL_VENDOR_SETTINGS.cacheTtlDays, 365),
    onlyUnknown: settings.onlyUnknown !== false,
  };
}

export function importedExternalVendorSettingsFallback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeExternalVendorSettings({ ...value, enabled: false });
}

export function externalVendorCandidateMacs(devices, settings = DEFAULT_EXTERNAL_VENDOR_SETTINGS, selectedMacs = []) {
  const normalized = normalizeExternalVendorSettings(settings);
  const selected = new Set(selectedMacs.map(normalizeExternalVendorMac).filter(Boolean));
  const seen = new Set();
  const candidates = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    if (!device || typeof device !== "object") continue;
    const mac = normalizeExternalVendorMac(device.mac || device.macAddress || device.mac_address || device.macFormatted || device.mac_formatted || device.CallingStationID);
    if (mac.length !== 12 || (selected.size && !selected.has(mac)) || seen.has(mac)) continue;
    if (normalized.onlyUnknown && text(device.vendor)) continue;
    seen.add(mac);
    candidates.push(mac);
  }
  return candidates.slice(0, normalized.rateLimit);
}

export function normalizeExternalVendorMac(value) {
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isFinite(value))) return "";
  const source = String(value).trim().toUpperCase();
  const accepted = /^(?:[0-9A-F]{12}|(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}|(?:[0-9A-F]{2}\s+){5}[0-9A-F]{2}|[0-9A-F]{4}(?:\.[0-9A-F]{4}){2}|[0-9A-F]{4}(?:\s+[0-9A-F]{4}){2})$/;
  if (!accepted.test(source)) return "";
  return normalizeMac(source).replaceAll(":", "");
}
