import test from "node:test";
import assert from "node:assert/strict";
import { attachMacTimelineHistoryEvent, buildMacTimeline, compareFinalAbsencePage, compareFinalAdditionPage, compareFinalModifiedDevicePage, compareFinalModificationDeviceGroupPage, compareFinalModificationEventPage, compareFinalUnchangedPage, compareFinals, compareInventoryObservation, reconcileAndCompareInventoryObservation, reconcileInventoryObservation, createFinalComparisonSummary, indexMacTimelineHistory, legacyObservationTimelineEvent, mergeMacTimelineHistoryEvent } from "../src/core/comparison.js";

test("partial Inventory observations compare known identities without fabricating absences", () => {
  const known = { id: "inventory-known", deviceId: "asset-1", mac: "00:11:22:33:44:01", model: "Projector" };
  const unchanged = { ...known };
  const changed = { ...known, model: "Conference system" };
  const newDevice = { id: "inventory-new", mac: "00:11:22:33:44:02", model: "Camera" };
  const candidates = new Map([
    [unchanged.id, { exactId: true, records: [known] }],
    [changed.id, { exactId: true, records: [known] }],
  ]);
  const comparison = compareInventoryObservation([unchanged, changed, newDevice], candidates, "2026-10-16T00:00:00Z");
  assert.deepEqual(comparison.added.map(({ id }) => id), [newDevice.id]);
  assert.equal(comparison.modified.length, 1);
  assert.equal(comparison.modified[0].changes[0].field, "model");
  assert.equal(comparison.unchangedCount, 1);
  assert.deepEqual(comparison.absent, []);
});

test("partial observations through a unique alternate MAC retain Inventory identity and canonical MAC", () => {
  const inventory = { id: "inventory-main", mac: "00:11:22:33:44:54", alternateMacs: ["00:11:22:33:44:99"], manufacturer: "Vendor" };
  const observation = { id: "generated-single-file-row", mac: "00:11:22:33:44:99", alternateMacs: ["00:11:22:33:44:54"], model: "Model D" };
  const candidates = new Map([[observation.id, { exactId: false, records: [inventory] }]]);
  reconcileInventoryObservation([observation], candidates);
  assert.equal(observation.id, inventory.id);
  assert.equal(observation.mac, inventory.mac);
  assert.deepEqual(observation.alternateMacs, ["00:11:22:33:44:99"]);
  const comparison = compareInventoryObservation([observation], candidates);
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.absent, []);
});

test("Inventory observation reconciliation and comparison reuse one index and release candidate references", () => {
  const inventory = {
    id: "inventory-device", mac: "00:11:22:33:44:54", alternateMacs: ["00:11:22:33:44:99"],
    model: "Old model", manufacturer: "Vendor",
  };
  const observation = { id: "generated-row", mac: "00:11:22:33:44:99", model: "New model" };
  const candidates = new Map([
    [observation.id, { records: [inventory] }],
    ["another-candidate-key", { records: [{ ...inventory, model: "Duplicate candidate" }] }],
  ]);

  const comparison = reconcileAndCompareInventoryObservation([observation], candidates, "2026-10-18T00:00:00Z");

  assert.equal(candidates.size, 0, "the candidate map must release record references before pair comparison");
  assert.equal(observation.id, inventory.id);
  assert.equal(observation.mac, inventory.mac);
  assert.deepEqual(observation.alternateMacs, ["00:11:22:33:44:99"]);
  assert.equal(comparison.modified.length, 1);
  assert.equal(comparison.modified[0].changes[0].field, "model");
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.absent, []);
});

test("ambiguous Inventory identity does not rewrite an observation ID or primary MAC", () => {
  const records = [
    { id: "inventory-a", mac: "00:11:22:33:44:54", alternateMacs: ["00:11:22:33:44:99"] },
    { id: "inventory-b", mac: "00:11:22:33:44:54", alternateMacs: ["00:11:22:33:44:99"] },
  ];
  const observation = { id: "generated-ambiguous", mac: "00:11:22:33:44:99", alternateMacs: ["00:11:22:33:44:54"] };
  reconcileInventoryObservation([observation], new Map([[observation.id, { records }]]));
  assert.equal(observation.id, "generated-ambiguous");
  assert.equal(observation.mac, "00:11:22:33:44:99");
});

