import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDevice, hasKnownRoom } from "../src/core/normalize.js";
import { enrich, mergeDevice } from "../src/core/enrichment.js";
import { detectMappingReport } from "../src/data/importer.js";
import { Database } from "../src/data/database.js";
import { aggregateSnapshotHistory, collectPresenceTransitions, createUniqueAnalyticsDeviceFilter } from "../src/core/analytics.js";
import { buildMacTimeline, createMacTimelineAccumulator } from "../src/core/comparison.js";
import { macTimelineContent, macTimelineCandidateRowsContent } from "../src/ui/render.js";
import { build as buildDataset, collectAnalyticsBuckets } from "../src/core/analytics-detail.js";

const mac = "00:11:22:33:44:55";
const fullAddress = "Москва, Кутузовский проспект, 32А, второй этаж";

test("returning MAC retains its previous snapshot and is not presented as a first-ever appearance", () => {
  const events = buildMacTimeline(mac, [
    { id: "one", name: "Первый", createdAt: "2026-11-01", devices: [{ id: "d", mac, model: "Before", address: fullAddress }] },
    { id: "two", name: "Второй", createdAt: "2026-11-02", devices: [] },
    { id: "three", name: "Третий", createdAt: "2026-11-03", devices: [{ id: "d", mac, model: "After", address: "Новый адрес" }] },
  ]);
  assert.equal(events[0].returned, undefined);
  assert.equal(events[1].status, "absent");
  assert.equal(events[2].returned, true);
  assert.equal(events[2].previousSnapshotId, "one");
  assert.equal(events[2].before.model, "Before");
  assert.equal(events[2].after.model, "After");
  assert.deepEqual(events[2].changes, [], "absence does not invent observed field-change events");
  const html = macTimelineContent(events);
  assert.ok(html.includes("Повторное появление после отсутствия"));
  assert.ok(html.includes(fullAddress));
});

test("SmartRoom preserves a four-part Moscow address and never uses the floor as the room", () => {
  for (const field of ["room", "locationPath"]) {
    const device = normalizeDevice({ mac, [field]: fullAddress }, "SmartRoom");
    assert.equal(device.address, fullAddress);
    assert.equal(device.locationPath, fullAddress);
    assert.equal(device.city, "Москва");
    assert.equal(device.businessUnit, "");
    assert.equal(device.floor, "второй этаж");
    assert.equal(device.room, "");
  }
  const device = normalizeDevice({ mac, address: fullAddress, room: "Переговорная 2" }, "SmartRoom");
  assert.equal(device.address, fullAddress);
  assert.equal(device.room, "Переговорная 2");
  const sitePath = "ЦА, Москва, Кутузовский 32А, 2, Переговорная";
  const siteDevice = normalizeDevice({ mac, room: sitePath }, "SmartRoom");
  assert.equal(siteDevice.address, sitePath);
  assert.equal(siteDevice.room, "Переговорная");
});

test("column detection preserves the address and keeps the floor and room separate", async () => {
  const headers = ["MAC", "Адрес локации", "Этаж", "Название комнаты"];
  const rows = [[mac, fullAddress, "второй этаж", "Переговорная 2"]];
  const { mapping } = detectMappingReport(headers, rows, "smartroom");
  assert.equal(mapping.address, 1);
  assert.equal(mapping.floor, 2);
  assert.equal(mapping.room, 3);
  const result = await enrich({ mainRows: [[mac]], smartroomRows: rows, mappings: { main: { mac: 0 }, smartroom: mapping } });
  assert.equal(result.devices[0].address, fullAddress);
  assert.equal(result.devices[0].room, "Переговорная 2");
});

test("SmartRoom can expand a known floor fragment but cannot replace a different full address", () => {
  const incoming = normalizeDevice({ mac, room: fullAddress }, "SmartRoom");
  const target = normalizeDevice({ mac, address: "второй этаж" }, "Main");
  mergeDevice(target, incoming, "SmartRoom");
  assert.equal(target.address, fullAddress);
  assert.equal(target.fieldSources.address, "SmartRoom");
  const different = normalizeDevice({ mac, address: "Москва, улица Ленина, 9" }, "Main");
  mergeDevice(different, incoming, "SmartRoom");
  assert.equal(different.address, "Москва, улица Ленина, 9");
  assert.ok(different.conflicts.some((item) => item.field === "address"));
});

