import test from "node:test";
import assert from "node:assert/strict";
import { aggregateSnapshotHistory } from "../src/core/analytics.js";
import { createAnalyticsHistoryWorkerRuntime } from "../src/core/analytics-history-worker.js";
import { aggregateSnapshotHistoryInWorker } from "../src/core/analytics-history-worker-client.js";

function historyFixture() {
  const snapshots = [
    { id: "one", name: "Final 1", createdAt: "2026-01-05T00:00:00Z", deviceCount: 2 },
    { id: "two", name: "Final 2", createdAt: "2026-01-12T00:00:00Z", deviceCount: 2 },
    { id: "three", name: "Final 3", createdAt: "2026-01-19T00:00:00Z", deviceCount: 2 },
  ];
  const chunks = new Map([
    ["one", [[{ id: "a", mac: "00:11:22:33:44:51", room: "A", model: "Old" }], [{ serial: "B-1", mac: "00:11:22:33:44:52", room: "B" }]]],
    ["two", [[{ id: "a", mac: "00:11:22:33:44:51", room: "A", model: "New" }], [{ id: "c", mac: "00:11:22:33:44:53", room: "C" }]]],
    ["three", [[{ id: "a", mac: "00:11:22:33:44:51", room: "A", model: "New" }], [{ serial: "B-1", mac: "00:11:22:33:44:52", room: "B" }]]],
  ]);
  return { snapshots, chunks };
}

async function visitChunks(chunks, id, visit) {
  for (const chunk of chunks.get(id) || []) await visit(chunk);
}

test("history worker aggregation matches the IndexedDB main-thread aggregator across snapshot chunks", async () => {
  const { snapshots, chunks } = historyFixture();
  const replies = [];
  const scope = { postMessage: (message) => replies.push(message) };
  createAnalyticsHistoryWorkerRuntime(scope);
  const send = (requestId, action, payload = {}) => {
    scope.onmessage({ data: { requestId, action, ...payload } });
    const reply = replies.pop();
    assert.equal(reply.requestId, requestId);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  send(1, "start");
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    send(index * 10 + 2, "beginSnapshot", { snapshot, index });
    await visitChunks(chunks, snapshot.id, (devices) => send(index * 10 + 3, "ingest", { devices }));
    send(index * 10 + 4, "endSnapshot");
  }
  const actual = send(99, "finish");
  const expected = await aggregateSnapshotHistory(snapshots, (id, visit) => visitChunks(chunks, id, visit));
  assert.deepEqual(actual, expected);
  assert.throws(() => send(100, "finish"), /Сессия аналитики истории не запущена/);
});