test("streamed comparison summary matches full comparison counts across chunk boundaries", () => {
  const previous = [
    { id: "a", mac: "00:11:22:33:44:01", model: "A", room: "R1" },
    { id: "b", mac: "00:11:22:33:44:02", model: "B", room: "R2" },
    { id: "absent", mac: "00:11:22:33:44:03", model: "C" },
  ];
  const current = [
    { id: "a", mac: "00:11:22:33:44:01", model: "A2", room: "R1" },
    { id: "b", mac: "00:11:22:33:44:02", model: "B", room: "R2" },
    { id: "new", mac: "00:11:22:33:44:04", model: "D" },
  ];
  const full = compareFinals(previous, current, "2026-10-14T00:00:00Z");
  const streamed = createFinalComparisonSummary(previous, "2026-10-14T00:00:00Z");
  streamed.observeChunk(current.slice(0, 1));
  streamed.observeChunk(current.slice(1));
  const summary = streamed.finish();
  assert.deepEqual([summary.added, summary.absent, summary.modified], [full.added.length, full.absent.length, full.modified.length]);
  assert.deepEqual([summary.rooms.length, summary.macs.length], [1, 1]);
});

test("Final persistence comparison counts unchanged devices without retaining before/after row pairs", () => {
  const previous = Array.from({ length: 1_000 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:${(index >> 16 & 255).toString(16).padStart(2, "0")}:${(index >> 8 & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    model: "Same model",
  }));
  const current = previous.map((device) => ({ ...device }));
  const comparison = compareFinals(previous, current, "2026-10-15T00:00:00Z", { includeUnchangedRows: false });
  assert.equal(comparison.unchangedCount, 1_000);
  assert.deepEqual(comparison.unchanged, []);
  assert.deepEqual([comparison.added.length, comparison.absent.length, comparison.modified.length], [0, 0, 0]);
});

test("streamed comparison summary suppresses additions and absences for ambiguous identity", () => {
  const previous = [
    { id: "a", deviceId: "shared", mac: "00:11:22:33:44:01" },
    { id: "b", deviceId: "shared", mac: "00:11:22:33:44:02" },
  ];
  const current = [{ id: "c", deviceId: "shared", mac: "00:11:22:33:44:03" }];
  const full = compareFinals(previous, current);
  const streamed = createFinalComparisonSummary(previous);
  streamed.observeChunk(current);
  const summary = streamed.finish();
  assert.deepEqual([summary.added, summary.absent, summary.modified], [full.added.length, full.absent.length, full.modified.length]);
});

test("streamed absence pages match full comparison across pages and ambiguous strong identifiers", async () => {
  const previous = [
    { id: "matched", mac: "00:11:22:33:44:01", room: "A" },
    { id: "absent-1", mac: "00:11:22:33:44:02", room: "B" },
    { id: "ambiguous-a", deviceId: "shared", mac: "00:11:22:33:44:03" },
    { id: "ambiguous-b", deviceId: "shared", mac: "00:11:22:33:44:04" },
    { id: "absent-2", mac: "00:11:22:33:44:05", room: "C" },
  ];
  const chunks = [[
    { id: "matched", mac: "00:11:22:33:44:01", room: "A" },
    { id: "current-ambiguous", deviceId: "shared", mac: "00:11:22:33:44:06" },
  ]];
  const full = compareFinals(previous, chunks.flat());
  const visit = async (accept) => { for (const chunk of chunks) await accept(chunk); };
  const first = await compareFinalAbsencePage(previous, visit, { offset: 0, limit: 1 });
  const rest = await compareFinalAbsencePage(previous, visit, { offset: 1, limit: 10 });
  assert.equal(first.total, full.absent.length);
  assert.deepEqual(first.devices.map(({ id }) => id), full.absent.slice(0, 1).map(({ id }) => id));
  assert.deepEqual(rest.devices.map(({ id }) => id), full.absent.slice(1).map(({ id }) => id));
  assert.equal(rest.hasPrevious, true);
  assert.equal(rest.hasNext, false);
});

test("streamed absence pages preserve overflow duplicate-token ambiguity", async () => {
  const mac = "00:11:22:33:44:55";
  const previous = Array.from({ length: 8 }, (_, index) => ({ id: `old-${index}`, mac }));
  const current = [{ id: "new-device", mac }];
  const expected = compareFinals(previous, current).absent;
  const page = await compareFinalAbsencePage(previous, async (visit) => visit(current), { limit: 20 });
  assert.equal(page.total, expected.length);
  assert.deepEqual(page.devices, expected);
});

test("streamed addition pages match full comparison across chunks and suppress ambiguous identities", async () => {
  const previous = [
    { id: "known", mac: "00:11:22:33:44:01" },
    { id: "ambiguous-a", deviceId: "shared", mac: "00:11:22:33:44:02" },
    { id: "ambiguous-b", deviceId: "shared", mac: "00:11:22:33:44:03" },
  ];
  const current = [
    { id: "known", mac: "00:11:22:33:44:01" },
    { id: "uncertain", deviceId: "shared", mac: "00:11:22:33:44:04" },
    { id: "new-1", mac: "00:11:22:33:44:05" },
    { id: "new-2", mac: "00:11:22:33:44:06" },
  ];
  const full = compareFinals(previous, current);
  const visit = async (accept) => {
    await accept(current.slice(0, 2));
    await accept(current.slice(2));
  };
  const first = await compareFinalAdditionPage(previous, visit, { offset: 0, limit: 1 });
  const rest = await compareFinalAdditionPage(previous, visit, { offset: 1, limit: 5 });
  assert.equal(first.total, full.added.length);
  assert.deepEqual([...first.devices, ...rest.devices].map(({ id }) => id), full.added.map(({ id }) => id));
  assert.equal(rest.hasPrevious, true);
  assert.equal(rest.hasNext, false);
});

test("streamed modification event pages match comparison order, critical filter and device filter", async () => {
  const previous = [
    { id: "first", mac: "00:11:22:33:44:01", ip: "10.0.0.1", model: "Old", deviceType: "video conference" },
    { id: "second", mac: "00:11:22:33:44:02", room: "Room 1", model: "Old" },
  ];
  const current = [
    { ...previous[0], ip: "10.0.0.9", model: "New" },
    { ...previous[1], room: "Room 2", model: "New" },
  ];
  const full = compareFinals(previous, current, "2026-10-15T00:00:00Z");
  const expected = full.modified.flatMap((row) => row.changes.map((change) => ({ id: row.after.id, field: change.field })));
  const visit = async (accept) => { await accept(current.slice(0, 1)); await accept(current.slice(1)); };
  const first = await compareFinalModificationEventPage(previous, visit, { offset: 0, limit: 2, timestamp: full.timestamp });
  const next = await compareFinalModificationEventPage(previous, visit, { offset: 2, limit: 10, timestamp: full.timestamp });
  assert.deepEqual([...first.events, ...next.events].map(({ device, change }) => ({ id: device.id, field: change.field })), expected);
  assert.equal(first.total, expected.length);
  const critical = await compareFinalModificationEventPage(previous, visit, { criticalOnly: true, timestamp: full.timestamp });
  assert.deepEqual(critical.events.map(({ device, change }) => [device.id, change.field]), [["first", "ip"]]);
  const video = await compareFinalModificationEventPage(previous, visit, { deviceType: "video conference", timestamp: full.timestamp });
  assert.deepEqual(video.events.map(({ device }) => device.id), ["first", "first"]);
  const groups = await compareFinalModificationDeviceGroupPage(previous, visit, { offset: 0, limit: 1 });
  assert.equal(groups.total, 2);
  assert.equal(groups.totalEvents, 4);
  assert.equal(groups.groups[0].changes.length, 2);
  const criticalGroups = await compareFinalModificationDeviceGroupPage(previous, visit, { offset: 0, limit: 5, criticalOnly: true });
  assert.equal(criticalGroups.total, 1);
  assert.equal(criticalGroups.totalEvents, 1);
  assert.deepEqual(criticalGroups.groups[0].changes.map(({ field }) => field), ["ip"]);
});

test("streamed modification device-group pages keep every changed field together with exact event totals", async () => {
  const previous = Array.from({ length: 220 }, (_, index) => ({
    id: "group-" + index,
    deviceId: "asset-" + index,
    ip: "10.0.0." + (index + 1),
    ...(index === 99 ? { model: "Before", room: "Room 1" } : {}),
  }));
  const current = previous.map((device, index) => ({
    ...device,
    ip: "10.1.0." + (index + 1),
    ...(index === 99 ? { model: "After", room: "Room 2" } : {}),
  }));
  const visit = async (accept) => { await accept(current); };
  const pages = [];
  for (let offset = 0; ; ) {
    const page = await compareFinalModificationDeviceGroupPage(previous, visit, { offset, limit: 100 });
    pages.push(page);
    if (!page.hasNext) break;
    offset = page.offset + page.groups.length;
  }
  const allGroups = pages.flatMap((page) => page.groups);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => [page.total, page.totalEvents]), [[220, 222], [220, 222], [220, 222]]);
  assert.equal(allGroups.length, 220);
  assert.equal(new Set(allGroups.map((group) => group.device.deviceId)).size, 220);
  assert.deepEqual(allGroups[99].changes.map((change) => change.field), ["ip", "room", "model"]);
  assert.equal(pages[0].groups.length, 100);
  assert.equal(pages[1].groups.length, 100);
  assert.equal(pages[2].groups.length, 20);
});

