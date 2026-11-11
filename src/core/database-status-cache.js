const STORAGE_KEY = "mac-analyzer-database-status-v2";

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function readDatabaseStatusCache(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!validCount(cached.snapshotCount) || !validCount(cached.activeFinalCount) || !validCount(cached.inventoryCount)) return null;
    return { snapshotCount: cached.snapshotCount, activeFinalCount: cached.activeFinalCount, inventoryCount: cached.inventoryCount, savedAt: String(cached.savedAt || "") };
  } catch {
    return null;
  }
}

export function writeDatabaseStatusCache({ snapshotCount, activeFinalCount, inventoryCount }, storage) {
  if (!validCount(snapshotCount) || !validCount(activeFinalCount) || !validCount(inventoryCount)) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    target?.setItem(STORAGE_KEY, JSON.stringify({ snapshotCount, activeFinalCount, inventoryCount, savedAt: new Date().toISOString() }));
    return Boolean(target);
  } catch {
    return false;
  }
}
