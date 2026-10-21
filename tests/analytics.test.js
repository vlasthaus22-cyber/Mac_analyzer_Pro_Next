import test from "node:test";
import assert from "node:assert/strict";
import { aggregateSnapshotHistory, analyzeRoomChangeCoverage, analyzeRoomSwitchAnomalies, buildAnalytics, buildAnalyticsPair, buildAnalyticsPairFromChunks, buildPresenceChurn, buildSnapshotTotalSeries, collectPresenceTransitions, createPresenceChurnTracker, defaultSnapshotSelection, MAX_COMPARISON_DIAGNOSTIC_PREVIEW, releaseDashboardCurrentDevices, snapshotHistorySignature } from "../src/core/analytics.js";
import { buildPositionedIdentityIndex, identityLookupKeys, packAlternateMacsInPlace } from "../src/core/identity.js";
import { analyzeRoomSwitchIpAnomalies, createRoomSwitchIpAnomalyCollector } from "../src/core/analytics-detail.js";

test("snapshot history signatures ignore ordering but track dates, counts and in-place data revisions", () => {
  const snapshots = [
    { id: "b", createdAt: "2026-01-02T00:00:00Z", deviceCount: 2, chunkCount: 1 },
    { id: "a", createdAt: "2026-01-01T00:00:00Z", deviceCount: 1, chunkCount: 1 },
  ];
  assert.equal(snapshotHistorySignature(snapshots), snapshotHistorySignature([...snapshots].reverse()));
  assert.notEqual(snapshotHistorySignature(snapshots), snapshotHistorySignature([{ ...snapshots[0], deviceCount: 3 }, snapshots[1]]));
  assert.notEqual(snapshotHistorySignature(snapshots), snapshotHistorySignature([{ ...snapshots[0], dataRevision: 1 }, snapshots[1]]));
});

test("snapshot totals build an exact chronological trend from metadata without opening device rows", () => {
  const snapshots = [
    { id: "later", name: "Later", createdAt: "2026-01-02T00:00:00Z", deviceCount: 7, get devices() { throw new Error("metadata trend must not read device bodies"); } },
    { id: "first", name: "First", createdAt: "2026-01-01T00:00:00Z", deviceCount: 3, get devices() { throw new Error("metadata trend must not read device bodies"); } },
  ];
  assert.deepEqual(buildSnapshotTotalSeries(snapshots), [
    { label: "First", value: 3 },
    { label: "Later", value: 7 },
  ]);
});

test("snapshot history aggregation visits every snapshot once and compares adjacent chunks", async () => {
  const snapshots = [
    { id: "three", name: "Three", createdAt: "2026-01-03T00:00:00Z", deviceCount: 1 },
    { id: "one", name: "One", createdAt: "2026-01-01T00:00:00Z", deviceCount: 1 },
    { id: "two", name: "Two", createdAt: "2026-01-02T00:00:00Z", deviceCount: 2 },
  ];
  const bodies = {
    one: [{ id: "a", mac: "00:11:22:33:44:01", model: "A", room: "Room" }],
    two: [{ id: "a", mac: "00:11:22:33:44:01", model: "B", room: "Room" }, { id: "b", mac: "00:11:22:33:44:02", model: "C" }],
    three: [{ id: "b", mac: "00:11:22:33:44:02", model: "C" }],
  };
  const reads = [];
  let reading = false;
  const result = await aggregateSnapshotHistory(snapshots, async (id, visit) => {
    assert.equal(reading, false, "Final snapshots must be read serially");
    reading = true;
    reads.push(id);
    const rows = bodies[id];
    visit(rows.slice(0, 1));
    if (rows.length > 1) visit(rows.slice(1));
    reading = false;
  });
  assert.deepEqual(reads, ["one", "two", "three"]);
  assert.deepEqual(result.weekly.map(({ added, absent, modified }) => [added, absent, modified]), [[1, 1, 1]]);
  assert.deepEqual(result.weekly[0].macs, 1);
  assert.deepEqual(result.snapshotChanges, [
    { label: "Two", added: 1, absent: 0 },
    { label: "Three", added: 0, absent: 1 },
  ], "per-Final presence deltas start at the second snapshot and never fabricate first-snapshot changes");
  assert.deepEqual(result.totals.map(({ label, value }) => [label, value]), [["One", 1], ["Two", 2], ["Three", 1]]);
  assert.deepEqual(result.history, { snapshots: 3, deviceTotal: 4, uniqueMacs: 2 });
});

test("per-Final change series excludes the baseline and totals include every snapshot", () => {
  const result = buildAnalytics([
    { id: "one", name: "Baseline", createdAt: "2026-01-01T00:00:00Z", deviceCount: 2, devices: [{ mac: "00:11:22:33:44:01" }, { mac: "00:11:22:33:44:02" }] },
    { id: "two", name: "Second", createdAt: "2026-01-02T00:00:00Z", deviceCount: 3, devices: [{ mac: "00:11:22:33:44:01" }, { mac: "00:11:22:33:44:02" }, { mac: "00:11:22:33:44:03" }] },
    { id: "three", name: "Third", createdAt: "2026-01-03T00:00:00Z", deviceCount: 1, devices: [{ mac: "00:11:22:33:44:01" }] },
  ]);
  assert.deepEqual(result.snapshotChanges, [
    { label: "Second", added: 1, absent: 0 },
    { label: "Third", added: 0, absent: 2 },
  ]);
  assert.deepEqual(result.totals, [
    { label: "Baseline", value: 2 },
    { label: "Second", value: 3 },
    { label: "Third", value: 1 },
  ]);
});

test("analytics defaults to the last two Final snapshots by observation time", () => {
  assert.deepEqual(defaultSnapshotSelection([
    { id: "later", createdAt: "2026-01-03T00:00:00Z" },
    { id: "first", createdAt: "2026-01-01T00:00:00Z" },
    { id: "middle", createdAt: "2026-01-02T00:00:00Z" },
  ]), { baseId: "middle", currentId: "later" });
  assert.deepEqual(defaultSnapshotSelection([{ id: "only", createdAt: "2026-01-01T00:00:00Z" }]), { baseId: "", currentId: "only" });
});