test("streamed absence page reports no rows when comparing a Final with itself", async () => {
  const devices = [{ id: "one", mac: "00:11:22:33:44:01" }, { id: "two", mac: "00:11:22:33:44:02" }];
  const page = await compareFinalAbsencePage(devices, async (visit) => visit(devices));
  assert.equal(page.total, 0);
  assert.deepEqual(page.devices, []);
});

test("MAC timeline reports full known states, real field changes and absence transitions", () => {
  const mac = "00:11:22:33:44:55";
  const snapshots = [
    { id: "one", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "device", mac, model: "Kit A", room: "Room 1", deviceId: "device-1", authenticationTime: "2026-01-01T00:00:00Z" }] },
    { id: "two", createdAt: "2026-01-02T00:00:00Z", devices: [{ id: "device", mac, model: "Kit B", room: "Room 1", deviceId: "device-1", address: "Office" }] },
    { id: "three", createdAt: "2026-01-03T00:00:00Z", devices: [] },
    { id: "four", createdAt: "2026-01-04T00:00:00Z", devices: [{ id: "device", mac, model: "Kit B" }] },
  ];
  const events = buildMacTimeline(mac, snapshots);
  assert.deepEqual(events.map((event) => event.status), ["first", "changed", "absent", "first"]);
  assert.equal(events[0].after.deviceId, "device-1");
  assert.ok(events[1].changes.some((change) => change.field === "model" && change.oldValue === "Kit A" && change.newValue === "Kit B"));
  assert.equal(events[1].changes.some((change) => change.field === "address"), false, "empty-to-known is not a change");
  assert.equal(events[2].before.room, "Room 1");
});

