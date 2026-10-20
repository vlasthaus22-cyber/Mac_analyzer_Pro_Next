import test from "node:test";
import assert from "node:assert/strict";
import { aggregateSnapshotHistory, buildAnalyticsPair } from "../src/core/analytics.js";
import { compactComparisonDevice, compactFinalDevice, compactFinalDevices, loadCompactSnapshot, loadPreviousSnapshotOrEmpty, trimComparisonBaseline, trimComparisonDeviceInPlace } from "../src/core/compact-final-analytics.js";
import { compareFinals } from "../src/core/comparison.js";
import { identityTokens } from "../src/core/identity.js";

test("compact Final comparison rows copy required identity, comparison and room context fields only", () => {
  const source = {
    id: "device-1", deviceId: "hardware-1", serial: "serial-1", mac: "00:11:22:33:44:55",
    alternateMacs: ["AA:BB:CC:DD:EE:FF"], room: "101", address: "Building A", manufacturer: "Acme",
    model: "Board X", ip: { value: "10.0.0.8" }, fieldSources: { model: "Main" }, possibleIps: ["10.0.0.1"],
    conflicts: [{ field: "model", value: "Unrelated" }], rawSpreadsheetRow: Array(1_000).fill("unused"),
  };
  const compact = compactFinalDevice(source);
  assert.equal(compact.id, source.id);
  assert.equal(compact.mac, source.mac);
  assert.equal(compact.room, source.room);
  assert.notEqual(compact.alternateMacs, source.alternateMacs);
  assert.notEqual(compact.fieldSources, source.fieldSources);
  assert.equal(Object.hasOwn(compact, "conflicts"), false);
  assert.equal(Object.hasOwn(compact, "rawSpreadsheetRow"), false);
  assert.deepEqual(source.rawSpreadsheetRow, Array(1_000).fill("unused"));
});

test("compact Previous Final loads validated chunks and preserves merge evidence", async () => {
  const chunks = [
    [{ id: "device-1", deviceId: "hardware-1", mac: "00:11:22:33:44:55", model: "Board X", fieldSources: { model: "Main" }, conflicts: [{ field: "ip", value: "10.0.0.2" }], conflictsTruncated: true }],
    [{ id: "device-2", serial: "serial-2", alternateMacs: ["AA:BB:CC:DD:EE:FF"], possibleIps: ["10.0.0.3"] }],
  ];
  const snapshot = await loadCompactSnapshot("snapshot-1", async (id, visit) => {
    assert.equal(id, "snapshot-1");
    for (const [index, chunk] of chunks.entries()) await visit(chunk, index, { id, chunkCount: chunks.length });
    return { id, deviceCount: 2, chunkCount: 2, createdAt: "2026-04-01T00:00:00Z" };
  });
  assert.equal(snapshot.deviceCount, 2);
  assert.equal(snapshot.devices.length, 2);
  assert.deepEqual(snapshot.devices[0].conflicts, chunks[0][0].conflicts);
  assert.equal(snapshot.devices[0].conflictsTruncated, true);
  assert.deepEqual(snapshot.devices[1].alternateMacs, chunks[1][0].alternateMacs);
});

test("missing active pointer means no baseline, while an unreadable active Final fails closed", async () => {
  let loadCalls = 0;
  assert.equal(await loadPreviousSnapshotOrEmpty("", async () => { loadCalls += 1; }), null);
  assert.equal(loadCalls, 0, "no active pointer must not invoke the snapshot loader");

  const failure = new Error("Повреждён чанк активного Final");
  await assert.rejects(
    loadPreviousSnapshotOrEmpty("active-final", async (id) => {
      loadCalls += 1;
      assert.equal(id, "active-final");
      throw failure;
    }),
    (error) => {
      assert.equal(error.message, failure.message);
      assert.equal(error.cause, failure, "the original read failure remains available for diagnosis");
      assert.equal(error.batchStage, "чтение предыдущего Final");
      return true;
    },
  );
  assert.equal(loadCalls, 1, "a present active pointer must be validated and its failure propagated");
});

