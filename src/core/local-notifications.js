export const LOCAL_NOTIFICATION_LIMIT = 100;
export const LOCAL_NOTIFICATION_EVENTS = Object.freeze(["analysis", "quality", "backup"]);

export const DEFAULT_LOCAL_NOTIFICATION_SETTINGS = Object.freeze({
  events: Object.freeze({ analysis: true, quality: true, backup: true }),
});

const LEVELS = new Set(["info", "success", "warning", "error"]);
const TYPES = new Set([...LOCAL_NOTIFICATION_EVENTS, "test"]);

function boundedText(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, maximum);
}

export function normalizeLocalNotificationSettings(value) {
  const events = value?.events && typeof value.events === "object" && !Array.isArray(value.events) ? value.events : {};
  return {
    events: Object.fromEntries(LOCAL_NOTIFICATION_EVENTS.map((event) => [
      event,
      typeof events[event] === "boolean" ? events[event] : DEFAULT_LOCAL_NOTIFICATION_SETTINGS.events[event],
    ])),
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !TYPES.has(value.type)) return null;
  const title = boundedText(value.title, 160).trim();
  const message = boundedText(value.message, 1_000).trim();
  const createdAt = boundedText(value.createdAt, 40);
  if (!title || !message || !Number.isFinite(Date.parse(createdAt))) return null;
  return {
    id: boundedText(value.id, 128) || crypto.randomUUID(),
    createdAt: new Date(createdAt).toISOString(),
    type: value.type,
    title,
    message,
    level: LEVELS.has(value.level) ? value.level : "info",
    status: "local",
  };
}

export function normalizeLocalNotificationLog(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LOCAL_NOTIFICATION_LIMIT).map(normalizeRecord).filter(Boolean);
}

export function appendLocalNotification(log, item, settings, { now = new Date(), id = crypto.randomUUID() } = {}) {
  const current = normalizeLocalNotificationLog(log);
  const normalizedSettings = normalizeLocalNotificationSettings(settings);
  if (item?.type !== "test" && (!LOCAL_NOTIFICATION_EVENTS.includes(item?.type) || !normalizedSettings.events[item.type])) {
    return { log: current, added: null };
  }
  const added = normalizeRecord({ ...item, id, createdAt: now.toISOString(), status: "local" });
  if (!added) return { log: current, added: null };
  return { log: [added, ...current].slice(0, LOCAL_NOTIFICATION_LIMIT), added };
}