test("legacy SQLite observation becomes a read-only point-in-time timeline event, not a field change", () => {
  const event = legacyObservationTimelineEvent({
    id: "legacy-mac-1", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T12:00:00Z",
    source: "old-import.csv", mac: "00-11-22-33-44-55",
    payload: { room: "Room A", vendor: "Vendor A", ip: "192.0.2.8", switch_ip: "192.0.2.1" },
  });
  assert.equal(event.status, "observation");
  assert.equal(event.observationKind, "mac_history");
  assert.equal(event.after.mac, "00:11:22:33:44:55");
  assert.equal(event.after.manufacturer, "Vendor A");
  assert.equal(event.after.room, "Room A");
  assert.equal(event.after.ip, "192.0.2.8");
  assert.equal(event.after.switchIp, "192.0.2.1");
  assert.deepEqual(event.changes, [], "an imported observation is not synthetic proof of a change");
  assert.equal(legacyObservationTimelineEvent({ kind: "mac_history", payload: { room: "No MAC" } }), null);
});

test("MAC timeline labels prior and current Final and merges duplicate saved events into calculated changes", () => {
  const mac = "00:11:22:33:44:55";
  const events = buildMacTimeline(mac, [
    { id: "final-old", name: "Old inventory", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "d", mac, model: "Model A" }] },
    { id: "final-new", name: "Current inventory", createdAt: "2026-01-02T00:00:00Z", devices: [{ id: "d", mac, model: "Model B" }] },
  ], [
    { id: 41, snapshotId: "final-new", field: "model", oldValue: "Model A", newValue: "Model B" },
    { id: 42, snapshotId: "final-new", field: "model", oldValue: "Model A", newValue: "Model B" },
    { id: 43, snapshotId: "final-new", field: "model", oldValue: "Model X", newValue: "Model B" },
  ]);
  const change = events[1];
  assert.equal(change.previousSnapshotName, "Old inventory");
  assert.equal(change.snapshotName, "Current inventory");
  assert.deepEqual(change.changes.find((item) => item.field === "model").historyEventIds, ["41", "42"]);
});