test("room switch anomaly keeps exact counts without retaining a duplicate room roster", () => {
  const base = { smartroomId: "SR-1", businessUnit: "ЦА", city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1", address: "Кутузовский 1" };
  const devices = [
    { ...base, id: "a", mac: "00:11:22:33:44:51", switchIp: "10.0.0.1", model: "A" },
    { ...base, id: "b", mac: "00:11:22:33:44:52", switchIp: "10.0.0.1", model: "B" },
    { ...base, id: "c", mac: "00:11:22:33:44:53", switchIp: "10.0.0.1", model: "C" },
    { ...base, smartroomId: "", address: "", id: "d", mac: "00:11:22:33:44:54", switchIp: "10.0.0.2", model: "D" },
    { ...base, id: "e", mac: "00:11:22:33:44:55", switchIp: "", model: "E" },
  ];
  const result = analyzeRoomSwitchAnomalies(devices);
  assert.equal(result.length, 1);
  assert.equal(result[0].deviceCount, 5);
  assert.equal(result[0].deviationCount, 1);
  assert.equal(result[0].missingSwitchDevices, 1);
  assert.equal(result[0].switches["10.0.0.1"], 3);
  assert.equal(result[0].switches["10.0.0.2"], 1);
  assert.equal("devices" in result[0], false);
});

test("room switch anomaly requires at least three known devices and a strict majority", () => {
  const room = { smartroomId: "SR-1", room: "Room" };
  assert.equal(analyzeRoomSwitchAnomalies([
    { ...room, id: "a", switchIp: "10.0.0.1" },
    { ...room, id: "b", switchIp: "10.0.0.2" },
  ]).length, 0);
  assert.equal(analyzeRoomSwitchAnomalies([
    { ...room, id: "a", switchIp: "10.0.0.1" },
    { ...room, id: "b", switchIp: "10.0.0.2" },
    { ...room, id: "c", switchIp: "10.0.0.3" },
  ]).length, 0);
  const result = analyzeRoomSwitchAnomalies([
    { ...room, id: "a", switchIp: "10.0.0.1" },
    { ...room, id: "b", switchIp: "10.0.0.1" },
    { ...room, id: "c", switchIp: "10.0.0.1" },
    { ...room, id: "d", switchIp: "10.0.0.2" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].deviceCount, 4);
  assert.equal(result[0].deviationCount, 1);
});

test("high-cardinality room switch anomaly preserves full sorted known-IP counts", () => {
  const room = { smartroomId: "SR-1", room: "Room 1" };
  const devices = [
    ...Array.from({ length: 1_000 }, (_, index) => ({ ...room, id: `dominant-${index}`, switchIp: "10.0.0.1" })),
    ...Array.from({ length: 204 }, (_, index) => ({ ...room, id: `other-${index}`, switchIp: `10.1.0.${index + 1}` })),
    { ...room, id: "missing", switchIp: "" },
  ];
  const [anomaly] = analyzeRoomSwitchAnomalies(devices);

  assert.equal(anomaly.deviceCount, 1_205);
  assert.equal(anomaly.switchCount, 205);
  assert.equal(anomaly.missingSwitchDevices, 1);
  assert.equal(anomaly.deviationCount, 204);
  assert.equal(anomaly.dominantIp, "10.0.0.1");
  assert.equal(Object.keys(anomaly.switches).length, 205);
  assert.deepEqual(Object.keys(anomaly.switches).slice(0, 2), ["10.0.0.1", "10.1.0.1"]);
});

test("streamed room switch anomaly treats invalid and empty switch IPs as unknown", () => {
  const room = { smartroomId: "SR-1", room: "Room" };
  const result = analyzeRoomSwitchIpAnomalies([
    { ...room, id: "a", switchIp: "10.0.0.1" },
    { ...room, id: "b", switchIp: "10.0.0.1" },
    { ...room, id: "c", switchIp: "10.0.0.1" },
    { ...room, id: "d", switchIp: "10.0.0.2" },
    { ...room, id: "e", switchIp: "999.0.0.1" },
    { ...room, id: "f", switchIp: "" },
  ]);
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].totalDevices, 6);
  assert.equal(result.rooms[0].knownSwitchDevices, 4);
  assert.equal(result.rooms[0].missingSwitchDevices, 2);
  assert.equal(result.rooms[0].deviationCount, 1);
  assert.deepEqual(result.rooms[0].switchIps.map(({ switchIp }) => switchIp), ["10.0.0.1", "10.0.0.2"]);
  assert.equal(result.rooms[0].devices.filter(({ missingSwitchIp }) => missingSwitchIp).length, 2);
  assert.equal(result.rooms[0].devices.filter(({ missingSwitchIp }) => missingSwitchIp).every(({ isDeviation }) => !isDeviation), true);
});

test("room switch reconciliation preserves exact counts while enforcing sample limits", () => {
  const collector = createRoomSwitchIpAnomalyCollector({ roomDeviceSampleLimit: 20 });
  for (const city of ["Москва", "Казань"]) {
    for (let index = 0; index < 30; index += 1) {
      collector.acceptOne({ smartroomId: "SR-merge", room: "Переговорная", city, switchIp: "10.0.0.1" });
    }
    for (let index = 0; index < 24; index += 1) {
      collector.acceptOne({ smartroomId: "", room: "Переговорная", city, switchIp: "10.0.0.2" });
    }
  }

  const result = collector.finish();
  assert.equal(result.totalRooms, 1);
  assert.equal(result.analyzedRooms, 1);
  assert.equal(result.rooms[0].totalDevices, 108);
  assert.equal(result.rooms[0].knownSwitchDevices, 108);
  assert.equal(result.rooms[0].deviationCount, 48);
  assert.equal(result.rooms[0].switchIps.find(({ switchIp }) => switchIp === "10.0.0.2").count, 48);
  assert.equal(result.rooms[0].devices.filter(({ switchIp }) => switchIp === "10.0.0.2").length, 20);
  assert.equal(result.rooms[0].devices.length, 40);
  assert.equal("deviations" in result.rooms[0], false, "anomaly details keep one device sample array");
  assert.equal(result.rooms[0].devicesTruncated, true);
  assert.equal(collector.finish(), result, "finish is stable and does not recreate intermediate state");
  assert.throws(() => collector.acceptOne({ room: "late", switchIp: "10.0.0.3" }), /уже завершён/);
});

test("analytics KPIs exclude conflicting strong identities while retaining diagnostics", () => {
  const previous = { id: "before", devices: [
    { mac: "AA:BB:CC:00:00:01", serial: "SERIAL-1", room: "101" },
    { mac: "AA:BB:CC:00:00:02", serial: "SERIAL-2", room: "102" },
  ] };
  const current = { id: "after", devices: [
    { mac: "AA:BB:CC:00:00:01", serial: "SERIAL-2", room: "103" },
  ] };
  const result = buildAnalyticsPair(previous, current);
  assert.equal(result.comparison.identityConflicts.length, 1);
  assert.deepEqual(
    [result.kpis.modified, result.kpis.absent, result.comparison.modified.length, result.comparison.absent.length],
    [0, 0, 0, 0],
  );
  assert.equal(result.kpis.unchanged, 0);
  assert.equal(result.comparison.ambiguous.length, 1);
  assert.equal(result.comparison.added.length, 0);
});

test("selected dashboard counts unchanged devices without retaining unchanged comparison rows", () => {
  const room = { smartroomId: "SR-compact", room: "Room compact", address: "Address" };
  const previous = { id: "before", devices: [{ ...room, id: "same", mac: "00:11:22:33:44:70", ip: "10.0.0.1" }] };
  const current = { id: "after", devices: [{ ...room, id: "same", mac: "00:11:22:33:44:70", ip: "10.0.0.1" }] };
  const result = buildAnalyticsPair(previous, current);

  assert.equal(result.kpis.unchanged, 1);
  assert.equal(result.comparison.unchangedCount, 1);
  assert.deepEqual(result.comparison.unchanged, []);
  assert.equal(result.previous.id, "before");
  assert.equal("devices" in result.previous, false, "the compared baseline roster is released after comparison");
  assert.equal(result.roomChanges[0].deviceCount, 1);
  assert.equal(result.roomChanges[0].changedCount, 0);
});

test("Dashboard field filters are applied after full identity matching so unrelated devices are not false absences", () => {
  const outside = { deviceId: "outside", mac: "00:11:22:33:44:02", manufacturer: "Vendor B", room: "Room 2" };
  const previous = { id: "before", devices: [
    { deviceId: "keep", mac: "00:11:22:33:44:01", manufacturer: "Vendor A", room: "Room 1" },
    outside,
    { deviceId: "missing", mac: "00:11:22:33:44:03", manufacturer: "Vendor A", room: "Room 1" },
  ] };
  const current = { id: "after", devices: [
    { ...previous.devices[0] },
    { ...previous.devices[1] },
    { deviceId: "new-outside", mac: "00:11:22:33:44:04", manufacturer: "Vendor B", room: "Room 2" },
  ] };
  const result = buildAnalyticsPair(previous, current, {
    deviceMatches: (device) => device.manufacturer === "Vendor A" && device.room === "Room 1",
  });
  assert.equal(result.kpis.devices, 1);
  assert.equal(result.kpis.unchanged, 1);
  assert.equal(result.kpis.absent, 1);
  assert.deepEqual(result.comparison.absent.map(({ deviceId }) => deviceId), ["missing"]);
  assert.deepEqual(result.devices.map(({ deviceId }) => deviceId), ["keep"]);
  assert.deepEqual(result.comparison.added, []);
  assert.equal(result.comparison.statusClassifier({ ...outside }), "filtered", "status filtering follows full identity resolution and does not leak other vendors into the roster dataset");
  assert.equal(previous.devices.length, 2);
  assert.equal(current.devices.length, 1);
});

