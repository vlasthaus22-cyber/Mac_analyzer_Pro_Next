import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkspaceState, normalizeWorkspaceState } from "../src/core/workspace-state.js";

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