test("MAC timeline accepts saved history page by page and ignores unrelated events", () => {
  const events = buildMacTimeline("00:11:22:33:44:55", [
    { id: "before", createdAt: "2026-01-01T00:00:00Z", devices: [{ mac: "00:11:22:33:44:55", model: "A" }] },
    { id: "after", createdAt: "2026-01-02T00:00:00Z", devices: [{ mac: "00:11:22:33:44:55", model: "B" }] },
  ]);
  const historyIndex = indexMacTimelineHistory(events);
  assert.equal(attachMacTimelineHistoryEvent(historyIndex, { id: 51, snapshotId: "after", field: "model", oldValue: "A", newValue: "B" }), true);
  assert.equal(attachMacTimelineHistoryEvent(historyIndex, { id: 52, snapshotId: "after", field: "model", oldValue: "A", newValue: "B" }), true);
  assert.equal(attachMacTimelineHistoryEvent(historyIndex, { id: 53, snapshotId: "elsewhere", field: "model", oldValue: "A", newValue: "B" }), false);
  assert.deepEqual(events[1].changes.find((item) => item.field === "model").historyEventIds, ["51", "52"]);
});

test("MAC timeline retains unmatched real history changes without duplicating snapshot changes", () => {
  const snapshots = [{ id: "current", name: "Current Final", createdAt: "2026-01-02T00:00:00Z", devices: [{ id: "device-1", mac: "00:11:22:33:44:55", room: "Room B" }] }];
  const events = buildMacTimeline("00:11:22:33:44:55", snapshots);
  const historyIndex = indexMacTimelineHistory(events);
  const stored = { id: 81, snapshotId: "current", deviceId: "device-1", mac: "00:11:22:33:44:55", type: "modified", field: "room", label: "Помещение", oldValue: "Room A", newValue: "Room B", timestamp: "2026-01-02T00:00:00Z", source: "Main.csv" };

  assert.equal(mergeMacTimelineHistoryEvent(events, historyIndex, stored, snapshots), true);
  assert.equal(mergeMacTimelineHistoryEvent(events, historyIndex, stored, snapshots), true);
  assert.equal(events.length, 2);
  assert.equal(events[1].historyOnly, true);
  assert.equal(events[1].source, "Main.csv");
  assert.equal(events[1].after.id, "device-1");
  assert.deepEqual(events[1].changes[0].historyEventIds, ["81"]);
  assert.equal(mergeMacTimelineHistoryEvent(events, historyIndex, { ...stored, id: 82, type: "absent", field: "", oldValue: "", newValue: "" }, snapshots), false);
});

