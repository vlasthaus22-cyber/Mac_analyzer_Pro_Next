export const APPLICATION_LOG_LIMIT = 100;

export function normalizeApplicationLogEntry(entry = {}) {
  const event = String(entry.event || "").trim();
  const errorName = String(entry.errorName || "").trim();
  const timestamp = String(entry.timestamp || "");
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(event)
    || (errorName && !/^[a-z][a-z0-9]{0,63}$/i.test(errorName))
    || !Number.isFinite(Date.parse(timestamp))) return null;
  return { event, errorName, timestamp };
}

export function appendApplicationLog(entries = [], entry, limit = APPLICATION_LOG_LIMIT) {
  const normalized = normalizeApplicationLogEntry(entry);
  if (!normalized) throw new TypeError("Запись журнала приложения имеет неверный формат");
  const safeLimit = Math.max(1, Math.floor(Number(limit) || APPLICATION_LOG_LIMIT));
  return [...(Array.isArray(entries) ? entries : []).filter(normalizeApplicationLogEntry), normalized].slice(-safeLimit);
}
