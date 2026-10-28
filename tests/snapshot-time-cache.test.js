import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotTimeCache } from "../src/core/snapshot-time-cache.js";

test("snapshot timestamp cache loads unique missing IDs and preserves existing event dates", async () => {
  const calls = [];
  const cache = createSnapshotTimeCache(async (ids) => {
    calls.push([...ids]);
    return new Map(ids.map((id) => [id, `date:${id}`]));
  });
  const rows = await cache.resolve([
    { id: "a1", snapshotId: "final-a" },
    { id: "a2", snapshotId: "final-a" },
    { id: "b1", snapshotId: "final-b", timestamp: "event-date" },
    { id: "c1", snapshotId: "final-c" },
  ]);
  assert.deepEqual(calls, [["final-a", "final-c"]]);
  assert.deepEqual(rows.map(({ timestamp }) => timestamp), ["date:final-a", "date:final-a", "event-date", "date:final-c"]);
});

test("snapshot timestamp cache is bounded LRU, refreshes hits, and reloads evicted IDs", async () => {
  const calls = [];
  const cache = createSnapshotTimeCache(async (ids) => {
    calls.push([...ids]);
    return new Map(ids.map((id) => [id, `date:${id}`]));
  }, { maxEntries: 2 });
  await cache.resolve([{ snapshotId: "a" }, { snapshotId: "b" }]);
  await cache.resolve([{ snapshotId: "a" }]);
  await cache.resolve([{ snapshotId: "c" }]);
  assert.equal(cache.size, 2);
  await cache.resolve([{ snapshotId: "b" }]);
  assert.deepEqual(calls, [["a", "b"], ["c"], ["b"]]);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("snapshot timestamp cache avoids database access for pages with timestamps or no snapshot ID", async () => {
  let calls = 0;
  const cache = createSnapshotTimeCache(async () => { calls += 1; return new Map(); });
  const rows = await cache.resolve([{ timestamp: "event-date" }, { snapshotId: "" }]);
  assert.equal(calls, 0);
  assert.deepEqual(rows, [{ timestamp: "event-date" }, { snapshotId: "", timestamp: "" }]);
});

test("snapshot timestamp cache propagates lookup failures without caching incomplete dates", async () => {
  let calls = 0;
  const cache = createSnapshotTimeCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("lookup failed");
    return new Map([["a", "2026-10-01"]]);
  });
  await assert.rejects(cache.resolve([{ snapshotId: "a" }]), /lookup failed/);
  assert.deepEqual(await cache.resolve([{ snapshotId: "a" }]), [{ snapshotId: "a", timestamp: "2026-10-01" }]);
  assert.equal(calls, 2);
});