test("compact Previous Final keeps identity, merge, provenance and conflict evidence", async () => {
  const previous = {
    id: "device-1", deviceId: "asset-1", serial: "serial-1", mac: "00:11:22:33:44:55",
    alternateMacs: ["AA:BB:CC:DD:EE:FF"], hostname: "desk-1", smartroomId: "room-id", ip: "10.0.0.4",
    switchIp: "10.0.0.1", switchPort: "Gi1/0/1", physicalAddress: "Building A", businessUnit: "IT",
    city: "Moscow", site: "HQ", floor: "2", room: "201", address: "North wing",
    manufacturer: "Acme", vendorConfidence: 0.95, vendorSource: "PyQt OUI history",
    model: "Board X", modelConfidence: 0.8, modelSource: "PyQt MAC5 history",
    deviceType: "Display", deviceName: "Screen",
    authenticationTime: "2026-01-01", possibleIps: ["10.0.0.5"], sources: ["Main"],
    customFields: { "custom_a": "Защита" }, customFieldSources: { "custom_a": "Main" },
    conflicts: [{ field: "model", value: "Other" }], alternateMacsTruncated: true,
    possibleIpsTruncated: true, conflictsTruncated: true,
    fieldSources: { manufacturer: "legacy.sqlite:oui_vendor_history", model: "legacy.sqlite:mac5_model_history" },
    source: "legacy.csv", vendor: "Unused vendor",
    historicalEvidence: { model: { snapshotId: "old" } }, rawSpreadsheetRow: ["unused"],
  };
  const compact = await loadCompactSnapshot("snapshot-1", async (id, visit) => {
    await visit([previous]);
    return { id, deviceCount: 1, chunkCount: 1 };
  });
  assert.deepEqual(compact.devices[0], {
    id: previous.id, deviceId: previous.deviceId, serial: previous.serial, mac: previous.mac,
    alternateMacs: previous.alternateMacs, hostname: previous.hostname, smartroomId: previous.smartroomId,
    ip: previous.ip, switchIp: previous.switchIp, switchPort: previous.switchPort,
    physicalAddress: previous.physicalAddress, businessUnit: previous.businessUnit, city: previous.city,
    site: previous.site, floor: previous.floor, room: previous.room, address: previous.address,
    manufacturer: previous.manufacturer, vendorConfidence: previous.vendorConfidence, vendorSource: previous.vendorSource,
    model: previous.model, modelConfidence: previous.modelConfidence, modelSource: previous.modelSource,
    deviceType: previous.deviceType,
    deviceName: previous.deviceName, authenticationTime: previous.authenticationTime,
    possibleIps: previous.possibleIps, fieldSources: previous.fieldSources,
    customFields: previous.customFields, customFieldSources: previous.customFieldSources,
    sources: previous.sources, conflicts: previous.conflicts,
    alternateMacsTruncated: true, possibleIpsTruncated: true, conflictsTruncated: true,
  });
  assert.equal(compact.devices[0].alternateMacs, previous.alternateMacs);
  assert.equal(compact.devices[0].possibleIps, previous.possibleIps);
  assert.equal(compact.devices[0].sources, previous.sources);
  assert.equal(compact.devices[0].conflicts, previous.conflicts);
  assert.equal(compact.devices[0].customFields, previous.customFields);
  assert.equal(compact.devices[0].customFieldSources, previous.customFieldSources);
  assert.equal(compact.devices[0].fieldSources, previous.fieldSources);
  assert.equal(Object.hasOwn(compact.devices[0], "historicalEvidence"), false);
  assert.equal(Object.hasOwn(compact.devices[0], "rawSpreadsheetRow"), false);
});