test("history worker aggregates two 10,000-device Finals with exact change and churn totals", () => {
  const macFor = (index) => [2, (index >>> 24) & 255, (index >>> 16) & 255, (index >>> 8) & 255, index & 255, 1]
    .map((value) => value.toString(16).padStart(2, "0")).join(":").toUpperCase();
  const previous = Array.from({ length: 10_000 }, (_, index) => ({ id: `device-${index}`, mac: macFor(index), manufacturer: "Vendor", model: "Old" }));
  const current = previous.map((device, index) => index === 5000 ? { ...device, model: "New" } : device);
  const snapshots = [
    { id: "large-one", name: "Large 1", createdAt: "2026-02-01T00:00:00Z", deviceCount: previous.length },
    { id: "large-two", name: "Large 2", createdAt: "2026-02-08T00:00:00Z", deviceCount: current.length },
  ];
  const chunks = new Map([
    ["large-one", Array.from({ length: 20 }, (_, index) => previous.slice(index * 500, (index + 1) * 500))],
    ["large-two", Array.from({ length: 20 }, (_, index) => current.slice(index * 500, (index + 1) * 500))],
  ]);
  const replies = [];
  const scope = { postMessage: (message) => replies.push(message) };
  createAnalyticsHistoryWorkerRuntime(scope);
  let requestId = 0;
  const send = (action, payload = {}) => {
    const id = ++requestId;
    scope.onmessage({ data: { requestId: id, action, ...payload } });
    const reply = replies.pop();
    assert.equal(reply.requestId, id);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  send("start");
  snapshots.forEach((snapshot, index) => {
    send("beginSnapshot", { snapshot, index });
    for (const devices of chunks.get(snapshot.id)) send("ingest", { devices });
    send("endSnapshot");
  });
  const result = send("finish");
  assert.equal(result.history.snapshots, 2);
  assert.equal(result.history.deviceTotal, 20_000);
  assert.equal(result.history.uniqueMacs, 10_000);
  assert.deepEqual(result.snapshotChanges, [{ label: "Large 2", added: 0, absent: 0 }]);
  assert.equal(result.weekly.at(-1).modified, 1);
  assert.equal(result.churn.length, 0);
});

test("history worker and fallback apply dashboard filters after identity matching to all trend totals", async () => {
  const snapshots = [
    { id: "filtered-one", name: "Filtered 1", createdAt: "2026-03-01T00:00:00Z", deviceCount: 2 },
    { id: "filtered-two", name: "Filtered 2", createdAt: "2026-03-08T00:00:00Z", deviceCount: 2 },
  ];
  const chunks = new Map([
    ["filtered-one", [[
      { id: "a", mac: "00:11:22:33:44:51", manufacturer: "Acme", model: "Old" },
      { id: "b", mac: "00:11:22:33:44:52", manufacturer: "Other", model: "Old" },
    ]]],
    ["filtered-two", [[
      { id: "a", mac: "00:11:22:33:44:51", manufacturer: "Acme", model: "New" },
      { id: "c", mac: "00:11:22:33:44:53", manufacturer: "Acme", model: "Added" },
    ]]],
  ]);
  const filters = { manufacturer: "Acme" };
  const replies = [];
  const scope = { postMessage: (message) => replies.push(message) };
  createAnalyticsHistoryWorkerRuntime(scope);
  let requestId = 0;
  const send = (action, data = {}) => {
    const id = ++requestId;
    scope.onmessage({ data: { requestId: id, action, ...data } });
    const reply = replies.pop();
    assert.equal(reply.requestId, id);
    if (reply.error) throw new Error(reply.error);
    return reply?.value;
  };
  send("start", { filters });
  for (let index = 0; index < snapshots.length; index += 1) {
    send("beginSnapshot", { snapshot: snapshots[index], index });
    for (const devices of chunks.get(snapshots[index].id)) send("ingest", { devices });
    send("endSnapshot");
  }
  const workerResult = send("finish");
  const fallbackResult = await aggregateSnapshotHistory(snapshots, (id, visit) => visitChunks(chunks, id, visit), { filters });
  assert.deepEqual(workerResult, fallbackResult);
  assert.deepEqual(workerResult.totals.map((row) => row.value), [1, 2]);
  assert.deepEqual(workerResult.snapshotChanges, [{ label: "Filtered 2", added: 1, absent: 0 }]);
  assert.equal(workerResult.weekly.at(-1).modified, 1);
  assert.equal(workerResult.history.deviceTotal, 3);
  assert.equal(workerResult.history.uniqueMacs, 2);
});

test("history worker retains a compact copy instead of a released source chunk row", () => {
  const runtime = createAnalyticsHistoryWorkerRuntime({ postMessage() {} });
  runtime.dispatch("start");
  runtime.dispatch("beginSnapshot", { snapshot: { id: "one", name: "Final 1", createdAt: "2026-01-05T00:00:00Z", deviceCount: 1 }, index: 0 });
  const reusable = { id: "device-1", mac: "00:11:22:33:44:55", model: "Old", fieldSources: { model: "Main" }, rawSpreadsheetRow: Array(5_000).fill("unused") };
  runtime.dispatch("ingest", { devices: [reusable] });
  reusable.model = "New";
  runtime.dispatch("endSnapshot");

  runtime.dispatch("beginSnapshot", { snapshot: { id: "two", name: "Final 2", createdAt: "2026-01-12T00:00:00Z", deviceCount: 1 }, index: 1 });
  runtime.dispatch("ingest", { devices: [{ id: "device-1", mac: "00:11:22:33:44:55", model: "New" }] });
  runtime.dispatch("endSnapshot");
  const result = runtime.dispatch("finish");
  assert.equal(result.weekly.at(-1).modified, 1);
});

test("history worker client streams one awaited chunk at a time and releases the worker URL", async () => {
  const { snapshots, chunks } = historyFixture();
  const actions = [];
  const progress = [];
  let terminated = false;
  let revoked = "";
  class FakeWorker {
    constructor(url) { this.url = url; }
    postMessage(message) {
      actions.push(message.action);
      const value = message.action === "finish" ? { complete: true } : true;
      this.onmessage({ data: { requestId: message.requestId, value } });
    }
    terminate() { terminated = true; }
  }
  const visit = async (id, callback) => {
    for (const chunk of chunks.get(id) || []) await callback(chunk);
  };
  const result = await aggregateSnapshotHistoryInWorker(snapshots, visit, {
    source: "worker-source",
    onProgress: (item) => progress.push([item.phase, item.snapshotIndex, item.deviceCount || 0]),
    WorkerConstructor: FakeWorker,
    BlobConstructor: class { constructor(parts) { this.parts = parts; } },
    urlApi: { createObjectURL: () => "blob:history-worker", revokeObjectURL: (url) => { revoked = url; } },
  });
  assert.deepEqual(result, { complete: true });
  assert.deepEqual(actions, ["start", "beginSnapshot", "ingest", "ingest", "endSnapshot", "beginSnapshot", "ingest", "ingest", "endSnapshot", "beginSnapshot", "ingest", "ingest", "endSnapshot", "finish"]);
  assert.deepEqual(progress, [
    ["snapshot-start", 0, 0], ["worker-start", 0, 1], ["chunk-complete", 0, 1], ["worker-start", 0, 1], ["chunk-complete", 0, 1], ["snapshot-complete", 0, 0],
    ["snapshot-start", 1, 0], ["worker-start", 1, 1], ["chunk-complete", 1, 1], ["worker-start", 1, 1], ["chunk-complete", 1, 1], ["snapshot-complete", 1, 0],
    ["snapshot-start", 2, 0], ["worker-start", 2, 1], ["chunk-complete", 2, 1], ["worker-start", 2, 1], ["chunk-complete", 2, 1], ["snapshot-complete", 2, 0],
    ["finish-start", undefined, 0], ["finish-complete", undefined, 0],
  ]);
  assert.equal(terminated, true);
  assert.equal(revoked, "blob:history-worker");
});

test("history worker client sends compact rows and preserves query matches from omitted source fields", async () => {
  const snapshot = { id: "compact", createdAt: "2026-01-05T00:00:00Z", deviceCount: 1 };
  const sourceRow = {
    id: "device-1",
    mac: "00:11:22:33:44:55",
    model: "Room unit",
    privateImportNote: "Exact Needle",
    fieldSources: { model: "Main" },
  };
  let ingestPayload;
  class FakeWorker {
    postMessage(message) {
      if (message.action === "ingest") ingestPayload = message;
      this.onmessage({ data: { requestId: message.requestId, value: message.action === "finish" ? { complete: true } : true } });
    }
    terminate() {}
  }
  await aggregateSnapshotHistoryInWorker([snapshot], async (_id, visit) => visit([sourceRow]), {
    filters: { query: "Exact Needle" },
    source: "worker-source",
    WorkerConstructor: FakeWorker,
    BlobConstructor: class {},
    urlApi: { createObjectURL: () => "blob:compact-history", revokeObjectURL() {} },
  });
  assert.equal(ingestPayload.projected, true);
  assert.deepEqual(ingestPayload.matchedFilters, [true]);
  assert.deepEqual(ingestPayload.devices, [{ id: "device-1", mac: "00:11:22:33:44:55", model: "Room unit" }]);
  assert.equal(Object.hasOwn(ingestPayload.devices[0], "fieldSources"), false);
  assert.equal(Object.hasOwn(ingestPayload.devices[0], "privateImportNote"), false);
});

test("history worker uses transferred match flags when compact rows omit the query field", () => {
  const runtime = createAnalyticsHistoryWorkerRuntime({ postMessage() {} });
  runtime.dispatch("start", { filters: { query: "Exact Needle" } });
  runtime.dispatch("beginSnapshot", { snapshot: { id: "one", name: "Final 1", createdAt: "2026-01-05T00:00:00Z", deviceCount: 1 }, index: 0 });
  runtime.dispatch("ingest", {
    devices: [{ id: "device-1", mac: "00:11:22:33:44:55" }],
    matchedFilters: [true],
    projected: true,
  });
  runtime.dispatch("endSnapshot");
  runtime.dispatch("beginSnapshot", { snapshot: { id: "two", name: "Final 2", createdAt: "2026-01-12T00:00:00Z", deviceCount: 0 }, index: 1 });
  runtime.dispatch("ingest", { devices: [], matchedFilters: [], projected: true });
  runtime.dispatch("endSnapshot");

  const result = runtime.dispatch("finish");
  assert.deepEqual(result.totals.map(({ value }) => value), [1, 0]);
  assert.deepEqual(result.snapshotChanges, [{ label: "Final 2", added: 0, absent: 1 }]);
});

test("history worker client falls back when Worker initialization cannot answer", async () => {
  let terminated = false;
  class SilentWorker {
    postMessage() {}
    terminate() { terminated = true; }
  }
  const result = await aggregateSnapshotHistoryInWorker([], async () => {}, {
    source: "worker-source",
    startupTimeoutMs: 100,
    WorkerConstructor: SilentWorker,
    BlobConstructor: class {},
    urlApi: { createObjectURL: () => "blob:unavailable", revokeObjectURL() {} },
  });
  assert.equal(result, null);
  assert.equal(terminated, true);
});

test("history worker client reports a stuck final response and terminates instead of hanging analytics", async () => {
  let terminated = false;
  class NoFinishReplyWorker {
    postMessage(message) {
      if (message.action !== "finish") this.onmessage({ data: { requestId: message.requestId, value: true } });
    }
    terminate() { terminated = true; }
  }
  await assert.rejects(aggregateSnapshotHistoryInWorker([{ id: "one", deviceCount: 0 }], async () => {}, {
    source: "worker-source",
    requestTimeoutMs: 1_000,
    WorkerConstructor: NoFinishReplyWorker,
    BlobConstructor: class {},
    urlApi: { createObjectURL: () => "blob:stuck-finish", revokeObjectURL() {} },
  }), /не ответил на finish за 1000 мс/);
  assert.equal(terminated, true);
});

test("history worker client names the Final and chunk when ingest stops responding", async () => {
  let terminated = false;
  const progress = [];
  class NoIngestReplyWorker {
    postMessage(message) {
      if (message.action !== "ingest") this.onmessage({ data: { requestId: message.requestId, value: true } });
    }
    terminate() { terminated = true; }
  }
  const snapshot = { id: "large-final", name: "Large Final", createdAt: "2026-01-01T00:00:00Z", deviceCount: 1, chunkCount: 1 };
  await assert.rejects(aggregateSnapshotHistoryInWorker([snapshot], async (_id, visit) => visit([{ mac: "00:11:22:33:44:55" }], 0), {
    source: "worker-source",
    requestTimeoutMs: 1_000,
    WorkerConstructor: NoIngestReplyWorker,
    BlobConstructor: class {},
    urlApi: { createObjectURL: () => "blob:stuck-ingest", revokeObjectURL() {} },
    onProgress: (event) => progress.push(event),
  }), /Final 1\/1 «Large Final», чанк 1\/1: Web Worker аналитики не ответил на ingest за 1000 мс/);
  assert.equal(terminated, true);
  assert.ok(progress.some(({ phase, chunkIndex, chunkCount }) => phase === "worker-start" && chunkIndex === 0 && chunkCount === 1));
  assert.ok(progress.some(({ phase, error }) => phase === "worker-error" && error.includes("Large Final") && error.includes("чанк 1/1")));
});

test("history worker client stops reading chunks as soon as its analytics request becomes stale", async () => {
  const { snapshots, chunks } = historyFixture();
  const actions = [];
  let current = true;
  let terminated = false;
  class FakeWorker {
    postMessage(message) {
      actions.push(message.action);
      this.onmessage({ data: { requestId: message.requestId, value: true } });
    }
    terminate() { terminated = true; }
  }
  await assert.rejects(aggregateSnapshotHistoryInWorker(snapshots, async (id, accept) => {
    const [first] = chunks.get(id);
    await accept(first);
    current = false;
    const [, second] = chunks.get(id);
    await accept(second);
  }, {
    source: "worker-source",
    WorkerConstructor: FakeWorker,
    BlobConstructor: class {},
    urlApi: { createObjectURL: () => "blob:history-worker", revokeObjectURL() {} },
    isCurrent: () => current,
  }), (error) => error.name === "AbortError");
  assert.deepEqual(actions, ["start", "beginSnapshot", "ingest"]);
  assert.equal(terminated, true);
});