test("MAC timeline returns an explicit ambiguous event instead of selecting a duplicate MAC", () => {
  const events = buildMacTimeline("00-11-22-33-44-55", [{
    createdAt: "2026-01-01T00:00:00Z",
    devices: [
      { id: "one", mac: "00:11:22:33:44:55" },
      { id: "two", alternateMacs: ["0011.2233.4455"], deviceId: "device-2" },
    ],
  }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "ambiguous");
  assert.equal(events[0].candidates.length, 2);
});

test("MAC timeline carries the last known field across incomplete snapshots", () => {
  const mac = "00:11:22:33:44:55";
  const events = buildMacTimeline(mac, [
    { createdAt: "2026-02-01T00:00:00Z", devices: [{ mac, model: "Model A", room: "301" }] },
    { createdAt: "2026-02-02T00:00:00Z", devices: [{ mac, room: "301" }] },
    { createdAt: "2026-02-03T00:00:00Z", devices: [{ mac, model: "Model A", room: "301" }] },
    { createdAt: "2026-02-04T00:00:00Z", devices: [{ mac, room: "301" }] },
    { createdAt: "2026-02-05T00:00:00Z", devices: [{ mac, model: "Model B", room: "301" }] },
  ]);
  assert.deepEqual(events.map((event) => event.status), ["first", "present", "present", "present", "changed"]);
  assert.equal(events[2].changes.some((change) => change.field === "model"), false, "restoring the same last-known value is not a change");
  assert.equal(events[4].changes.find((change) => change.field === "model").oldValue, "Model A");
  assert.equal(events[4].before.model, "Model A");
});

test("MAC timeline backfills the last complete state for an absence observation", () => {
  const mac = "00:11:22:33:44:55";
  const events = buildMacTimeline(mac, [
    { createdAt: "2026-03-01T00:00:00Z", devices: [{ mac, model: "Model A", room: "301" }] },
    { createdAt: "2026-03-02T00:00:00Z", devices: [{ mac, room: "301" }] },
    { createdAt: "2026-03-03T00:00:00Z", devices: [] },
  ]);
  assert.equal(events.at(-1).status, "absent");
  assert.equal(events.at(-1).before.model, "Model A");
});

test("comparison keeps strong-identity conflicts in diagnostics without changing exact counts", () => {
  const before = [
    { mac: "AA:BB:CC:00:00:01", serial: "SERIAL-1", room: "101" },
    { mac: "AA:BB:CC:00:00:02", serial: "SERIAL-2", room: "102" },
  ];
  const after = [{ mac: "AA:BB:CC:00:00:01", serial: "SERIAL-2", room: "103" }];
  const result = compareFinals(before, after);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].candidates.length, 2);
  assert.equal(result.identityConflicts.length, 1);
  assert.equal(result.added.length, 0);
  assert.equal(result.absent.length, 0);
  assert.equal(result.modified.length, 0);
  assert.equal(result.unchangedCount, 0);
  assert.equal(result.identityConflicts[0].alternative, before[0]);
  const streamed = createFinalComparisonSummary(before);
  streamed.observeChunk(after);
  const summary = streamed.finish();
  assert.equal(summary.identityConflicts, result.identityConflicts.length);
  assert.deepEqual([summary.added, summary.absent, summary.modified], [result.added.length, result.absent.length, result.modified.length]);
});

test("streamed comparison pages exclude every row in a conflicting strong-identity pair", async () => {
  const previous = [
    { id: "stable-device", mac: "00:11:22:33:44:55", model: "Model A" },
    { id: "other-device", mac: "AA:BB:CC:DD:EE:FF", model: "Model B" },
  ];
  const current = [{ id: "stable-device", mac: "AA:BB:CC:DD:EE:FF", model: "Model C" }];
  const visitCurrentChunks = async (visit) => visit(current);
  const options = { includeStatusClassifier: true };
  const comparison = compareFinals(previous, current, "2026-10-17T00:00:00Z", options);
  assert.equal(comparison.statusClassifier(current[0]), "unresolved");
  assert.deepEqual([comparison.added.length, comparison.modified.length, comparison.absent.length, comparison.unchangedCount], [0, 0, 0, 0]);
  assert.equal((await compareFinalAdditionPage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalAbsencePage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalModifiedDevicePage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalUnchangedPage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalModificationEventPage(previous, visitCurrentChunks)).total, 0);
});