test("selected dashboard releases the baseline roster while preserving exact modified and absent evidence", () => {
  const beforeChanged = { id: "changed", mac: "00:11:22:33:44:71", ip: "10.0.0.1" };
  const beforeAbsent = { id: "absent", mac: "00:11:22:33:44:72", ip: "10.0.0.2" };
  const previous = { id: "before", createdAt: "2026-01-01T00:00:00Z", devices: [beforeChanged, beforeAbsent] };
  const current = {
    id: "after",
    createdAt: "2026-01-02T00:00:00Z",
    devices: [{ ...beforeChanged, ip: "10.0.0.10" }],
  };

  const result = buildAnalyticsPair(previous, current);

  assert.equal("devices" in result.previous, false);
  assert.equal(result.comparison.modified[0].before, beforeChanged);
  assert.equal(result.comparison.absent[0], beforeAbsent);
  assert.deepEqual(result.dashboardExportSummary.fieldChanges, [{ label: "IP устройства", value: 1 }]);
  assert.deepEqual(result.dashboardExportSummary.absentVendors, [{ label: "Unknown", value: 1 }]);
});

test("selected Dashboard classifies current status rows with the shared identity and known-value comparison", () => {
  const changedBefore = { deviceId: "changed", mac: "00:11:22:33:44:81", model: "Model A" };
  const unchangedBefore = { deviceId: "same", mac: "00:11:22:33:44:82", model: "Model B" };
  const absentBefore = { deviceId: "missing", mac: "00:11:22:33:44:83", model: "Model C" };
  const changedAfter = { ...changedBefore, model: "Model A2" };
  const unchangedAfter = { ...unchangedBefore };
  const newDevice = { deviceId: "new", mac: "00:11:22:33:44:84", model: "Model D" };
  const current = { id: "after", devices: [changedAfter, unchangedAfter, newDevice] };
  const result = buildAnalyticsPair({ id: "before", devices: [changedBefore, unchangedBefore, absentBefore] }, current);
  assert.equal(result.comparison.statusClassifier({ ...changedAfter }), "changed", "streamed IndexedDB rows classify by strong identity rather than object reference");
  assert.equal(result.comparison.statusClassifier({ ...unchangedAfter }), "unchanged");
  assert.equal(result.comparison.statusClassifier({ ...newDevice }), "added");
  assert.deepEqual(result.comparison.absent, [absentBefore]);
});

test("selected Dashboard can request a compact absent-position mask", () => {
  const previous = { id: "old", devices: [
    { id: "present", mac: "00:11:22:33:44:01" },
    { id: "absent", mac: "00:11:22:33:44:02" },
  ] };
  const current = { id: "new", devices: [{ id: "present", mac: "00:11:22:33:44:01" }] };
  const result = buildAnalyticsPair(previous, current, { includeAbsentPositionMask: true });
  assert.deepEqual([...result.comparison.absentPositionMask], [0, 1]);
});

test("selected Dashboard can request a compact current-status mask", () => {
  const previous = { id: "old", devices: [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { id: "same", mac: "00:11:22:33:44:02" },
  ] };
  const current = { id: "new", devices: [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.2" },
    { id: "same", mac: "00:11:22:33:44:02" },
  ] };
  const result = buildAnalyticsPair(previous, current, { includeCurrentStatusMask: true, includeStatusClassifier: false });
  assert.deepEqual([...result.comparison.currentStatusMask], [1, 2]);
  assert.equal(Object.hasOwn(result.comparison, "statusClassifier"), false);
});

test("selected Dashboard omits the baseline-capturing classifier when status filtering does not need it", () => {
  const previous = { id: "old", devices: [{ id: "absent", mac: "00:11:22:33:44:02" }] };
  const current = { id: "new", devices: [] };
  const filtered = buildAnalyticsPair(previous, current, { includeStatusClassifier: false });
  assert.equal(Object.hasOwn(filtered.comparison, "statusClassifier"), false);
  const classified = buildAnalyticsPair(previous, current);
  assert.equal(typeof classified.comparison.statusClassifier, "function");
});

test("stored Dashboard releases roster and comparison detail rows while retaining exact counts", () => {
  const previous = { id: "before", devices: [
    { id: "d", mac: "00:11:22:33:44:73", ip: "10.0.0.1" },
    { id: "gone", mac: "00:11:22:33:44:74", ip: "10.0.0.4" },
  ] };
  const currentDevice = { id: "d", mac: "00:11:22:33:44:73", ip: "10.0.0.2" };
  const current = { id: "after", deviceCount: 1, devices: [currentDevice] };
  const addedDevice = { id: "new", mac: "00:11:22:33:44:75" };
  const result = buildAnalyticsPair(previous, current);
  result.comparison.added.push(addedDevice);
  releaseDashboardCurrentDevices(result);

  assert.equal("devices" in result.current, false);
  assert.equal("devices" in result, false);
  assert.deepEqual(result.comparison.modified, []);
  assert.equal(result.comparison.modifiedDeviceCount, 1);
  assert.equal(result.comparison.modifiedEventCount, 1);
  assert.equal(result.comparison.criticalModifiedEventCount, 1);
  assert.equal(result.comparison.criticalModifiedDeviceCount, 1);
  assert.equal(result.comparison.absentCount, 1);
  assert.equal(result.comparison.addedCount, 1);
  assert.deepEqual(result.comparison.added, []);
  assert.deepEqual(result.comparison.absent, []);
  assert.equal(result.kpis.absent, 1);
  assert.equal(result.kpis.modified, 1);
});

test("Dashboard release fallback counts critical events and devices in one pass without temporary change arrays", () => {
  const analytics = {
    current: { id: "current", devices: [{ id: "d" }] },
    devices: [{ id: "d" }],
    comparison: {
      modified: [
        { changes: [
          { field: "ip", oldValue: "10.0.0.1", newValue: "10.0.0.2" },
          { field: "model", oldValue: "A", newValue: "B" },
        ] },
        { changes: [
          { field: "IP-адрес", oldValue: "192.0.2.1", newValue: "192.0.2.2" },
          { field: "switchIp", oldValue: "", newValue: "192.0.2.254" },
        ] },
      ],
      added: [],
      absent: [],
    },
  };
  releaseDashboardCurrentDevices(analytics);
  assert.equal(analytics.comparison.modifiedEventCount, 4);
  assert.equal(analytics.comparison.criticalModifiedEventCount, 1);
  assert.equal(analytics.comparison.criticalModifiedDeviceCount, 2);
  assert.equal(analytics.comparison.modifiedDeviceCount, 2);
  assert.deepEqual(analytics.comparison.modified, []);
});