test("Main roster counts each original MAC once and excludes SmartRoom-only devices", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  const second = "00:11:22:33:44:66";
  const result = await enrich({
    mainRows: [[mac, "D-1"], [mac, "D-1"], [second, "D-1"]],
    smartroomRows: [["00:11:22:33:44:77", "D-2"]],
    mappings: { main: { mac: 0, deviceId: 1 }, smartroom: { mac: 0, deviceId: 1 } },
    strategy: "ALLOW_EXPANSION",
  });
  await database.saveFinal({ id: "main", name: "Main", devices: result.devices, diagnostics: result.diagnostics });
  const page = await database.loadSnapshotMainMacPage("main", { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.devices.length, 1);
  const next = await database.loadSnapshotMainMacPage("main", { page: 2, limit: 1 });
  assert.notEqual(next.devices[0].mac, page.devices[0].mac);
  assert.equal(next.total, result.diagnostics.counts.mainUniqueMacs);
});

test("missing room means an empty Final room even when SmartRoom ID is present", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  const devices = [
    normalizeDevice({ id: "1", mac, smartroomId: "SR-1", address: fullAddress }),
    normalizeDevice({ id: "2", mac: "00:11:22:33:44:66", room: "Переговорная" }),
    normalizeDevice({ id: "3", mac: "00:11:22:33:44:77", address: fullAddress }),
  ];
  assert.equal(hasKnownRoom(devices[0]), false);
  assert.equal(hasKnownRoom({ room: "", room_name: "stale alias" }), false);
  await database.saveFinal({ id: "room-test", devices });
  const missing = await database.loadSnapshotUnassignedRoomPage("room-test");
  const dataset = buildDataset(devices);
  assert.equal(missing.total, 2);
  assert.deepEqual(missing.devices.map(({ id }) => id), ["1", "3"]);
  assert.equal(dataset.roomOccupancy.unassignedDevices, missing.total);
});

test("duplicate MAC rows use one shared roster for chart and missing-room vendor counts", async () => {
  const rows = [
    { id: "a", mac, manufacturer: "Vendor" },
    { id: "conflict", mac, manufacturer: "Vendor" },
  ];
  const unique = rows.filter(createUniqueAnalyticsDeviceFilter());
  const buckets = collectAnalyticsBuckets(unique);
  assert.equal(unique.length, 1);
  assert.equal(buckets["unassigned-vendor"][0].count, 1);
  assert.equal(buildDataset(unique).roomOccupancy.unassignedDevices, 1);
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  await database.saveFinal({ id: "duplicate-missing", devices: rows });
  assert.equal((await database.loadSnapshotUnassignedRoomPage("duplicate-missing")).total, 1);
});

test("SmartRoom maps all nine requested columns without substituting room IDs for device IDs", () => {
  const headers = ["MAC-адрес", "IP-адрес", "Адрес помещения", "Серийный номер", "Тип устройства", "Модель", "Производитель", "Device ID", "ID помещения"];
  const rows = [[mac, "192.168.1.5", fullAddress, "SN-123", "Кодек", "DX80", "Cisco", "DEV-1", "ROOM-1"]];
  const { mapping } = detectMappingReport(headers, rows, "smartroom");
  assert.deepEqual(mapping, { mac: 0, model: 5, ip: 1, smartroomId: 8, manufacturer: 6, serial: 3, deviceType: 4, deviceId: 7, address: 2 });
});

test("12000 Main MACs remain the only final roster while SmartRoom fills rooms", async () => {
  const macAt = (index) => "02:11:" + index.toString(16).padStart(8, "0").match(/../g).join(":");
  const mainRows = Array.from({ length: 12000 }, (_, index) => [macAt(index)]);
  const smartroomRows = Array.from({ length: 15000 }, (_, index) => [macAt(index), fullAddress, index < 10000 ? "ROOM-" + index % 100 : "UNASSIGNED-" + index, index < 10000 ? "Комната " + index % 100 : ""]);
  const result = await enrich({ mainRows, smartroomRows, mappings: { main: { mac: 0 }, smartroom: { mac: 0, address: 1, smartroomId: 2, room: 3 } }, strategy: "NO_EXPANSION" });
  assert.equal(result.diagnostics.counts.mainUniqueMacs, 12000);
  assert.equal(result.devices.length, 12000);
  assert.equal(new Set(result.devices.map((device) => device.mac)).size, 12000);
  const summary = buildDataset(result.devices);
  assert.equal(summary.summary.devices, 12000);
  assert.equal(summary.roomOccupancy.unassignedDevices, 2000);
  assert.equal(summary.roomOccupancy.assignedDevices, 10000);
});

