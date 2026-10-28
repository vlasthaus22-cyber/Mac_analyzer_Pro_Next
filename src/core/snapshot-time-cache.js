export function createSnapshotTimeCache(loadSnapshotTimes, { maxEntries = 256 } = {}) {
  if (typeof loadSnapshotTimes !== "function") throw new TypeError("Требуется загрузчик дат Final");
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 256));
  const cache = new Map();

  return {
    clear() { cache.clear(); },
    get size() { return cache.size; },
    async resolve(rows = []) {
      const ids = [];
      const seen = new Set();
      for (const row of rows) {
        const id = String(row?.snapshotId || "");
        if (!row?.timestamp && id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      const missing = ids.filter((id) => !cache.has(id));
      const loaded = missing.length ? await loadSnapshotTimes(missing) : new Map();
      for (const id of ids) {
        const value = cache.has(id) ? cache.get(id) : String(loaded?.get?.(id) || "");
        cache.delete(id);
        cache.set(id, value);
        while (cache.size > limit) cache.delete(cache.keys().next().value);
      }
      return rows.map((row) => ({
        ...row,
        timestamp: String(row?.timestamp || cache.get(String(row?.snapshotId || "")) || ""),
      }));
    },
  };
}