test("unsaved Dashboard data keeps its current roster for non-IndexedDB callers", () => {
  const current = { devices: [{ id: "d", mac: "00:11:22:33:44:74" }] };
  const result = buildAnalyticsPair({ devices: [] }, current);

  assert.equal(releaseDashboardCurrentDevices(result), result);
  assert.equal(result.current.devices.length, 1);
  assert.equal(result.devices.length, 1);
});

test("ambiguous missing Smartroom ID is not guessed", () => {
  const location = { city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1" };
  const devices = [
    ...["10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.2"].map((switchIp, index) => ({ ...location, smartroomId: "SR-1", id: `a-${index}`, switchIp })),
    ...["10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.2"].map((switchIp, index) => ({ ...location, smartroomId: "SR-2", id: `b-${index}`, switchIp })),
    ...["10.0.0.1", "10.0.0.1"].map((switchIp, index) => ({ ...location, smartroomId: "", id: `anonymous-${index}`, switchIp })),
  ];
  const result = analyzeRoomSwitchAnomalies(devices);
  assert.deepEqual(result, [], "merging IDs by a shared path would fabricate a strict-majority switch anomaly");
});

test("dashboard room count bridges a missing ID only for one unambiguous location", () => {
  const base = { businessUnit: "ЦА", city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1" };
  const snapshots = [{
    id: "one",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [
      { ...base, id: "a", mac: "00:11:22:33:44:51", smartroomId: "SR-1" },
      { ...base, id: "b", mac: "00:11:22:33:44:52", smartroomId: "" },
    ],
  }];
  assert.equal(buildAnalytics(snapshots).kpis.rooms, 1);
});

test("unassigned KPI and vendor/model summaries use the full selected Final without retaining a duplicate roster", () => {
  const current = {
    id: "current",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [
      { id: "a", mac: "00:11:22:33:44:51", manufacturer: "Vendor A", model: "Model 1" },
      { id: "b", mac: "00:11:22:33:44:52", manufacturer: "Vendor A", model: "Model 2" },
      { id: "c", mac: "00:11:22:33:44:53", manufacturer: "Vendor B", model: "Model 2" },
      { id: "d", mac: "00:11:22:33:44:54", manufacturer: "Assigned", model: "Assigned", room: "Room 1", smartroomId: "SR-1" },
    ],
  };
  const previous = {
    id: "previous",
    createdAt: "2025-12-25T00:00:00Z",
    devices: [],
  };
  const result = buildAnalytics([previous, current]);
  assert.equal(result.kpis.withoutRoom, 3);
  assert.equal(Object.hasOwn(result, "unassignedDevices"), false);
  assert.deepEqual(result.unassignedVendors, [{ label: "Vendor A", value: 2 }, { label: "Vendor B", value: 1 }]);
  assert.deepEqual(result.unassignedModels, [{ label: "Model 2", value: 2 }, { label: "Model 1", value: 1 }]);
});

test("high-cardinality vendor and model summaries retain every unassigned value with deterministic rankings", () => {
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    manufacturer: `Vendor-${String(index).padStart(4, "0")}`,
    model: `Model-${String(index).padStart(4, "0")}`,
  }));
  const result = buildAnalytics([
    { id: "previous", createdAt: "2026-01-01T00:00:00Z", devices: [] },
    { id: "current", createdAt: "2026-01-02T00:00:00Z", devices },
  ]);

  assert.equal(result.kpis.devices, 1_205);
  assert.equal(result.unassignedVendors.length, 1_205);
  assert.equal(result.unassignedModels.length, 1_205);
  assert.deepEqual(result.unassignedVendors.slice(0, 2), [
    { label: "Vendor-0000", value: 1 }, { label: "Vendor-0001", value: 1 },
  ]);
  assert.deepEqual(result.vendors, Array.from({ length: 12 }, (_, index) => ({
    label: `Vendor-${String(index).padStart(4, "0")}`, value: 1,
  })));
});

test("all-changed room KPI counts a room only when every matched device has a confirmed change", () => {
  const room = { smartroomId: "SR-1", room: "Room 1", address: "Address" };
  const previous = { id: "previous", createdAt: "2026-01-01T00:00:00Z", devices: [
    { ...room, id: "a", mac: "00:11:22:33:44:51", ip: "10.0.0.1" },
    { ...room, id: "b", mac: "00:11:22:33:44:52", ip: "10.0.0.2" },
  ] };
  const current = { id: "current", createdAt: "2026-01-02T00:00:00Z", devices: [
    { ...room, id: "a", mac: "00:11:22:33:44:51", ip: "10.0.1.1" },
    { ...room, id: "b", mac: "00:11:22:33:44:52", ip: "10.0.2.2" },
  ] };
  const result = buildAnalytics([previous, current]);
  assert.equal(result.kpis.allChangedRooms, 1);
  assert.equal(result.roomChanges[0].allChanged, true);
  assert.equal(result.roomChanges[0].changedCount, 2);
  assert.equal(result.roomChanges[0].rosterCount, 2);
  assert.equal(Object.hasOwn(result.roomChanges[0], "devices"), false);
  assert.equal(Object.hasOwn(result.roomChanges[0], "entries"), false);
  const oneUnchanged = buildAnalytics([previous, { ...current, devices: [current.devices[0], previous.devices[1]] }]);
  assert.equal(oneUnchanged.kpis.allChangedRooms, 0);
});