test("weak-only identity evidence remains unresolved instead of creating additions or absences", async () => {
  const previous = Array.from({ length: 5 }, (_, index) => ({ id: `legacy-${index}`, hostname: "shared-host", smartroomId: "shared-room" }));
  const current = [{ hostname: "shared-host", smartroomId: "shared-room", model: "Observed model" }];
  const visitCurrentChunks = async (visit) => visit(current);
  const comparison = compareFinals(previous, current, "2026-10-17T00:00:00Z", { includeStatusClassifier: true });
  assert.equal(comparison.statusClassifier(current[0]), "unresolved");
  assert.equal(comparison.ambiguous.length, 1);
  assert.equal(comparison.ambiguous[0].candidates.length, 2);
  assert.deepEqual([comparison.added.length, comparison.modified.length, comparison.absent.length, comparison.unchangedCount], [0, 0, 0, 0]);

  const summary = createFinalComparisonSummary(previous);
  summary.observeChunk(current);
  assert.deepEqual([summary.finish().added, summary.finish().modified, summary.finish().absent], [0, 0, 0]);
  assert.equal((await compareFinalAdditionPage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalAbsencePage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalModifiedDevicePage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalUnchangedPage(previous, visitCurrentChunks)).total, 0);
  assert.equal((await compareFinalModificationEventPage(previous, visitCurrentChunks)).total, 0);

  const unmatched = compareFinals([], [{ hostname: "unseen-host" }]);
  assert.equal(unmatched.added.length, 0);
  assert.equal(unmatched.ambiguous.length, 1);
});

test("critical comparison fields are limited to confirmed MAC, device IP, and switch IP changes", () => {
  const before = [{ id: "stable", mac: "00:11:22:33:44:55", ip: "10.0.0.1", switchIp: "10.0.0.254", switchPort: "1", physicalAddress: "A", smartroomId: "room-a", room: "101" }];
  const after = [{ id: "stable", mac: "00:11:22:33:44:66", ip: "10.0.0.2", switchIp: "10.0.0.253", switchPort: "2", physicalAddress: "B", smartroomId: "room-b", room: "102" }];
  const comparison = compareFinals(before, after);
  assert.deepEqual(comparison.critical[0].changes.map(({ field }) => field), ["ip", "switchIp", "mac"]);
  const onlyEmptyToKnown = compareFinals([{ id: "stable", ip: "" }], [{ id: "stable", ip: "10.0.0.2" }]);
  assert.equal(onlyEmptyToKnown.critical.length, 0);
});

test("conflicting stale MAC does not turn a strong-identity match into synthetic changes", () => {
  const before = [
    { id: "stable-a", mac: "00:11:22:33:44:55", room: "A" },
    { id: "stable-b", mac: "AA:BB:CC:DD:EE:FF", room: "B" },
  ];
  const result = compareFinals(before, [{ id: "stable-a", mac: "AA:BB:CC:DD:EE:FF", room: "A" }]);
  assert.equal(result.added.length, 0);
  assert.equal(result.absent.length, 0);
  assert.equal(result.modified.length, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.deepEqual(result.ambiguous[0].candidates.map(({ id }) => id), ["stable-a", "stable-b"]);
  assert.equal(result.identityConflicts.length, 1);
});

test("overflowed duplicate MAC hits remain ambiguous without synthetic absences in full or streamed comparison", () => {
  const mac = "00:11:22:33:44:55";
  const previous = Array.from({ length: 8 }, (_, index) => ({ id: `old-${index}`, mac }));
  const current = [{ id: "new-device", mac }];
  const full = compareFinals(previous, current);
  const streamed = createFinalComparisonSummary(previous);
  streamed.observeChunk(current);
  assert.equal(full.ambiguous.length, 1);
  assert.equal(full.ambiguous[0].candidates.length, 2);
  assert.equal(full.added.length, 0);
  assert.equal(full.absent.length, 0);
  assert.deepEqual([streamed.finish().added, streamed.finish().absent], [0, 0]);
});
