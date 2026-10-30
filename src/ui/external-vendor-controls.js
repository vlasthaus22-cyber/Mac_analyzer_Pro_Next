import { normalizeExternalVendorSettings, normalizeExternalVendorMac } from "../core/external-vendor-settings.js";

export function externalVendorApiBase(locationLike = globalThis.location) {
  if (!locationLike || locationLike.protocol !== "http:") return null;
  if (!new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(String(locationLike.hostname || "").toLowerCase())) return null;
  if (!locationLike.port) return null;
  return locationLike.origin;
}

async function requestExternalVendor(route, { method = "GET", body, locationLike, fetchImpl = globalThis.fetch } = {}) {
  const base = externalVendorApiBase(locationLike);
  if (!base || typeof fetchImpl !== "function") throw new Error("Внешний vendor API доступен только через запущенный локальный optional host.");
  const response = await fetchImpl(`${base}/api/external-vendor/${route}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Локальный vendor API ответил HTTP ${response.status}.`);
  return payload;
}

export async function loadExternalVendorSettings(options = {}) {
  const payload = await requestExternalVendor("settings", options);
  return { settings: normalizeExternalVendorSettings(payload.settings), providers: payload.providers || [] };
}

export async function saveExternalVendorSettings(settings, options = {}) {
  const normalized = normalizeExternalVendorSettings(settings);
  const payload = await requestExternalVendor("settings", { ...options, method: "PUT", body: { settings: normalized } });
  return { settings: normalizeExternalVendorSettings(payload.settings), providers: payload.providers || [] };
}

export async function testExternalVendorApi(mac, { forceLive = false, ...options } = {}) {
  const normalizedMac = normalizeExternalVendorMac(mac);
  if (normalizedMac.length !== 12) throw new Error("Введите MAC из 12 шестнадцатеричных символов.");
  return requestExternalVendor("test", { ...options, method: "POST", body: { mac: normalizedMac, forceLive } });
}

export async function lookupExternalVendorMacs(macs, { lookupBudget, ...options } = {}) {
  if (!Array.isArray(macs) || macs.length > 500) throw new Error("За один запрос можно передать не более 500 MAC-адресов.");
  const normalizedMacs = macs.map(normalizeExternalVendorMac).filter((mac) => mac.length === 12);
  const safeBudget = Number.isSafeInteger(Number(lookupBudget)) ? Math.max(0, Math.min(500, Number(lookupBudget))) : undefined;
  return requestExternalVendor("lookup", { ...options, method: "POST", body: { macs: normalizedMacs, ...(safeBudget === undefined ? {} : { lookupBudget: safeBudget }) } });
}

export async function getExternalVendorCacheSummary(options = {}) {
  return requestExternalVendor("cache/summary", options);
}

export async function clearExternalVendorCache(provider = "", options = {}) {
  return requestExternalVendor("cache/clear", { ...options, method: "POST", body: { provider } });
}