test("room change coverage counts a large roster without materializing a values array", () => {
  const previousDevices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`, room: "Room 1", smartroomId: "SR-1", ip: `10.0.0.${index + 1}`,
  }));
  const currentDevices = previousDevices.map((device, index) => index < 602 ? { ...device, ip: `10.1.0.${index + 1}` } : device);
  const modified = currentDevices.slice(0, 602).map((after, index) => ({
    before: previousDevices[index], after, identity: `id:device-${index}`,
  }));
  const unchanged = currentDevices.slice(602).map((after, offset) => ({
    before: previousDevices[offset + 602], after, identity: `id:device-${offset + 602}`,
  }));
  const [room] = analyzeRoomChangeCoverage({ modified, unchanged, added: [], absent: [], ambiguous: [] }, previousDevices, currentDevices);

  assert.equal(room.deviceCount, 1_205);
  assert.equal(room.rosterCount, 1_205);
  assert.equal(room.changedCount, 602);
  assert.equal(room.allChanged, false);
});

test("chunked selected Dashboard pair matches full comparison, room coverage, filters and status masks", async () => {
  const beforeRoom = { businessUnit: "BU", city: "Moscow", site: "HQ", floor: "1", room: "101", smartroomId: "SR-1", manufacturer: "Acme" };
  const afterRoom = { ...beforeRoom, room: "202", smartroomId: "SR-2" };
  const previous = {
    id: "baseline",
    createdAt: "2026-10-17T00:00:00Z",
    devices: [
      { ...beforeRoom, id: "a", mac: "00:11:22:33:44:01", ip: "10.0.0.1", switchIp: "10.0.0.254", deviceType: "video conference", model: "Codec A" },
      { ...beforeRoom, id: "b", mac: "00:11:22:33:44:02", ip: "10.0.0.2", switchIp: "10.0.0.254", model: "Phone B" },
      { ...beforeRoom, id: "c", mac: "00:11:22:33:44:03", ip: "10.0.0.3", switchIp: "10.0.0.253", model: "Phone C" },
      { ...afterRoom, id: "d", mac: "00:11:22:33:44:04", ip: "10.0.0.4", switchIp: "10.0.0.253", model: "Phone D" },
      { ...afterRoom, id: "e", mac: "00:11:22:33:44:05", ip: "10.0.0.5", switchIp: "10.0.0.253", model: "Phone E" },
      { ...afterRoom, id: "f", mac: "00:11:22:33:44:06", ip: "10.0.0.6", switchIp: "10.0.0.252", model: "Phone F" },
      { ...afterRoom, id: "g", mac: "00:11:22:33:44:07", ip: "10.0.0.7", switchIp: "10.0.0.253", model: "Phone G" },
    ],
  };
  const current = {
    id: "current",
    createdAt: "2026-10-18T00:00:00Z",
    deviceCount: 7,
    chunkCount: 4,
    devices: [
      { ...afterRoom, id: "a", mac: "00:11:22:33:44:01", ip: "10.0.1.1", switchIp: "10.0.0.254", deviceType: "video conference", model: "Codec A" },
      previous.devices[1], previous.devices[3], previous.devices[4], previous.devices[5], previous.devices[6],
      { ...afterRoom, id: "h", mac: "00:11:22:33:44:08", ip: "10.0.0.8", switchIp: "10.0.0.253", model: "Phone H" },
    ],
  };
  const filters = { manufacturer: "Acme" };
  const deviceMatches = (device) => device.manufacturer === filters.manufacturer;
  const options = { deviceMatches, includeAbsentPositionMask: true, includeCurrentStatusMask: true, includeStatusClassifier: false };
  const full = releaseDashboardCurrentDevices(buildAnalyticsPair(
    { ...previous, devices: [...previous.devices] },
    { ...current, devices: [...current.devices] },
    options,
  ));
  const visitChunks = async (visit) => {
    for (let offset = 0; offset < current.devices.length; offset += 2) await visit(current.devices.slice(offset, offset + 2));
    return current;
  };
  const progress = [];
  const streamed = releaseDashboardCurrentDevices(await buildAnalyticsPairFromChunks({ ...previous, devices: [...previous.devices] }, current, visitChunks, { ...options, onProgress: (event) => progress.push(event) }));
  const resolveSparseBaselineChunk = async (chunk) => {
    const lookupKeys = new Set(chunk.flatMap(identityLookupKeys));
    const candidates = [];
    previous.devices.forEach((device, position) => {
      if (identityLookupKeys(device).some((key) => lookupKeys.has(key))) candidates.push({ position, device });
    });
    return buildPositionedIdentityIndex(candidates, previous.devices.length);
  };
  const streamedBaseline = releaseDashboardCurrentDevices(await buildAnalyticsPairFromChunks(
    { ...previous, devices: [], deviceCount: previous.devices.length },
    current,
    visitChunks,
    {
      ...options,
      previousDeviceCount: previous.devices.length,
      resolveIdentityChunk: resolveSparseBaselineChunk,
      visitPreviousChunks: async (visit) => {
        for (let offset = 0; offset < previous.devices.length; offset += 2) await visit(previous.devices.slice(offset, offset + 2));
      },
    },
  ));

  assert.deepEqual(streamed.kpis, full.kpis);
  assert.deepEqual(streamedBaseline.kpis, full.kpis);
  assert.deepEqual(streamed.vendors, full.vendors);
  assert.deepEqual(streamed.models, full.models);
  assert.deepEqual(streamed.unassignedVendors, full.unassignedVendors);
  assert.deepEqual(streamed.unassignedModels, full.unassignedModels);
  assert.deepEqual(streamed.dashboardExportSummary, full.dashboardExportSummary);
  assert.deepEqual(streamedBaseline.dashboardExportSummary, full.dashboardExportSummary);
  assert.deepEqual(streamed.dashboardFilterOptions, { manufacturers: ["Acme"], rooms: ["101", "202"] });
  assert.deepEqual([...streamed.comparison.absentPositionMask], [...full.comparison.absentPositionMask]);
  assert.deepEqual([...streamedBaseline.comparison.absentPositionMask], [...full.comparison.absentPositionMask]);
  assert.deepEqual([...streamed.comparison.currentStatusMask], [...full.comparison.currentStatusMask]);
  assert.deepEqual([...streamedBaseline.comparison.currentStatusMask], [...full.comparison.currentStatusMask]);
  assert.deepEqual(
    [streamed.comparison.addedCount, streamed.comparison.absentCount, streamed.comparison.modifiedDeviceCount, streamed.comparison.unchangedCount, streamed.comparison.modifiedEventCount, streamed.comparison.criticalModifiedEventCount, streamed.comparison.criticalModifiedDeviceCount],
    [full.comparison.addedCount, full.comparison.absentCount, full.comparison.modifiedDeviceCount, full.comparison.unchangedCount, full.comparison.modifiedEventCount, full.comparison.criticalModifiedEventCount, full.comparison.criticalModifiedDeviceCount],
  );
  assert.deepEqual(streamed.roomChanges.map(({ key, deviceCount, rosterCount, changedCount, allChanged }) => [key, deviceCount, rosterCount, changedCount, allChanged]).sort(),
    full.roomChanges.map(({ key, deviceCount, rosterCount, changedCount, allChanged }) => [key, deviceCount, rosterCount, changedCount, allChanged]).sort());
  assert.deepEqual(streamed.roomSwitchAnomalies, full.roomSwitchAnomalies);
  assert.equal(Object.hasOwn(streamed.current, "devices"), false);
  assert.deepEqual(progress.filter((event) => event.phase === "start").map(({ pass }) => pass), [1, 2, 3]);
  assert.deepEqual(progress.filter((event) => event.phase === "complete").map(({ processed }) => processed), [7, 7, 7]);
});

test("chunked Dashboard preserves alternate MAC changes after baseline packing", async () => {
  const previous = {
    id: "baseline",
    devices: [{ id: "device-1", mac: "00:11:22:33:44:01", alternateMacs: ["AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"], manufacturer: "Acme", room: "101" }],
  };
  const current = {
    id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 1, chunkCount: 1,
    devices: [{ id: "device-1", mac: "00:11:22:33:44:01", alternateMacs: ["AA:BB:CC:DD:EE:02", "AA:BB:CC:DD:EE:03"], manufacturer: "Acme", room: "101" }],
  };
  const options = { includeCurrentStatusMask: true };
  const full = buildAnalyticsPair({ ...previous, devices: [...previous.devices] }, current, options);
  const packedBaseline = { ...previous, devices: previous.devices.map((device) => ({ ...device, alternateMacs: [...device.alternateMacs] })) };
  packAlternateMacsInPlace(packedBaseline.devices);
  const streamed = await buildAnalyticsPairFromChunks(packedBaseline, current, async (visit) => {
    await visit(current.devices);
    return current;
  }, options);
  assert.equal(packedBaseline.devices[0].alternateMacs, "AA:BB:CC:DD:EE:01,AA:BB:CC:DD:EE:02");
  assert.equal(full.comparison.modified.length, 1);
  assert.equal(streamed.comparison.modifiedDeviceCount, 1);
  assert.equal(streamed.comparison.modifiedEventCount, 1);
  assert.equal(full.comparison.modified[0].changes[0].field, "alternateMacs");
  assert.deepEqual(streamed.dashboardExportSummary.fieldChanges, full.dashboardExportSummary.fieldChanges);
  assert.deepEqual([...streamed.comparison.currentStatusMask], [...full.comparison.currentStatusMask]);
});

test("chunked Dashboard can release its owned compact baseline after the final pass", async () => {
  const source = { id: "baseline", devices: [{ id: "a", mac: "00:11:22:33:44:01", manufacturer: "Acme", room: "101" }] };
  const previous = { ...source, devices: source.devices.map((device) => ({ ...device })) };
  const current = {
    id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 1, chunkCount: 1,
    devices: [{ id: "a", mac: "00:11:22:33:44:01", manufacturer: "Acme", room: "101" }],
  };
  const result = await buildAnalyticsPairFromChunks(previous, current, async (visit) => {
    await visit(current.devices);
    return current;
  }, { releasePreviousDevices: true });

  assert.equal(result.comparison.unchangedCount, 1);
  assert.equal(result.kpis.devices, 1);
  assert.deepEqual(previous.devices, [], "the caller opts in only when it owns this temporary projection");
  assert.equal(source.devices.length, 1, "the original baseline remains unchanged");
});

test("chunked Dashboard refuses mixed snapshot revisions across its multiple passes", async () => {
  let pass = 0;
  const current = { id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 1, chunkCount: 1, dataRevision: 1 };
  const visitChunks = async (visit) => {
    pass += 1;
    await visit([{ id: "a", mac: "00:11:22:33:44:01", manufacturer: "Acme" }]);
    return pass === 1 ? current : { ...current, dataRevision: 2 };
  };
  await assert.rejects(
    buildAnalyticsPairFromChunks({ devices: [] }, current, visitChunks),
    /изменился во время потокового расчёта/,
  );
  assert.equal(pass, 2, "stream must abort before aggregating a mixed third pass");
});

test("legacy vendor alias drives Dashboard manufacturer filter, KPI, rankings, and streamed analytics consistently", async () => {
  const legacyDevice = { id: "legacy-vendor", mac: "00:11:22:33:44:19", manufacturer: "Не указано", vendor: "Legacy Acme", room: "101" };
  const previous = { id: "previous", devices: [] };
  const current = { id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 1, chunkCount: 1, devices: [legacyDevice] };
  const deviceMatches = (device) => device.manufacturer === "Legacy Acme" || device.vendor === "Legacy Acme";
  const full = releaseDashboardCurrentDevices(buildAnalyticsPair(previous, current, { deviceMatches }));
  const streamed = releaseDashboardCurrentDevices(await buildAnalyticsPairFromChunks(previous, current, async (visit) => {
    await visit([legacyDevice]);
    return current;
  }, { deviceMatches }));

  for (const result of [full, streamed]) {
    assert.equal(result.kpis.devices, 1);
    assert.equal(result.kpis.manufacturers, 1);
    assert.deepEqual(result.vendors, [{ label: "Legacy Acme", value: 1 }]);
    assert.deepEqual(result.unassignedVendors, []);
  }
  assert.deepEqual(streamed.dashboardFilterOptions.manufacturers, ["Legacy Acme"]);
  assert.deepEqual(streamed.kpis, full.kpis);
  assert.deepEqual(streamed.vendors, full.vendors);
});

test("chunked selected Dashboard preserves weak ambiguity and strong identity conflict diagnostics", async () => {
  const previous = {
    id: "baseline",
    devices: [
      { id: "strong-a", serial: "SER-A", mac: "00:11:22:33:44:01", manufacturer: "Acme" },
      { id: "strong-b", serial: "SER-B", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
      { hostname: "shared-host", manufacturer: "Acme" },
      { hostname: "shared-host", manufacturer: "Acme" },
    ],
  };
  const current = {
    id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 2,
    devices: [
      { id: "strong-a", serial: "SER-B", mac: "00:11:22:33:44:01", manufacturer: "Acme" },
      { hostname: "shared-host", manufacturer: "Acme" },
    ],
  };
  const visitChunks = async (visit) => {
    await visit(current.devices.slice(0, 1));
    await visit(current.devices.slice(1));
    return current;
  };
  const full = buildAnalyticsPair({ ...previous, devices: [...previous.devices] }, current, { includeStatusClassifier: false });
  const streamed = await buildAnalyticsPairFromChunks({ ...previous, devices: [...previous.devices] }, current, visitChunks);

  assert.deepEqual([streamed.comparison.addedCount, streamed.comparison.absentCount, streamed.comparison.modifiedDeviceCount, streamed.comparison.unchangedCount],
    [full.comparison.addedCount, full.comparison.absentCount, full.comparison.modifiedDeviceCount, full.comparison.unchangedCount]);
  assert.equal(streamed.comparison.ambiguous.length, full.comparison.ambiguous.length);
  assert.deepEqual(streamed.comparison.ambiguous.map(({ reason, candidates }) => [reason || "", candidates.length]),
    full.comparison.ambiguous.map(({ reason, candidates }) => [reason || "", candidates.length]));
  assert.equal(streamed.comparison.identityConflicts.length, full.comparison.identityConflicts.length);
  assert.equal(streamed.comparison.identityConflictCount, full.comparison.identityConflicts.length);
});

test("chunked Dashboard keeps identity diagnostics bounded while retaining exact totals", async () => {
  const previous = { devices: [
    { id: "candidate-a", hostname: "shared-host" },
    { id: "candidate-b", hostname: "shared-host" },
  ] };
  const current = {
    id: "large-current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 1_250,
    devices: Array.from({ length: 1_250 }, () => ({ hostname: "shared-host" })),
  };
  const analytics = await buildAnalyticsPairFromChunks(previous, current, async (visit) => {
    for (let index = 0; index < current.devices.length; index += 125) await visit(current.devices.slice(index, index + 125));
    return current;
  });

  assert.equal(analytics.comparison.ambiguousCount, current.deviceCount);
  assert.equal(analytics.comparison.ambiguous.length, MAX_COMPARISON_DIAGNOSTIC_PREVIEW);
  assert.equal(analytics.comparison.identityConflictCount, 0);
  assert.equal(analytics.comparison.identityConflicts.length, 0);
});

test("chunked room coverage deduplicates repeated strong identities like full comparison", async () => {
  const room = { room: "101", smartroomId: "SR-1", manufacturer: "Acme" };
  const previous = { id: "baseline", devices: [
    { ...room, id: "a", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { ...room, id: "b", mac: "00:11:22:33:44:02", ip: "10.0.0.2" },
  ] };
  const repeated = { ...room, id: "a", mac: "00:11:22:33:44:01", ip: "10.0.1.1" };
  const current = { id: "current", createdAt: "2026-10-18T00:00:00Z", deviceCount: 3, devices: [repeated, { ...repeated }, previous.devices[1]] };
  const full = buildAnalyticsPair({ ...previous, devices: [...previous.devices] }, current, { includeStatusClassifier: false });
  const streamed = await buildAnalyticsPairFromChunks({ ...previous, devices: [...previous.devices] }, current, async (visit) => {
    await visit(current.devices);
    return current;
  });
  assert.deepEqual(streamed.roomChanges.map(({ deviceCount, rosterCount, changedCount, allChanged }) => [deviceCount, rosterCount, changedCount, allChanged]),
    full.roomChanges.map(({ deviceCount, rosterCount, changedCount, allChanged }) => [deviceCount, rosterCount, changedCount, allChanged]));
});

test("high-cardinality room summaries match across full and chunked analytics", async () => {
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(Math.floor(index / 256) % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    smartroomId: `SR-${index}`,
    room: `Room ${index}`,
  }));
  const previous = { id: "baseline", devices: [] };
  const current = { id: "current", createdAt: "2026-10-22T00:00:00Z", deviceCount: devices.length, devices };
  const full = buildAnalyticsPair(previous, current, { includeStatusClassifier: false });
  const streamed = await buildAnalyticsPairFromChunks(previous, current, async (visit) => {
    for (let offset = 0; offset < devices.length; offset += 125) await visit(devices.slice(offset, offset + 125));
    return current;
  });

  assert.equal(full.roomChanges.length, 1_205);
  assert.equal(streamed.roomChanges.length, 1_205);
  assert.deepEqual(streamed.roomChanges, full.roomChanges);
  assert.deepEqual(full.roomChanges[0], {
    key: "sr:sr-0", smartroomId: "SR-0", businessUnit: "", city: "", site: "", floor: "", room: "Room 0", address: "",
    deviceCount: 1, rosterCount: 1, changedCount: 1, allChanged: true,
  });
});

test("room coverage counts additions, removals, and moves as changed membership", () => {
  const previous = { id: "previous", createdAt: "2026-01-01T00:00:00Z", devices: [
    { id: "a", mac: "00:11:22:33:44:51", smartroomId: "SR-1", room: "Room 1", ip: "10.0.0.1" },
    { id: "b", mac: "00:11:22:33:44:52", smartroomId: "SR-1", room: "Room 1", ip: "10.0.0.2" },
  ] };
  const added = buildAnalytics([previous, { id: "added", createdAt: "2026-01-02T00:00:00Z", devices: [
    previous.devices[0], previous.devices[1],
    { id: "c", mac: "00:11:22:33:44:53", smartroomId: "SR-1", room: "Room 1", ip: "10.0.0.3" },
  ] }]);
  const addedRoom = added.roomChanges.find((item) => item.smartroomId === "SR-1");
  assert.equal(addedRoom.deviceCount, 3);
  assert.equal(addedRoom.changedCount, 1);
  assert.equal(addedRoom.allChanged, false);
  const removed = buildAnalytics([previous, { id: "removed", createdAt: "2026-01-02T12:00:00Z", devices: [] }]);
  assert.equal(removed.roomChanges.find((item) => item.smartroomId === "SR-1").allChanged, true);

  const moved = buildAnalytics([previous, { id: "moved", createdAt: "2026-01-03T00:00:00Z", devices: [
    { ...previous.devices[0], smartroomId: "SR-2", room: "Room 2" }, previous.devices[1],
  ] }]);
  assert.equal(moved.roomChanges.find((item) => item.smartroomId === "SR-1").allChanged, false);
  assert.equal(moved.roomChanges.find((item) => item.smartroomId === "SR-2").allChanged, true);
});

test("dashboard uses full snapshots and reports absent devices", () => {
  const snapshots = [
    { id: "1", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "a", mac: "00:11:22:33:44:55" }, { id: "b", mac: "AA:BB:CC:DD:EE:FF" }] },
    { id: "2", createdAt: "2026-01-08T00:00:00Z", devices: [{ id: "a", mac: "00:11:22:33:44:55" }] },
  ];
  const result = buildAnalytics(snapshots);
  assert.equal(result.kpis.devices, 1);
  assert.equal(result.kpis.absent, 1);
  assert.equal(result.comparison.absent[0].id, "b");
});

test("weekly change series combines same-week Finals, fills empty weeks, and preserves room and MAC tooltip counts", async () => {
  const { createWeeklyComparisonAccumulator } = await import("../src/core/analytics.js");
  const weekly = createWeeklyComparisonAccumulator();
  weekly.observeSummary({ createdAt: "2026-01-05T10:00:00Z" }, {
    modified: 2, added: 1, absent: 0,
    rooms: new Set(["room-a", "room-b"]), macs: new Set(["mac-a", "mac-b", "mac-c"]),
  });
  weekly.observeSummary({ createdAt: "2026-01-11T18:00:00Z" }, {
    modified: 3, added: 0, absent: 1,
    rooms: new Set(["room-b", "room-c"]), macs: new Set(["mac-c", "mac-d"]),
  });
  weekly.observeSummary({ createdAt: "2026-01-26T09:00:00Z" }, {
    modified: 1, added: 0, absent: 0,
    rooms: new Set(["room-z"]), macs: new Set(["mac-z"]),
  });
  assert.deepEqual(weekly.result(), [
    { label: "2026-01-05", modified: 5, added: 1, absent: 1, rooms: 3, macs: 4 },
    { label: "2026-01-12", modified: 0, added: 0, absent: 0, rooms: 0, macs: 0 },
    { label: "2026-01-19", modified: 0, added: 0, absent: 0, rooms: 0, macs: 0 },
    { label: "2026-01-26", modified: 1, added: 0, absent: 0, rooms: 1, macs: 1 },
  ]);
});

test("Final comparison uses persistent ID to avoid add/remove when a device MAC changes", () => {
  const result = buildAnalytics([
    { id: "one", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "persistent-device", mac: "00:11:22:33:44:55" }] },
    { id: "two", createdAt: "2026-01-02T00:00:00Z", devices: [{ id: "persistent-device", mac: "AA:BB:CC:DD:EE:FF" }] },
  ]);
  assert.equal(result.comparison.added.length, 0);
  assert.equal(result.comparison.absent.length, 0);
  assert.equal(result.comparison.modified.length, 1);
  assert.ok(result.comparison.modified[0].changes.some((change) => change.field === "mac"));
});

test("presence churn detects repeated disappearance and return", () => {
  const snapshots = [true, false, true, false, true].map((present, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00Z`,
    devices: present ? [{ mac: "00:11:22:33:44:55" }] : [],
  }));
  const result = buildPresenceChurn(snapshots);
  assert.equal(result[0].transitions, 4);
  assert.equal("presence" in result[0], false);
});

