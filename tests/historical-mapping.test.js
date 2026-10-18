import test from "node:test";
import assert from "node:assert/strict";
import { applyHistoricalAddress, applySmartroomRoom, buildCurrentSmartroomRoomIndex, buildHistoricalAddressIndex, buildSmartroomRoomIndex, compareSwitchIpHistory, compareSwitchIpHistoryInBatches, createHistoricalAddressAccumulator, selectSwitchIpHistoryPage, summarizeHistoricalAddressDevices } from "../src/core/historical-mapping.js";

const evidence = ["f1", "f2"].map((snapshotId) => ({
  snapshotId,
  snapshotName: `Final ${snapshotId}`,
  createdAt: "2026-09-01T00:00:00Z",
  switchIp: "10.0.0.1",
  address: "Москва, офис 1",
  deviceCount: 3,
  sampleMacs: ["00:11:22:33:44:55"],
}));

test("historical mapping confirms repeated switch-IP address evidence and carries evidence", () => {
  const index = buildHistoricalAddressIndex(evidence);
  const device = { switchIp: "10.0.0.1", address: "", fieldSources: {} };
  const suggestion = applyHistoricalAddress(device, index);
  assert.equal(suggestion.status, "confirmed");
  assert.equal(device.address, "Москва, офис 1");
  assert.equal(device.fieldSources.address, "Historical switch IP mapping");
  assert.equal(device.addressEvidence.length, 2);
  assert.ok(device.addressConfidence >= 0.8);
});

test("streamed historical address evidence matches array aggregation without a duplicate source array", () => {
  const accumulator = createHistoricalAddressAccumulator();
  for (const item of evidence) accumulator.add(item);
  accumulator.add({ switchIp: "invalid", address: "ignored", snapshotId: "f3" });
  assert.deepEqual([...accumulator.finish()], [...buildHistoricalAddressIndex(evidence)]);
});

test("historical address UI summary builds exact unique candidate and applied IP sets in one pass", () => {
  const summary = summarizeHistoricalAddressDevices([
    { switchIp: "10.0.0.1", address: "", fieldSources: {} },
    { switchIp: "10.0.0.1", address: "Known", fieldSources: { address: "Historical switch IP mapping" } },
    { switchIp: "10.0.0.2", address: "Known", fieldSources: { address: "Main" } },
    { switchIp: "10.0.0.3", address: "Known", fieldSources: { address: "Historical switch IP mapping" } },
    { switchIp: "", address: "Known", fieldSources: { address: "Historical switch IP mapping" } },
  ]);
  assert.deepEqual([...summary.candidateIps], ["10.0.0.1", "10.0.0.3"]);
  assert.equal(summary.appliedCount, 2);
});

test("single-snapshot or conflicting address evidence is review-only", () => {
  const single = buildHistoricalAddressIndex(evidence.slice(0, 1));
  assert.equal(single.get("10.0.0.1").status, "review");
  const conflict = buildHistoricalAddressIndex([
    ...evidence,
    { ...evidence[0], snapshotId: "f3", address: "Москва, офис 2", deviceCount: 8 },
    { ...evidence[1], snapshotId: "f4", address: "Москва, офис 2", deviceCount: 8 },
  ]);
  const target = { switchIp: "10.0.0.1", address: "", fieldSources: {} };
  assert.equal(conflict.get("10.0.0.1").status, "review");
  assert.equal(applyHistoricalAddress(target, conflict), null);
  assert.equal(target.address, "");
});

test("historical address inference requires at least 90 percent consensus across two snapshots", () => {
  const atThreshold = buildHistoricalAddressIndex([
    { switchIp: "10.0.0.10", snapshotId: "f1", address: "Address A", deviceCount: 45 },
    { switchIp: "10.0.0.10", snapshotId: "f2", address: "Address A", deviceCount: 45 },
    { switchIp: "10.0.0.10", snapshotId: "f3", address: "Address B", deviceCount: 10 },
  ]).get("10.0.0.10");
  assert.equal(atThreshold.status, "confirmed");
  assert.equal(atThreshold.address, "Address A");
  assert.equal(atThreshold.evidence.length, 2);
  assert.equal(atThreshold.confidence >= 0.8, true);
  assert.equal(atThreshold.alternatives[0].address, "Address B");

  const belowThreshold = buildHistoricalAddressIndex([
    { switchIp: "10.0.0.11", snapshotId: "f1", address: "Address A", deviceCount: 30 },
    { switchIp: "10.0.0.11", snapshotId: "f2", address: "Address A", deviceCount: 30 },
    { switchIp: "10.0.0.11", snapshotId: "f3", address: "Address A", deviceCount: 29 },
    { switchIp: "10.0.0.11", snapshotId: "f1", address: "Address B", deviceCount: 6 },
    { switchIp: "10.0.0.11", snapshotId: "f2", address: "Address B", deviceCount: 5 },
  ]).get("10.0.0.11");
  assert.equal(belowThreshold.status, "review");
  assert.equal(belowThreshold.address, "");
  const target = { switchIp: "10.0.0.11", address: "", fieldSources: {} };
  assert.equal(applyHistoricalAddress(target, new Map([[belowThreshold.switchIp, belowThreshold]])), null);
  assert.equal(target.address, "");
});