test("Previous Final compaction trims detached IndexedDB rows in place without allocating replacements", async () => {
  const stored = {
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
    customFields: { custom_a: "Комната" }, customFieldSources: { custom_a: "Main" },
    sources: ["Main"], conflicts: [{ field: "ip", value: "10.0.0.1" }],
    fieldSources: { model: "Main" }, rawSpreadsheetRow: Array(2_000).fill("unused"),
  };
  const detached = JSON.parse(JSON.stringify(stored));
  const snapshot = await loadCompactSnapshot("snapshot-1", async (id, visit) => {
    await visit([detached]);
    return { id, deviceCount: 1, chunkCount: 1 };
  }, { mutateDetachedChunks: true });
  assert.equal(snapshot.devices[0], detached);
  assert.equal(snapshot.devices[0].alternateMacs, detached.alternateMacs);
  assert.equal(snapshot.devices[0].customFields, detached.customFields);
  assert.equal(snapshot.devices[0].customFieldSources, detached.customFieldSources);
  assert.equal(snapshot.devices[0].fieldSources, detached.fieldSources);
  assert.equal(Object.hasOwn(detached, "rawSpreadsheetRow"), false);
  assert.equal(Object.hasOwn(stored, "rawSpreadsheetRow"), true);
});

test("history comparison retains only copied fields needed by the next Final", () => {
  const source = {
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
    room: "101", model: "Board X", ip: { value: "10.0.0.8" }, fieldSources: { model: "Main" },
    possibleIps: ["10.0.0.1"], conflicts: [{ field: "ip" }],
    rawSpreadsheetRow: Array(5_000).fill("unused"),
  };
  const compact = compactComparisonDevice(source);
  assert.deepEqual(compact, {
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
    room: "101", model: "Board X", ip: { value: "10.0.0.8" },
  });
  assert.equal(compact.alternateMacs, source.alternateMacs, "comparison projections share read-only alternate MAC arrays");
  assert.notEqual(compact.ip, source.ip, "unexpected object-valued fields remain isolated");
  assert.deepEqual(compact.ip, source.ip);
  assert.deepEqual(source.alternateMacs, ["AA:BB:CC:DD:EE:FF"], "projection must not mutate the source identity aliases");
  const compared = compareFinals([compact], [{
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:01"],
    room: "101", address: "Building A", manufacturer: "Acme", model: "Board X",
  }], "2026-10-19T00:00:00Z");
  assert.equal(compared.modified[0].changes[0].field, "alternateMacs");
  assert.deepEqual(source.alternateMacs, ["AA:BB:CC:DD:EE:FF"], "comparison must leave the shared alias array unchanged");
  assert.equal(Object.hasOwn(compact, "rawSpreadsheetRow"), false);
  assert.equal(Object.hasOwn(compact, "fieldSources"), false);
});

test("detached baseline chunks trim in place without copying alternate MAC arrays", () => {
  const alternateMacs = ["AA:BB:CC:DD:EE:FF"];
  const detached = {
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs,
    room: "101", model: "Board X", fieldSources: { model: "Main" },
    rawSpreadsheetRow: Array(5_000).fill("unused"),
  };
  const compact = trimComparisonDeviceInPlace(detached);
  assert.equal(compact, detached);
  assert.equal(compact.alternateMacs, alternateMacs);
  assert.deepEqual(compact, {
    id: "device-1", mac: "00:11:22:33:44:55", alternateMacs,
    room: "101", model: "Board X",
  });
});