test("presence churn accepts legacy macFormatted when canonical mac is missing", () => {
  const tracker = createPresenceChurnTracker();
  tracker.observe({ id: "one", createdAt: "2026-01-01" }, [{ mac: "—", macFormatted: "00-11-22-33-44-55", model: "Legacy" }]);
  tracker.observe({ id: "two", createdAt: "2026-01-02" }, []);
  tracker.observe({ id: "three", createdAt: "2026-01-03" }, [{ mac: "—", macFormatted: "0011.2233.4455", model: "Current" }]);
  const [result] = tracker.result();
  assert.equal(result.mac, "00:11:22:33:44:55");
  assert.equal(result.macFormatted, "00:11:22:33:44:55");
  assert.equal(result.disappearances, 1);
  assert.equal(result.reappearances, 1);
  assert.equal(result.model, "Current");
});

test("presence transition details fall back to valid macFormatted when legacy mac is an empty marker", async () => {
  const snapshots = [
    { id: "one", name: "First", createdAt: "2026-01-01" },
    { id: "two", name: "Second", createdAt: "2026-01-02" },
    { id: "three", name: "Third", createdAt: "2026-01-03" },
  ];
  const rows = new Map([
    ["one", [{ mac: "—", macFormatted: "00-11-22-33-44-55" }]],
    ["two", []],
    ["three", [{ mac: "", macFormatted: "0011.2233.4455" }]],
  ]);
  const transitions = await collectPresenceTransitions("00:11:22:33:44:55", snapshots, async (snapshotId, visit) => visit(rows.get(snapshotId)));
  assert.deepEqual(transitions, [
    { type: "absent", snapshotId: "two", name: "Second", date: "2026-01-02" },
    { type: "present", snapshotId: "three", name: "Third", date: "2026-01-03" },
  ]);
});