test("switch IP history reports only confirmed changes and keeps DDIO candidates advisory", () => {
  const devices = [
    { id: "changed", mac: "00:11:22:33:44:55", switchIp: "10.0.0.2", ip: "192.0.2.10", possibleIps: ["192.0.2.11", "bad"] },
    { id: "same", switchIp: "10.0.0.3" },
    { id: "unknown", switchIp: "10.0.0.4" },
    { id: "missing-current", switchIp: "" },
  ];
  const inventory = new Map([
    ["changed", { exactId: true, records: [{ id: "changed", switchIp: "10.0.0.1", lastSeen: "2026-10-01T00:00:00Z", snapshotId: "final-old" }] }],
    ["same", { exactId: true, records: [{ id: "same", switchIp: "10.0.0.3" }] }],
    ["missing-current", { exactId: true, records: [{ id: "missing-current", switchIp: "10.0.0.5" }] }],
  ]);
  const before = devices.map((device) => ({ ...device, ...(device.possibleIps ? { possibleIps: [...device.possibleIps] } : {}) }));
  assert.deepEqual(compareSwitchIpHistory(devices, inventory), [{
    id: "changed", mac: "00:11:22:33:44:55", previousIp: "10.0.0.1", currentIp: "10.0.0.2",
    deviceIp: "192.0.2.10", possibleIps: ["192.0.2.11"], identityConflicts: [], lastSeen: "2026-10-01T00:00:00Z", previousSnapshotId: "final-old",
  }]);
  assert.deepEqual(devices, before);
});