test("comparison baseline drops empty markers without changing identity or comparison results", () => {
  const previous = {
    id: "device-1", deviceId: "—", serial: "неизвестно", mac: "00:11:22:33:44:55",
    alternateMacs: [], ip: "N/A", switchIp: null, room: "101", model: "—", manufacturer: "Acme",
    unused: "large source value",
  };
  const current = [{
    id: "device-1", mac: "00:11:22:33:44:55", ip: "", room: "101", model: "",
    manufacturer: "Acme",
  }];
  const beforeIdentity = identityTokens(previous).map(({ key }) => key);
  const beforeComparison = compareFinals([previous], current, "2026-10-18T00:00:00Z");
  const compact = { ...previous };
  trimComparisonDeviceInPlace(compact);
  const afterComparison = compareFinals([compact], current, "2026-10-18T00:00:00Z");

  assert.deepEqual(identityTokens(compact).map(({ key }) => key), beforeIdentity);
  for (const field of ["deviceId", "serial", "alternateMacs", "ip", "switchIp", "model", "unused"]) {
    assert.equal(Object.hasOwn(compact, field), false, `${field} should be omitted from the temporary baseline`);
  }
  assert.equal(beforeComparison.unchangedCount, afterComparison.unchangedCount);
  assert.equal(beforeComparison.modifiedDeviceCount, afterComparison.modifiedDeviceCount);
  assert.equal(beforeComparison.absentCount, afterComparison.absentCount);
});

test("streamed history comparison remains exact after the reader reuses a released chunk row", async () => {
  const reusable = { id: "device-1", mac: "00:11:22:33:44:55", model: "Old" };
  const result = await aggregateSnapshotHistory([
    { id: "one", name: "Final 1", createdAt: "2026-01-05T00:00:00Z", deviceCount: 1 },
    { id: "two", name: "Final 2", createdAt: "2026-01-12T00:00:00Z", deviceCount: 1 },
  ], async (snapshotId, visit) => {
    if (snapshotId === "one") {
      visit([reusable]);
      reusable.model = "New";
    } else visit([{ id: "device-1", mac: "00:11:22:33:44:55", model: "New" }]);
  });
  assert.equal(result.weekly.at(-1).modified, 1);
});

test("analytics from compact current and previous Finals matches full-pair results", () => {
  const previous = [
    { id: "device-1", mac: "00:11:22:33:44:55", room: "101", address: "Building A", model: "Board X", fieldSources: { model: "Main" } },
    { id: "device-2", mac: "AA:BB:CC:DD:EE:FF", room: "102", model: "Board Y" },
  ];
  const current = [
    { id: "device-1", mac: "00:11:22:33:44:55", room: "101", address: "Building B", model: "Board X" },
    { id: "device-3", mac: "11:22:33:44:55:66", room: "103", model: "Board Z" },
  ];
  const full = buildAnalyticsPair({ id: "old", devices: previous }, { id: "new", createdAt: "2026-04-02T00:00:00Z", devices: current });
  const compact = buildAnalyticsPair({ id: "old", devices: compactFinalDevices(previous) }, { id: "new", createdAt: "2026-04-02T00:00:00Z", devices: compactFinalDevices(current) });
  assert.deepEqual(compact.kpis, full.kpis);
  assert.deepEqual(compact.comparison.added.map(({ id }) => id), full.comparison.added.map(({ id }) => id));
  assert.deepEqual(compact.comparison.absent.map(({ id }) => id), full.comparison.absent.map(({ id }) => id));
  assert.deepEqual(compact.comparison.modified.map(({ identity, changes }) => ({ identity, changes })), full.comparison.modified.map(({ identity, changes }) => ({ identity, changes })));
  assert.equal(compact.roomChanges.find((room) => room.room === "101")?.allChanged, true);
});

test("comparison baseline releases provenance and auxiliary arrays after history backfill", () => {
  const baseline = [
    compactFinalDevice({
      id: "device-1", deviceId: "hw-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
      room: "101", address: "Building A", manufacturer: "Acme", model: "Board X", switchIp: "10.0.0.1",
      source: "main.csv", fieldSources: { model: "Main" }, historicalEvidence: { model: { snapshotId: "older" } },
      possibleIps: ["10.0.0.2", "10.0.0.3"], conflicts: [{ field: "ip" }],
    }),
  ];
  const originalArray = baseline;
  assert.equal(trimComparisonBaseline(baseline), originalArray);
  assert.deepEqual(baseline[0], {
    id: "device-1", deviceId: "hw-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
    room: "101", address: "Building A", manufacturer: "Acme", model: "Board X", switchIp: "10.0.0.1", source: "main.csv",
  });
});