test("presence transition details are loaded by snapshot chunks and retain ordered disappearance and return evidence", async () => {
  const mac = "00:11:22:33:44:55";
  const snapshots = [
    { id: "three", name: "Third", createdAt: "2026-01-03", devices: undefined },
    { id: "one", name: "First", createdAt: "2026-01-01" },
    { id: "four", name: "Fourth", createdAt: "2026-01-04" },
    { id: "two", name: "Second", createdAt: "2026-01-02" },
  ];
  const rows = new Map([
    ["one", [{ macFormatted: "0011.2233.4455", manufacturer: "Acme" }]],
    ["two", [{ mac: "00:11:22:33:44:55", manufacturer: "Other" }]],
    ["three", [{ mac: "00-11-22-33-44-55", manufacturer: "Acme" }]],
    ["four", []],
  ]);
  const visited = [];
  const transitions = await collectPresenceTransitions(mac, snapshots, async (snapshotId, visit) => {
    visited.push(snapshotId);
    await visit(rows.get(snapshotId));
  }, { filters: { manufacturer: "Acme" } });
  assert.deepEqual(visited, ["one", "two", "three", "four"]);
  assert.deepEqual(transitions, [
    { type: "absent", snapshotId: "two", name: "Second", date: "2026-01-02" },
    { type: "present", snapshotId: "three", name: "Third", date: "2026-01-03" },
    { type: "absent", snapshotId: "four", name: "Fourth", date: "2026-01-04" },
  ]);
});

