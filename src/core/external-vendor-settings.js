export const EXTERNAL_VENDOR_PROVIDERS = Object.freeze(["macvendors", "maclookup", "mac2vendor"]);

export const DEFAULT_EXTERNAL_VENDOR_SETTINGS = Object.freeze({
  enabled: false,
  provider: "macvendors",
  rateLimit: 25,
  cacheTtlDays: 30,
  onlyUnknown: true,
});

export function normalizeExternalVendorSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const provider = EXTERNAL_VENDOR_PROVIDERS.includes(String(settings.provider || "").toLowerCase())
    ? String(settings.provider).toLowerCase()
    : DEFAULT_EXTERNAL_VENDOR_SETTINGS.provider;
  const boundedInteger = (input, fallback, maximum) => {
    const parsed = Number(input);
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
    const mac = normalizeExternalVendorMac(device.mac || device.macFormatted);
    if (mac.length !== 12 || (selected.size && !selected.has(mac)) || seen.has(mac)) continue;
    if (normalized.onlyUnknown && String(device.vendor || "").trim() && !["Unknown", "Не определено"].includes(String(device.vendor).trim())) continue;
    seen.add(mac);
    candidates.push(mac);
  }
  return candidates.slice(0, normalized.rateLimit);
}

export function normalizeExternalVendorMac(value) {
  return String(value ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
}
