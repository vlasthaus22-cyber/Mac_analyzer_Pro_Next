import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createFinalHistoryComparisonStream } from "../src/core/comparison.js";
import { stageFinalHistoryPlan } from "../src/core/history-plan.js";
import { Database } from "../src/data/database.js";

async function readStore(database, storeName) {
  const db = await database.open();
  const tx = db.transaction(storeName, "readonly");
  const request = tx.objectStore(storeName).getAll();
  const rows = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  return rows;
}

test("History plan matches reference comparison across Previous Final and current chunks", async () => {
  const database = new Database(`history-plan-roundtrip-${crypto.randomUUID()}`);
  const previous = Array.from({ length: 503 }, (_, index) => ({
    id: `history-plan-device-${index}`,
    mac: `00:11:22:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    ip: `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`,
    possibleIps: index === 501 ? ["10.0.0.9"] : [],
  }));
  const current = previous.slice(0, 502).map((device) => ({ ...device }));
  current[501] = { ...current[501], ip: "10.20.30.40", switchIp: "10.1.1.1", possibleIps: ["10.1.1.2"] };
  current.push({ id: "history-plan-new", mac: "AA:BB:CC:DD:EE:FF", ip: "10.2.3.4" });
  const timestamp = "2026-10-20T12:00:00.000Z";
  try {
    const baseline = await database.saveFinal({ id: "history-plan-baseline", createdAt: "2026-10-19T00:00:00Z", devices: previous });
    const referenceEvents = [];
    const reference = createFinalHistoryComparisonStream(previous, timestamp);
    reference.process(current, (event) => referenceEvents.push(event));
    const referenceSummary = reference.finish((event) => referenceEvents.push(event));
    const plan = await stageFinalHistoryPlan({
      snapshotId: baseline.id,
      devices: current,
      timestamp,
      queryId: `history-plan:${crypto.randomUUID()}`,
      loadPreviousIdentityIndex: (snapshotId, batch) => database.buildPreviousFinalIdentityIndex(snapshotId, batch),
      visitPreviousChunks: (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit),
      verifyPreviousSnapshot: (snapshotId, signature) => database.assertSnapshotSignature(snapshotId, signature),
      appendEvents: (queryId, events, options) => database.appendFinalHistoryPlanEvents(queryId, events, options),
      clearEvents: (queryId) => database.clearAnalyticsAggregateQuery(queryId),
    });
    assert.equal(plan.eventCount, referenceEvents.length);
    assert.deepEqual(plan.historyComparison, referenceSummary);

    await database.saveFinal({
      id: "history-plan-current",
      createdAt: timestamp,
      devices: current,
      diagnostics: { historyComparison: plan.historyComparison },
      historyPlanId: plan.queryId,
      historyPlanEventCount: plan.eventCount,
      historyPlanBaselineId: baseline.id,
      historyPlanBaselineSignature: plan.snapshotSignature,
    });
    const storedHistory = (await readStore(database, "history")).filter(({ snapshotId }) => snapshotId === "history-plan-current");
    const expectedRows = referenceEvents.flatMap((event) => {
      if (event.type === "added" || event.type === "absent") return [[event.type, event.device.id, "", ""]];
      return event.row.changes.map((change) => ["modified", event.row.after.id, change.field, change.newValue]);
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const actualRows = storedHistory.map(({ type, deviceId, field, newValue }) => [type, deviceId, field || "", newValue || ""])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(actualRows, expectedRows);
    assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId }) => queryId === plan.queryId), false);
  } finally {
    (await database.open()).close();
  }
});

test("History plan stages dense change events in bounded batches and commits every event", async () => {
  const database = new Database(`history-plan-dense-${crypto.randomUUID()}`);
  const previous = Array.from({ length: 1_001 }, (_, index) => ({
    id: `dense-device-${index}`,
    mac: `00:22:33:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    address: `Old address ${index}`,
  }));
  const current = previous.map((device, index) => ({ ...device, address: `New address ${index}` }));
  const stagedBatchSizes = [];
  try {
    const baseline = await database.saveFinal({ id: "history-plan-dense-baseline", createdAt: "2026-10-19T00:00:00Z", devices: previous });
    const plan = await stageFinalHistoryPlan({
      snapshotId: baseline.id,
      devices: current,
      timestamp: "2026-10-20T12:00:00.000Z",
      queryId: `history-plan:${crypto.randomUUID()}`,
      loadPreviousIdentityIndex: (snapshotId, batch, signature) => database.buildPreviousFinalIdentityIndex(snapshotId, batch, signature),
      visitPreviousChunks: (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit),
      verifyPreviousSnapshot: (snapshotId, signature) => database.assertSnapshotSignature(snapshotId, signature),
      appendEvents: async (queryId, events, options) => {
        stagedBatchSizes.push(events.length);
        return database.appendFinalHistoryPlanEvents(queryId, events, options);
      },
      clearEvents: (queryId) => database.clearAnalyticsAggregateQuery(queryId),
    });

    assert.deepEqual(stagedBatchSizes, [500, 500, 1]);
    assert.equal(plan.eventCount, current.length);
    assert.equal(plan.historyComparison.ambiguousCount, 0);
    await database.saveFinal({
      id: "history-plan-dense-current",
      createdAt: "2026-10-20T12:00:00.000Z",
      devices: current,
      diagnostics: { historyComparison: plan.historyComparison },
      historyPlanId: plan.queryId,
      historyPlanEventCount: plan.eventCount,
      historyPlanBaselineId: baseline.id,
      historyPlanBaselineSignature: plan.snapshotSignature,
    });

    const storedHistory = (await readStore(database, "history")).filter(({ snapshotId }) => snapshotId === "history-plan-dense-current");
    assert.equal(storedHistory.length, current.length);
    assert.equal(storedHistory[0].newValue, "New address 0");
    assert.equal(storedHistory.at(-1).newValue, "New address 1000");
    assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId }) => queryId === plan.queryId), false);
  } finally {
    (await database.open()).close();
  }
});

