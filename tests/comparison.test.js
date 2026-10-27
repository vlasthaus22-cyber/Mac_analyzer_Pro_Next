import test from "node:test";
import assert from "node:assert/strict";
import { createPositionedIdentityIndex, identityLookupKeys, packAlternateMacsInPlace } from "../src/core/identity.js";
import { attachMacTimelineHistoryEvent, buildMacTimeline, compareFinalAbsencePage, compareFinalAdditionPage, compareFinalIdentityDiagnosticPage, compareFinalModifiedDevicePage, compareFinalModificationDeviceGroupPage, compareFinalModificationEventPage, compareFinalUnchangedPage, compareFinals, compareInventoryObservation, createInventoryObservationComparator, deviceContainsNormalizedMac, reconcileAndCompareInventoryObservation, reconcileInventoryObservation, createFinalComparisonEventPlan, createFinalComparisonSummary, createFinalHistoryComparisonStream, createMacTimelineAccumulator, createMacTimelineSnapshotStatusIndex, indexMacTimelineHistory, legacyObservationTimelineEvent, mergeMacTimelineHistoryEvent } from "../src/core/comparison.js";

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

test("Final comparison canonicalizes alternate MAC aliases, order, and duplicates", () => {
  const previous = [{
    id: "device-1",
    mac: "00:11:22:33:44:01",
    alternateMacs: ["00:11:22:33:44:03", "0011.2233.4402", "00-11-22-33-44-03"],
  }];
  const equivalent = [{
    ...previous[0],
    alternateMacs: ["00:11:22:33:44:02", "00:11:22:33:44:03"],
  }];
  const same = compareFinals(previous, equivalent);
  assert.equal(same.unchangedCount, 1);
  assert.deepEqual(same.modified, []);

  const changed = compareFinals(previous, [{ ...equivalent[0], alternateMacs: ["00:11:22:33:44:04"] }]);
  assert.deepEqual(changed.modified[0].changes.map(({ field }) => field), ["alternateMacs"]);
});

test("packed Dashboard baseline keeps exact alternate MAC changes and rendered values", () => {
  const baseline = [{ id: "device-1", mac: "00:11:22:33:44:01", alternateMacs: ["00-11-22-33-44-02", "0011.2233.4403"] }];
  const current = [{ id: "device-1", mac: "00:11:22:33:44:01", alternateMacs: ["00:11:22:33:44:04"] }];
  const timestamp = "2026-10-18T00:00:00Z";
  const expected = compareFinals([{ ...baseline[0], alternateMacs: [...baseline[0].alternateMacs] }], current, timestamp);
  packAlternateMacsInPlace(baseline);
  const actual = compareFinals(baseline, current, timestamp);
  assert.deepEqual(actual.modified.map(({ identity, changes }) => ({ identity, changes })), expected.modified.map(({ identity, changes }) => ({ identity, changes })));
  assert.equal(actual.modified[0].changes[0].oldValue, "00:11:22:33:44:02, 00:11:22:33:44:03");
  assert.equal(baseline[0].alternateMacs, "00:11:22:33:44:02,00:11:22:33:44:03");
});

