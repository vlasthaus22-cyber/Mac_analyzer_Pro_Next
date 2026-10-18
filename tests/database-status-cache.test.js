import test from "node:test";
import assert from "node:assert/strict";
import { readDatabaseStatusCache, writeDatabaseStatusCache } from "../src/core/database-status-cache.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("database status cache preserves complete snapshot and inventory counters across unavailable startup", () => {
  const storage = memoryStorage();
  assert.equal(writeDatabaseStatusCache({ snapshotCount: 12, inventoryCount: 12249 }, storage), true);
  const cached = readDatabaseStatusCache(storage);
  assert.equal(cached.snapshotCount, 12);
  assert.equal(cached.inventoryCount, 12249);
  assert.ok(Number.isFinite(Date.parse(cached.savedAt)));
});

test("database status cache rejects malformed counters and tolerates unavailable storage", () => {
  assert.equal(readDatabaseStatusCache({ getItem: () => "{broken" }), null);
  assert.equal(writeDatabaseStatusCache({ snapshotCount: -1, inventoryCount: 4 }, memoryStorage()), false);
  assert.equal(readDatabaseStatusCache({ getItem: () => { throw new Error("storage disabled"); } }), null);
  assert.equal(writeDatabaseStatusCache({ snapshotCount: 1, inventoryCount: 4 }, { setItem: () => { throw new Error("quota"); } }), false);
});
