import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "../src/core/daily-scheduler.js";
import { captureWorkspaceState, deleteWorkspaceState, normalizeWorkspaceState, readWorkspaceState } from "../src/core/workspace-state.js";
import { Database } from "../src/data/database.js";

const options = {
  views: ["search", "analytics", "history"],
  sortFields: ["mac", "room", "manufacturer"],
  pageSizes: [50, 100, 250, 500, 1000],
};

test("workspace resume state keeps only bounded navigation and search preferences", () => {
  const state = captureWorkspaceState({
    view: "analytics", search: "AA:BB:CC:DD:EE:FF", page: 4, pageSize: 250,
    sort: { field: "room", direction: -1 },
    inventory: [{ id: "must-not-persist" }], files: [{ rows: ["must-not-persist"] }],
    analytics: { cache: "must-not-persist" }, engineeringCredential: "must-not-persist",
  }, options.views, options.sortFields, options.pageSizes);

  assert.deepEqual(state, {
    version: 1, view: "analytics", search: "AA:BB:CC:DD:EE:FF", page: 4,
    pageSize: 250, sort: { field: "room", direction: -1 },
  });
  assert.equal(Object.hasOwn(state, "inventory"), false);
  assert.equal(Object.hasOwn(state, "files"), false);
  assert.equal(Object.hasOwn(state, "engineeringCredential"), false);
});

test("workspace restore rejects unknown views, sort fields and page sizes", () => {
  assert.deepEqual(normalizeWorkspaceState({
    view: "missing", search: "x".repeat(2_000), page: Infinity, pageSize: 10,
    sort: { field: "device-secret", direction: 0 },
  }, options), {
    version: 1, view: "search", search: "x".repeat(1_000), page: 1,
    pageSize: 50, sort: { field: "mac", direction: 1 },
  });
});

test("workspace page restore clamps oversized persisted offsets", () => {
  assert.equal(normalizeWorkspaceState({ page: 1e20 }, options).page, 1_000_000);
  assert.equal(normalizeWorkspaceState({ page: -4 }, options).page, 1);
});

test("workspace checkpoint restores from IndexedDB after closing and reopening the database connection", async () => {
  const databaseName = `workspace-reopen-${crypto.randomUUID()}`;
  const queue = createSerialQueue();
  const firstDatabase = new Database(databaseName);
  const saved = captureWorkspaceState({
    view: "analytics", search: "00:11:22", page: 7, pageSize: 250,
    sort: { field: "room", direction: -1 },
  }, options.views, options.sortFields, options.pageSizes);

  await queue.enqueue(() => firstDatabase.setSetting("workspaceState", saved));
  const firstConnection = await firstDatabase.open();
  firstConnection.close();
  firstDatabase.connection = null;

  const reopenedDatabase = new Database(databaseName);
  assert.deepEqual(await readWorkspaceState(queue, reopenedDatabase), saved);
  (await reopenedDatabase.open()).close();
});

test("workspace checkpoint reads and deletes run after queued autosaves", async () => {
  const queue = createSerialQueue();
  let stored = null;
  const operations = [];
  let releaseSave;
  let notifySaveStarted;
  const saveStarted = new Promise((resolve) => { notifySaveStarted = resolve; });
  const database = {
    async setSetting(key, value) {
      operations.push(`set:${key}`);
      stored = value;
    },
    async getSetting(key, fallback) {
      operations.push(`get:${key}`);
      return stored ?? fallback;
    },
    async deleteSetting(key) {
      operations.push(`delete:${key}`);
      stored = null;
      return true;
    },
  };
  const autosave = queue.enqueue(async () => {
    await new Promise((resolve) => { releaseSave = resolve; notifySaveStarted(); });
    await database.setSetting("workspaceState", { view: "analytics" });
  });
  await saveStarted;
  const restore = readWorkspaceState(queue, database);
  const deletion = deleteWorkspaceState(queue, database);
  releaseSave();

  assert.deepEqual(await restore, { view: "analytics" });
  assert.equal(await deletion, true);
  await autosave;
  assert.deepEqual(operations, ["set:workspaceState", "get:workspaceState", "delete:workspaceState"]);
  assert.equal(stored, null, "a queued autosave cannot recreate the checkpoint after deletion");
});
