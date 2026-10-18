import test from "node:test";
import assert from "node:assert/strict";
import { backfillComparisonDevices } from "../src/core/history-enrichment.js";

test("comparison backfills each blank field from the newest unique strong-identity history row", async () => {
  const snapshots = [
    { id: "older", name: "Older Final", createdAt: "2026-01-01T00:00:00Z" },
    { id: "newer", name: "Newer Final", createdAt: "2026-01-02T00:00:00Z" },
  ];
  const rows = {
    older: [{ id: "stable", mac: "00:11:22:33:44:55", model: "Legacy", ip: "192.0.2.1", address: "Room 1", fieldSources: { model: "Main" } }],
    newer: [{ id: "stable", mac: "00:11:22:33:44:55", model: "", ip: "192.0.2.9", address: "", fieldSources: { ip: "DDIO" } }],
  };
  const target = { id: "stable", mac: "00:11:22:33:44:55", model: "", ip: "", address: "Known address" };
  const order = [];
  const result = await backfillComparisonDevices([target], snapshots, async (snapshotId, visit) => {
    order.push(snapshotId);
    visit(rows[snapshotId]);
  });
  assert.deepEqual(order, ["newer", "older"]);
  assert.equal(result.devices[0].model, "Legacy");
  assert.equal(result.devices[0].ip, "192.0.2.9");
  assert.equal(result.devices[0].address, "Known address");
  assert.deepEqual(result.devices[0].fieldSources, { model: "Main", ip: "DDIO" });
  assert.deepEqual(result.devices[0].historicalEvidence.model, { snapshotId: "older", snapshotName: "Older Final", observedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(target, { id: "stable", mac: "00:11:22:33:44:55", model: "", ip: "", address: "Known address" });
  assert.equal(result.restoredFieldCount, 2);
});

test("comparison backfill can reuse a freshly loaded baseline array and returns scalar restored-field totals", async () => {
  const devices = [{ id: "device-1", mac: "00:11:22:33:44:55", model: "" }];
  const snapshot = { id: "history", name: "History", createdAt: "2026-01-01T00:00:00Z" };
  const result = await backfillComparisonDevices(devices, [snapshot], async (_id, visit) => visit([
    { id: "device-1", mac: "00:11:22:33:44:55", model: "Recovered" },
  ]), { inPlace: true });
  assert.equal(result.devices, devices);
  assert.equal(devices[0].model, "Recovered");
  assert.equal(result.restoredFieldCount, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("comparison backfill leaves ambiguous duplicates and conflicting strong IDs unresolved", async () => {
  const snapshots = [{ id: "history", name: "History", createdAt: "2026-01-01T00:00:00Z" }];
  const rows = [
    { id: "a", mac: "00:11:22:33:44:55", model: "A" },
    { id: "b", mac: "00-11-22-33-44-55", model: "B" },
    { id: "old-id", deviceId: "OLD", mac: "AA:BB:CC:DD:EE:FF", model: "Old" },
  ];
  const result = await backfillComparisonDevices([
    { mac: "0011.2233.4455", model: "" },
    { id: "new-id", deviceId: "NEW", mac: "AA:BB:CC:DD:EE:FF", model: "" },
  ], snapshots, async (_id, visit) => visit(rows));
  assert.equal(result.devices[0].model, "");
  assert.equal(result.devices[1].model, "");
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].snapshotId, "history");
  assert.deepEqual(result.diagnostics[1].conflictingFields.sort(), ["deviceId", "id"]);
});

test("comparison backfill does not restore fields when a lower-priority strong identity points to another row", async () => {
  const snapshot = { id: "history-conflict", name: "Conflicting Final", createdAt: "2026-02-01T00:00:00Z" };
  const rows = [
    { id: "stable-device", mac: "00:11:22:33:44:55", model: "Trusted by ID" },
    { id: "different-device", mac: "00:11:22:33:44:55", model: "Conflicting MAC row" },
  ];
  const result = await backfillComparisonDevices([
    { id: "stable-device", mac: "00:11:22:33:44:55", model: "" },
  ], [snapshot], async (_snapshotId, visit) => visit(rows));

  assert.equal(result.devices[0].model, "");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].snapshotId, snapshot.id);
  assert.deepEqual(result.diagnostics[0].conflictingFields, ["identity"]);
  assert.deepEqual(result.diagnostics[0].candidates.map(({ id }) => id), ["stable-device", "different-device"]);
});