test("switch IP history follows normalized strong IDs across MAC changes and exposes conflicting aliases", () => {
  const changes = compareSwitchIpHistory([
    { id: "new-id", deviceId: "Asset-A", serial: "SERIAL-new", mac: "AA:BB:CC:DD:EE:FF", switchIp: "10.0.0.2" },
  ], new Map([
    ["new-id", { exactId: false, records: [{ id: "old-id", deviceId: "asset-a", serial: "SERIAL-old", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1" }] }],
  ]));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousIp, "10.0.0.1");
  assert.deepEqual(changes[0].identityConflicts, ["id", "serial", "mac"]);
});

test("switch IP history falls back to one exact MAC and rejects ambiguous or conflicting identities", () => {
  const devices = [
    { id: "new-id", mac: "00:11:22:33:44:55", switchIp: "10.0.0.2" },
    { id: "ambiguous", mac: "00:11:22:33:44:66", switchIp: "10.0.0.2" },
    { id: "conflict", mac: "00:11:22:33:44:77", deviceId: "new-device-id", switchIp: "10.0.0.2" },
  ];
  const inventory = new Map([
    ["new-id", { exactId: false, records: [{ id: "old-id", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1" }] }],
    ["ambiguous", { exactId: false, records: [{ id: "a", mac: "00:11:22:33:44:66", switchIp: "10.0.0.1" }, { id: "b", mac: "00:11:22:33:44:66", switchIp: "10.0.0.3" }] }],
    ["conflict", { exactId: false, records: [{ id: "old-id", mac: "00:11:22:33:44:77", deviceId: "old-device-id", switchIp: "10.0.0.1" }] }],
  ]);
  assert.deepEqual(compareSwitchIpHistory(devices, inventory).map(({ id, previousIp, currentIp }) => ({ id, previousIp, currentIp })), [
    { id: "new-id", previousIp: "10.0.0.1", currentIp: "10.0.0.2" },
  ]);
});

test("switch IP history resolves every device in bounded Inventory candidate batches", async () => {
  const devices = Array.from({ length: 601 }, (_, index) => ({
    id: `device-${index}`,
    deviceId: `asset-${index}`,
    switchIp: "10.0.0.2",
  }));
  const batchSizes = [];
  const changes = await compareSwitchIpHistoryInBatches(devices, async (page) => {
    batchSizes.push(page.length);
    return new Map(page.map((device) => [device.id, {
      exactId: true,
      records: [{ id: device.id, deviceId: device.deviceId, switchIp: "10.0.0.1" }],
    }]));
  }, { batchSize: 250 });
  assert.deepEqual(batchSizes, [250, 250, 101]);
  assert.equal(changes.length, 601);
  assert.equal(changes[600].id, "device-600");
});

test("switch-IP history pages preserve totals and clamp to valid page boundaries", () => {
  const changes = Array.from({ length: 251 }, (_, index) => ({ id: `device-${index}` }));
  const secondPage = selectSwitchIpHistoryPage(changes, { offset: 137, limit: 100 });
  assert.equal(secondPage.total, 251);
  assert.equal(secondPage.offset, 100);
  assert.equal(secondPage.rows.length, 100);
  assert.equal(secondPage.rows[0].id, "device-100");
  assert.equal(secondPage.hasPrevious, true);
  assert.equal(secondPage.hasNext, true);
  const lastPage = selectSwitchIpHistoryPage(changes, { offset: 999, limit: 100 });
  assert.equal(lastPage.offset, 200);
  assert.equal(lastPage.rows.length, 51);
  assert.equal(lastPage.hasNext, false);
  assert.equal(selectSwitchIpHistoryPage(changes, { offset: 100, limit: 1000 }).rows.length, 251);
});

test("historical mapping never overwrites an address supplied by the current source", () => {
  const index = buildHistoricalAddressIndex(evidence);
  const device = { switchIp: "10.0.0.1", address: "Новый адрес" };
  assert.equal(applyHistoricalAddress(device, index), null);
  assert.equal(device.address, "Новый адрес");
});

test("Smartroom room evidence resolves the latest source mapping and preserves current room", () => {
  const index = buildSmartroomRoomIndex([
    { smartroomId: "SR-101", room: "Переговорная 101", status: "confirmed", sourceFinalId: "final-1", snapshotName: "Final 1", createdAt: "2026-10-01T00:00:00Z", deviceCount: 4, sampleMacs: ["00:11:22:33:44:55"] },
    { smartroomId: "SR-102", room: "", status: "review", sourceFinalId: "final-2", snapshotName: "Final 2", createdAt: "2026-10-02T00:00:00Z", alternatives: [{ room: "Room A" }, { room: "Room B" }] },
  ]);
  const device = { smartroomId: "sr-101", room: "", fieldSources: {} };
  const applied = applySmartroomRoom(device, index);
  assert.equal(applied.snapshotName, "Final 1");
  assert.equal(device.room, "Переговорная 101");
  assert.equal(device.fieldSources.room, "Historical Smartroom ID mapping");
  assert.equal(device.roomEvidence.sourceFinalId, "final-1");
  const current = { smartroomId: "SR-101", room: "Новое помещение" };
  assert.equal(applySmartroomRoom(current, index), null);
  assert.equal(current.room, "Новое помещение");
  const conflict = { smartroomId: "SR-102", room: "" };
  assert.equal(applySmartroomRoom(conflict, index), null);
});

test("current Smartroom mapping fills only when one room agrees for the ID", () => {
  const index = buildCurrentSmartroomRoomIndex([
    ...Array.from({ length: 7 }, (_, index) => ({
      smartroomId: "SR-1", room: "Room One", mac: `00:11:22:33:44:${String(index + 1).padStart(2, "0")}`,
    })),
    { smartroomId: "SR-2", room: "Room A" },
    { smartroomId: "SR-2", room: "Room B" },
  ]);
  const target = { smartroomId: "sr-1", room: "" };
  assert.ok(applySmartroomRoom(target, index, "Current Smartroom ID mapping"));
  assert.equal(target.room, "Room One");
  assert.equal(target.fieldSources.room, "Current Smartroom ID mapping");
  assert.equal(target.roomEvidence.deviceCount, 7, "room evidence reports all matching devices, not the five-MAC sample cap");
  assert.equal(target.roomEvidence.sampleMacs.length, 5);
  assert.equal(applySmartroomRoom({ smartroomId: "SR-2", room: "" }, index), null);
});