test("partial observations through a unique alternate MAC retain Inventory identity and canonical MAC", () => {
  const inventory = { id: "inventory-main", mac: "00:11:22:33:44:54", alternateMacs: "00:11:22:33:44:99", manufacturer: "Vendor" };
  const observation = { id: "generated-single-file-row", mac: "00:11:22:33:44:99", alternateMacs: "00:11:22:33:44:54", model: "Model D" };
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

test("paged Inventory candidates are compacted immediately and match the existing partial comparison", () => {
  const inventory = {
    id: "inventory-paged", mac: "00:11:22:33:44:54", alternateMacs: ["00:11:22:33:44:99"], model: "Old",
    largeImportedPayload: "x".repeat(100_000),
    fieldSources: { mac: "Источник MAC", model: "История", unrelated: "x".repeat(10_000) },
  };
  const changed = { id: "source-row", mac: "00:11:22:33:44:99", alternateMacs: ["00:11:22:33:44:54"], model: "New" };
  const unchanged = { id: "inventory-stable", mac: "00:11:22:33:44:01", model: "Same" };
  const current = [changed, { ...unchanged }, { id: "brand-new", mac: "00:11:22:33:44:02", model: "Camera" }];
  const comparator = createInventoryObservationComparator(current, "2026-10-18T00:00:00Z");
  comparator.acceptCandidates(new Map([["first", { records: [inventory] }]]));
  comparator.acceptCandidates(new Map([["duplicate", { records: [{ ...inventory, model: "stale duplicate" }] }], [unchanged.id, { records: [unchanged] }]]));

  const comparison = comparator.finish();
  assert.equal(changed.id, inventory.id);
  assert.equal(changed.mac, inventory.mac);
  assert.deepEqual(comparison.modified.map(({ changes }) => changes.map(({ field }) => field)), [["model"]]);
  assert.equal(comparison.modified[0].before.largeImportedPayload, undefined);
  assert.deepEqual(comparison.modified[0].before.fieldSources, { mac: "Источник MAC" });
  assert.equal(comparison.unchangedCount, 1);
  assert.deepEqual(comparison.added.map(({ id }) => id), ["brand-new"]);
  assert.deepEqual(comparison.absent, []);
  assert.throws(() => comparator.acceptCandidates(), /уже завершено/);
});

test("streamed Inventory comparison emits the same additions and changes without retaining full result arrays", () => {
  const inventory = [
    { id: "stream-changed", mac: "00:11:22:33:44:01", model: "Old", largeImportedPayload: "x".repeat(20_000), fieldSources: { mac: "OUI", model: "Inventory", unrelated: "x".repeat(1_000) } },
    { id: "stream-stable", mac: "00:11:22:33:44:02", model: "Same" },
  ];
  const current = [
    { id: "stream-changed", mac: "00:11:22:33:44:01", model: "New" },
    { id: "stream-stable", mac: "00:11:22:33:44:02", model: "Same" },
    { id: "stream-added", mac: "00:11:22:33:44:03", model: "Camera" },
  ];
  const timestamp = "2026-10-22T12:00:00.000Z";
  const full = createInventoryObservationComparator(current.map((device) => ({ ...device })), timestamp);
  const streamed = createInventoryObservationComparator([], timestamp);
  for (const comparator of [full, streamed]) comparator.acceptCandidates(new Map(inventory.map((device) => [device.id, { records: [device] }])));
  const expected = full.finish();
  const events = [];
  const stream = streamed.comparisonStream();
  for (let offset = 0; offset < current.length; offset += 2) stream.process(current.slice(offset, offset + 2).map((device) => ({ ...device })), (event) => events.push(event));
  const summary = stream.finish();
  assert.deepEqual(events.map((event) => event.type === "added"
    ? { type: event.type, id: event.device.id }
    : { type: event.type, id: event.row.after.id, fields: event.row.changes.map(({ field }) => field) }), [
    { type: "modified", id: "stream-changed", fields: ["model"] },
    { type: "added", id: "stream-added" },
  ]);
  assert.equal(summary.addedCount, expected.addedCount);
  assert.equal(summary.modifiedDeviceCount, expected.modifiedDeviceCount);
  assert.equal(summary.unchangedCount, expected.unchangedCount);
  assert.equal(summary.ambiguousCount, expected.ambiguousCount);
  const modifiedEvent = events.find(({ type }) => type === "modified");
  assert.equal(modifiedEvent.row.before.largeImportedPayload, undefined);
  assert.deepEqual(modifiedEvent.row.before.fieldSources, { mac: "OUI" });
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
  assert.equal(summary.unchanged, full.unchangedCount);
  assert.equal(summary.modifiedEventCount, full.modified.reduce((count, row) => count + row.changes.length, 0));
  assert.deepEqual(summary.fieldChanges, { "Модель": 1 });
  assert.deepEqual(summary.absentVendors, { Unknown: 1 });
  assert.deepEqual([summary.rooms.length, summary.macs.length], [1, 1]);
});

test("streamed Dashboard summary can skip all changed-room and changed-MAC sets without changing counts", () => {
  const previous = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:${String(index >> 16).padStart(2, "0")}:${String(index >> 8 & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    room: `old-${index}`,
  }));
  const current = previous.map((device, index) => ({
    ...device,
    mac: `02:11:22:${String(index >> 16).padStart(2, "0")}:${String(index >> 8 & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    room: `new-${index}`,
  }));
  const summary = createFinalComparisonSummary(previous, "2026-10-22T00:00:00Z", { includeChangeLocations: false });
  for (let offset = 0; offset < current.length; offset += 250) summary.observeChunk(current.slice(offset, offset + 250));
  const result = summary.finish();
  assert.deepEqual([result.modified, result.modifiedEventCount, result.criticalModifiedEventCount, result.criticalModifiedDeviceCount], [1_205, 2_410, 1_205, 1_205]);
  assert.deepEqual([result.rooms, result.macs], [[], []]);
});

test("streamed comparison aggregates changed fields directly and retains details only for callbacks", () => {
  const previous = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    serial: `SER-${index}`,
    model: "Before",
    switchIp: "10.0.0.1",
    room: `room-${index % 20}`,
  }));
  const current = previous.map((device, index) => ({
    ...device,
    model: "After",
    switchIp: index % 10 === 0 ? "10.0.1.1" : device.switchIp,
  }));
  const full = compareFinals(previous, current, "2026-10-22T00:00:00Z");
  const expectedFields = {};
  for (const row of full.modified) for (const change of row.changes) expectedFields[change.label] = (expectedFields[change.label] || 0) + 1;

  const summary = createFinalComparisonSummary(previous, "2026-10-22T00:00:00Z", { includeChangeLocations: false });
  for (let offset = 0; offset < current.length; offset += 250) summary.observeChunk(current.slice(offset, offset + 250));
  const result = summary.finish();
  assert.deepEqual([result.modified, result.modifiedEventCount, result.criticalModifiedEventCount, result.criticalModifiedDeviceCount], [
    full.modified.length,
    full.modified.reduce((total, row) => total + row.changes.length, 0),
    full.critical.length,
    full.critical.length,
  ]);
  assert.deepEqual(result.fieldChanges, expectedFields);

  let modifiedSample = null;
  const withCallback = createFinalComparisonSummary(previous.slice(0, 1), "2026-10-22T00:00:00Z", {
    includeChangeLocations: false,
    onModified: (row) => { modifiedSample = row; },
  });
  withCallback.observeChunk([current[0]]);
  withCallback.finish();
  assert.deepEqual(modifiedSample.changes.map(({ field, oldValue, newValue }) => [field, oldValue, newValue]), [
    ["switchIp", "10.0.0.1", "10.0.1.1"],
    ["model", "Before", "After"],
  ]);
});

test("streamed comparison keeps unchanged callback payloads compatible without allocating per-row change arrays", () => {
  const previous = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    serial: `SER-${index}`,
    model: "Stable",
  }));
  let unchangedCount = 0;
  const summary = createFinalComparisonSummary(previous, undefined, {
    includeChangeLocations: false,
    onUnchanged: (row) => {
      unchangedCount += 1;
      assert.deepEqual(row.changes, []);
    },
  });
  for (let offset = 0; offset < previous.length; offset += 250) summary.observeChunk(previous.slice(offset, offset + 250));
  const result = summary.finish();
  assert.equal(unchangedCount, previous.length);
  assert.deepEqual([result.unchanged, result.modified, result.added], [previous.length, 0, 0]);
});

test("streamed comparison summary produces exact current and absent status masks", () => {
  const previous = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.1", manufacturer: "Acme" },
    { id: "same", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
    { id: "missing", mac: "00:11:22:33:44:03", manufacturer: "Acme" },
  ];
  const current = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.2", manufacturer: "Acme" },
    { id: "same", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
    { id: "new", mac: "00:11:22:33:44:04", manufacturer: "Acme" },
  ];
  let absentVisits = 0;
  const streamed = createFinalComparisonSummary(previous, "2026-10-18T00:00:00Z", {
    deviceCount: current.length,
    includeAbsentPositionMask: true,
    includeCurrentStatusMask: true,
    onAbsent: () => { absentVisits += 1; },
  });
  streamed.observeChunk(current.slice(0, 1));
  streamed.observeChunk(current.slice(1));
  const summary = streamed.finish();
  assert.equal(streamed.finish(), summary);
  assert.equal(absentVisits, 1);
  assert.throws(() => streamed.observeChunk([]), /уже завершено/);

  assert.deepEqual([...summary.currentStatusMask], [1, 2, 0]);
  assert.deepEqual([...summary.absentPositionMask], [0, 0, 1]);
  assert.deepEqual([summary.added, summary.modified, summary.absent, summary.unchanged], [1, 1, 1, 1]);
  assert.equal(summary.criticalModifiedEventCount, 1);
  assert.equal(summary.criticalModifiedDeviceCount, 1);

  assert.throws(() => createFinalComparisonSummary(previous, undefined, { includeCurrentStatusMask: true }), /точный размер Final/);
  const incomplete = createFinalComparisonSummary(previous, undefined, { deviceCount: 4, includeCurrentStatusMask: true });
  incomplete.observeChunk(current);
  assert.throws(() => incomplete.finish(), /не совпало с размером маски/);
});

test("absent-position mask preserves exact baseline chunk positions without retaining absent rows", () => {
  const previous = [
    { id: "present", mac: "00:11:22:33:44:01", manufacturer: "Acme" },
    { id: "absent", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
    { id: "filtered", mac: "00:11:22:33:44:03", manufacturer: "Other" },
  ];
  const current = [{ id: "present", mac: "00:11:22:33:44:01", manufacturer: "Acme" }];
  const comparison = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    includeAbsentPositionMask: true,
    deviceMatches: (device) => device.manufacturer === "Acme",
  });
  assert.deepEqual([...comparison.absentPositionMask], [0, 1, 0]);
  assert.deepEqual(comparison.absent.map(({ id }) => id), ["absent"]);
});

test("current-status mask classifies matched rows once and leaves additions, conflicts, and filtered rows out", () => {
  const previous = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.1", manufacturer: "Acme" },
    { id: "same", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
    { id: "conflict", mac: "00:11:22:33:44:03", deviceId: "old", manufacturer: "Acme" },
    { id: "other", mac: "00:11:22:33:44:06", deviceId: "new", manufacturer: "Acme" },
  ];
  const current = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.2", manufacturer: "Acme" },
    { id: "same", mac: "00:11:22:33:44:02", manufacturer: "Acme" },
    { id: "new", mac: "00:11:22:33:44:04", manufacturer: "Acme" },
    { id: "filtered", mac: "00:11:22:33:44:05", manufacturer: "Other" },
    { id: "conflict", mac: "00:11:22:33:44:03", deviceId: "new", manufacturer: "Acme" },
  ];
  const comparison = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    includeCurrentStatusMask: true,
    includeStatusClassifier: false,
    deviceMatches: (device) => device.manufacturer === "Acme",
  });
  assert.deepEqual([...comparison.currentStatusMask], [1, 2, 0, 0, 0]);
  assert.equal(comparison.modifiedDeviceCount, 1);
  assert.equal(comparison.unchangedCount, 1);
  assert.equal(Object.hasOwn(comparison, "statusClassifier"), false);
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

test("count-only comparison avoids row details for 1,205 devices while callbacks retain exact details", () => {
  const previous = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    serial: `SER-${index}`,
    model: "Stable",
  }));
  const current = previous.map((device, index) => index === 1204 ? { ...device, model: "Updated" } : { ...device });
  const counts = compareFinals(previous, current, "2026-10-22T00:00:00Z", {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
  });
  assert.deepEqual([counts.addedCount, counts.absentCount, counts.modifiedDeviceCount, counts.unchangedCount], [0, 0, 1, 1_204]);
  assert.deepEqual([counts.added, counts.absent, counts.modified, counts.unchanged], [[], [], [], []]);

  const modifiedRows = [];
  let unchangedCount = 0;
  const callbacks = compareFinals(previous, current, "2026-10-22T00:00:00Z", {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
    onModified: (row) => modifiedRows.push(row),
    onUnchanged: (row) => {
      unchangedCount += 1;
      assert.deepEqual(row.changes, []);
    },
  });
  assert.deepEqual([callbacks.modifiedDeviceCount, unchangedCount], [1, 1_204]);
  assert.deepEqual(modifiedRows.map(({ identity, changes }) => [identity, changes.map(({ field, oldValue, newValue }) => [field, oldValue, newValue])]), [
    ["id:device-1204", [["model", "Stable", "Updated"]]],
  ]);
});

test("Final persistence comparison skips unused critical and diagnostic detail arrays", () => {
  const previous = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { id: "ambiguous-a", deviceId: "shared", mac: "00:11:22:33:44:02" },
    { id: "ambiguous-b", deviceId: "shared", mac: "00:11:22:33:44:03" },
    { id: "conflicting-id", deviceId: "DEVICE-A", mac: "00:11:22:33:44:05" },
    { id: "conflicting-mac", mac: "00:11:22:33:44:06" },
  ];
  const current = [
    { id: "changed", mac: "00:11:22:33:44:01", ip: "10.0.0.2" },
    { id: "ambiguous-current", deviceId: "shared", mac: "00:11:22:33:44:04" },
    { id: "conflicting-id", deviceId: "DEVICE-A", mac: "00:11:22:33:44:06" },
  ];
  const full = compareFinals(previous, current, "2026-10-18T00:00:00Z");
  const persisted = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
  });
  assert.equal(full.critical.length, 1);
  assert.equal(full.ambiguous.length, 2);
  assert.equal(full.identityConflicts.length, 1);
  assert.deepEqual(persisted.added, full.added);
  assert.deepEqual(persisted.absent, full.absent);
  assert.deepEqual(persisted.modified, full.modified);
  assert.deepEqual(persisted.critical, []);
  assert.deepEqual(persisted.ambiguous, []);
  assert.deepEqual(persisted.identityConflicts, []);
  assert.deepEqual(persisted.ambiguous, []);
});

test("Final comparison plan releases its identity index before ambiguous detail pages are read", () => {
  const previous = [
    { id: "old-a", deviceId: "shared", mac: "00:11:22:33:44:02" },
    { id: "old-b", deviceId: "shared", mac: "00:11:22:33:44:03" },
  ];
  const after = { id: "new", deviceId: "shared", mac: "00:11:22:33:44:04" };
  const plan = createFinalComparisonEventPlan(previous, [after], "2026-10-22T00:00:00Z");
  Object.defineProperty(after, "deviceId", { configurable: true, get() { throw new Error("Identity index was queried again"); } });

  const [event] = plan.events("ambiguous");
  assert.deepEqual(event.item.candidates.map(({ id }) => id), ["old-a", "old-b"]);
  assert.equal(event.item.after, after);
  assert.equal(plan.ambiguousCount, 1);
});

test("count-only comparison counts ambiguous identities without building diagnostic candidate rows", () => {
  const previous = [];
  const current = [];
  const mac = (prefix, index) => `${prefix}:${(index >> 8 & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`;
  for (let index = 0; index < 300; index += 1) {
    const deviceId = `shared-${index}`;
    previous.push(
      { id: `old-a-${index}`, deviceId, mac: mac("00:00:00:00", index) },
      { id: `old-b-${index}`, deviceId, mac: mac("00:01:00:00", index) },
    );
    current.push({ id: `new-${index}`, deviceId, mac: mac("00:02:00:00", index) });
  }
  const counts = compareFinals(previous, current, "2026-10-22T00:00:00Z", {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
  });
  assert.deepEqual([counts.ambiguousCount, counts.addedCount, counts.absentCount], [300, 0, 0]);
  assert.deepEqual([counts.ambiguous, counts.identityConflicts, counts.added, counts.absent], [[], [], [], []]);

  let diagnostic = null;
  compareFinals(previous.slice(0, 2), [current[0]], "2026-10-22T00:00:00Z", {
    includeDiagnosticRows: false,
    onAmbiguous: (item) => { diagnostic = item; },
  });
  assert.equal(diagnostic.reason, undefined);
  assert.equal(diagnostic.candidates.length, 2);
});

test("Final persistence streams exact history events without retaining comparison rows", () => {
  const previous = [
    { id: "modified", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { id: "absent", mac: "00:11:22:33:44:02", model: "Old" },
  ];
  const current = [
    { id: "modified", mac: "00:11:22:33:44:01", ip: "10.0.0.10" },
    { id: "added", mac: "00:11:22:33:44:03", model: "New" },
  ];
  const full = compareFinals(previous, current, "2026-10-18T00:00:00Z");
  const streamedEvents = { added: [], modified: [], absent: [] };
  const streamed = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
    collectRows: false,
    onAdded: (device) => streamedEvents.added.push(device),
    onModified: (row) => streamedEvents.modified.push(row),
    onAbsent: (device) => streamedEvents.absent.push(device),
  });
  assert.deepEqual(streamedEvents.added, full.added);
  assert.deepEqual(streamedEvents.modified, full.modified);
  assert.deepEqual(streamedEvents.absent, full.absent);
  assert.deepEqual([streamed.addedCount, streamed.absentCount, streamed.modifiedDeviceCount], [full.added.length, full.absent.length, full.modified.length]);
  assert.deepEqual([streamed.added, streamed.absent, streamed.modified, streamed.critical, streamed.ambiguous, streamed.identityConflicts], [[], [], [], [], [], []]);
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

test("Final History comparison stream matches the reference across chunks, ambiguity, conflicts, and absences", () => {
  const previous = [
    { id: "matched", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { id: "absent", mac: "00:11:22:33:44:02" },
    { id: "ambiguous-a", deviceId: "shared-device-id", mac: "00:11:22:33:44:03" },
    { id: "ambiguous-b", deviceId: "shared-device-id", mac: "00:11:22:33:44:04" },
    { id: "conflict-id", deviceId: "old-device-id", mac: "00:11:22:33:44:05" },
    { id: "conflict-alternative", deviceId: "new-device-id", mac: "00:11:22:33:44:06" },
  ];
  const current = [
    { id: "matched", mac: "00:11:22:33:44:01", ip: "10.0.0.9" },
    { id: "new", mac: "00:11:22:33:44:07" },
    { deviceId: "shared-device-id", mac: "00:11:22:33:44:08" },
    { id: "conflict-id", deviceId: "new-device-id", mac: "00:11:22:33:44:05" },
  ];
  const timestamp = "2026-10-19T12:00:00Z";
  const expected = [];
  compareFinals(previous, current, timestamp, {
    collectRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
    onAdded: (device) => expected.push({ type: "added", device }),
    onModified: (row) => expected.push({ type: "modified", row }),
    onAbsent: (device) => expected.push({ type: "absent", device }),
  });

  const actual = [];
  const stream = createFinalHistoryComparisonStream(previous, timestamp);
  stream.process(current.slice(0, 1), (event) => actual.push(event));
  stream.process(current.slice(1, 3), (event) => actual.push(event));
  stream.process(current.slice(3), (event) => actual.push(event));
  const diagnostics = stream.finish((event) => actual.push(event));
  assert.deepEqual(actual, expected);
  assert.deepEqual([diagnostics.ambiguousCount, diagnostics.identityConflictCount, diagnostics.diagnosticSamplesTruncated], [2, 1, 0]);
  assert.deepEqual(diagnostics.diagnosticSamples.map(({ type }) => type), ["ambiguous", "identity-conflict"]);
  assert.throws(() => stream.finish(), /уже завершён/);
  assert.throws(() => stream.process([]), /после завершения/);
});

test("Final History comparison diagnostics keep exact totals and a fixed-size identity sample", () => {
  const previous = [
    { id: "candidate-a", deviceId: "shared-device-id", mac: "00:11:22:33:44:01" },
    { id: "candidate-b", deviceId: "shared-device-id", mac: "00:11:22:33:44:02" },
  ];
  const current = Array.from({ length: 105 }, (_, index) => ({
    deviceId: "shared-device-id",
    mac: `00:11:22:33:45:${String(index).padStart(2, "0")}`,
  }));
  const stream = createFinalHistoryComparisonStream(previous);
  stream.process(current);
  const summary = stream.finish();
  assert.equal(summary.ambiguousCount, 105);
  assert.equal(summary.identityConflictCount, 0);
  assert.equal(summary.diagnosticSamples.length, 100);
  assert.equal(summary.diagnosticSamplesTruncated, 5);
});

test("Final History comparison streams indexed candidates and emits absences by baseline chunk", () => {
  const previous = [
    { id: "match-a", mac: "00:11:22:33:44:01", model: "Old model" },
    { id: "match-b", mac: "00:11:22:33:44:02", model: "Current model" },
    { id: "absent-a", mac: "00:11:22:33:44:03" },
    { id: "absent-b", mac: "00:11:22:33:44:04" },
  ];
  const current = [
    { id: "match-a", mac: "00:11:22:33:44:01", model: "New model" },
    { id: "match-b", mac: "00:11:22:33:44:02", model: "Current model" },
    { id: "added-a", mac: "00:11:22:33:44:05" },
  ];
  const timestamp = "2026-10-20T12:00:00.000Z";
  const expected = [];
  const reference = createFinalHistoryComparisonStream(previous, timestamp);
  reference.process(current, (event) => expected.push(event));
  const expectedDiagnostics = reference.finish((event) => expected.push(event));

  const positioned = createPositionedIdentityIndex(previous.length);
  const streamed = createFinalHistoryComparisonStream(positioned.devices, timestamp, { previousIdentityIndex: positioned });
  const actual = [];
  for (let offset = 0; offset < current.length; offset += 2) {
    const batch = current.slice(offset, offset + 2);
    const lookupKeys = new Set(batch.flatMap(identityLookupKeys));
    previous.forEach((device, position) => {
      if (identityLookupKeys(device).some((key) => lookupKeys.has(key))) positioned.addCandidate(position, device);
    });
    streamed.process(batch, (event) => actual.push(event));
    positioned.clearCandidates();
  }
  let diagnostics = null;
  for (let offset = 0; offset < previous.length; offset += 2) {
    const summary = streamed.finishChunk(previous.slice(offset, offset + 2), offset, (event) => actual.push(event));
    if (summary) diagnostics = summary;
  }

  assert.deepEqual(actual, expected);
  assert.deepEqual(diagnostics, expectedDiagnostics);
  assert.throws(() => streamed.finishChunk([], previous.length), /уже завершён/);
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
    source: "old-import.csv", mac: "—",
    payload: { mac_formatted: "00-11-22-33-44-55", room: "Room A", vendor: "Vendor A", ip: "192.0.2.8", switch_ip: "192.0.2.1" },
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

test("MAC timeline snapshot status index deduplicates only real first and absent observations", () => {
  const events = [
    { snapshotId: "final-first", status: "first" },
    { snapshotId: "final-absent", status: "absent" },
    { snapshotId: "history-only", status: "first", historyOnly: true },
    { snapshotId: "changed", status: "changed" },
  ];
  const index = createMacTimelineSnapshotStatusIndex(events);
  assert.equal(index.has("final-first", "first"), true);
  assert.equal(index.has("final-first", "absent"), false);
  assert.equal(index.has("final-absent", "absent"), true);
  assert.equal(index.has("history-only", "first"), false);
  assert.equal(index.has("changed", "changed"), false);
  assert.equal(index.has("", "first"), false);
  index.add("", "first");
  assert.equal(index.has("", "first"), true);
  index.add("host-final", "first");
  assert.equal(index.has("host-final", "first"), true);
  index.add("host-final", "changed");
  assert.equal(index.has("host-final", "changed"), false);
});

test("MAC timeline snapshot status index handles large event rosters without repeated scans", () => {
  const events = Array.from({ length: 50_000 }, (_, index) => ({
    snapshotId: `final-${index}`,
    status: index % 2 ? "absent" : "first",
  }));
  const index = createMacTimelineSnapshotStatusIndex(events);
  assert.equal(index.has("final-0", "first"), true);
  assert.equal(index.has("final-49999", "absent"), true);
  assert.equal(index.has("final-49999", "first"), false);
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

test("MAC timeline uses snapshot indexes for large unmatched history pages", () => {
  const snapshots = [{ id: "snapshot-1", name: "Current", createdAt: "2026-01-02T00:00:00Z" }];
  const events = [{ snapshotId: "snapshot-1", snapshotName: "Current", date: snapshots[0].createdAt, status: "first", after: { mac: "00:11:22:33:44:55" }, changes: [] }];
  const historyIndex = indexMacTimelineHistory(events, snapshots);
  const rejectLinearFind = (array) => new Proxy(array, {
    get(target, property) {
      if (property === "find") throw new Error("MAC history hot path must use its snapshot index");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const indexedEvents = rejectLinearFind(events);
  const indexedSnapshots = rejectLinearFind(snapshots);

  for (let id = 1; id <= 10_000; id += 1) {
    assert.equal(mergeMacTimelineHistoryEvent(indexedEvents, historyIndex, {
      id,
      snapshotId: "snapshot-1",
      mac: "00:11:22:33:44:55",
      type: "modified",
      field: "deviceName",
      oldValue: `Old ${id}`,
      newValue: `New ${id}`,
      timestamp: snapshots[0].createdAt,
      device: {
        mac: "00:11:22:33:44:55",
        room: "101",
        fieldSources: { room: "Main.csv" },
        ...(id === 1 ? { rawDebugPayload: Array.from({ length: 10_000 }, (_, index) => index) } : {}),
      },
    }, indexedSnapshots), true);
  }
  assert.equal(events.length, 10_001);
  assert.equal(events[10_000].changes[0].historyEventIds[0], "10000");
  assert.equal(events[1].after.room, "101");
  assert.deepEqual(events[1].after.fieldSources, { room: "Main.csv" });
  assert.equal(Object.hasOwn(events[1].after, "rawDebugPayload"), false);
});

test("incremental MAC timeline processes one Final at a time and keeps device context for unmatched history", () => {
  const mac = "00:11:22:33:44:55";
  const first = { id: "first", name: "First", createdAt: "2026-01-01T00:00:00Z" };
  const second = { id: "second", name: "Second", createdAt: "2026-01-02T00:00:00Z" };
  const device = { id: "device-1", mac, model: "Model A" };
  const timeline = createMacTimelineAccumulator(mac);
  timeline.addSnapshot(first, [device]);
  timeline.addSnapshot(second, [{ ...device, model: "Model B" }]);
  timeline.addHistory({
    id: 90, snapshotId: "second", deviceId: "device-1", mac,
    type: "modified", field: "deviceName", label: "Название устройства",
    oldValue: "Old", newValue: "New", timestamp: second.createdAt,
  }, [first, second]);
  const events = timeline.finish();
  assert.deepEqual(events.slice(0, 2).map((event) => event.status), ["first", "changed"]);
  assert.equal(events[2].historyOnly, true);
  assert.equal(events[2].after.model, "Model B");
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

test("MAC timeline finds canonical, packed, and legacy MAC identity fields", () => {
  const target = "00:11:22:33:44:55";
  const arrayDevice = { id: "array-device", mac: "AA:BB:CC:DD:EE:01", alternateMacs: ["0011.2233.4455"] };
  const packedDevice = { id: "packed-device", mac: "AA:BB:CC:DD:EE:02", alternateMacs: "00-11-22-33-44-54, 00:11:22:33:44:55" };
  assert.equal(deviceContainsNormalizedMac(arrayDevice, target), true);
  assert.equal(deviceContainsNormalizedMac(packedDevice, target), true);
  assert.equal(deviceContainsNormalizedMac({ macFormatted: "0011.2233.4455" }, target), true);
  assert.equal(deviceContainsNormalizedMac({ mac2: "00-11-22-33-44-55" }, target), true);
  assert.equal(deviceContainsNormalizedMac({ secondary_mac: target }, target), true);
  assert.equal(deviceContainsNormalizedMac({ additional_mac: target }, target), true);
  assert.equal(deviceContainsNormalizedMac({ mac: "AA:BB:CC:DD:EE:03", alternateMacs: "00:11:22:33:44:54" }, target), false);
  const events = buildMacTimeline(target, [{ id: "final-1", createdAt: "2026-10-21", devices: [packedDevice] }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].after.id, "packed-device");
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

test("critical comparison keeps exact high-cardinality rows without mapping and filtering all modified devices", () => {
  const previous = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    ip: `10.${index >> 16}.${index >> 8 & 255}.${index & 255}`,
    model: "Before",
  }));
  const current = previous.map((device, index) => ({
    ...device,
    ip: index % 10 === 0 ? `192.0.${index >> 8 & 255}.${index & 255}` : device.ip,
    model: "After",
  }));
  const result = compareFinals(previous, current);
  assert.equal(result.modified.length, previous.length);
  assert.equal(result.critical.length, 121);
  assert.deepEqual(result.critical.map(({ after, changes }) => [after.id, changes.map(({ field }) => field)]),
    previous.filter((_, index) => index % 10 === 0).map(({ id }) => [id, ["ip"]]));
  assert.equal(result.critical[0].before, previous[0]);
  assert.equal(result.critical[0].after, current[0]);
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

test("identity diagnostics are available in exact bounded pages across current chunks", async () => {
  const previous = [
    { id: "device-a", serial: "SER-A", mac: "00:11:22:33:44:01" },
    { id: "device-b", serial: "SER-B", mac: "00:11:22:33:44:02" },
    { id: "host-a", hostname: "shared-host" },
    { id: "host-b", hostname: "shared-host" },
  ];
  const current = [
    { id: "device-a", serial: "SER-B", mac: "00:11:22:33:44:01" },
    { hostname: "shared-host" },
  ];
  const visit = async (accept) => {
    await accept(current.slice(0, 1));
    await accept(current.slice(1));
  };
  const first = await compareFinalIdentityDiagnosticPage(previous, visit, { offset: 0, limit: 2 });
  const last = await compareFinalIdentityDiagnosticPage(previous, visit, { offset: 2, limit: 2 });

  assert.equal(first.total, 3);
  assert.equal(first.ambiguousCount, 2);
  assert.equal(first.identityConflictCount, 1);
  assert.equal(first.rows.length, 2);
  assert.equal(first.hasNext, true);
  assert.equal(last.rows.length, 1);
  assert.equal(last.total, 3);
  assert.equal(last.hasPrevious, true);
  assert.equal(last.hasNext, false);
  assert.deepEqual([...first.rows, ...last.rows].map(({ type }) => type).sort(), ["ambiguous", "ambiguous", "identityConflict"].sort());
});
