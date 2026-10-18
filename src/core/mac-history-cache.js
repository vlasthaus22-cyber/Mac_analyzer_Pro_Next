export const MAC_HISTORY_CACHE_LIMIT = 4;
export const MAC_HISTORY_CACHE_EVENT_LIMIT = 5000;

export function readMacHistoryCache(cache, key) {
  if (!(cache instanceof Map) || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value.events;
}

export function writeMacHistoryCache(cache, key, events, sourceEventCount, { maxEntries = MAC_HISTORY_CACHE_LIMIT, maxEvents = MAC_HISTORY_CACHE_EVENT_LIMIT } = {}) {
  if (!(cache instanceof Map)) return false;
  const weight = Math.max(0, Number(sourceEventCount) || 0);
  if (weight > maxEvents || events.length > maxEvents) return false;
  cache.delete(key);
  cache.set(key, { events, weight });
  while (cache.size > Math.max(1, maxEntries)) cache.delete(cache.keys().next().value);
  return true;
}
