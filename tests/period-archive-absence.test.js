import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { mainMacAbsenceReport } from "../src/core/main-mac-absence.js";
import { selectArchiveSnapshotIds } from "../src/core/portable-archive.js";
import { Database } from "../src/data/database.js";
import { detectMapping, inspectPortableArchiveHeader, readPortableArchiveEvents } from "../src/data/importer.js";

const gone = "02:00:00:00:00:01";
const present = "02:00:00:00:00:02";
const details = { mac: gone, source: "Main", address: "Москва, Тестовый проезд, 12, этаж 3", room: "301", ip: "10.0.0.7", model: "Test" };

test("period archive exports a fixed set of Finals and mounting selected files preserves the active DB", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  const create = (id, date) => database.saveFinal({
    id, name: id, createdAt: date, devices: [{ ...details, id: "asset" }],
    comparisonEvents: (add) => add({ type: "added", deviceId: "asset", mac: gone, macKey: gone, timestamp: date }),
  });
  const live = () => database.listSnapshots({ finalOnly: true, catalogOnly: true });
  const file = async (ids, name) => new globalThis.File([await new globalThis.Response(database.exportSnapshotArchiveStream(ids)).blob()], name);
  const mount = async (archive) => {
    const header = await inspectPortableArchiveHeader(archive);
    return database.importArchiveEvents(header, readPortableArchiveEvents(archive), { analyticsPreviewName: archive.name });
  };
  await create("sept", "2026-09-15T12:00:00Z");
  await create("oct", "2026-10-15T12:00:00Z");
  const ids = selectArchiveSnapshotIds(await live(), new Set(), { to: "2026-09-30" });
  assert.deepEqual(ids, ["sept"]);
  const september = await file(ids, "September.madb.json");
  await database.markExternalSnapshotArchive(september.name, ids);
  const withoutSeptember = await database.analyticsSnapshotCatalog(await live());
  assert.deepEqual(withoutSeptember.snapshots.map(({ id }) => id), ["oct"]);
  const october = await file(selectArchiveSnapshotIds(await live(), withoutSeptember.archivedIds), "October.madb.json");
  await database.markExternalSnapshotArchive(october.name, ["oct"]);
  await create("nov", "2026-11-15T12:00:00Z");
  assert.deepEqual((await database.analyticsSnapshotCatalog(await live())).snapshots.map(({ id }) => id), ["nov"]);
  const first = await mount(september);
  const second = await mount(october);
  const one = await database.analyticsSnapshotCatalog(await live(), { selectedArchiveIds: [first.id] });
  assert.deepEqual(one.snapshots.map(({ id }) => id), ["sept", "nov"]);
  const both = await database.analyticsSnapshotCatalog(await live(), { selectedArchiveIds: [first.id, second.id, first.id] });
  assert.deepEqual(both.snapshots.map(({ id }) => id), ["sept", "oct", "nov"]);
  assert.equal(both.archiveCount, 2);
  database.setAnalyticsArchiveSources(both.sources);
  assert.equal((await database.loadSnapshotPage("sept")).devices[0].address, details.address);
  assert.equal((await database.historySearchPage({}, { scope: both })).total, 3);
  assert.equal((await database.activeSnapshotMetadata()).id, "nov");
  assert.equal((await live()).length, 3);
  assert.deepEqual((await database.listLocalArchivesPage()).rows.map(({ name }) => name).sort(), [october.name, september.name].sort());
  const original = JSON.parse(await september.text());
  assert.deepEqual(original.snapshots.map(({ id }) => id), ["sept"]);
  assert.deepEqual(original.history.map(({ snapshotId }) => snapshotId), ["sept"]);
});

test("absence requires five Main misses, ignores SmartRoom-only presence, and retains the latest known record", async () => {
  const snapshots = Array.from({ length: 8 }, (_, index) => ({ id: String(index), createdAt: `2026-11-0${index + 1}`, mainUniqueMacs: index < 3 ? 2 : 1 }));
  const visit = async (id, consume) => {
    const index = Number(id);
    consume([{ mac: present, source: "Main" }, { ...details, model: index === 2 ? "Latest" : "Old", source: index < 3 ? "Main" : "SmartRoom" }]);
  };
  const report = await mainMacAbsenceReport(snapshots, visit);
  assert.deepEqual(report.unknown, []);
  assert.equal(report.rows.length, 1);
  assert.deepEqual(
    [report.rows[0].mac, report.rows[0].snapshotId, report.rows[0].model, report.rows[0].address, report.rows[0].ip, report.rows[0].room, report.rows[0].missingSnapshots, report.rows[0].appearances],
    [gone, "2", "Latest", details.address, details.ip, "301", 5, 3],
  );
  assert.equal((await mainMacAbsenceReport(snapshots.slice(0, 7), visit)).rows.length, 0, "four misses are below threshold");
  const mismatch = await mainMacAbsenceReport(snapshots.map((row, index) => index === 7 ? { ...row, mainUniqueMacs: 3 } : row), visit);
  assert.equal(mismatch.rows.length, 0, "an incomplete recent Main cannot prove absence");
  assert.equal(mismatch.unknown[0].id, "7");
});

test("SmartRoom reserves the uniquely labelled location ID even when the sheet also contains a generic SmartRoom ID", () => {
  const headers = ["MAC", "SmartRoom ID", "Smartroom ID локации", "Device ID"];
  const result = detectMapping(headers, [[gone, "SR-GENERIC", "12345", "DEV-1"]], "smartroom");
  assert.equal(result.smartroomId, 2);
  assert.equal(result.deviceId, 3);
});
