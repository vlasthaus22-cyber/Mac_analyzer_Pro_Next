import { normalizeNotificationSettings, normalizeNotificationSecret, notificationSummary } from "../core/notification-settings.js";

export function notificationApiBase(locationLike = globalThis.location) {
  if (!locationLike || locationLike.protocol !== "http:") return null;
  if (!new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(String(locationLike.hostname || "").toLowerCase())) return null;
  return locationLike.port ? locationLike.origin : null;
}

async function requestNotifications(route, { method = "GET", body, locationLike, fetchImpl = globalThis.fetch } = {}) {
  const base = notificationApiBase(locationLike);
  if (!base || typeof fetchImpl !== "function") throw new Error("Внешние уведомления доступны только через optional host на этом компьютере.");
  const response = await fetchImpl(base + "/api/notifications/" + route, {
    method, cache: "no-store", credentials: "same-origin", redirect: "error",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || ("Локальный host ответил HTTP " + response.status + "."));
  return payload;
}

export async function loadNotificationSettings(options = {}) {
  return normalizeNotificationSettings(await requestNotifications("settings", options));
}

export async function saveNotificationChannel(channel, settings, secret, { clearSecret = false, ...options } = {}) {
  const normalizedSettings = normalizeNotificationSettings({ channels: { [channel]: settings } }).channels[channel];
  const normalizedSecret = normalizeNotificationSecret(channel, secret);
  const payload = await requestNotifications("settings", {
    ...options, method: "PUT",
    body: { channel, settings: normalizedSettings, secret: normalizedSecret, clearSecret: clearSecret === true },
  });
  return {
    settings: normalizeNotificationSettings({ channels: { [channel]: payload.settings }, secretsConfigured: { [channel]: payload.secretsConfigured } }),
  };
}

export async function testNotificationChannel(channel, options = {}) {
  return requestNotifications("test", { ...options, method: "POST", body: { channel } });
}

export async function deliverAnalysisNotification(summary, options = {}) {
  const normalized = notificationSummary(summary);
  if (!normalized) return { skipped: true };
  return requestNotifications("deliver", { ...options, method: "POST", body: { type: "analysis", summary: normalized } });
}