test("paged chronology counts ambiguous sources and appearances without discarding candidate evidence", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  const queryId = "mac-timeline:" + crypto.randomUUID();
  const key = "00000000000000001:0000000000000001";
  const event = { snapshotId: "s1", snapshotName: "First source", date: "2026-11-01", status: "ambiguous", candidateCount: 2, candidates: [{ id: "a", mac }, { id: "b", mac }] };
  await database.appendMacTimelinePage(queryId, [{ key, event }]);
  const summary = await database.macTimelineSummary(queryId, { appearanceCount: 1 });
  assert.equal(summary.sourceCount, 1);
  const page = await database.macTimelinePage(queryId, { page: 1, limit: 12 });
  assert.equal(page.rows[0].candidates.length, 2);
});

test("churn detail retains the last known source and before/after location in one result", async () => {
  const snapshots = ["one", "two", "three"].map((id, index) => ({ id, name: id, createdAt: "2026-11-0" + (index + 1) }));
  const rows = {
    one: [{ mac, model: "Before", address: fullAddress, switchIp: "10.0.0.1" }],
    two: [],
    three: [{ mac, model: "After", address: "Москва, улица Ленина, 9", switchIp: "10.0.0.2" }],
  };
  const result = await collectPresenceTransitions(mac, snapshots, (id, visit) => visit(rows[id]));
  assert.equal(result.length, 2);
  assert.equal(result[0].lastSeen.snapshotId, "one");
  assert.equal(result[0].before.address, fullAddress);
  assert.equal(result[1].after.model, "After");
  assert.equal(result[1].before.switchIp, "10.0.0.1");
  assert.equal(result[1].after.switchIp, "10.0.0.2");
});

test("ambiguous MAC history retains bounded visible candidates with their full address", () => {
  const accumulator = createMacTimelineAccumulator(mac);
  const candidates = [
    { id: "a", mac, model: "A", address: fullAddress },
    { id: "b", mac, model: "B", address: "Other address" },
  ];
  accumulator.addSnapshot({ id: "s", name: "Main file", createdAt: "2026-11-01" }, candidates, { matchCount: 20, candidatesInScratch: true });
  assert.equal(accumulator.events[0].candidateCount, 20);
  assert.equal(accumulator.events[0].candidates.length, 2);
  const content = macTimelineContent(accumulator.events);
  assert.ok(content.includes("Main file"));
  assert.ok(content.includes(fullAddress));
  assert.ok(macTimelineCandidateRowsContent(candidates).html.includes("Other address"));
});

test("restored archives join chronological analytics exactly once and preserve the active snapshot", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  await database.saveFinal({ id: "old", name: "Older", createdAt: "2026-11-01", devices: [{ id: "d", mac, room: "Old" }] });
  const archive = await database.createLocalArchive("Older data");
  await database.saveFinal({ id: "new", name: "Newer", createdAt: "2026-11-02", devices: [{ id: "d", mac, room: "New" }] });
  const db = await database.open();
  const tx = db.transaction(["snapshots", "snapshotChunks"], "readwrite");
  tx.objectStore("snapshots").delete("old");
  tx.objectStore("snapshotChunks").delete(["old", 0]);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  assert.equal((await database.restoreLocalArchivesForAnalytics()).archiveCount, 1);
  assert.equal((await database.activeSnapshotMetadata()).id, "new");
  assert.deepEqual((await database.listSnapshots({ finalOnly: true })).map((row) => row.id), ["old", "new"]);
  await database.restoreLocalArchivesForAnalytics();
  assert.equal((await database.listSnapshots({ finalOnly: true })).length, 2);
  assert.equal((await database.listLocalArchivesPage()).rows[0].id, archive.id);
  const analytics = await aggregateSnapshotHistory(await database.listSnapshots({ finalOnly: true }), (id, visit) => database.forEachSnapshotChunk(id, visit));
  assert.deepEqual(analytics.totals.map((row) => row.value), [1, 1]);
  assert.equal(analytics.history.snapshots, 2);
  assert.equal(analytics.history.selectedSnapshotUniqueMacs, 1, "archived snapshot must not inflate the current device count");
  assert.equal(analytics.weekly.reduce((sum, row) => sum + row.modified, 0), 1, "the room change must include the restored archive evidence");
});