test("chunk-staged current devices release the result array before History planning and commit atomically", async () => {
  const database = new Database(`history-plan-staged-current-${crypto.randomUUID()}`);
  const previous = Array.from({ length: 1_001 }, (_, index) => ({
    id: `staged-device-${index}`,
    mac: `00:33:44:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    address: `Old address ${index}`,
  }));
  const current = previous.map((device, index) => ({ ...device, address: `New address ${index}` }));
  const stageId = `final-device-stage:${crypto.randomUUID()}`;
  try {
    const baseline = await database.saveFinal({ id: "staged-current-baseline", createdAt: "2026-10-19T00:00:00Z", devices: previous });
    const originalCount = current.length;
    for (let offset = 0; offset < originalCount; offset += 500) {
      const end = Math.min(originalCount, offset + 500);
      const page = current.slice(offset, end);
      await database.appendFinalDeviceStageChunk(stageId, page, { offset, total: originalCount });
      for (let index = offset; index < end; index += 1) current[index] = null;
    }
    current.length = 0;
    assert.equal(current.length, 0);
    const historyPageSizes = [];
    const plan = await stageFinalHistoryPlan({
      snapshotId: baseline.id,
      deviceCount: originalCount,
      loadDevicePage: async (offset, limit) => {
        const page = await database.finalDeviceStagePage(stageId, { offset, limit });
        historyPageSizes.push(page.length);
        return page;
      },
      timestamp: "2026-10-20T12:00:00.000Z",
      queryId: `history-plan:${crypto.randomUUID()}`,
      loadPreviousIdentityIndex: (snapshotId, batch, signature) => database.buildPreviousFinalIdentityIndex(snapshotId, batch, signature),
      visitPreviousChunks: (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit),
      verifyPreviousSnapshot: (snapshotId, signature) => database.assertSnapshotSignature(snapshotId, signature),
      appendEvents: (queryId, events, options) => database.appendFinalHistoryPlanEvents(queryId, events, options),
      clearEvents: (queryId) => database.clearAnalyticsAggregateQuery(queryId),
    });
    assert.deepEqual(historyPageSizes, [500, 500, 1]);
    assert.equal(plan.eventCount, originalCount);
    const saved = await database.saveFinal({
      id: "staged-current-final",
      createdAt: "2026-10-20T12:00:00.000Z",
      devices: [],
      stagedDeviceQueryId: stageId,
      stagedDeviceCount: originalCount,
      diagnostics: { historyComparison: plan.historyComparison },
      historyPlanId: plan.queryId,
      historyPlanEventCount: plan.eventCount,
      historyPlanBaselineId: baseline.id,
      historyPlanBaselineSignature: plan.snapshotSignature,
    });

    assert.equal(saved.deviceCount, originalCount);
    assert.equal(await database.getSetting("activeSnapshotId"), saved.id);
    const firstPage = await database.loadSnapshotPage(saved.id, { page: 1, limit: 500 });
    const lastPage = await database.loadSnapshotPage(saved.id, { page: 3, limit: 500 });
    assert.equal(firstPage.devices[0].address, "New address 0");
    assert.equal(lastPage.devices[0].address, "New address 1000");
    const history = (await readStore(database, "history")).filter(({ snapshotId }) => snapshotId === saved.id);
    assert.equal(history.length, originalCount);
    assert.equal(history[0].newValue, "New address 0");
    assert.equal(history.at(-1).newValue, "New address 1000");
    assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId }) => queryId === stageId || queryId === plan.queryId), false);
  } finally {
    await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
    (await database.open()).close();
  }
});

test("an incomplete staged Final cannot replace the prior active snapshot", async () => {
  const database = new Database(`history-plan-staged-atomic-${crypto.randomUUID()}`);
  try {
    const active = await database.saveFinal({ id: "staged-atomic-active", devices: [{ id: "active-device", mac: "00:55:66:77:88:99" }] });
    const stageId = `final-device-stage:${crypto.randomUUID()}`;
    await database.appendFinalDeviceStageChunk(stageId, [{ id: "staged-one", mac: "00:55:66:77:88:01" }], { offset: 0, total: 2 });
    await assert.rejects(database.saveFinal({
      id: "staged-atomic-failed",
      devices: [],
      stagedDeviceQueryId: stageId,
      stagedDeviceCount: 2,
    }), /временный Final неполон/i);
    assert.equal(await database.getSetting("activeSnapshotId"), active.id);
    assert.equal((await database.listSnapshots()).some(({ id }) => id === "staged-atomic-failed"), false);
    await database.clearAnalyticsAggregateQuery(stageId);
  } finally {
    (await database.open()).close();
  }
});

test("a staged Final write failure rolls back snapshot chunks and retains the old active snapshot", async () => {
  const database = new Database(`history-plan-staged-rollback-${crypto.randomUUID()}`);
  const stageId = `final-device-stage:${crypto.randomUUID()}`;
  const devices = Array.from({ length: 1_001 }, (_, index) => ({ id: `rollback-device-${index}`, mac: `00:66:77:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}` }));
  try {
    await database.saveFinal({ id: "staged-rollback-active", devices: [{ id: "rollback-active-device", mac: "00:66:77:88:99:01" }] });
    for (let offset = 0; offset < devices.length; offset += 500) {
      await database.appendFinalDeviceStageChunk(stageId, devices.slice(offset, offset + 500), { offset, total: devices.length });
    }
    const originalPut = globalThis.IDBObjectStore.prototype.put;
    globalThis.IDBObjectStore.prototype.put = function failStagedSecondChunk(value, key) {
      if (this.name === "snapshotChunks" && value?.snapshotId === "staged-rollback-failed" && value.index === 1) {
        const error = new Error("Injected staged Final DataCloneError");
        error.name = "DataCloneError";
        throw error;
      }
      return originalPut.call(this, value, key);
    };
    try {
      await assert.rejects(database.saveFinal({
        id: "staged-rollback-failed",
        devices: [],
        stagedDeviceQueryId: stageId,
        stagedDeviceCount: devices.length,
        updateInventory: false,
      }), /Injected staged Final DataCloneError/);
    } finally {
      globalThis.IDBObjectStore.prototype.put = originalPut;
    }
    assert.equal((await database.activeSnapshotMetadata()).id, "staged-rollback-active");
    assert.equal((await database.listSnapshots()).some(({ id }) => id === "staged-rollback-failed"), false);
    assert.equal((await database.finalDeviceStagePage(stageId, { offset: 0, limit: 500 })).length, 500, "an aborted transaction restores consumed stage rows");
    assert.equal((await database.finalDeviceStagePage(stageId, { offset: 1_000, limit: 500 }))[0].id, "rollback-device-1000");
  } finally {
    await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
    (await database.open()).close();
  }
});