test("presence churn requires both disappearance and return and retains latest device details", () => {
  const tracker = createPresenceChurnTracker();
  tracker.observe({ id: "one", createdAt: "2026-01-01" }, [
    { mac: "00:11:22:33:44:55", vendor: "Old Vendor", model: "Old", ip: "10.0.0.1", room: "A" },
    { mac: "00:11:22:33:44:66", vendor: "Vendor", model: "No Return" },
  ]);
  tracker.observe({ id: "two", createdAt: "2026-01-02" }, []);
  tracker.observe({ id: "three", createdAt: "2026-01-03" }, [
    { mac: "00:11:22:33:44:55", vendor: "Current Vendor", model: "Current", ip: "10.0.0.8", room: "B", address: "North", smartroomId: "room-8" },
  ]);
  assert.deepEqual(tracker.result().map(({ mac, vendor, model, ip, room, address, smartroomId, present, disappearances, reappearances, transitionCount, firstSeen, lastSeen }) => ({
    mac, vendor, model, ip, room, address, smartroomId, present, disappearances, reappearances, transitionCount, firstSeen, lastSeen,
  })), [{
    mac: "00:11:22:33:44:55", vendor: "Current Vendor", model: "Current", ip: "10.0.0.8", room: "B", address: "North", smartroomId: "room-8", present: 2, disappearances: 1, reappearances: 1, transitionCount: 2, firstSeen: "2026-01-01", lastSeen: "2026-01-03",
  }]);
});

test("presence churn tracker keeps compact state across streamed snapshot chunks", () => {
  const tracker = createPresenceChurnTracker();
  tracker.observe({ id: "one" }, [{ mac: "00-11-22-33-44-55" }]);
  tracker.observe({ id: "two" }, [{ mac: "0011.2233.4455" }]);
  tracker.observe({ id: "three" }, []);
  tracker.observe({ id: "four" }, [{ mac: "00:11:22:33:44:55" }]);
  assert.deepEqual(tracker.result().map(({ mac, transitions, present, absent }) => ({ mac, transitions, present, absent })), [
    { mac: "00:11:22:33:44:55", transitions: 2, present: 3, absent: 1 },
  ]);
});

test("presence churn position buffers deduplicate MAC aliases and keep the last returning device details", () => {
  const tracker = createPresenceChurnTracker();
  const mac = "00:11:22:33:44:55";
  tracker.observe({ createdAt: "2026-01-01" }, [
    { mac: "00-11-22-33-44-55", model: "First observation" },
    { mac: "0011.2233.4455", model: "Last first-snapshot duplicate" },
  ]);
  tracker.observe({ createdAt: "2026-01-02" }, []);
  tracker.observe({ createdAt: "2026-01-03" }, [
    { mac: "0011.2233.4455", model: "Earlier return duplicate" },
    { mac, model: "Latest return duplicate" },
  ]);

  const [record] = tracker.result();
  assert.equal(record.mac, mac);
  assert.equal(record.model, "Latest return duplicate");
  assert.deepEqual({ present: record.present, absent: record.absent, disappearances: record.disappearances, reappearances: record.reappearances, transitions: record.transitions }, {
    present: 2, absent: 1, disappearances: 1, reappearances: 1, transitions: 2,
  });
});

test("presence churn keeps first and last non-empty observation dates", () => {
  const tracker = createPresenceChurnTracker();
  tracker.observe({}, [{ mac: "00:11:22:33:44:55" }]);
  tracker.observe({ createdAt: "2026-01-02" }, [{ mac: "00:11:22:33:44:55" }]);
  tracker.observe({ createdAt: "2026-01-03" }, []);
  tracker.observe({ createdAt: "2026-01-04" }, [{ mac: "00:11:22:33:44:55" }]);
  const [record] = tracker.result();
  assert.equal(record.firstSeen, "2026-01-02");
  assert.equal(record.lastSeen, "2026-01-04");
});

test("presence churn grows compact counters and preserves exact results across capacity boundaries", () => {
  const tracker = createPresenceChurnTracker();
  const devices = Array.from({ length: 40 }, (_, index) => ({
    mac: `02:00:00:00:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    model: `Model ${index}`,
  }));
  tracker.observe({ createdAt: "2026-01-01" }, devices);
  tracker.observe({ createdAt: "2026-01-02" }, devices.filter((_, index) => index % 2 === 1));
  tracker.observe({ createdAt: "2026-01-03" }, devices);

  assert.equal(tracker.uniqueCount(), 40);
  const result = tracker.result();
  assert.equal(result.length, 20);
  for (const record of result) {
    const index = devices.findIndex(({ mac }) => mac.toUpperCase() === record.mac);
    assert.equal(index % 2, 0);
    assert.equal(record.model, `Model ${index}`);
    assert.equal(record.present, 2);
    assert.equal(record.absent, 1);
    assert.equal(record.disappearances, 1);
    assert.equal(record.reappearances, 1);
    assert.equal(record.transitions, 2);
    assert.equal(record.transitionCount, 2);
    assert.equal(record.firstSeen, "2026-01-01");
    assert.equal(record.lastSeen, "2026-01-03");
  }
});

test("presence churn does not materialize detail fields for stable MACs", () => {
  const tracker = createPresenceChurnTracker();
  const stableDevice = (mac) => ({
    mac,
    get manufacturer() { throw new Error("stable MAC details must not be retained"); },
    get model() { throw new Error("stable MAC details must not be retained"); },
    get ip() { throw new Error("stable MAC details must not be retained"); },
    get room() { throw new Error("stable MAC details must not be retained"); },
  });
  tracker.observe({ id: "one" }, [stableDevice("00:11:22:33:44:55")]);
  tracker.observe({ id: "two" }, [stableDevice("00:11:22:33:44:55")]);

  assert.deepEqual(tracker.result(), []);
  assert.equal(tracker.uniqueCount(), 1);
});

test("presence churn accepts devices incrementally without a separate full-snapshot MAC set", () => {
  const tracker = createPresenceChurnTracker();
  assert.throws(() => tracker.observeDevice("00:11:22:33:44:55"), /не начат/);
  tracker.beginSnapshot();
  tracker.observeDevice("00-11-22-33-44-55");
  tracker.observeDevice({ mac: "0011.2233.4455" });
  tracker.endSnapshot();
  tracker.beginSnapshot();
  tracker.observeDevice("00:11:22:33:44:55");
  tracker.endSnapshot();
  tracker.beginSnapshot();
  tracker.endSnapshot();
  tracker.beginSnapshot();
  tracker.observeDevice("00:11:22:33:44:55");
  tracker.endSnapshot();
  assert.deepEqual(tracker.result().map(({ mac, transitions, present, absent }) => ({ mac, transitions, present, absent })), [
    { mac: "00:11:22:33:44:55", transitions: 2, present: 3, absent: 1 },
  ]);
});

