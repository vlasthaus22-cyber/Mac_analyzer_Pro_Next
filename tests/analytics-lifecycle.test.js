import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyticsIdleScheduler, createBoundedComparisonPageCache, feedAnalyticsDatasetRows, reuseInFlightRequest, runAnalyticsInStages, usableAnalyticsFallback } from "../src/core/analytics-lifecycle.js";
import { createCollector as createDatasetAnalyticsCollector } from "../src/core/analytics-detail.js";
import { compactComparisonDevice, compactFinalDevices } from "../src/core/compact-final-analytics.js";

test("only a completed selected-Final comparison can serve as dashboard fallback", () => {
  const complete = { detailsReady: true, current: { id: "final-2" }, comparison: { unchangedCount: 4 } };
  assert.equal(usableAnalyticsFallback(complete), complete);
  assert.equal(usableAnalyticsFallback({ ...complete, detailsReady: false }), null);
  assert.equal(usableAnalyticsFallback({ ...complete, current: {} }), null);
  assert.equal(usableAnalyticsFallback({ ...complete, comparison: null }), null);
  assert.equal(usableAnalyticsFallback(null), null);
});

test("comparison page cache is pair-keyed, LRU bounded, row bounded, and returns independent page arrays", () => {
  const cache = createBoundedComparisonPageCache({ maxEntries: 2, maxRows: 3 });
  const firstPage = { devices: [{ id: "a" }, { id: "b" }], total: 2 };
  assert.equal(cache.set("pair-a:added:0", firstPage), true);
  assert.equal(cache.set("pair-b:modified:0", { events: [{ id: "c" }], total: 1 }), true);
  const hit = cache.get("pair-a:added:0");
  assert.notEqual(hit.devices, firstPage.devices);
  hit.devices.pop();
  assert.equal(cache.get("pair-a:added:0").devices.length, 2);
  assert.equal(cache.set("pair-a:added:100", { devices: [{ id: "d" }, { id: "e" }, { id: "f" }, { id: "g" }] }), false);
  assert.equal(cache.set("pair-c:absent:0", { devices: [{ id: "d" }] }), true);
  assert.equal(cache.get("pair-b:modified:0"), null, "least recently used comparison page is evicted");
  assert.equal(cache.get("pair-a:added:0").total, 2, "an exact pair key keeps its own page");
  assert.equal(cache.size, 2);
  assert.equal(cache.rowCount, 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.rowCount, 0);
});

test("analytics idle scheduler cancels superseded work and runs only the newest report", async () => {
  const callbacks = new Map();
  const canceled = [];
  let nextId = 0;
  const scheduler = createAnalyticsIdleScheduler({
    requestIdleCallback: (callback, options) => {
      assert.deepEqual(options, { timeout: 1200 });
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancelIdleCallback: (id) => canceled.push(id),
  });
  const ran = [];
  scheduler.schedule(() => ran.push("stale"));
  scheduler.schedule(async () => ran.push("current"));
  assert.deepEqual(canceled, [1]);
  assert.equal(scheduler.pending, true);
  callbacks.get(1)();
  callbacks.get(2)();
  await Promise.resolve();
  assert.deepEqual(ran, ["current"]);
  assert.equal(scheduler.pending, false);

  scheduler.schedule(() => ran.push("cancelled"));
  assert.equal(scheduler.cancel(), true);
  callbacks.get(3)();
  await Promise.resolve();
  assert.deepEqual(ran, ["current"]);
  assert.equal(scheduler.cancel(), false);
});

test("analytics idle scheduler uses a cancellable task fallback and reports task failures", async () => {
  const callbacks = new Map();
  const canceled = [];
  const errors = [];
  let nextId = 0;
  const scheduler = createAnalyticsIdleScheduler({
    requestIdleCallback: null,
    setTimeout: (callback, delay) => {
      assert.equal(delay, 0);
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout: (id) => canceled.push(id),
    onError: (error) => errors.push(error),
  });
  scheduler.schedule(() => {});
  scheduler.schedule(async () => { throw new Error("detail failure"); });
  assert.deepEqual(canceled, [1]);
  callbacks.get(1)();
  callbacks.get(2)();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /detail failure/);
});

test("analytics paints the exact selected-pair summary before loading extended reports", async () => {
  const order = [];
  let deferred = null;
  const pair = { comparison: { added: 1 }, kpis: { added: 1 } };
  const result = await runAnalyticsInStages({
    calculatePair: async () => { order.push("pair"); return pair; },
    calculateDetails: async (selectedPair) => { order.push("details"); assert.equal(selectedPair, pair); return { report: "full" }; },
    isCurrent: () => true,
    paintSummary: (selectedPair) => { order.push("summary"); assert.equal(selectedPair.kpis.added, 1); },
    paintDetails: (_selectedPair, details) => { order.push(`paint:${details.report}`); },
    schedule: (callback) => { deferred = callback; },
  });
  assert.equal(result, pair);
  assert.deepEqual(order, ["pair", "summary"]);
  await deferred();
  assert.deepEqual(order, ["pair", "summary", "details", "paint:full"]);
});

test("stale analytics results cannot paint summary or extended details", async () => {
  let current = true;
  let deferred = null;
  const painted = [];
  await runAnalyticsInStages({
    calculatePair: async () => ({ id: "stale" }),
    calculateDetails: async () => ({ report: true }),
    isCurrent: () => current,
    paintSummary: () => painted.push("summary"),
    paintDetails: () => painted.push("details"),
    schedule: (callback) => { deferred = callback; },
  });
  current = false;
  await deferred();
  assert.deepEqual(painted, ["summary"]);
});

test("current Dashboard detail failures reach the fallback handler and never paint partial details", async () => {
  let deferred = null;
  const error = new Error("IndexedDB transaction failed");
  const handled = [];
  const painted = [];
  await runAnalyticsInStages({
    calculatePair: async () => ({ id: "selected" }),
    calculateDetails: async () => { throw error; },
    isCurrent: () => true,
    paintSummary: () => painted.push("summary"),
    paintDetails: () => painted.push("details"),
    schedule: (callback) => { deferred = callback; },
    onError: (failure) => handled.push(failure),
  });

  await deferred();
  assert.deepEqual(painted, ["summary"]);
  assert.deepEqual(handled, [error]);
});

test("stale Dashboard detail failures cannot replace the currently selected report", async () => {
  let current = true;
  let deferred = null;
  const handled = [];
  const painted = [];
  await runAnalyticsInStages({
    calculatePair: async () => ({ id: "old-selection" }),
    calculateDetails: async () => { throw new Error("stale IndexedDB failure"); },
    isCurrent: () => current,
    paintSummary: () => painted.push("summary"),
    paintDetails: () => painted.push("details"),
    schedule: (callback) => { deferred = callback; },
    onError: (error) => handled.push(error),
  });

  current = false;
  await deferred();
  assert.deepEqual(painted, ["summary"]);
  assert.deepEqual(handled, []);
});

test("stale request finishing before its selected pair is discarded", async () => {
  let current = false;
  let summaryPainted = false;
  const result = await runAnalyticsInStages({
    calculatePair: async () => ({ id: "old" }),
    calculateDetails: async () => ({}),
    isCurrent: () => current,
    paintSummary: () => { summaryPainted = true; },
    paintDetails: () => {},
    schedule: () => assert.fail("stale request must not schedule extended analytics"),
  });
  assert.equal(result, null);
  assert.equal(summaryPainted, false);
});

test("identical in-flight analytics work is shared and cleared after settlement", async () => {
  const requests = new Map();
  let calls = 0;
  let resolve;
  const operation = () => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  };
  const first = reuseInFlightRequest(requests, "same-selection", operation);
  const second = reuseInFlightRequest(requests, "same-selection", operation);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve("complete");
  assert.equal(await first, "complete");
  await Promise.resolve();
  assert.equal(requests.has("same-selection"), false);
  assert.equal(await reuseInFlightRequest(requests, "same-selection", async () => { calls += 1; return "again"; }), "again");
  assert.equal(calls, 2);
});

