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
