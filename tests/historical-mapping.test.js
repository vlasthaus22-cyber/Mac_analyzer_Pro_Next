import test from "node:test";
import assert from "node:assert/strict";
import { applyHistoricalAddress, applySmartroomRoom, buildCurrentSmartroomRoomIndex, buildCurrentSmartroomRoomIndexAsync, buildHistoricalAddressIndex, buildImportedSmartroomRoomIndex, buildSmartroomRoomIndex, compareSwitchIpHistory, compareSwitchIpHistoryInBatches, createHistoricalAddressAccumulator, createHistoricalAddressDeviceSummaryAccumulator, createAppliedSmartroomMappingSummaryAccumulator, mappingIndexPage, selectSwitchIpHistoryPage, summarizeHistoricalAddressDevices, summarizeAppliedSmartroomMappings } from "../src/core/historical-mapping.js";

const evidence = ["f1", "f2"].map((snapshotId) => ({
  snapshotId,
  snapshotName: `Final ${snapshotId}`,
  createdAt: "2026-09-01T00:00:00Z",
  switchIp: "10.0.0.1",
  address: "Москва, офис 1",
  deviceCount: 3,
  sampleMacs: ["00:11:22:33:44:55"],
}));

test("current Smartroom room index matches the synchronous reference and yields so cancellation can run", async () => {
  const sample = [
    { smartroomId: "SR-A", room: "Room A", mac: "00:11:22:33:44:01" },
    { smartroomId: "SR-A", room: "Room A", mac: "00:11:22:33:44:02" },
    { smartroomId: "SR-B", room: "Room B", mac: "00:11:22:33:44:03" },
  ];
  assert.deepEqual(await buildCurrentSmartroomRoomIndexAsync(sample), buildCurrentSmartroomRoomIndex(sample));

  const controller = new globalThis.AbortController();
  let reads = 0;
  const devices = Array.from({ length: 1_000 }, (_, index) => {
    const device = { room: "Room A", mac: `00:11:22:33:44:${(index % 256).toString(16).padStart(2, "0")}` };
    Object.defineProperty(device, "smartroomId", {
      get() {
        reads += 1;
        if (reads === 1) globalThis.setImmediate(() => controller.abort());
        return "SR-A";
      },
    });
    return device;
  });

  await assert.rejects(buildCurrentSmartroomRoomIndexAsync(devices, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 500);
  assert.deepEqual([...buildCurrentSmartroomRoomIndex(devices)].map(([key, value]) => [key, value.room, value.deviceCount]), [["sr-a", "Room A", 1_000]]);
});

test("current Smartroom room index finalizes accumulator values in place", async () => {
  const originalMap = globalThis.Map;
  let constructedMaps = 0;
  globalThis.Map = class CountingMap extends originalMap {
    constructor(...args) {
      super(...args);
      constructedMaps += 1;
    }
  };
  try {
    const devices = Array.from({ length: 1_001 }, (_, index) => ({
      smartroomId: `SR-${index % 500}`,
      room: index % 7 ? "Room A" : "Room B",
      mac: `00:11:22:33:44:${(index % 256).toString(16).padStart(2, "0")}`,
    }));
    const actual = await buildCurrentSmartroomRoomIndexAsync(devices);
    assert.equal(constructedMaps, 1, "the accumulator map should also hold finalized entries");
    assert.deepEqual(actual, buildCurrentSmartroomRoomIndex(devices));
  } finally {
    globalThis.Map = originalMap;
  }
});

test("current Smartroom room index can retain only IDs needed by blank-room devices", async () => {
  const devices = [
    { smartroomId: "SR-A", room: "Room A", mac: "00:11:22:33:44:01" },
    { smartroomId: "SR-A", room: "Room A", mac: "00:11:22:33:44:02" },
    { smartroomId: "SR-B", room: "Room B", mac: "00:11:22:33:44:03" },
    { smartroomId: "SR-C", room: "Room C", mac: "00:11:22:33:44:04" },
  ];
  const full = buildCurrentSmartroomRoomIndex(devices);
  const selected = await buildCurrentSmartroomRoomIndexAsync(devices, { targetIds: new Set(["sr-a", "sr-c"]) });
  assert.deepEqual(selected, new Map([["sr-a", full.get("sr-a")], ["sr-c", full.get("sr-c")]]));
  assert.equal(selected.size, 2);
  assert.equal(selected.get("sr-a").deviceCount, 2, "all devices sharing a requested ID still contribute evidence");
});

test("historical and imported room indexes reuse their accumulator maps during finalization", () => {
  const originalMap = globalThis.Map;
  let constructedMaps = 0;
  globalThis.Map = class CountingMap extends originalMap {
    constructor(...args) {
      super(...args);
      constructedMaps += 1;
    }
  };
  try {
    const imported = buildImportedSmartroomRoomIndex([
      { smartroomId: "SR-A", room: "Room A", source: "db", updatedAt: "2026-01-01" },
      { smartroomId: "SR-A", room: "Room A", source: "db", updatedAt: "2026-01-02" },
      { smartroomId: "SR-B", room: "Room B", source: "db", updatedAt: "2026-01-01" },
    ]);
    assert.equal(constructedMaps, 1, "imported mappings should not copy the accumulator Map or spread it into an array");
    assert.equal(imported.get("sr-a").room, "Room A");
    assert.equal(imported.get("sr-a").status, "confirmed");

    constructedMaps = 0;
    const historical = buildHistoricalAddressIndex([
      { switchIp: "10.0.0.1", address: "Address A", snapshotId: "f1", deviceCount: 2 },
      { switchIp: "10.0.0.1", address: "Address A", snapshotId: "f2", deviceCount: 2 },
      { switchIp: "10.0.0.2", address: "Address B", snapshotId: "f1", deviceCount: 2 },
      { switchIp: "10.0.0.2", address: "Address C", snapshotId: "f2", deviceCount: 2 },
    ]);
    assert.equal(constructedMaps, 6, "historical finalization should reuse the outer Map (1 outer + 2 IP + 3 address/snapshot maps)");
    assert.equal(historical.get("10.0.0.1").status, "confirmed");
    assert.equal(historical.get("10.0.0.2").status, "review");
  } finally {
    globalThis.Map = originalMap;
  }
});

test("historical mapping confirms repeated switch-IP address evidence and carries evidence", () => {
  const index = buildHistoricalAddressIndex(evidence);
  const device = { switchIp: "10.0.0.1", address: "", fieldSources: {} };
  const suggestion = applyHistoricalAddress(device, index);
  assert.equal(suggestion.status, "confirmed");
  assert.equal(device.address, "Москва, офис 1");
  assert.equal(device.fieldSources.address, "Historical switch IP mapping");
  assert.equal(device.addressEvidence.length, 2);
  assert.deepEqual(device.addressEvidence, evidence.map(({ snapshotId, snapshotName, createdAt, deviceCount, sampleMacs }) => ({
    snapshotId, snapshotName, createdAt, deviceCount, sampleMacs,
  })));
  assert.ok(device.addressConfidence >= 0.8);
});

test("streamed historical address evidence matches array aggregation without a duplicate source array", () => {
  const accumulator = createHistoricalAddressAccumulator();
  for (const item of evidence) accumulator.add(item);
  accumulator.add({ switchIp: "invalid", address: "ignored", snapshotId: "f3" });
  assert.deepEqual([...accumulator.finish()], [...buildHistoricalAddressIndex(evidence)]);
});

test("historical address alternatives retain exact totals while evidence is materialized only for the winner", () => {
  const accumulator = createHistoricalAddressAccumulator();
  for (const snapshotId of ["winner-1", "winner-2", "winner-3"]) {
    accumulator.add({ switchIp: "10.0.0.8", address: "Winning address", snapshotId, deviceCount: 5, sampleMacs: [snapshotId] });
  }
  for (let index = 0; index < 100; index += 1) {
    accumulator.add({
      switchIp: "10.0.0.8",
      address: `Alternative ${index}`,
      snapshotId: `alternative-${index}`,
      deviceCount: 1,
      sampleMacs: [`alternative-${index}`],
    });
  }

  const suggestion = accumulator.finish().get("10.0.0.8");
  assert.equal(suggestion.status, "review");
  assert.equal(suggestion.evidence.length, 3);
  assert.deepEqual(suggestion.evidence.map((item) => item.snapshotId), ["winner-1", "winner-2", "winner-3"]);
  assert.equal(suggestion.alternatives.length, 100);
  assert.ok(suggestion.alternatives.every((item) => !Object.hasOwn(item, "evidence")));
  assert.deepEqual(suggestion.alternatives.map((item) => item.address), Array.from({ length: 100 }, (_, index) => `Alternative ${index}`));
  assert.equal(suggestion.alternatives.find((item) => item.address === "Alternative 99").deviceCount, 1);
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

test("Smartroom mapping UI counts distinct normalized applied IDs without filtering to a copied array", () => {
  const devices = [
    { smartroomId: " SR-1 ", fieldSources: { room: "Historical Smartroom ID mapping" } },
    { smartroomId: "sr-1", fieldSources: { room: "Historical Smartroom ID mapping" } },
    { smartroomId: "SR-2", fieldSources: { room: "Imported SQLite Smartroom room mapping" } },
    { smartroomId: "SR-3", fieldSources: { room: "Main" } },
  ];
  assert.deepEqual(summarizeAppliedSmartroomMappings(devices), { historicalCount: 1, importedCount: 1 });
});

test("Final presentation summaries combine staged pages with exact cross-page distinct totals", () => {
  const addressSummary = createHistoricalAddressDeviceSummaryAccumulator();
  const roomSummary = createAppliedSmartroomMappingSummaryAccumulator();
  const firstPage = [
    { switchIp: "10.0.0.1", address: "", fieldSources: { room: "Historical Smartroom ID mapping" }, smartroomId: " SR-1 " },
    { switchIp: "10.0.0.2", address: "Main", fieldSources: { address: "Main" }, smartroomId: "SR-2", fieldSources: { room: "Imported SQLite Smartroom room mapping" } },
  ];
  const secondPage = [
    { switchIp: "10.0.0.1", address: "Historical", fieldSources: { address: "Historical switch IP mapping", room: "Historical Smartroom ID mapping" }, smartroomId: "sr-1" },
    { switchIp: "10.0.0.2", address: "Main", fieldSources: { address: "Main", room: "Imported SQLite Smartroom room mapping" }, smartroomId: "sr-3" },
  ];
  addressSummary.add(firstPage);
  addressSummary.add(secondPage);
  roomSummary.add(firstPage);
  roomSummary.add(secondPage);
  const finishedAddress = addressSummary.finish();
  assert.deepEqual([...finishedAddress.candidateIps], ["10.0.0.1"]);
  assert.equal(finishedAddress.appliedCount, 1);
  assert.deepEqual(roomSummary.finish(), { historicalCount: 1, importedCount: 2 });
  assert.throws(() => addressSummary.add([]), /уже завершена/);
  assert.throws(() => roomSummary.finish(), /уже завершена/);
});

test("Smartroom mapping table pages retain exact totals and review counts", () => {
  const index = new Map(Array.from({ length: 205 }, (_, position) => [
    `SR-${position + 1}`,
    { smartroomId: `SR-${position + 1}`, status: position % 2 ? "review" : "confirmed" },
  ]));
  const first = mappingIndexPage(index);
  const second = mappingIndexPage(index, { offset: 100, limit: 100 });
  const last = mappingIndexPage(index, { offset: 200, limit: 100 });
  const overflow = mappingIndexPage(index, { offset: 900, limit: 100 });
  assert.equal(first.rows.length, 100);
  assert.equal(first.total, 205);
  assert.equal(first.reviewCount, 102);
  assert.equal(first.hasPrevious, false);
  assert.equal(first.hasNext, true);
  assert.equal(second.offset, 100);
  assert.equal(second.rows.length, 100);
  assert.equal(second.hasPrevious, true);
  assert.equal(second.hasNext, true);
  assert.equal(last.offset, 200);
  assert.equal(last.rows.length, 5);
  assert.equal(last.hasNext, false);
  assert.equal(overflow.offset, 200);
  assert.equal(overflow.rows.length, 5);
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

test("switch IP history can stream changed rows by bounded candidate batch without collecting the full result", async () => {
  const devices = Array.from({ length: 601 }, (_, index) => ({ id: `device-${index}`, switchIp: "10.0.0.2" }));
  const received = [];
  const summary = await compareSwitchIpHistoryInBatches(devices, async (page) => new Map(page.map((device) => [device.id, {
    exactId: true,
    records: [{ id: device.id, switchIp: "10.0.0.1" }],
  }])), {
    batchSize: 250,
    onChangesBatch: async (changes, progress) => received.push({ changes, progress }),
  });

  assert.deepEqual(summary, { total: 601 });
  assert.deepEqual(received.map(({ changes }) => changes.length), [250, 250, 101]);
  assert.deepEqual(received.map(({ progress }) => [progress.offset, progress.total]), [[0, 250], [250, 500], [500, 601]]);
  assert.equal(received[2].changes[100].id, "device-600");
});

test("switch IP history consumes staged Final pages without retaining the full device array", async () => {
  const expected = Array.from({ length: 601 }, (_, index) => ({ id: `staged-${index}`, switchIp: "10.0.0.2" }));
  const loadedPages = [];
  const visitedPages = [];
  const savedBatches = [];
  const summary = await compareSwitchIpHistoryInBatches([], async (page) => new Map(page.map((device) => [device.id, {
    exactId: true,
    records: [{ id: device.id, switchIp: "10.0.0.1" }],
  }])), {
    deviceCount: expected.length,
    loadDevicePage: async (offset, limit) => {
      loadedPages.push([offset, limit]);
      return expected.slice(offset, offset + limit);
    },
    onDevicePage: (page, progress) => visitedPages.push([page.length, progress.offset, page[0].id]),
    batchSize: 250,
    onChangesBatch: async (changes) => savedBatches.push(changes.map(({ id }) => id)),
  });
  assert.deepEqual(summary, { total: expected.length });
  assert.deepEqual(loadedPages, [[0, 250], [250, 250], [500, 101]]);
  assert.deepEqual(visitedPages, [[250, 0, "staged-0"], [250, 250, "staged-250"], [101, 500, "staged-500"]]);
  assert.deepEqual(savedBatches.flat().map((id) => id), expected.map(({ id }) => id));
});

test("switch IP history rejects a short staged page before querying Inventory", async () => {
  let inventoryQueries = 0;
  await assert.rejects(compareSwitchIpHistoryInBatches([], async () => {
    inventoryQueries += 1;
    return new Map();
  }, {
    deviceCount: 2,
    loadDevicePage: async () => [{ id: "one", switchIp: "10.0.0.2" }],
  }), /страница Final .*неполна/i);
  assert.equal(inventoryQueries, 0);
});

test("switch IP history cancellation stops between batches and preserves AbortError", async () => {
  const devices = Array.from({ length: 501 }, (_, index) => ({ id: `device-${index}`, switchIp: "10.0.0.2" }));
  const controller = new globalThis.AbortController();
  let loadedBatches = 0;
  let writtenBatches = 0;
  await assert.rejects(compareSwitchIpHistoryInBatches(devices, async (page) => {
    loadedBatches += 1;
    return new Map(page.map((device) => [device.id, {
      exactId: true,
      records: [{ id: device.id, switchIp: "10.0.0.1" }],
    }]));
  }, {
    batchSize: 250,
    signal: controller.signal,
    onChangesBatch: async () => {
      writtenBatches += 1;
      controller.abort();
    },
  }), (error) => error.name === "AbortError");
  assert.equal(loadedBatches, 1);
  assert.equal(writtenBatches, 1);
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