test("analytics dataset consumes the loaded dashboard payload without rereading the Final", async () => {
  const rows = [{ mac: "00:11:22:33:44:55" }, { mac: "00:11:22:33:44:66" }];
  const accepted = [];
  let reads = 0;
  const source = await feedAnalyticsDatasetRows({
    snapshotId: "selected-final",
    devices: rows,
    visitChunks: async () => { reads += 1; },
    accept: (chunk) => accepted.push(...chunk),
  });

  assert.equal(source, "payload");
  assert.equal(reads, 0);
  assert.deepEqual(accepted, rows);
});

test("analytics dataset falls back to snapshot chunks when no loaded payload is available", async () => {
  const accepted = [];
  const visited = [];
  const offsets = [];
  const source = await feedAnalyticsDatasetRows({
    snapshotId: "selected-final",
    visitChunks: async (snapshotId, visit) => {
      visited.push(snapshotId);
      await visit([{ mac: "00:11:22:33:44:55" }], 0);
      await visit([{ mac: "00:11:22:33:44:66" }], 1);
    },
    accept: (chunk, startOffset) => { accepted.push(...chunk); offsets.push(startOffset); },
  });

  assert.equal(source, "chunks");
  assert.deepEqual(visited, ["selected-final"]);
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(accepted.length, 2);
});

test("stale analytics dataset reads stop after the current bounded chunk", async () => {
  let current = true;
  const accepted = [];
  const visited = [];
  const source = await feedAnalyticsDatasetRows({
    snapshotId: "selected-final",
    isCurrent: () => current,
    visitChunks: async (_snapshotId, visit) => {
      for (const chunk of [[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]) {
        visited.push(chunk[0].id);
        if (await visit(chunk) === false) break;
      }
    },
    accept: (chunk) => { accepted.push(...chunk); current = false; },
  });

  assert.equal(source, "stale");
  assert.deepEqual(visited, [1]);
  assert.deepEqual(accepted.map((row) => row.id), [1]);
});

test("compact selected-Final payload produces the same extended dataset as reading full snapshot chunks", async () => {
  const rows = [
    { id: "a", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board A", ip: "10.0.0.1", room: "101", smartroomId: "SR-1", address: "North", switchIp: "10.0.0.254", switchPort: "1" },
    { id: "b", mac: "00:11:22:33:44:66", manufacturer: "Acme", model: "Board B", ip: "10.0.0.2", room: "101", smartroomId: "SR-1", address: "North", switchIp: "10.0.0.254", switchPort: "2" },
  ];
  const aggregate = async (devices, visitChunks) => {
    const collector = createDatasetAnalyticsCollector({ includeTopologyDevices: false });
    await feedAnalyticsDatasetRows({ snapshotId: "selected", devices, visitChunks, accept: (chunk) => collector.accept(chunk) });
    return collector.finish();
  };
  const fromPayload = await aggregate(compactFinalDevices(rows));
  const fromSelectedPairIndex = await aggregate(rows.map(compactComparisonDevice));
  const fromChunks = await aggregate(undefined, async (_snapshotId, visit) => visit(rows));
  assert.deepEqual(fromPayload, fromChunks);
  assert.deepEqual(fromSelectedPairIndex, fromChunks);
});
