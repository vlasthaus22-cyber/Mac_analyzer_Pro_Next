import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Database, databaseNameFromSearch, sanitizeArrayRangeForDatabase, sanitizeForDatabase } from "../src/data/database.js";
import { enrich } from "../src/core/enrichment.js";
import { backfillComparisonDevices } from "../src/core/history-enrichment.js";
import { buildMacTimeline, compareFinalAbsencePage, compareFinalAdditionPage, compareFinalIdentityDiagnosticPage, compareFinalModifiedDevicePage, compareFinalModificationDeviceGroupPage, compareFinalModificationEventPage, compareFinalUnchangedPage, compareFinals, createFinalHistoryComparisonStream } from "../src/core/comparison.js";
import { buildIdentityIndex, findIdentityMatch, packAlternateMacsInPlace } from "../src/core/identity.js";
import { matchesDeviceSearch } from "../src/core/search.js";
import { TableTsvCollector } from "../src/core/table-actions.js";
import { analyzeRoomSwitchAnomalies, snapshotHistorySignature } from "../src/core/analytics.js";
import { compactComparisonDevice, compactFinalDevices, finalAnalyticsIndexSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, trimComparisonDeviceInPlace } from "../src/core/compact-final-analytics.js";
import { compareSwitchIpHistory } from "../src/core/historical-mapping.js";
import { locationKey, normalizeIp } from "../src/core/normalize.js";
import { build as buildDatasetAnalytics, createCollector as createDatasetAnalyticsCollector } from "../src/core/analytics-detail.js";
import { TemporalStatisticsAccumulator } from "../src/core/temporal-statistics.js";
import { inspectPortableArchiveHeader, readPortableArchiveEvents } from "../src/data/importer.js";
import { PORTABLE_ARCHIVE_RECORD_COLLECTIONS } from "../src/core/portable-archive.js";
import { captureWorkspaceState } from "../src/core/workspace-state.js";
import { legacyAnalyticsDashboardSettings } from "../src/core/analytics-dashboard-settings.js";
import { feedAnalyticsDatasetRows, runAnalyticsInStages } from "../src/core/analytics-lifecycle.js";
import { SINGLE_ANALYSIS_SNAPSHOT_TYPE } from "../src/core/snapshot-kind.js";

async function readArchive(database) {
  return new globalThis.Response(database.exportArchiveStream()).json();
}

test("range database sanitizer matches a sliced array while sharing the same byte and node limits", () => {
  const circular = { name: "cycle" };
  circular.self = circular;
  const records = [
    { id: "skip-0" },
    { id: "range-1", when: new Date("2026-01-01T00:00:00Z"), nested: ["ok", undefined, () => {}], devices: [{ id: "embedded" }] },
    { id: "range-2", circular },
    { id: "skip-3" },
  ];
  const options = { dropEmbeddedSnapshotRows: true };
  assert.deepEqual(sanitizeArrayRangeForDatabase(records, 1, 3, options), sanitizeForDatabase(records.slice(1, 3), options));
  assert.throws(() => sanitizeArrayRangeForDatabase(records, 0, 3, { maxNodes: 2 }), (error) => error.code === "DATABASE_RECORD_LIMIT");
  assert.throws(() => sanitizeArrayRangeForDatabase(records, -1, 2), /Некорректный диапазон/);
});

async function readInventory(database) {
  const rows = [];
  await database.forEachInventory((device) => rows.push(device));
  return rows;
}

test("staged Final device pages can be replaced transactionally for bounded enrichment", async () => {
  const database = new Database(`final-device-stage-replace-${crypto.randomUUID()}`);
  const stageId = `final-device-stage:${crypto.randomUUID()}`;
  try {
    await database.appendFinalDeviceStageChunk(stageId, [
      { id: "stage-one", mac: "00:11:22:33:44:01", room: "" },
      { id: "stage-two", mac: "00:11:22:33:44:02", room: "" },
    ], { offset: 0, total: 2 });
    const page = await database.finalDeviceStagePage(stageId, { offset: 0, limit: 2 });
    page[0].room = "Room 1";
    await database.replaceFinalDeviceStagePage(stageId, { offset: 0, devices: page });
    assert.deepEqual(await database.finalDeviceStagePage(stageId, { offset: 0, limit: 2 }), [
      { id: "stage-one", mac: "00:11:22:33:44:01", room: "Room 1" },
      { id: "stage-two", mac: "00:11:22:33:44:02", room: "" },
    ]);
    await assert.rejects(database.replaceFinalDeviceStagePage(stageId, { offset: 2, devices: [{ id: "out-of-range" }] }));
  } finally {
    await database.clearAnalyticsAggregateQuery(stageId);
    (await database.open()).close();
  }
});

test("snapshot History iterator reads bounded pages for one Final from a stable high-water mark", async () => {
  const database = new Database(`snapshot-history-pages-${globalThis.crypto.randomUUID()}`);
  const eventCount = 1001;
  await database.saveFinal({
    id: "history-copy-final",
    createdAt: "2026-10-21T10:00:00Z",
    devices: [],
    comparisonEvents(add) {
      for (let index = 0; index < eventCount; index += 1) {
        add({
          type: "modified", deviceId: `history-device-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
          field: "room", oldValue: "101", newValue: "202", timestamp: "2026-10-21T10:00:00Z",
        });
      }
    },
  });
  await database.saveFinal({
    id: "history-copy-other-final",
    createdAt: "2026-10-21T10:01:00Z",
    devices: [],
    comparisonEvents(add) {
      add({ type: "added", deviceId: "other-device", mac: "00:11:22:33:44:55", timestamp: "2026-10-21T10:01:00Z" });
    },
  });

  const pageSizes = [];
  const seenIds = new Set();
  for await (const page of database.iterateSnapshotHistoryEvents("history-copy-final", { pageSize: 250 })) {
    pageSizes.push(page.length);
    for (const event of page) {
      assert.equal(event.snapshotId, "history-copy-final");
      assert.equal(seenIds.has(event.id), false);
      seenIds.add(event.id);
    }
    assert.ok(page.length <= 250);
  }
  assert.deepEqual(pageSizes, [250, 250, 250, 250, 1]);
  assert.equal(seenIds.size, eventCount);
});

test("Inventory iterator pages by cursor and excludes IDs added after its high-water mark", async () => {
  const database = new Database(`inventory-pages-${globalThis.crypto.randomUUID()}`);
  const idb = await database.open();
  const tx = idb.transaction("inventory", "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Inventory seed transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("Inventory seed transaction failed"));
  });
  const store = tx.objectStore("inventory");
  for (let index = 0; index < 501; index += 1) store.add({ id: `inventory-${String(index).padStart(4, "0")}`, observationCount: index + 1 });
  await done;

  const iterator = database.iterateInventoryPages({ pageSize: 250 });
  const first = await iterator.next();
  assert.equal(first.value.length, 250);
  const lateTx = idb.transaction("inventory", "readwrite");
  const lateDone = new Promise((resolve, reject) => {
    lateTx.oncomplete = resolve;
    lateTx.onabort = () => reject(lateTx.error || new Error("Late Inventory transaction aborted"));
    lateTx.onerror = () => reject(lateTx.error || new Error("Late Inventory transaction failed"));
  });
  lateTx.objectStore("inventory").add({ id: "inventory-zzzz-late", observationCount: 1 });
  await lateDone;

  const seen = first.value.map(({ id }) => id);
  const sizes = [first.value.length];
  for await (const page of iterator) {
    sizes.push(page.length);
    seen.push(...page.map(({ id }) => id));
  }
  assert.deepEqual(sizes, [250, 250, 1]);
  assert.equal(seen.length, 501);
  assert.equal(new Set(seen).size, 501);
  assert.equal(seen.includes("inventory-zzzz-late"), false);
});

test("every IndexedDB store has an explicit portable, local-archive, origin-bound, or rebuildable policy", async () => {
  const database = new Database(`portable-store-policy-${globalThis.crypto.randomUUID()}`);
  const idb = await database.open();
  try {
    const portableSpecialStores = ["snapshots", "snapshotChunks", "originalFiles"];
    const separatelyPortableLocalArchiveStores = ["archives", "archiveRecords"];
    const transientStores = ["legacyObservationImportIds"];
    const originBoundStores = ["fileHandles"];
    const rebuildableStores = [
      "analyticsCache", "finalAnalytics", "finalAnalyticsMetadata",
      "legacyObservationQueryScratch", "legacyVendorModelPrefixCounts",
    ];
    const classified = [
      ...PORTABLE_ARCHIVE_RECORD_COLLECTIONS,
      ...portableSpecialStores,
      ...separatelyPortableLocalArchiveStores,
      ...transientStores,
      ...originBoundStores,
      ...rebuildableStores,
    ].sort();
    const actual = Array.from(idb.objectStoreNames).sort();

    assert.deepEqual(classified, actual, "a new persistent store must be assigned an explicit transfer policy");
    assert.ok(PORTABLE_ARCHIVE_RECORD_COLLECTIONS.includes("legacyObservations"));
    assert.ok(PORTABLE_ARCHIVE_RECORD_COLLECTIONS.includes("dataQualityReports"));
    assert.ok(PORTABLE_ARCHIVE_RECORD_COLLECTIONS.includes("legacySmartroomRoomMappings"));
  } finally {
    idb.close();
  }
});

async function readStore(database, name) {
  const db = await database.open();
  const tx = db.transaction(name, "readonly");
  const rows = await new Promise((resolve, reject) => {
    const request = tx.objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
  return rows;
}

test("setting batches commit together and reject duplicate keys before writing", async () => {
  const database = new Database(`setting-batch-${crypto.randomUUID()}`);
  await database.setSettings([
    { key: "theme", value: "dark" },
    { key: "enrichmentStrategy", value: "ALLOW_EXPANSION" },
  ]);
  assert.equal(await database.getSetting("theme"), "dark");
  assert.equal(await database.getSetting("enrichmentStrategy"), "ALLOW_EXPANSION");
  await assert.rejects(database.setSettings([
    { key: "theme", value: "light" }, { key: "theme", value: "dark" },
  ]), /повторяющиеся ключи/);
  assert.equal(await database.getSetting("theme"), "dark");
  database.connection?.close();
  database.connection = null;
});

test("deleting one setting preserves unrelated settings", async () => {
  const database = new Database(`setting-delete-${crypto.randomUUID()}`);
  await database.setSettings([
    { key: "workspaceState", value: { view: "analytics" } },
    { key: "theme", value: "dark" },
  ]);
  assert.equal(await database.deleteSetting("workspaceState"), true);
  assert.equal(await database.getSetting("workspaceState", null), null);
  assert.equal(await database.getSetting("theme"), "dark");
  await assert.rejects(database.deleteSetting(""), /нужен ключ/);
  database.connection?.close();
  database.connection = null;
});

test("compact workspace resume state survives reopening a disposable IndexedDB", async () => {
  const name = `workspace-state-reopen-${crypto.randomUUID()}`;
  const options = { views: ["search", "analytics"], sortFields: ["mac", "room"], pageSizes: [50, 100, 250] };
  const value = captureWorkspaceState({ view: "analytics", search: "00:11", page: 3, pageSize: 100, sort: { field: "room", direction: -1 }, files: [{ rows: ["excluded"] }] }, options.views, options.sortFields, options.pageSizes);
  const first = new Database(name);
  await first.setSetting("workspaceState", value);
  first.connection?.close();
  first.connection = null;

  const reopened = new Database(name);
  assert.deepEqual(await reopened.getSetting("workspaceState"), value);
  reopened.connection?.close();
  reopened.connection = null;
});

test("trimming a detached Final chunk for comparison does not mutate stored snapshot rows", async () => {
  const database = new Database(`comparison-detached-chunk-${crypto.randomUUID()}`);
  const snapshotId = `comparison-detached-${crypto.randomUUID()}`;
  await database.saveFinal({
    id: snapshotId,
    devices: [{
      id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
      room: "101", model: "Board X", rawSpreadsheetRow: ["large", "unused"],
    }],
  });
  await database.forEachSnapshotChunk(snapshotId, (chunk) => trimComparisonDeviceInPlace(chunk[0]));
  const persisted = [];
  await database.forEachSnapshotChunk(snapshotId, (chunk) => persisted.push(...chunk));
  assert.equal(persisted[0].rawSpreadsheetRow[0], "large");
  assert.deepEqual(persisted[0].alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
  database.connection?.close();
  database.connection = null;
});

test("switch-IP report scratch pages every diagnostic row with exact totals and cleans up by query", async () => {
  const database = new Database(`switch-ip-report-pages-${crypto.randomUUID()}`);
  const queryId = `switch-ip-report:${Date.now()}:${crypto.randomUUID()}`;
  const changes = Array.from({ length: 251 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:33:${String(Math.floor(index / 256)).padStart(2, "0")}:${String(index % 256).padStart(2, "0")}`,
    previousIp: "10.0.0.1",
    currentIp: "10.0.0.2",
  }));
  await database.appendSwitchIpReportChanges(queryId, changes.slice(0, 128), { offset: 0 });
  await database.appendSwitchIpReportChanges(queryId, changes.slice(128), { offset: 128 });

  const firstPage = await database.switchIpReportChangesPage(queryId, { limit: 100 });
  const secondPage = await database.switchIpReportChangesPage(queryId, { offset: 137, limit: 100 });
  const lastPage = await database.switchIpReportChangesPage(queryId, { offset: 999, limit: 100 });
  assert.equal(firstPage.total, 251);
  assert.equal(firstPage.rows.length, 100);
  assert.equal(firstPage.rows[0].id, "device-0");
  assert.equal(secondPage.offset, 100);
  assert.equal(secondPage.rows.length, 100);
  assert.equal(secondPage.rows[0].id, "device-100");
  assert.equal(lastPage.offset, 200);
  assert.equal(lastPage.rows.length, 51);
  assert.equal(lastPage.rows.at(-1).id, "device-250");
  assert.equal(lastPage.hasNext, false);

  const archive = await readArchive(database);
  assert.equal(Object.hasOwn(archive, "legacyObservationQueryScratch"), false);
  await database.clearExpiredAnalyticsAggregateQueries("switch-ip-report:", Date.now() + 1);
  assert.equal((await database.switchIpReportChangesPage(queryId)).total, 0);
  database.connection?.close();
  database.connection = null;
});

test("failed Final commit leaves the previous active snapshot intact and clears staged switch-IP report rows", async () => {
  const database = new Database(`switch-ip-report-abort-${crypto.randomUUID()}`);
  const previous = await database.saveFinal({ id: "switch-report-before", devices: [{ id: "device-before", mac: "00:11:22:33:44:01" }] });
  const queryId = `switch-ip-report:${Date.now()}:${crypto.randomUUID()}`;
  await database.appendSwitchIpReportChanges(queryId, [{ id: "device-before", previousIp: "10.0.0.1", currentIp: "10.0.0.2" }]);

  await assert.rejects(database.saveFinal({
    id: "switch-report-after",
    devices: [{ id: "device-after", mac: "00:11:22:33:44:02" }],
    comparisonEvents() { throw new Error("injected comparison failure"); },
  }), /injected comparison failure/);
  await database.clearAnalyticsAggregateQuery(queryId);

  assert.equal((await database.activeSnapshotMetadata()).id, previous.id);
  assert.equal((await readStore(database, "snapshots")).some(({ id }) => id === "switch-report-after"), false);
  assert.equal((await database.switchIpReportChangesPage(queryId)).total, 0);
  database.connection?.close();
  database.connection = null;
});

test("legacy autosaves page by settings cursor and activation accepts only an existing Final", async () => {
  const database = new Database(`legacy-autosave-restore-${crypto.randomUUID()}`);
  const current = await database.saveFinal({ id: "legacy-autosave-current", devices: [{ id: "current-device", mac: "00:11:22:33:44:55" }] });
  const imported = await database.saveFinal({ id: "legacy-autosave-imported", devices: [{ id: "imported-device", mac: "00:11:22:33:44:66" }], activate: false, updateInventory: false });
  await database.setSettings([
    { key: "legacyAutosave:main", value: { state: "{}", snapshotId: imported.id } },
    { key: "legacyAutosave:nightly", value: { state: "{}", snapshotId: imported.id } },
    { key: "legacyAutosave:weekend", value: { state: "{}", snapshotId: imported.id } },
  ]);

  const firstPage = await database.legacyAutosavePage({ limit: 1 });
  assert.equal(firstPage.rows.length, 1);
  assert.equal(firstPage.rows[0].key, "legacyAutosave:main");
  assert.equal("state" in firstPage.rows[0].value, false);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextCursor, "legacyAutosave:main");
  const secondPage = await database.legacyAutosavePage({ limit: 1, after: firstPage.nextCursor });
  assert.deepEqual(secondPage.rows.map(({ key }) => key), ["legacyAutosave:nightly"]);
  assert.equal(secondPage.hasMore, true);
  assert.equal(secondPage.nextCursor, "legacyAutosave:nightly");
  const finalPage = await database.legacyAutosavePage({ limit: 1, after: secondPage.nextCursor });
  assert.deepEqual(finalPage.rows.map(({ key }) => key), ["legacyAutosave:weekend"]);
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.nextCursor, null);
  await assert.rejects(database.legacyAutosavePage({ after: "activeSnapshotId" }), /Некорректный курсор/);
  assert.deepEqual(await database.legacyAutosavePage({ limit: 100 }).then(({ rows }) => rows.map(({ key }) => key)), ["legacyAutosave:main", "legacyAutosave:nightly", "legacyAutosave:weekend"]);
  await assert.rejects(database.activateSnapshot("missing-final"), /Final для активации не найден/);
  assert.equal((await database.activeSnapshotMetadata()).id, current.id);
  assert.equal((await database.activateSnapshot(imported.id)).id, imported.id);
  assert.equal((await database.activeSnapshotMetadata()).id, imported.id);
  assert.deepEqual(new Set((await database.listSnapshots()).map(({ id }) => id)), new Set([current.id, imported.id]));
});

test("legacy autosave state reads one bounded record and rejects invalid slots or oversized content", async () => {
  const database = new Database(`legacy-autosave-state-${crypto.randomUUID()}`);
  await database.setSetting("legacyAutosave:restore", { state: JSON.stringify({ theme: "dark" }), reason: "manual" });
  assert.deepEqual(JSON.parse(await database.legacyAutosaveState("legacyAutosave:restore")), { theme: "dark" });
  await assert.rejects(database.legacyAutosaveState("activeSnapshotId"), /Некорректный слот/);
  await database.setSetting("legacyAutosave:large", { state: "x".repeat(1025) });
  await assert.rejects(database.legacyAutosaveState("legacyAutosave:large", { maxBytes: 1024 }), /допустимого размера/);
  await database.setSetting("legacyAutosave:utf8-large", { state: "я".repeat(600) });
  await assert.rejects(database.legacyAutosaveState("legacyAutosave:utf8-large", { maxBytes: 1024 }), /допустимого размера/);
  await assert.rejects(database.legacyAutosaveState("legacyAutosave:missing"), /не содержит состояния/);
  database.connection?.close();
  database.connection = null;
});

test("snapshot UI summaries are read by cursor without retaining diagnostic payloads", async () => {
  const database = new Database(`snapshot-summary-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "snapshot-summary-final",
    name: "Summary test",
    createdAt: "2026-10-18T00:00:00Z",
    devices: [],
    diagnostics: { invalidRows: Array.from({ length: 100 }, (_, index) => ({ row: index + 1, reason: "invalid" })) },
  });
  const summary = await database.listSnapshots({ includeDiagnostics: false });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, "snapshot-summary-final");
  assert.equal(Object.hasOwn(summary[0], "diagnostics"), false);
  const complete = await database.listSnapshots();
  assert.equal(complete[0].diagnostics.invalidRows.length, 100);
  database.connection?.close();
  database.connection = null;
});

test("snapshot metadata uses a canonical ascending timestamp and ID order", async () => {
  const database = new Database(`snapshot-metadata-order-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "z-same-time", createdAt: "2026-10-18T00:00:00Z", devices: [] });
  await database.saveFinal({ id: "a-same-time", createdAt: "2026-10-18T00:00:00Z", devices: [] });
  await database.saveFinal({ id: "older", createdAt: "2026-10-17T00:00:00Z", devices: [] });
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["older", "a-same-time", "z-same-time"]);
  database.connection?.close();
  database.connection = null;
});

test("quality reports persist by Final, list in reverse time order, and transfer additively", async () => {
  const source = new Database(`quality-archive-${crypto.randomUUID()}`);
  const snapshot = { id: "quality-final", name: "Final quality", devices: [] };
  await source.saveFinal(snapshot);
  const first = await source.saveDataQualityReport(snapshot, { score: 92, grade: "A", summary: { devices: 12 }, issues: [], recommendations: [] });
  const second = await source.saveDataQualityReport(snapshot, { score: 70, grade: "C", summary: { devices: 12 }, issues: [], recommendations: [] });
  const reports = await source.listDataQualityReports({ limit: 2, snapshotId: snapshot.id });
  assert.equal(reports.length, 2);
  assert.ok(reports.some((item) => item.id === second.id));
  assert.equal((await source.listDataQualityReports({ limit: 20, snapshotId: "missing" })).length, 0);
  const archive = await readArchive(source);
  assert.equal(archive.dataQualityReports.length, 2);
  const destination = new Database(`quality-restore-${crypto.randomUUID()}`);
  await destination.importArchive(archive);
  assert.ok((await destination.listSnapshots()).some((item) => item.id === snapshot.id));
  const restored = await destination.listDataQualityReports();
  assert.deepEqual(new Set(restored.map((item) => item.id)), new Set([first.id, second.id]));
  await destination.importArchive(archive);
  assert.equal((await destination.listDataQualityReports()).length, 2, "archive re-import must not duplicate stable report IDs");
});

test("quality report history pages every stored report with exact totals and bounded rows", async () => {
  const database = new Database(`quality-report-pages-${crypto.randomUUID()}`);
  const snapshotId = "quality-pages-final";
  const db = await database.open();
  const tx = db.transaction("dataQualityReports", "readwrite");
  const store = tx.objectStore("dataQualityReports");
  for (let index = 0; index < 205; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    store.add({ id: `quality-report-${String(index).padStart(3, "0")}`, snapshotId, snapshotName: "Quality pages", createdAt, score: 90, grade: "A", report: { summary: { devices: index } } });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const first = await database.dataQualityReportsPage({ limit: 100, snapshotId });
  const second = await database.dataQualityReportsPage({ offset: 100, limit: 100, snapshotId });
  const third = await database.dataQualityReportsPage({ offset: 200, limit: 100, snapshotId });
  assert.equal(first.total, 205);
  assert.equal(first.rows.length, 100);
  assert.equal(first.rows[0].id, "quality-report-204");
  assert.equal(first.rows.at(-1).id, "quality-report-105");
  assert.equal(first.hasPrevious, false);
  assert.equal(first.hasNext, true);
  assert.equal(second.offset, 100);
  assert.equal(second.rows.length, 100);
  assert.equal(second.rows[0].id, "quality-report-104");
  assert.equal(second.hasPrevious, true);
  assert.equal(second.hasNext, true);
  assert.equal(third.offset, 200);
  assert.equal(third.rows.length, 5);
  assert.equal(third.rows.at(-1).id, "quality-report-000");
  assert.equal(third.hasPrevious, true);
  assert.equal(third.hasNext, false);
  const staleOffset = await database.dataQualityReportsPage({ offset: 900, limit: 100, snapshotId });
  assert.equal(staleOffset.offset, 200);
  assert.equal(staleOffset.rows.length, 5);
  assert.equal(staleOffset.rows[0].id, "quality-report-004");
  assert.equal(staleOffset.hasPrevious, true);
  assert.equal(staleOffset.hasNext, false);
  assert.equal((await database.dataQualityReportsPage({ snapshotId: "missing" })).total, 0);
  database.connection?.close();
  database.connection = null;
});

test("legacy Smartroom mappings are indexed by exact normalized ID and survive additive archive transfer", async () => {
  const source = new Database(`legacy-smartroom-map-${crypto.randomUUID()}`);
  const mapping = {
    id: "sr-map-1\u0000SR-MAP-1", smartroomId: "SR-MAP-1", smartroomIdKey: "sr-map-1", room: "Meeting Room",
    source: "manual", updatedAt: "2026-10-15T12:00:00.000Z",
  };
  await source.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacySmartroomRoomMappings: [mapping] });
  assert.deepEqual(await source.legacySmartroomRoomMappingsForIds([" sr-map-1 ", "SR-UNKNOWN"]), [mapping]);
  const archive = await readArchive(source);
  assert.deepEqual(archive.legacySmartroomRoomMappings, [mapping]);
  const target = new Database(`legacy-smartroom-restore-${crypto.randomUUID()}`);
  await target.importArchive(archive);
  await target.importArchive(archive);
  assert.deepEqual(await target.legacySmartroomRoomMappingsForIds(["SR-MAP-1"]), [mapping]);
});

test("Smartroom mapping lookup reads only requested normalized IDs", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("smartroomRoomMappings", "readwrite");
  const store = tx.objectStore("smartroomRoomMappings");
  store.put({ smartroomIdKey: "sr-query-a", smartroomId: "SR-QUERY-A", room: "Room A" });
  store.put({ smartroomIdKey: "sr-query-b", smartroomId: "SR-QUERY-B", room: "Room B" });
  store.put({ smartroomIdKey: "sr-unrelated", smartroomId: "SR-UNRELATED", room: "Other" });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const originalGetAll = globalThis.IDBObjectStore.prototype.getAll;
  globalThis.IDBObjectStore.prototype.getAll = function forbiddenGetAll() { throw new Error("Smartroom ID lookup must not scan the full store"); };
  let rows;
  try {
    rows = await database.smartroomRoomMappingsForIds([" SR-QUERY-A ", "sr-query-b", "SR-QUERY-A", "", null]);
    assert.equal((await database.smartroomRoomMappingsForIds([])).length, 0);
  } finally {
    globalThis.IDBObjectStore.prototype.getAll = originalGetAll;
  }
  assert.deepEqual(rows.map((row) => row.smartroomId).sort(), ["SR-QUERY-A", "SR-QUERY-B"]);

  const bulkTx = db.transaction("smartroomRoomMappings", "readwrite");
  for (let index = 0; index < 275; index += 1) {
    const id = `sr-batch-${String(index).padStart(3, "0")}`;
    bulkTx.objectStore("smartroomRoomMappings").put({ smartroomIdKey: id, smartroomId: id, room: `Room ${index}` });
  }
  await new Promise((resolve, reject) => { bulkTx.oncomplete = resolve; bulkTx.onabort = () => reject(bulkTx.error); bulkTx.onerror = () => reject(bulkTx.error); });
  const bulkRows = await database.smartroomRoomMappingsForIds(Array.from({ length: 275 }, (_, index) => `SR-BATCH-${String(index).padStart(3, "0")}`));
  assert.equal(bulkRows.length, 275);
});

test("legacy observations are searchable by kind or MAC in bounded timestamp pages", async () => {
  const database = new Database(`legacy-observations-${crypto.randomUUID()}`);
  await database.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, (async function* () {
    yield { type: "records", collection: "legacyObservations", records: [
      { id: "mac-a1", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-14T10:00:00.000Z", mac: "00:11:22:33:44:55", payload: { room: "A" } },
      { id: "mac-a2", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T10:00:00.000Z", mac: "00:11:22:33:44:55", payload: { room: "B" } },
      { id: "vendor-b1", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T11:00:00.000Z", mac: "00:11:22:33:44:66", payload: { model: "X" } },
      { id: "app-log-c1", kind: "app_logs", sourceTable: "app_logs", observedAt: "2026-10-15T12:00:00.000Z", mac: "", payload: { action: "Save final state" } },
    ] };
  })());
  const first = await database.legacyObservationPage({ kind: "mac_history", limit: 1 });
  assert.deepEqual(first.rows.map(({ id }) => id), ["mac-a2"]);
  assert.equal(first.hasMore, true);
  const second = await database.legacyObservationPage({ kind: "mac_history", cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.rows.map(({ id }) => id), ["mac-a1"]);
  assert.equal(second.hasMore, false);
  const byMac = await database.legacyObservationPage({ mac: "00-11-22-33-44-66", limit: 5 });
  assert.deepEqual(byMac.rows.map(({ id }) => id), ["vendor-b1"]);
  const appLogs = await database.legacyObservationPage({ kind: "app_logs", limit: 5 });
  assert.deepEqual(appLogs.rows.map(({ payload }) => payload.action), ["Save final state"]);
  await assert.rejects(database.legacyObservationPage({}), /укажите таблицу или MAC/);
  await assert.rejects(
    database.legacyObservationPage({ kind: "mac_history", cursor: { key: ["other-kind", "2026-10-15T10:00:00.000Z", "mac-a2"], id: "mac-a2" } }),
    /Некорректный курсор legacy-наблюдений/,
  );
});

test("streamed portable archive import restores legacy observations and quality reports", async () => {
  const source = new Database(`portable-legacy-source-${crypto.randomUUID()}`);
  const target = new Database(`portable-legacy-target-${crypto.randomUUID()}`);
  const snapshot = { id: "portable-final", name: "Portable Final", devices: [] };
  await source.saveFinal(snapshot);
  await source.saveDataQualityReport(snapshot, { score: 92, grade: "A", summary: { devices: 0 }, issues: [], recommendations: [] });
  await source.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    { id: "portable-observation", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T10:00:00Z", mac: "00:11:22:33:44:55", payload: { room: "Room 1" } },
  ] });
  const blob = await new globalThis.Response(source.exportArchiveStream()).blob();
  const file = { size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  await target.importArchiveEvents(header, readPortableArchiveEvents(file));
  assert.deepEqual((await target.legacyObservationPage({ kind: "mac_history" })).rows.map(({ id }) => id), ["portable-observation"]);
  assert.deepEqual((await target.dataQualityReportsPage({ snapshotId: "portable-final" })).rows.map(({ score, grade }) => ({ score, grade })), [
    { score: 92, grade: "A" },
  ]);
});

test("legacy observation search filters and counts the full result while paging and deletes selected rows atomically", async () => {
  const database = new Database(`legacy-observation-search-${crypto.randomUUID()}`);
  const records = [
    { id: "vendor-1", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-01T10:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", model: "Router X", source_file: "october.xlsx" } },
    { id: "vendor-2", kind: "vendor_model_history", sourceTable: "vendor_model_history", source: "Imported SQLite", observedAt: "2026-10-02T10:00:00Z", mac: "00:11:22:33:44:66", payload: { vendor: "Acme", model: "Router Y", source_file: "october.xlsx" } },
    { id: "vendor-3", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-03T10:00:00Z", mac: "AA:BB:CC:DD:EE:FF", payload: { vendor: "Other", model: "Switch", source_file: "other.csv" } },
    { id: "mac-history", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-02T12:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", room: "Room 12", source_file: "october.xlsx" } },
    { id: "resolved-history", kind: "resolved_device_history", sourceTable: "resolved_device_history", observedAt: "2026-10-04T10:00:00Z", mac: "AA:BB:CC:DD:EE:11", payload: { decodedPayload: { vendor: "Nested Vendor", model: "Nested Model", room: "Lab A", source_file: "resolved.json" } } },
  ];
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: records });
  const filters = { source: "OCTOBER", vendor: "acme", from: "2026-10-01", to: "2026-10-02" };
  await assert.rejects(database.legacyObservationSearchPage({ from: "2026-02-31" }), /Дата фильтра не существует/);
  await assert.rejects(database.legacyObservationSearchPage({ dateTo: "2026-13-01" }), /Дата фильтра не существует/);
  assert.equal((await database.legacyObservationSearchPage({ from: "0001-01-01", to: "0001-01-31" })).total, 0);
  assert.equal((await database.legacyObservationSearchPage({ from: "2024-02-29", to: "2024-02-29" })).total, 0);
  assert.equal((await database.legacyObservationSearchPage({ from: "2026-10-01", to: "2026-10-02" })).total, 3);
  const first = await database.legacyObservationSearchPage(filters, { limit: 1 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.byKind, {
    mac_history: 1, resolved_device_history: 0, vendor_model_history: 2, app_logs: 0, scheduled_tasks: 0, task_file_queue: 0,
    history_loads: 0, analysis_history: 0, performance_metrics: 0, daily_stats: 0, exports: 0,
  });
  assert.deepEqual(first.summary, { uniqueMacs: 2, vendors: 1, models: 2, rooms: 1, sources: 1 });
  assert.deepEqual(first.rows.map(({ id }) => id), ["mac-history"]);
  assert.equal(first.hasMore, true);
  const second = await database.legacyObservationSearchPage(filters, { cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.rows.map(({ id }) => id), ["vendor-2"]);
  assert.equal(second.total, 3);
  assert.equal((await database.legacyObservationSearchPage({ source: "sqlite" })).total, 1);
  const nested = await database.legacyObservationSearchPage({ kind: "resolved_device_history", vendor: "nested", room: "lab" });
  assert.equal(nested.total, 1);
  assert.deepEqual(nested.summary, { uniqueMacs: 1, vendors: 1, models: 1, rooms: 1, sources: 1 });

  assert.equal(await database.deleteLegacyObservations(["vendor-1", "vendor-1", "missing"]), 1);
  assert.equal((await database.legacyObservationPage({ kind: "vendor_model_history" })).rows.length, 2);
  const prefix = await database.legacyVendorModelSuggestionsForMacs(["00:11:22:33:44:99"]);
  assert.equal(prefix.get("00:11:22:33:44:99").model, "Router Y");
  await assert.rejects(database.deleteLegacyObservationsByFilters({}), /задайте хотя бы один фильтр/);
  assert.equal(await database.deleteLegacyObservationsByFilters({ source: "other.csv" }), 1);
  assert.equal((await database.legacyObservationSearchPage({ source: "other.csv" })).total, 0);
  await assert.rejects(database.deleteLegacyObservations([17]), /Некорректный ID/);
});

test("legacy observation distinct summaries use unique-key adds without scratch lookups", async () => {
  const database = new Database(`legacy-observation-summary-add-${crypto.randomUUID()}`);
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    { id: "summary-a", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-01T10:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", model: "Router", room: "Lab", source_file: "same.db" } },
    { id: "summary-b", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-02T10:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", model: "Router", room: "Lab", source_file: "same.db" } },
  ] });
  const originalGet = globalThis.IDBObjectStore.prototype.get;
  let scratchReads = 0;
  globalThis.IDBObjectStore.prototype.get = function (...args) {
    if (this.name === "legacyObservationQueryScratch") scratchReads += 1;
    return originalGet.apply(this, args);
  };
  try {
    const page = await database.legacyObservationSearchPage({ kind: "mac_history" });
    assert.equal(page.total, 2);
    assert.deepEqual(page.summary, { uniqueMacs: 1, vendors: 1, models: 1, rooms: 1, sources: 1 });
    assert.equal(scratchReads, 0);
  } finally {
    globalThis.IDBObjectStore.prototype.get = originalGet;
  }
});

test("legacy observation summary LRU skips repeated scratch writes without changing exact totals", async () => {
  const database = new Database(`legacy-observation-summary-cache-${crypto.randomUUID()}`);
  const shared = { vendor: "Acme", model: "Router", room: "Lab", source_file: "same.db" };
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    { id: "cache-a", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-01T10:00:00Z", mac: "00:11:22:33:44:55", payload: shared },
    { id: "cache-b", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-02T10:00:00Z", mac: "00:11:22:33:44:55", payload: shared },
  ] });
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalAdd = prototype.add;
  let scratchAdds = 0;
  prototype.add = function (...args) {
    if (this.name === "legacyObservationQueryScratch") scratchAdds += 1;
    return originalAdd.apply(this, args);
  };
  let page;
  try {
    page = await database.legacyObservationSearchPage({ kind: "mac_history" });
  } finally {
    prototype.add = originalAdd;
  }
  assert.equal(page.total, 2);
  assert.deepEqual(page.summary, { uniqueMacs: 1, vendors: 1, models: 1, rooms: 1, sources: 1 });
  assert.equal(scratchAdds, 5, "the second identical observation reuses five bounded cached keys");
});

test("clearing imported legacy load history deletes only history_loads observations", async () => {
  const database = new Database(`legacy-load-clear-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "keep-final", name: "Keep Final", devices: [] });
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    { id: "load-1", kind: "history_loads", sourceTable: "history_loads", observedAt: "2026-10-01T00:00:00Z", payload: { filename: "one.xlsx" } },
    { id: "load-2", kind: "history_loads", sourceTable: "history_loads", observedAt: "2026-10-02T00:00:00Z", payload: { filename: "two.xlsx" } },
    { id: "vendor-keep", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-03T00:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", model: "Router" } },
  ] });
  assert.equal(await database.deleteLegacyObservations(["load-2"]), 1);
  assert.deepEqual((await database.legacyObservationPage({ kind: "history_loads" })).rows.map(({ id }) => id), ["load-1"]);
  assert.equal(await database.deleteLegacyObservationsByFilters({ kind: "history_loads" }), 1);
  assert.equal((await database.legacyObservationPage({ kind: "history_loads" })).rows.length, 0);
  assert.deepEqual((await database.legacyObservationPage({ kind: "vendor_model_history" })).rows.map(({ id }) => id), ["vendor-keep"]);
  assert.equal((await database.listSnapshots()).some(({ id }) => id === "keep-final"), true);
});

test("filter deletion removes the full weighted vendor/model prefix evidence", async () => {
  const database = new Database(`legacy-prefix-filter-delete-${crypto.randomUUID()}`);
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    {
      id: "weighted-vendor-history",
      kind: "vendor_model_history",
      sourceTable: "vendor_model_history",
      observedAt: "2026-10-01T00:00:00Z",
      mac: "00:11:22:33:44:55",
      payload: { vendor: "Acme Networks", times_seen: 4, legacySourceTable: "mac_vendor_history", source_file: "legacy-4.xlsx" },
    },
    {
      id: "weighted-vendor-history-2",
      kind: "vendor_model_history",
      sourceTable: "vendor_model_history",
      observedAt: "2026-10-02T00:00:00Z",
      mac: "00:11:22:44:55:66",
      payload: { vendor: "Acme Networks", times_seen: 9, legacySourceTable: "mac_vendor_history", source_file: "legacy-9.xlsx" },
    },
  ] });

  const inferredBeforeDelete = await database.legacyVendorModelSuggestionsForMacs(
    ["00:11:22:AA:BB:CC"], { useMac5Match: false, useOuiMatch: true },
  );
  assert.equal(inferredBeforeDelete.get("00:11:22:AA:BB:CC").vendor, "Acme Networks");
  assert.equal(inferredBeforeDelete.get("00:11:22:AA:BB:CC").matches, 13);

  assert.equal(await database.deleteLegacyObservationsByFilters({ kind: "vendor_model_history", source: "legacy-4.xlsx" }), 1);
  const inferredAfterFirstDelete = await database.legacyVendorModelSuggestionsForMacs(
    ["00:11:22:AA:BB:CC"], { useMac5Match: false, useOuiMatch: true },
  );
  assert.equal(inferredAfterFirstDelete.get("00:11:22:AA:BB:CC").matches, 9);

  assert.equal(await database.deleteLegacyObservationsByFilters({ kind: "vendor_model_history", source: "legacy-9.xlsx" }), 1);
  const inferredAfterDelete = await database.legacyVendorModelSuggestionsForMacs(
    ["00:11:22:AA:BB:CC"], { useMac5Match: false, useOuiMatch: true },
  );
  assert.equal(inferredAfterDelete.has("00:11:22:AA:BB:CC"), false);
});

test("legacy task records are searchable, portable and deletable without entering device history", async () => {
  const database = new Database(`legacy-task-records-${crypto.randomUUID()}`);
  const records = [
    { id: "task-record", kind: "scheduled_tasks", sourceTable: "scheduled_tasks", observedAt: "2026-10-14T09:00:00Z", mac: "", payload: { id: "task-1", name: "Nightly", enabled: true, intervalMinutes: 60 } },
    { id: "queue-record", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-15T09:00:00Z", mac: "", payload: { id: "queue-record", taskId: "task-1", filename: "main.xlsx", status: "pending", contentBase64: "Ynl0ZXM=", contentAvailable: true, contentRetainedInSourceDatabase: true } },
    { id: "queue-record-2", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-15T09:15:00Z", mac: "", payload: { id: "queue-record-2", taskId: "task-1", filename: "second.csv", status: "error", contentAvailable: false } },
    { id: "queue-other-task", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-15T09:30:00Z", mac: "", payload: { id: "queue-other-task", taskId: "task-2", filename: "other.csv", status: "pending", contentBase64: "b3RoZXI=", contentAvailable: true } },
    { id: "queue-complete", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-15T10:00:00Z", mac: "", payload: { id: "queue-complete", taskId: "task-1", filename: "done.csv", status: "done", contentAvailable: false } },
  ];
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: records });
  const page = await database.legacyObservationSearchPage({ kind: "task_file_queue" });
  assert.equal(page.total, 4);
  assert.equal(page.byKind.task_file_queue, 4);
  const displayedQueueFile = page.rows.find(({ id }) => id === "queue-record");
  assert.equal(displayedQueueFile.payload.filename, "main.xlsx");
  assert.equal(Object.hasOwn(displayedQueueFile.payload, "contentBase64"), false);
  assert.equal((await database.legacyTaskQueueFileContent("queue-record")).contentBase64, "Ynl0ZXM=");
  const task = await database.legacyScheduledTask("task-record");
  assert.equal(task.payload.name, "Nightly");
  const queuePage = await database.legacyTaskQueuePage("task-1", { limit: 1 });
  assert.deepEqual(queuePage.rows.map(({ id }) => id), ["queue-record"]);
  assert.equal(queuePage.hasMore, true);
  const secondQueuePage = await database.legacyTaskQueuePage("task-1", { after: queuePage.nextCursor, limit: 1 });
  assert.deepEqual(secondQueuePage.rows.map(({ id }) => id), ["queue-record-2"]);
  assert.equal(secondQueuePage.hasMore, false);
  await assert.rejects(
    database.legacyTaskQueuePage("task-1", { after: { key: ["scheduled_tasks", "2026-10-15T09:00:00Z", "queue-record"] } }),
    /Некорректный курсор очереди файлов/,
  );
  const kindPage = await database.legacyObservationPage({ kind: "task_file_queue", limit: 10 });
  assert.equal(Object.hasOwn(kindPage.rows.find(({ id }) => id === "queue-record").payload, "contentBase64"), false);
  assert.equal(await database.updateLegacyTaskQueueFile("queue-record", { status: "running", startedAt: "2026-10-16T10:00:00Z" }), true);
  assert.deepEqual((await database.legacyTaskQueuePage("task-1")).rows.map(({ id }) => id), ["queue-record", "queue-record-2"]);
  assert.equal(await database.updateLegacyTaskQueueFile("queue-record", { status: "done", finishedAt: "2026-10-16T10:01:00Z", result: { valid: 2 } }), true);
  assert.equal((await database.legacyTaskQueueFileContent("queue-record")).status, "done");
  assert.equal(await database.updateLegacyScheduledTaskRun("task-record", "2026-10-16T10:00:00Z", "2026-10-16T11:00:00Z"), true);
  assert.equal((await database.legacyScheduledTask("task-record")).payload.nextRunAt, "2026-10-16T11:00:00Z");
  await assert.rejects(database.updateLegacyScheduledTaskRun("task-record", "2026-02-31T10:00:00Z", "2026-03-01T11:00:00Z"), /Некорректное время запуска расписания/);
  assert.equal((await database.legacyScheduledTask("task-record")).payload.nextRunAt, "2026-10-16T11:00:00Z");
  assert.equal(await database.updateLegacyScheduledTaskEnabled("task-record", false), true);
  assert.equal((await database.legacyScheduledTask("task-record")).payload.enabled, false);
  assert.equal(await database.updateLegacyScheduledTaskEnabled("missing-task", true), false);
  assert.equal(await database.deleteLegacyObservations(["queue-record"]), 1);
  assert.equal((await database.legacyObservationSearchPage({ kind: "scheduled_tasks" })).rows[0].payload.name, "Nightly");
  assert.equal(await database.deleteLegacyObservations(["task-record"]), 3);
  assert.deepEqual((await database.legacyObservationSearchPage({ kind: "task_file_queue" })).rows.map(({ id }) => id), ["queue-other-task"]);
  await database.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: [
    { id: "task-filter", kind: "scheduled_tasks", sourceTable: "scheduled_tasks", observedAt: "2026-10-13T09:00:00Z", mac: "", payload: { id: "task-filter-id", name: "Filtered", enabled: false } },
    { id: "queue-filter", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-13T09:15:00Z", mac: "", payload: { id: "queue-filter", taskId: "task-filter-id", filename: "filter.csv", status: "pending" } },
  ] });
  assert.equal(await database.deleteLegacyObservationsByFilters({ kind: "scheduled_tasks", source: "" }), 2);
  assert.equal((await database.legacyObservationSearchPage({ kind: "task_file_queue" })).total, 1);
  const timeline = await database.legacyObservationPage({ mac: "00:11:22:33:44:55" });
  assert.equal(timeline.rows.length, 0);
});

test("local legacy schedules retain small queue files as Blobs and archive portable content", async () => {
  const database = new Database(`legacy-local-queue-${crypto.randomUUID()}`);
  const task = await database.createLegacyScheduledTask({ name: "Daily import", intervalMinutes: 90 });
  assert.equal(task.kind, "scheduled_tasks");
  assert.equal(task.payload.name, "Daily import");
  assert.equal(task.payload.intervalMinutes, 90);
  assert.ok(Date.parse(task.payload.nextRunAt) > Date.now());
  await assert.rejects(database.createLegacyScheduledTask({ name: "", intervalMinutes: 1 }), /Некорректные параметры/);

  const bytes = Uint8Array.from({ length: 100_003 }, (_, index) => index % 251);
  const file = new globalThis.File([bytes], "daily.csv", { type: "text/csv" });
  const overLimit = { name: "too-large.csv", size: 64 * 1024 * 1024 + 1, slice() { throw new Error("over-limit file must not be read"); } };
  const added = await database.appendLegacyTaskQueueFiles(task.id, [file, new globalThis.File([], "empty.csv"), overLimit]);
  assert.equal(added.queued, 1);
  assert.deepEqual(added.invalid, ["empty.csv", "too-large.csv"]);
  const queue = await database.legacyObservationSearchPage({ kind: "task_file_queue" });
  assert.equal(queue.total, 1);
  assert.equal(queue.rows[0].payload.contentBase64, undefined, "journal pages must not materialize large file bytes");
  const stored = await database.legacyTaskQueueFileContent(queue.rows[0].id);
  assert.equal(stored.contentAvailable, false);
  assert.equal(stored.contentBase64Chars, 0);
  assert.equal(stored.contentRetainedLocally, true);
  const local = await database.legacyTaskQueueLocalFile(queue.rows[0].id);
  assert.equal(local.blob.size, bytes.byteLength);
  assert.deepEqual(new Uint8Array(await local.blob.arrayBuffer()), bytes);
  const portable = await readArchive(database);
  const archivedObservation = portable.legacyObservations.find(({ id }) => id === queue.rows[0].id);
  assert.equal(archivedObservation.payload.contentBase64, undefined);
  assert.equal(archivedObservation.payload.contentRetainedLocally, undefined);
  const archivedFile = portable.legacyTaskQueueFiles.find(({ id }) => id === queue.rows[0].id);
  assert.equal(archivedFile.size, bytes.byteLength);
  assert.equal(archivedFile.chunks.length, 1);
  assert.deepEqual(
    Uint8Array.from(globalThis.atob(archivedFile.chunks[0]), (char) => char.charCodeAt(0)),
    bytes,
  );
  const restored = new Database(`legacy-local-queue-restore-${crypto.randomUUID()}`);
  await restored.importArchive(portable);
  const restoredQueue = await restored.legacyTaskQueueFileContent(queue.rows[0].id);
  assert.equal(restoredQueue.contentAvailable, false);
  const restoredLocal = await restored.legacyTaskQueueLocalFile(queue.rows[0].id);
  assert.deepEqual(new Uint8Array(await restoredLocal.blob.arrayBuffer()), bytes);
});

test("portable archive streams legacy inline queue files larger than the JSON cell limit", async () => {
  const database = new Database(`legacy-inline-queue-large-${crypto.randomUUID()}`);
  const task = await database.createLegacyScheduledTask({ name: "Legacy inline archive", intervalMinutes: 60 });
  const queueId = `legacy-inline-${crypto.randomUUID()}`;
  const contentBase64 = "QUFB".repeat(1_100_000);
  const expectedSize = contentBase64.length / 4 * 3;
  const db = await database.open();
  const tx = db.transaction("legacyObservations", "readwrite");
  tx.objectStore("legacyObservations").put({
    id: queueId,
    kind: "task_file_queue",
    sourceTable: "task_file_queue",
    observedAt: new Date().toISOString(),
    mac: "",
    internalDeviceId: "",
    payload: { id: queueId, taskId: task.payload.id, filename: "legacy-large.csv", type: "text/csv", status: "pending", contentBase64, contentAvailable: true },
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });

  const archiveFile = await new globalThis.Response(database.exportArchiveStream()).blob();
  const header = await inspectPortableArchiveHeader(archiveFile);
  const restored = new Database(`legacy-inline-queue-large-restore-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(archiveFile, { sourceFormat: header.sourceFormat }));
  const queue = await restored.legacyTaskQueueFileContent(queueId);
  assert.equal(queue.contentBase64, "", "portable queue observations keep file bytes out of large JSON string values");
  assert.equal(queue.contentAvailable, false);
  const local = await restored.legacyTaskQueueLocalFile(queueId);
  assert.equal(local.blob.size, expectedSize);
  const bytes = new Uint8Array(await local.blob.slice(0, 8).arrayBuffer());
  assert.deepEqual(bytes, new Uint8Array([65, 65, 65, 65, 65, 65, 65, 65]));
});

test("legacy task queue summaries count every status by task without mixing schedules", async () => {
  const database = new Database(`legacy-queue-summary-${crypto.randomUUID()}`);
  const firstTask = await database.createLegacyScheduledTask({ name: "Queue summary A", intervalMinutes: 60 });
  const otherTask = await database.createLegacyScheduledTask({ name: "Queue summary B", intervalMinutes: 120 });
  const files = ["pending.csv", "running.csv", "done.csv", "error.csv"].map((name) => new globalThis.File(["mac,model"], name));
  const added = await database.appendLegacyTaskQueueFiles(firstTask.id, files);
  await database.appendLegacyTaskQueueFiles(otherTask.id, [new globalThis.File(["other"], "other.csv")]);
  const firstPage = await database.legacyObservationSearchPage({ kind: "task_file_queue" }, { limit: 10 });
  const firstRows = firstPage.rows.filter((row) => row.payload.taskId === firstTask.payload.id);
  assert.equal(firstRows.length, 4);
  for (const [index, status] of ["pending", "running", "done", "error"].entries()) {
    await database.updateLegacyTaskQueueFile(firstRows[index].id, { status });
  }
  assert.equal(added.queued, 4);
  const summaries = await database.legacyTaskQueueSummaries([firstTask.payload.id, otherTask.payload.id, firstTask.payload.id]);
  assert.deepEqual(summaries.get(firstTask.payload.id), { pending: 1, running: 1, done: 1, error: 1, total: 4 });
  assert.deepEqual(summaries.get(otherTask.payload.id), { pending: 1, running: 0, done: 0, error: 0, total: 1 });
  await assert.rejects(database.legacyTaskQueueSummaries("not-an-array"), /должен быть массивом/);
});

test("locally retained legacy queue blobs stream through portable archives and delete with their schedule", async () => {
  const database = new Database(`legacy-local-blob-${crypto.randomUUID()}`);
  const task = await database.createLegacyScheduledTask({ name: "Large source", intervalMinutes: 30 });
  const key = "legacyQueueFile:large-test";
  const queueId = "legacy-queue-large-test";
  const db = await database.open();
  const tx = db.transaction(["legacyObservations", "fileHandles"], "readwrite");
  tx.objectStore("fileHandles").put({ key, file: new globalThis.Blob(["local bytes"]), filename: "large.xlsx", size: 11 });
  tx.objectStore("legacyObservations").put({
    id: queueId, kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: new Date().toISOString(), mac: "", internalDeviceId: "",
    payload: { id: queueId, taskId: task.payload.id, filename: "large.xlsx", status: "pending", localBlobKey: key, contentRetainedLocally: true, contentAvailable: false },
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
  assert.equal((await database.legacyTaskQueueLocalFile(queueId)).blob.size, 11);
  const archiveFile = await new globalThis.Response(database.exportArchiveStream()).blob();
  const header = await inspectPortableArchiveHeader(archiveFile);
  const restored = new Database(`legacy-local-blob-restore-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(archiveFile, { sourceFormat: header.sourceFormat }));
  const restoredFile = await restored.legacyTaskQueueLocalFile(queueId);
  assert.equal(restoredFile.blob.size, 11);
  assert.equal(await new globalThis.Response(restoredFile.blob).text(), "local bytes");
  assert.equal((await restored.legacyTaskQueueFileContent(queueId)).contentAvailable, false);
  const objectArchive = await readArchive(database);
  assert.equal(objectArchive.legacyTaskQueueFiles[0].size, 11);
  const objectRestored = new Database(`legacy-local-blob-object-restore-${crypto.randomUUID()}`);
  const occupiedKey = `legacyQueueFile:${queueId}`;
  const collisionDb = await objectRestored.open();
  const collisionTx = collisionDb.transaction("fileHandles", "readwrite");
  collisionTx.objectStore("fileHandles").put({ key: occupiedKey, file: new globalThis.Blob(["keep existing bytes"]), filename: "unrelated.csv", size: 18, taskId: "unrelated-task" });
  await new Promise((resolve, reject) => { collisionTx.oncomplete = resolve; collisionTx.onabort = () => reject(collisionTx.error); collisionTx.onerror = () => reject(collisionTx.error); });
  await objectRestored.importArchive(objectArchive);
  const objectFile = await objectRestored.legacyTaskQueueLocalFile(queueId);
  assert.equal(objectFile.blob.size, 11);
  assert.equal(await new globalThis.Response(objectFile.blob).text(), "local bytes");
  assert.equal(await new globalThis.Response((await readStore(objectRestored, "fileHandles")).find(({ key: storedKey }) => storedKey === occupiedKey).file).text(), "keep existing bytes");
  const invalidArchive = globalThis.structuredClone(objectArchive);
  invalidArchive.legacyTaskQueueFiles[0].taskId = "wrong-task";
  const rejected = new Database(`legacy-local-blob-invalid-${crypto.randomUUID()}`);
  await assert.rejects(rejected.importArchive(invalidArchive), /Некорректный файл очереди расписания/);
  assert.equal(await rejected.legacyTaskQueueLocalFile(queueId), null, "invalid queue-file metadata must be rejected before writes");
  assert.equal(await database.deleteLegacyObservations([task.id]), 2);
  assert.equal(await database.legacyTaskQueueLocalFile(queueId), null);
  assert.equal((await readStore(database, "fileHandles")).some(({ key: storedKey }) => storedKey === key), false);
});

test("adding a queue file above 30 MiB retains it locally without materializing portable Base64", async () => {
  const database = new Database(`legacy-large-local-queue-${crypto.randomUUID()}`);
  const task = await database.createLegacyScheduledTask({ name: "Large import", intervalMinutes: 120 });
  const size = 30 * 1024 * 1024 + 1;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x53;
  bytes[size - 1] = 0x51;
  const file = new globalThis.File([bytes], "large.csv", { type: "text/csv" });
  const result = await database.appendLegacyTaskQueueFiles(task.id, [file]);
  assert.equal(result.queued, 1);
  const queue = await database.legacyObservationSearchPage({ kind: "task_file_queue" });
  const row = queue.rows[0];
  assert.equal(row.payload.contentAvailable, false);
  assert.equal(row.payload.contentRetainedLocally, true);
  assert.equal(row.payload.contentBase64, undefined);
  const local = await database.legacyTaskQueueLocalFile(row.id);
  assert.equal(local.filename, "large.csv");
  assert.equal(local.blob.size, size);
  const edgeBytes = new Uint8Array(await local.blob.slice(0, 1).arrayBuffer());
  const endBytes = new Uint8Array(await local.blob.slice(-1).arrayBuffer());
  assert.deepEqual([edgeBytes[0], endBytes[0]], [0x53, 0x51]);
  const archiveFile = await new globalThis.Response(database.exportArchiveStream()).blob();
  const header = await inspectPortableArchiveHeader(archiveFile);
  const restored = new Database(`legacy-large-local-queue-restore-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(archiveFile, { sourceFormat: header.sourceFormat }));
  const restoredRow = await restored.legacyObservationSearchPage({ kind: "task_file_queue" });
  assert.equal(restoredRow.rows[0].payload.contentAvailable, false);
  assert.equal(restoredRow.rows[0].payload.contentRetainedLocally, true);
  assert.equal(restoredRow.rows[0].payload.contentBase64, undefined);
  const restoredFile = await restored.legacyTaskQueueLocalFile(row.id);
  assert.equal(restoredFile.blob.size, size);
  const restoredFirst = new Uint8Array(await restoredFile.blob.slice(0, 1).arrayBuffer());
  const restoredLast = new Uint8Array(await restoredFile.blob.slice(-1).arrayBuffer());
  assert.deepEqual([restoredFirst[0], restoredLast[0]], [0x53, 0x51]);
});

test("portable archives resolve queue files retained in imported SQLite sources", async () => {
  const database = new Database(`legacy-sqlite-queue-archive-${crypto.randomUUID()}`);
  const namespace = "a".repeat(24);
  const taskId = `legacy-task-${namespace}-${"b".repeat(16)}`;
  const queueId = "legacy-sqlite-queue-record";
  await database.recordLegacySqliteImportSource({ importId: "sqlite-queue-import", sourceIdbName: "sqlite-queue-source.db", sourceNamespace: namespace });
  const db = await database.open();
  const tx = db.transaction("legacyObservations", "readwrite");
  tx.objectStore("legacyObservations").put({
    id: queueId, kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: new Date().toISOString(), mac: "", internalDeviceId: "",
    payload: { id: "source-file-1", taskId, sourceTaskId: "source-task-1", filename: "retained.xlsx", status: "pending", contentAvailable: false, contentRetainedInSourceDatabase: true },
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  let readerCalls = 0;
  const stream = database.exportArchiveStream({
    readLegacyTaskQueueFile: async (source, observation) => {
      readerCalls += 1;
      assert.equal(source.sourceIdbName, "sqlite-queue-source.db");
      assert.equal(observation.payload.sourceTaskId, "source-task-1");
      return { filename: "retained.xlsx", blob: new globalThis.Blob(["sqlite attachment bytes"]) };
    },
  });
  const archiveFile = await new globalThis.Response(stream).blob();
  const header = await inspectPortableArchiveHeader(archiveFile);
  const restored = new Database(`legacy-sqlite-queue-restore-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(archiveFile, { sourceFormat: header.sourceFormat }));
  const restoredFile = await restored.legacyTaskQueueLocalFile(queueId);
  assert.equal(readerCalls, 1);
  assert.equal(restoredFile.filename, "retained.xlsx");
  assert.equal(await new globalThis.Response(restoredFile.blob).text(), "sqlite attachment bytes");
  await assert.rejects(new globalThis.Response(database.exportArchiveStream()).blob(), /исходной SQLite-базе/);
});

test("named archives export the queue attachment captured with their observation snapshot", async () => {
  const database = new Database(`named-archive-queue-snapshot-${crypto.randomUUID()}`);
  const task = await database.createLegacyScheduledTask({ name: "Captured queue", intervalMinutes: 30 });
  const queueId = "named-archive-queue-row";
  const blobKey = "legacyQueueFile:named-archive-queue-row";
  const db = await database.open();
  const tx = db.transaction(["legacyObservations", "fileHandles"], "readwrite");
  tx.objectStore("legacyObservations").put({
    id: queueId, kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: new Date().toISOString(), mac: "", internalDeviceId: "",
    payload: { id: queueId, taskId: task.payload.id, filename: "captured.xlsx", status: "pending", contentAvailable: false, contentRetainedLocally: true, localBlobKey: blobKey },
  });
  tx.objectStore("fileHandles").put({ key: blobKey, file: new globalThis.Blob(["captured attachment"]), filename: "captured.xlsx", size: 19, taskId: task.payload.id });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const archive = await database.createLocalArchive("Queue snapshot");
  const changeTx = (await database.open()).transaction(["legacyObservations", "fileHandles"], "readwrite");
  changeTx.objectStore("legacyObservations").put({
    id: queueId, kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: new Date().toISOString(), mac: "", internalDeviceId: "",
    payload: { id: queueId, taskId: task.payload.id, filename: "changed.xlsx", status: "pending", contentAvailable: false, contentRetainedLocally: true, localBlobKey: blobKey },
  });
  changeTx.objectStore("fileHandles").put({ key: blobKey, file: new globalThis.Blob(["changed attachment"]), filename: "changed.xlsx", size: 18, taskId: task.payload.id });
  await new Promise((resolve, reject) => { changeTx.oncomplete = resolve; changeTx.onabort = () => reject(changeTx.error); changeTx.onerror = () => reject(changeTx.error); });

  const archiveFile = await new globalThis.Response(await database.exportLocalArchiveStream(archive.id)).blob();
  const header = await inspectPortableArchiveHeader(archiveFile);
  const restored = new Database(`named-archive-queue-snapshot-restore-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(archiveFile, { sourceFormat: header.sourceFormat }));
  const restoredQueue = (await restored.legacyObservationSearchPage({ kind: "task_file_queue" })).rows.find(({ id }) => id === queueId);
  const restoredFile = await restored.legacyTaskQueueLocalFile(queueId);
  assert.equal(restoredQueue.payload.filename, "captured.xlsx");
  assert.equal(restoredFile.filename, "captured.xlsx");
  assert.equal(await new globalThis.Response(restoredFile.blob).text(), "captured attachment");

  const removeTx = (await database.open()).transaction(["legacyObservations", "fileHandles"], "readwrite");
  removeTx.objectStore("legacyObservations").delete(queueId);
  removeTx.objectStore("fileHandles").delete(blobKey);
  await new Promise((resolve, reject) => { removeTx.oncomplete = resolve; removeTx.onabort = () => reject(removeTx.error); removeTx.onerror = () => reject(removeTx.error); });
  await database.restoreLocalArchive(archive.id);
  const locallyRestored = await database.legacyTaskQueueLocalFile(queueId);
  assert.equal(locallyRestored.filename, "captured.xlsx");
  assert.equal(await new globalThis.Response(locallyRestored.blob).text(), "captured attachment");
});

test("legacy exact vendor/model lookup uses the latest known value for each field and skips placeholders", async () => {
  const database = new Database(`legacy-vendor-suggestions-${crypto.randomUUID()}`);
  const mac = "00:11:22:33:44:55";
  const db = await database.open();
  const tx = db.transaction("legacyObservations", "readwrite");
  const store = tx.objectStore("legacyObservations");
  store.put({ id: "vendor-old", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-14T10:00:00Z", mac, payload: { vendor: "Vendor A", model: "Model A" } });
  store.put({ id: "vendor-new", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T10:00:00Z", mac, payload: { id: 5, vendor: "Vendor B", model: "Unknown" } });
  store.put({ id: "vendor-newer-id", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T10:00:00Z", mac, payload: { id: 9, vendor: "Vendor C", model: "Unknown" } });
  store.put({ id: "not-vendor-history", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-16T10:00:00Z", mac, payload: { vendor: "Wrong", model: "Wrong" } });
  const secondMac = "AA:BB:CC:DD:EE:FF";
  store.put({ id: "vendor-second-mac", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T08:00:00Z", mac: secondMac, payload: { id: 2, vendor: "Vendor D", model: "Model D", vendorConfidence: null, modelConfidence: "", times_seen: 10 } });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
  const suggestions = await database.legacyVendorModelSuggestionsForMacs([mac, "00-11-22-33-44-55", secondMac, "invalid"]);
  assert.deepEqual(suggestions.get(mac), {
    vendor: "Vendor C", model: "Model A", source: "vendor_model_history_exact", confidence: 0.504,
    matchedPrefix: "001122334455", matches: 1, vendorConfidence: 0.504, modelConfidence: 0.504,
    vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_exact",
    vendorMatchedPrefix: "001122334455", modelMatchedPrefix: "001122334455",
  });
  assert.deepEqual(suggestions.get(secondMac), {
    vendor: "Vendor D", model: "Model D", source: "vendor_model_history_exact", confidence: 0.54,
    matchedPrefix: "AABBCCDDEEFF", matches: 1, vendorConfidence: 0.54, modelConfidence: 0.54,
    vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_exact",
    vendorMatchedPrefix: "AABBCCDDEEFF", modelMatchedPrefix: "AABBCCDDEEFF",
  });
  assert.equal(suggestions.size, 2);
});

test("legacy vendor/model prefix lookup ranks MAC5 and OUI counts and combines exact fields", async () => {
  const database = new Database(`legacy-vendor-prefix-${crypto.randomUUID()}`);
  const records = [
    ["exact", "00:11:22:33:44:99", { vendor: "Exact Vendor", model: "Unknown" }],
    ["ten-a", "00:11:22:33:44:01", { vendor: "Vendor Z", model: "Model Ten" }],
    ["ten-b", "00:11:22:33:44:02", { vendor: "Vendor Z", model: "Model Ten" }],
    ["ten-tie-a", "00:11:22:33:44:03", { vendor: "Vendor A", model: "Model Ten" }],
    ["ten-tie-b", "00:11:22:33:44:04", { vendor: "Vendor A", model: "Model Ten" }],
    ["eight", "00:11:22:33:55:01", { vendor: "Vendor Eight", model: "Model Eight" }],
    ["oui-a", "AA:BB:CC:99:00:01", { vendor: "Vendor OUI", model: "Model OUI" }],
  ].map(([id, mac, payload]) => ({ id, kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: `2026-10-15T10:00:00Z`, mac, payload }));
  const archive = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: records };
  await database.importArchive(archive);
  await database.importArchive(archive);

  const target = "00:11:22:33:44:99";
  const ranked = await database.legacyVendorModelSuggestionsForMacs([target]);
  assert.deepEqual(ranked.get(target), {
    vendor: "Exact Vendor", model: "Model Ten", source: "vendor_model_history_mixed",
    confidence: 0.504, matchedPrefix: "001122334499", matches: 4, vendorConfidence: 0.504, modelConfidence: 0.516,
    vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_prefix",
    vendorMatchedPrefix: "001122334499", modelMatchedPrefix: "0011223344",
  });
  const tieMac = "00:11:22:33:44:88";
  assert.equal((await database.legacyVendorModelSuggestionsForMacs([tieMac])).get(tieMac).vendor, "Vendor A");
  const ouiTarget = "AA:BB:CC:00:00:99";
  const ouiOnly = await database.legacyVendorModelSuggestionsForMacs([ouiTarget], { useMac5Match: false, useOuiMatch: true });
  assert.equal(ouiOnly.get(ouiTarget).vendor, "Vendor OUI");
  assert.equal(ouiOnly.get(ouiTarget).model, "Model OUI");
  assert.equal(ouiOnly.get(ouiTarget).source, "vendor_model_history_prefix");
  assert.equal(ouiOnly.get(ouiTarget).confidence, 0.504);
  assert.equal((await database.legacyVendorModelSuggestionsForMacs([ouiTarget], { useMac5Match: false, useOuiMatch: false })).size, 0);
});

test("legacy observations survive portable archive export, additive import, and local archive restoration", async () => {
  const source = new Database(`legacy-observation-archive-${crypto.randomUUID()}`);
  const observation = { id: "mac-history-row-a", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T12:00:00Z", mac: "00:11:22:33:44:55", payload: { room: "Room A" } };
  await source.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, (async function* () {
    yield { type: "records", collection: "legacyObservations", records: [observation] };
  })());
  const portable = await readArchive(source);
  assert.deepEqual(portable.legacyObservations, [observation]);

  const restored = new Database(`legacy-observation-restored-${crypto.randomUUID()}`);
  await restored.importArchive(portable);
  await restored.importArchive(portable);
  assert.deepEqual((await restored.legacyObservationPage({ kind: "mac_history" })).rows, [observation]);

  const archive = await source.createLocalArchive("Legacy history");
  const db = await source.open();
  const tx = db.transaction("legacyObservations", "readwrite");
  tx.objectStore("legacyObservations").delete(observation.id);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
  await source.restoreLocalArchive(archive.id);
  assert.deepEqual((await source.legacyObservationPage({ kind: "mac_history" })).rows, [observation]);
});

test("MAC model lookup reads only matching 3-, 4-, and 5-byte prefixes for requested MACs", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("mac5Models", "readwrite");
  const store = tx.objectStore("mac5Models");
  store.put({ prefix: "AABBCCDD", model: "Four byte rule" });
  store.put({ prefix: "AABBCCDDEE", model: "Five byte rule" });
  store.put({ prefix: "AABBCC", model: "Three byte rule" });
  store.put({ prefix: "00112233", model: "Unrelated rule" });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const rows = await database.mac5ModelsForMacs(["AA:BB:CC:DD:EE:FF", "aabb.ccdd.eeff", "invalid"]);
  assert.deepEqual([...rows], [["AABBCCDD", "Four byte rule"], ["AABBCCDDEE", "Five byte rule"], ["AABBCC", "Three byte rule"]]);
  assert.equal((await database.mac5ModelsForMacs([])).size, 0);
});

test("MAC5 model rules are searchable in complete cursor pages without getAll", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("mac5Models", "readwrite");
  const store = tx.objectStore("mac5Models");
  for (let index = 0; index < 235; index += 1) {
    const prefix = index.toString(16).toUpperCase().padStart(8, "0");
    store.put({ prefix, model: index % 7 === 0 ? `Router ${index}` : `Device ${index}` });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const originalGetAll = globalThis.IDBObjectStore.prototype.getAll;
  globalThis.IDBObjectStore.prototype.getAll = function forbiddenGetAll() { throw new Error("MAC5 pages must use a cursor"); };
  try {
    const prefixes = [];
    let afterPrefix = null;
    let pageCount = 0;
    do {
      const page = await database.mac5ModelPage({ afterPrefix, limit: 37 });
      pageCount += 1;
      prefixes.push(...page.rows.map(({ prefix }) => prefix));
      afterPrefix = page.nextCursor;
      assert.equal(page.hasMore, afterPrefix !== null);
    } while (afterPrefix);
    assert.equal(pageCount, 7);
    assert.equal(prefixes.length, 235);
    assert.equal(new Set(prefixes).size, 235);
    assert.deepEqual(prefixes, [...prefixes].sort());

    const filtered = await database.mac5ModelPage({ query: "router 1", limit: 100 });
    assert.ok(filtered.rows.length > 0);
    assert.ok(filtered.rows.every(({ model }) => model.toLocaleLowerCase("ru-RU").includes("router 1")));
    const modelMatches = await database.mac5ModelsMatchingModel("router 1");
    assert.ok(modelMatches.length > 0);
    assert.ok(modelMatches.every(({ model }) => model.toLocaleLowerCase("ru-RU").includes("router 1")));
  } finally {
    globalThis.IDBObjectStore.prototype.getAll = originalGetAll;
  }
});

test("local performance preview stays capped while statistics include every operation", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const timestamp = new Date().toISOString();
  await Promise.all(Array.from({ length: 12 }, (_, index) => database.recordPerformanceMetric(
    index % 2 ? "export_csv" : "enrichment", index * 10, timestamp,
  )));
  assert.deepEqual(await database.performanceStatistics({ days: 7 }), [
    { operation: "enrichment", count: 6, totalMs: 300, averageMs: 50, minMs: 0, maxMs: 100, latestAt: timestamp },
    { operation: "export_csv", count: 6, totalMs: 360, averageMs: 60, minMs: 10, maxMs: 110, latestAt: timestamp },
  ]);
  await assert.rejects(database.recordPerformanceMetric("filename report.csv", 10), /неверный формат/);
  for (let index = 0; index < 510; index += 1) await database.recordPerformanceMetric("export_csv", 1, timestamp);
  const stored = await database.getSetting("performanceMetrics:v1", []);
  assert.equal(stored.length, 500);
  assert.equal((await database.performanceStatistics({ days: 7 })).find((item) => item.operation === "export_csv").count, 516);

  const archive = await readArchive(database);
  const file = new globalThis.Blob([JSON.stringify(archive)]);
  const header = await inspectPortableArchiveHeader(file);
  const restored = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  await restored.importArchiveEvents(header, readPortableArchiveEvents(file));
  assert.equal((await restored.performanceStatistics({ days: 7 })).find((item) => item.operation === "export_csv").count, 516);
});

test("legacy SQLite performance metrics aggregate every cursor row beyond 500", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const db = await database.open();
  const tx = db.transaction("settings", "readwrite");
  const store = tx.objectStore("settings");
  const count = 750;
  for (let index = 0; index < count; index += 1) {
    store.put({
      key: `legacyPerformanceMetric:sqlite-row-${String(index).padStart(4, "0")}`,
      value: { operation: "legacy_import", durationMs: index, timestamp },
    });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("SQLite metric seed aborted"));
    tx.onerror = () => reject(tx.error || new Error("SQLite metric seed failed"));
  });
  assert.deepEqual(await database.performanceStatistics({ days: 7 }), [{
    operation: "legacy_import", count, totalMs: 280_875, averageMs: 374.5, minMs: 0, maxMs: 749, latestAt: timestamp,
  }]);
});

test("legacy capped performance preview migrates once and does not double count", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const timestamp = new Date().toISOString();
  await database.setSetting("performanceMetrics:v1", [
    { operation: "enrichment", durationMs: 100, timestamp },
    { operation: "export_csv", durationMs: 200, timestamp },
  ]);
  await database.recordPerformanceMetric("enrichment", 300, timestamp);
  await database.recordPerformanceMetric("export_csv", 400, timestamp);
  assert.deepEqual((await database.performanceStatistics({ days: 7 })).map(({ operation, count, totalMs }) => ({ operation, count, totalMs })), [
    { operation: "enrichment", count: 2, totalMs: 400 },
    { operation: "export_csv", count: 2, totalMs: 600 },
  ]);
});

test("learned OUI and 3-5 byte model rules are added atomically without replacing user rules", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  await database.importOui([{ prefix: "001122", vendor: "Manual Vendor" }]);
  await database.saveMac5Model("001122", "Manual Model");
  const saved = await database.saveLearnedVendorModelRules({
    vendors: [
      { prefix: "001122", vendor: "Learned Vendor", observations: 9 },
      { prefix: "AABBCC", vendor: "New Vendor", observations: 4 },
    ],
    models: [
      { prefix: "001122", model: "Learned Model", observations: 8 },
      { prefix: "AABBCC", model: "New Model", observations: 3 },
    ],
  });
  assert.deepEqual(saved, { vendors: 1, models: 1 });
  assert.equal((await database.ouiIndexForMacs(["AA:BB:CC:00:00:01"])).get("AABBCC"), "New Vendor");
  assert.deepEqual((await database.ouiRulesForMacs(["AA:BB:CC:00:00:01"])).get("AABBCC"), {
    prefix: "AABBCC", vendor: "New Vendor", source: "Обучено по локальной истории", observations: 4,
  });
  assert.equal((await database.mac5ModelsForMacs(["AA:BB:CC:00:00:01"])).get("AABBCC"), "New Model");
  assert.equal((await database.ouiIndexForMacs(["00:11:22:33:44:55"])).get("001122"), "Manual Vendor");
  assert.equal((await database.ouiRulesForMacs(["00:11:22:33:44:55"])).get("001122").source, "Пользовательский справочник");
  assert.equal((await database.mac5ModelsForMacs(["00:11:22:33:44:55"])).get("001122"), "Manual Model");
});

test("learned rules fill only blank fields in the active Final and matching Inventory without changing its ID", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const snapshot = {
    id: "learned-rules-active-final", name: "Final for rule learning", devices: [
      { id: "learned-device", mac: "00:11:22:33:44:55", manufacturer: "", model: "", fieldSources: {}, sources: [] },
      { id: "known-device", mac: "00:11:22:33:44:66", manufacturer: "Existing Vendor", model: "Existing Model", fieldSources: { manufacturer: "Main", model: "Main" }, sources: ["Main"] },
      { id: "four-byte-device", mac: "00:11:23:3A:44:55", manufacturer: "", model: "", fieldSources: {}, sources: [] },
    ],
  };
  await database.saveFinal(snapshot);
  await database.saveLearnedVendorModelRules({
    vendors: [{ prefix: "001122", vendor: "Learned Vendor", observations: 2 }],
    models: [{ prefix: "00112233", model: "Learned Model", observations: 2 }],
  });
  await database.importOui([{ prefix: "0011233", vendor: "Four-byte Vendor", source: "Imported custom OUI file" }]);
  const applied = await database.applyVendorModelRulesToActiveSnapshot();
  assert.deepEqual(applied, { snapshotId: snapshot.id, vendorsFilled: 2, modelsFilled: 1 });
  const devices = [];
  await database.forEachSnapshotChunk(snapshot.id, (chunk) => devices.push(...chunk));
  assert.equal(devices[0].manufacturer, "Learned Vendor");
  assert.equal(devices[0].model, "Learned Model");
  assert.equal(devices[0].fieldSources.manufacturer, "Обучено по локальной истории");
  assert.equal(devices[0].vendorSource, "Обучено по локальной истории");
  assert.equal(devices[0].vendorConfidence, 0.95);
  assert.equal(devices[0].fieldSources.model, "MAC rule 00112233");
  assert.equal(devices[1].manufacturer, "Existing Vendor");
  assert.equal(devices[1].model, "Existing Model");
  assert.equal(devices[2].manufacturer, "Four-byte Vendor");
  assert.equal(devices[2].fieldSources.manufacturer, "Imported custom OUI file");
  const metadata = (await database.listSnapshots()).find(({ id }) => id === snapshot.id);
  assert.equal(metadata.dataRevision, 1);
  assert.equal(await database.getSetting("activeSnapshotId"), snapshot.id);
  assert.equal((await readInventory(database)).find(({ id }) => id === "learned-device").model, "Learned Model");
  const learnedInventory = (await readInventory(database)).find(({ id }) => id === "learned-device");
  assert.equal(learnedInventory.vendorSource, "Обучено по локальной истории");
  assert.equal(learnedInventory.vendorConfidence, 0.95);
  assert.deepEqual(await database.applyVendorModelRulesToActiveSnapshot(), { snapshotId: snapshot.id, vendorsFilled: 0, modelsFilled: 0 });
  assert.equal((await database.listSnapshots()).find(({ id }) => id === snapshot.id).dataRevision, 1);
});

test("failed active Final rule application aborts chunk writes and preserves active metadata", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const snapshot = { id: "learned-rules-broken-final", devices: [{ id: "broken-device", mac: "00:11:22:33:44:55", manufacturer: "", model: "", fieldSources: {} }] };
  await database.saveFinal(snapshot);
  await database.saveLearnedVendorModelRules({
    vendors: [{ prefix: "001122", vendor: "Learned Vendor", observations: 2 }],
  });
  const db = await database.open();
  const tx = db.transaction("snapshots", "readwrite");
  const metadata = await new Promise((resolve, reject) => {
    const request = tx.objectStore("snapshots").get(snapshot.id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  metadata.deviceCount += 1;
  tx.objectStore("snapshots").put(metadata);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  await assert.rejects(database.applyVendorModelRulesToActiveSnapshot(), /Final повреждён/);
  const chunks = await readStore(database, "snapshotChunks");
  assert.equal(chunks.find(({ snapshotId }) => snapshotId === snapshot.id).devices[0].manufacturer, "");
  assert.equal((await database.listSnapshots()).find(({ id }) => id === snapshot.id).dataRevision, 0);
  assert.equal(await database.getSetting("activeSnapshotId"), snapshot.id);
});

test("switch address evidence is cursor-read only for requested switch IPs", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("switchAddressEvidence", "readwrite");
  const store = tx.objectStore("switchAddressEvidence");
  store.put({ switchIp: "10.0.0.1", address: "Room A", snapshotId: "final-a", deviceCount: 3 });
  store.put({ switchIp: "10.0.0.1", address: "Room A", snapshotId: "final-b", deviceCount: 4 });
  store.put({ switchIp: "10.0.0.2", address: "Room B", snapshotId: "final-c", deviceCount: 3 });
  store.put({ switchIp: "10.0.0.3", address: "Unrelated", snapshotId: "final-d", deviceCount: 3 });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const rows = [];
  await database.forEachSwitchAddressEvidenceForIps(["10.0.0.1", "10.0.0.2", "10.0.0.1"], (record) => rows.push(record));
  assert.equal(rows.length, 3);
  assert.equal(rows.some((record) => record.switchIp === "10.0.0.3"), false);
  const relatedIps = await database.switchAddressEvidenceIpsPage(0, 10, ["10.0.0.1", "10.0.0.3"]);
  assert.deepEqual(relatedIps.ips, ["10.0.0.1", "10.0.0.3"]);
  assert.equal(relatedIps.total, 2);
  const unrelatedIps = await database.switchAddressEvidenceIpsPage(0, 10, ["10.0.0.99"]);
  assert.deepEqual(unrelatedIps.ips, []);
  assert.equal(unrelatedIps.total, 0);
});

test("switch address evidence IP pages use a unique-key cursor and return exact totals", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("switchAddressEvidence", "readwrite");
  const store = tx.objectStore("switchAddressEvidence");
  for (let index = 1; index <= 1_205; index += 1) {
    const switchIp = `192.168.${Math.floor(index / 250)}.${index % 250}`;
    store.put({ switchIp, address: "Room", snapshotId: `final-${index}` });
    if (index % 100 === 0) store.put({ switchIp, address: "Room", snapshotId: `repeat-${index}` });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  const first = await database.switchAddressEvidenceIpsPage(0, 500);
  const second = await database.switchAddressEvidenceIpsPage(500, 500);
  const last = await database.switchAddressEvidenceIpsPage(1_000, 500);
  assert.equal(first.total, 1_205);
  assert.equal(second.total, first.total);
  assert.equal(last.total, first.total);
  assert.equal(first.ips.length, 500);
  assert.equal(second.ips.length, 500);
  assert.equal(last.ips.length, 205);
  assert.equal(new Set([...first.ips, ...second.ips, ...last.ips]).size, 1_205);
  assert.deepEqual([...first.ips, ...second.ips, ...last.ips], [...first.ips, ...second.ips, ...last.ips].sort());
});

async function seedSnapshotRelations(database, ids) {
  const db = await database.open();
  const tx = db.transaction(["snapshotChunks", "history", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "analyticsCache", "smartroomRoomMappings", "switchAddressEvidence", "inventory"], "readwrite");
  ids.forEach((id, index) => {
    tx.objectStore("snapshotChunks").put({ snapshotId: id, index: 0, devices: [{ id: `device-${id}`, mac: `00:00:00:00:00:0${index}` }] });
    tx.objectStore("history").put({ snapshotId: id, deviceId: `device-${id}`, timestamp: `2026-01-0${index + 1}` });
    tx.objectStore("originalFiles").put({ snapshotId: id, role: "main", name: `${id}.csv`, size: 0, blob: new globalThis.Blob([]) });
    tx.objectStore("finalAnalytics").put({ snapshotId: id, generation: "generation-1", index: 0, devices: [] });
    tx.objectStore("finalAnalyticsMetadata").put({ snapshotId: id, generation: "generation-1" });
    tx.objectStore("smartroomRoomMappings").put({ smartroomIdKey: `smartroom-${id}`, sourceFinalId: id });
    tx.objectStore("switchAddressEvidence").put({ switchIp: "10.0.0.1", address: `room-${id}`, snapshotId: id });
  });
  tx.objectStore("analyticsCache").put({ key: "snapshot-history", schemaVersion: 2, signature: "sig", value: {} });
  tx.objectStore("inventory").put({ id: "persistent-inventory-device", mac: "00:11:22:33:44:55" });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
}

test("deleting selected Final atomically removes its derived rows and keeps Inventory", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "delete-old-final", createdAt: "2026-01-01T00:00:00Z", devices: [] });
  await database.saveFinal({ id: "delete-active-final", createdAt: "2026-01-02T00:00:00Z", devices: [] });
  await seedSnapshotRelations(database, ["delete-old-final", "delete-active-final"]);
  await database.setSetting("activeSnapshotId", "delete-active-final");

  const result = await database.deleteSnapshots(["delete-active-final", "missing-final"]);
  assert.deepEqual(result, { deleted: 1, activeSnapshotId: "delete-old-final" });
  assert.deepEqual((await database.listSnapshots()).map((row) => row.id), ["delete-old-final"]);
  for (const store of ["snapshotChunks", "history", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "smartroomRoomMappings", "switchAddressEvidence"]) {
    assert.equal((await readStore(database, store)).some((row) => row.snapshotId === "delete-active-final" || row.sourceFinalId === "delete-active-final"), false, store);
    assert.equal((await readStore(database, store)).length, store === "snapshotChunks" || store === "history" || store === "originalFiles" || store === "finalAnalytics" || store === "finalAnalyticsMetadata" || store === "smartroomRoomMappings" || store === "switchAddressEvidence" ? 1 : 1, store);
  }
  assert.equal(await database.getSetting("activeSnapshotId"), "delete-old-final");
  assert.equal(await database.loadAnalyticsCache("snapshot-history", "sig", 2), null);
  assert.equal((await readInventory(database)).length, 1);
});

test("deleting Final history invalidates derived comparison-backfill indexes and their chunks", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const sourceId = "backfill-index-source-final";
  const derivedId = `__mac_analyzer_comparison_backfill__:${sourceId}`;
  await database.saveFinal({ id: sourceId, createdAt: "2026-01-01T00:00:00Z", devices: [] });
  await database.saveFinalAnalyticsIndex(derivedId, "derived-signature", [{ id: "historical-device", mac: "00:11:22:33:44:55" }], FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);
  assert.equal((await readStore(database, "finalAnalytics")).some((row) => row.snapshotId === derivedId), true);
  assert.equal((await readStore(database, "finalAnalyticsMetadata")).some((row) => row.snapshotId === derivedId), true);

  await database.deleteSnapshots([sourceId]);

  assert.equal(await database.loadFinalAnalyticsIndex(derivedId, "derived-signature", FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), null);
  assert.equal((await readStore(database, "finalAnalytics")).some((row) => row.snapshotId === derivedId), false);
  assert.equal((await readStore(database, "finalAnalyticsMetadata")).some((row) => row.snapshotId === derivedId), false);
});

test("deleting every Final clears the active pointer and tolerates unknown IDs", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "delete-all-one", createdAt: "2026-02-01T00:00:00Z", devices: [] });
  await database.saveFinal({ id: "delete-all-two", createdAt: "2026-02-02T00:00:00Z", devices: [] });
  await database.setSetting("activeSnapshotId", "delete-all-two");
  const result = await database.deleteSnapshots(["delete-all-one", "delete-all-two", "unknown"]);
  assert.deepEqual(result, { deleted: 2, activeSnapshotId: "" });
  assert.deepEqual(await database.listSnapshots(), []);
  assert.equal(await database.getSetting("activeSnapshotId"), "");
  assert.deepEqual(await database.deleteSnapshots(["unknown"]), { deleted: 0, activeSnapshotId: "" });
});

test("selected Final deletion cursor-scans snapshot metadata and restores the newest active Final", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction(["snapshots", "settings"], "readwrite");
  const snapshots = tx.objectStore("snapshots");
  for (let index = 0; index < 1200; index += 1) {
    snapshots.put({
      id: `cursor-delete-${String(index).padStart(4, "0")}`,
      name: `Final ${index}`,
      snapshotType: "final",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  }
  snapshots.put({ id: "cursor-delete-single-analysis", name: "Single file: newest", snapshotType: "single-analysis", createdAt: "2027-01-01T00:00:00Z" });
  snapshots.put({ id: "cursor-delete-no-date", name: "Final without date", snapshotType: "final" });
  tx.objectStore("settings").put({ key: "activeSnapshotId", value: "cursor-delete-1199" });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  assert.deepEqual(await database.deleteSnapshots(["cursor-delete-1199"]), {
    deleted: 1,
    activeSnapshotId: "cursor-delete-1198",
  });
  assert.equal(await database.getSetting("activeSnapshotId"), "cursor-delete-1198");
  assert.equal((await database.listSnapshots()).length, 1201);
});

test("clearing Final history is atomic and preserves Inventory, knowledge rules, and user settings", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "clear-history-one", createdAt: "2026-03-01T00:00:00Z", devices: [] });
  await database.saveFinal({ id: "clear-history-two", createdAt: "2026-03-02T00:00:00Z", devices: [] });
  await seedSnapshotRelations(database, ["clear-history-one", "clear-history-two"]);
  await database.setSetting("activeSnapshotId", "clear-history-two");
  await database.setSetting("theme", "dark");
  const db = await database.open();
  const tx = db.transaction(["mac5Models", "oui", "archives"], "readwrite");
  tx.objectStore("mac5Models").put({ prefix: "AABBCCDD", model: "Switch X" });
  tx.objectStore("oui").put({ prefix: "AABBCC", vendor: "Acme" });
  tx.objectStore("archives").put({ id: "saved-archive", name: "Keep" });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

  assert.deepEqual(await database.clearSnapshots(), { deleted: 2, activeSnapshotId: "" });
  assert.deepEqual(await database.listSnapshots(), []);
  assert.equal(await database.getSetting("activeSnapshotId"), "");
  assert.equal(await database.getSetting("theme"), "dark");
  assert.equal((await readInventory(database)).length, 1);
  for (const store of ["snapshotChunks", "history", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "analyticsCache", "smartroomRoomMappings", "switchAddressEvidence"]) {
    assert.deepEqual(await readStore(database, store), [], store);
  }
  assert.equal((await readStore(database, "mac5Models")).length, 1);
  assert.equal((await readStore(database, "oui")).length, 1);
  assert.equal((await readStore(database, "archives")).length, 1);
});

test("Final comparison and persistence retain one Inventory identity when a device MAC changes", async () => {
  const database = new Database(`stable-history-identity-${crypto.randomUUID()}`);
  const before = [{ id: "persistent-device", mac: "00:11:22:33:44:55", model: "Board" }];
  const after = [{ id: "persistent-device", mac: "AA:BB:CC:DD:EE:FF", model: "Board" }];
  await database.saveFinal({ id: "stable-old", createdAt: "2026-01-01T00:00:00Z", devices: before });
  const comparison = compareFinals(before, after, "2026-01-02T00:00:00Z");
  assert.equal(comparison.added.length, 0);
  assert.equal(comparison.absent.length, 0);
  assert.equal(comparison.modified.length, 1);
  await database.saveFinal({ id: "stable-new", createdAt: "2026-01-02T00:00:00Z", devices: after, comparison });
  const inventory = await readInventory(database);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].id, "persistent-device");
  const history = await database.historySearchPage({ mac: "aabbccddeeff" });
  assert.equal(history.total, 1);
  assert.equal(history.rows[0].deviceId, "persistent-device");
});

async function readSwitchAddressEvidence(database) {
  const rows = [];
  await database.forEachSwitchAddressEvidence((record) => rows.push(record));
  return rows;
}

test("browser smoke can select a unique disposable database without changing the default", () => {
  assert.equal(databaseNameFromSearch("?db=mac-analyzer-pro-next-test-12345678"), "mac-analyzer-pro-next-test-12345678");
  assert.equal(databaseNameFromSearch("?db=mac-analyzer-pro-next"), "mac-analyzer-pro-next");
  assert.equal(databaseNameFromSearch("?db=../user-data"), "mac-analyzer-pro-next");
});

test("history period filters normalize legacy event types and Russian critical fields", async () => {
  const database = new Database(`history-aliases-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("history", "readwrite");
  [
    { id: "legacy-removed", timestamp: "2026-02-01T10:00:00.000Z", type: "removed", field: "device", mac: "001122334455" },
    { id: "russian-ip", timestamp: "2026-02-01T11:00:00.000Z", type: "Изменено", field: "IP-адрес", oldValue: "10.0.0.1", newValue: "10.0.0.2" },
    { id: "blank-switch", timestamp: "2026-02-01T12:00:00.000Z", type: "modified", label: "Коммутатор", oldValue: "", newValue: "10.0.0.3" },
    { id: "room-address", timestamp: "2026-02-01T13:00:00.000Z", type: "modified", field: "address", oldValue: "A", newValue: "B" },
    { id: "reference-shape", timestamp: "2026-02-01T14:00:00.000Z", type: "modified", fieldLabel: "IP коммутатора", before: "10.0.0.5", after: "10.0.0.6" },
  ].forEach((event) => tx.objectStore("history").put(event));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const critical = await database.historySearchPage({ from: "2026-02-01", to: "2026-02-01", severity: "critical" });
  assert.deepEqual(critical.rows.map(({ id }) => id), ["legacy-removed", "russian-ip", "reference-shape"]);
  const absent = await database.historySearchPage({ from: "2026-02-01", to: "2026-02-01", type: "absent" });
  assert.deepEqual(absent.rows.map(({ id }) => id), ["legacy-removed"]);
});

test("date history summary aggregates the selected period, classifies changes, and pages dates", async () => {
  const database = new Database(`history-date-summary-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("history", "readwrite");
  [
    { id: "sum-added", timestamp: "2026-03-01T10:00:00.000Z", type: "added", mac: "00:11:22:33:44:55" },
    { id: "sum-modified", timestamp: "2026-03-01T11:00:00.000Z", type: "modified", mac: "001122334455", oldValue: "A", newValue: "B" },
    { id: "sum-removed", timestamp: "2026-03-02T10:00:00.000Z", type: "modified", mac: "AA:BB:CC:DD:EE:FF", oldValue: "A", newValue: "—" },
    { id: "sum-outside", timestamp: "2026-03-03T10:00:00.000Z", type: "modified", mac: "AA:BB:CC:DD:EE:FF" },
  ].forEach((event) => tx.objectStore("history").put(event));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const queryId = `history-date-summary:${crypto.randomUUID()}`;
  await database.historyDateRangeSummary({ from: "2026-03-01", to: "2026-03-02" }, { queryId });
  const page = await database.historyDateSummaryPage(queryId, { limit: 1 });
  assert.deepEqual(page.rows, [{ date: "2026-03-01", total: 2, added: 1, removed: 0, modified: 1 }]);
  assert.equal(page.hasMore, true);
  const next = await database.historyDateSummaryPage(queryId, { after: page.nextCursor, limit: 1 });
  assert.deepEqual(next.rows, [{ date: "2026-03-02", total: 1, added: 0, removed: 1, modified: 0 }]);
  assert.equal(next.hasMore, false);
  assert.deepEqual((await database.analyticsAggregateTop(queryId, "mac", 50)).map(({ value, count }) => [value, count]), [["00:11:22:33:44:55", 2], ["AA:BB:CC:DD:EE:FF", 1]]);
  await database.clearAnalyticsAggregateQuery(queryId);
});

test("date history Top MAC keeps first-observed order when change counts tie", async () => {
  const database = new Database(`history-date-summary-ties-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("history", "readwrite");
  [
    { id: "first-observed", timestamp: "2026-05-01T09:00:00.000Z", mac: "FF:FF:FF:FF:FF:FE" },
    { id: "second-observed", timestamp: "2026-05-01T10:00:00.000Z", mac: "00:00:00:00:00:01" },
    { id: "third-observed", timestamp: "2026-05-01T11:00:00.000Z", mac: "AA:AA:AA:AA:AA:AA" },
  ].forEach((event) => tx.objectStore("history").put({ ...event, type: "modified" }));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const queryId = `history-date-summary:${crypto.randomUUID()}`;
  await database.historyDateRangeSummary({ from: "2026-05-01", to: "2026-05-01" }, { queryId });
  assert.deepEqual(
    (await database.analyticsAggregateTop(queryId, "mac", 50, "ru", { tieBreak: "firstObserved" })).map(({ value }) => value),
    ["FF:FF:FF:FF:FF:FE", "00:00:00:00:00:01", "AA:AA:AA:AA:AA:AA"],
  );
  await database.clearAnalyticsAggregateQuery(queryId);
});

test("history date export pages through duplicate timestamps without crossing the selected dates", async () => {
  const database = new Database(`history-date-page-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("history", "readwrite");
  [
    { id: "a", timestamp: "2026-04-01T12:00:00.000Z" },
    { id: "b", timestamp: "2026-04-01T12:00:00.000Z" },
    { id: "c", timestamp: "2026-04-02T12:00:00.000Z" },
    { id: "outside", timestamp: "2026-04-03T12:00:00.000Z" },
  ].forEach((event) => tx.objectStore("history").put(event));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const first = await database.historyDateRangePage({ from: "2026-04-01", to: "2026-04-02" }, { limit: 2 });
  assert.deepEqual(first.rows.map(({ id }) => id), ["a", "b"]);
  assert.equal(first.hasMore, true);
  const next = await database.historyDateRangePage({ from: "2026-04-01", to: "2026-04-02" }, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(next.rows.map(({ id }) => id), ["c"]);
  assert.equal(next.hasMore, false);
});

test("history filtering and XLSX source paging honor exact time bounds and all-field search", async () => {
  const database = new Database(`history-time-filter-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction("history", "readwrite");
  const localMinuteStart = new Date("2026-04-01T11:30:00").getTime();
  [
    { id: "before-minute", timestamp: new Date(localMinuteStart - 1).toISOString(), type: "modified", mac: "00:11:22:33:44:55", manufacturer: "Acme" },
    { id: "in-minute-a", timestamp: new Date(localMinuteStart).toISOString(), type: "modified", mac: "00:11:22:33:44:55", manufacturer: "Acme" },
    { id: "in-minute-b", timestamp: new Date(localMinuteStart + 59_999).toISOString(), type: "modified", mac: "00:11:22:33:44:66", manufacturer: "Acme" },
    { id: "after-minute", timestamp: new Date(localMinuteStart + 60_000).toISOString(), type: "modified", mac: "00:11:22:33:44:77", manufacturer: "Acme" },
  ].forEach((event) => tx.objectStore("history").put(event));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const filters = { from: "2026-04-01", fromTime: "11:30", to: "2026-04-01", toTime: "11:30", query: "Acme" };
  assert.deepEqual((await database.historySearchPage(filters)).rows.map(({ id }) => id), ["in-minute-a", "in-minute-b"]);
  assert.deepEqual((await database.historyDateRangePage(filters)).rows.map(({ id }) => id), ["in-minute-a", "in-minute-b"]);
  const queryId = `history-date-summary:${crypto.randomUUID()}`;
  await database.historyDateRangeSummary(filters, { queryId });
  assert.deepEqual((await database.historyDateSummaryPage(queryId)).rows.map(({ total }) => total), [2]);
  await database.clearAnalyticsAggregateQuery(queryId);
  await assert.rejects(database.historySearchPage({ fromTime: "11:30" }), /выберите дату начала/);
  await assert.rejects(database.historySearchPage({ from: "2026-02-31" }), /Дата фильтра не существует/);
});

test("OUI batches persist incrementally and later duplicate prefixes win", async () => {
  const database = new Database(`oui-batches-${crypto.randomUUID()}`);
  assert.equal(await database.importOui([
    { prefix: "AABBCC", vendor: "First Vendor" },
    { prefix: "AABBCCD", vendor: "Specific Vendor" },
    { prefix: "AABBCCDD", vendor: "Four-byte Vendor" },
    { prefix: "AABBCCDDE", vendor: "Most Specific Vendor" },
    { prefix: "AABBCCDDEE", vendor: "Five-byte Vendor" },
    { prefix: "DDEEFF", vendor: "Other Vendor" },
    { prefix: "AABB", vendor: "Invalid short prefix" },
    { prefix: "AABBCCDDEEFF", vendor: "Invalid full MAC" },
  ]), 6);
  assert.equal(await database.importOui([
    { prefix: "AABBCC", vendor: "Corrected Vendor" },
    { prefix: "112233", vendor: "Additional Vendor" },
  ]), 2);
  const index = await database.ouiIndexForMacs(["AA:BB:CC:DD:EE:FF", "invalid"]);
  assert.deepEqual([...index].sort(([a], [b]) => a.localeCompare(b)), [
    ["AABBCC", "Corrected Vendor"],
    ["AABBCCD", "Specific Vendor"],
    ["AABBCCDD", "Four-byte Vendor"],
    ["AABBCCDDE", "Most Specific Vendor"],
    ["AABBCCDDEE", "Five-byte Vendor"],
  ]);
  assert.equal(database.ouiIndex, undefined);
});

test("bundled OUI version updates add missing assignments without replacing user rules", async () => {
  const database = new Database(`oui-bundled-migration-${crypto.randomUUID()}`);
  await database.importOui([
    { prefix: "AABBCC", vendor: "User Override", source: "My reference" },
    { prefix: "DDEEFF", vendor: "Legacy bundled value", source: "Встроенный IEEE OUI" },
  ]);
  assert.equal(await database.importOui([
    { prefix: "AABBCC", vendor: "Current IEEE value", source: "Встроенный IEEE OUI" },
    { prefix: "112233", vendor: "New IEEE value", source: "Встроенный IEEE OUI" },
  ], { overwriteExisting: false }), 1);
  assert.deepEqual((await database.ouiPage({ limit: 10 })).rows.map(({ prefix, vendor, source }) => ({ prefix, vendor, source })), [
    { prefix: "112233", vendor: "New IEEE value", source: "Встроенный IEEE OUI" },
    { prefix: "AABBCC", vendor: "User Override", source: "My reference" },
    { prefix: "DDEEFF", vendor: "Legacy bundled value", source: "Встроенный IEEE OUI" },
  ]);
});

test("bundled OUI refresh replaces only explicitly recognized seed provenance", async () => {
  const database = new Database(`oui-bundled-provenance-${crypto.randomUUID()}`);
  await database.importOui([
    { prefix: "AABBCC", vendor: "Old bundled vendor" },
    { prefix: "DDEEFF", vendor: "Old tagged vendor", source: "Встроенный IEEE OUI" },
    { prefix: "112233", vendor: "Imported override", source: "custom-vendors.csv" },
    { prefix: "445566", vendor: "Learned override", source: "Обучено по локальной истории" },
  ]);
  await database.importOui([
    { prefix: "AABBCC", vendor: "Updated legacy seed", source: "Встроенный IEEE OUI" },
    { prefix: "DDEEFF", vendor: "Updated tagged seed", source: "Встроенный IEEE OUI" },
    { prefix: "112233", vendor: "Must preserve imported", source: "Встроенный IEEE OUI" },
    { prefix: "445566", vendor: "Must preserve learned", source: "Встроенный IEEE OUI" },
    { prefix: "778899", vendor: "New assignment", source: "Встроенный IEEE OUI" },
  ], { overwriteSources: ["Пользовательский справочник", "Встроенный IEEE OUI"] });
  assert.deepEqual((await database.ouiPage({ limit: 10 })).rows.map(({ prefix, vendor, source }) => ({ prefix, vendor, source })), [
    { prefix: "112233", vendor: "Imported override", source: "custom-vendors.csv" },
    { prefix: "445566", vendor: "Learned override", source: "Обучено по локальной истории" },
    { prefix: "778899", vendor: "New assignment", source: "Встроенный IEEE OUI" },
    { prefix: "AABBCC", vendor: "Updated legacy seed", source: "Встроенный IEEE OUI" },
    { prefix: "DDEEFF", vendor: "Updated tagged seed", source: "Встроенный IEEE OUI" },
  ]);
});

test("legacy 2026.10 IEEE seed refresh changes only exact old seed values", async () => {
  const database = new Database(`oui-legacy-seed-refresh-${crypto.randomUUID()}`);
  await database.importOui([
    { prefix: "B4DB91", vendor: "CELESTICA INC." },
    { prefix: "3CDA6D", vendor: "My chosen Tiandy label" },
    { prefix: "001EB8", vendor: "Aloys, Inc", source: "custom-vendors.csv" },
  ]);
  const legacySeedMatches = new Map([
    ["B4DB91", "CELESTICA INC."],
    ["3CDA6D", "Tiandy Technologies CO.,LTD"],
    ["001EB8", "Aloys, Inc"],
  ]);
  await database.importOui([
    { prefix: "B4DB91", vendor: "Celestica Platform and Cloud Solution Malaysia Sdn Bhd", source: "Встроенный IEEE OUI" },
    { prefix: "3CDA6D", vendor: "Tiandy Technologies Co.,LTD", source: "Встроенный IEEE OUI" },
    { prefix: "001EB8", vendor: "ATLAS LINK INC.", source: "Встроенный IEEE OUI" },
  ], { overwriteSources: ["Встроенный IEEE OUI"], legacySeedMatches });
  assert.deepEqual((await database.ouiPage({ limit: 10 })).rows.map(({ prefix, vendor, source }) => ({ prefix, vendor, source })), [
    { prefix: "001EB8", vendor: "Aloys, Inc", source: "custom-vendors.csv" },
    { prefix: "3CDA6D", vendor: "My chosen Tiandy label", source: "Пользовательский справочник" },
    { prefix: "B4DB91", vendor: "Celestica Platform and Cloud Solution Malaysia Sdn Bhd", source: "Встроенный IEEE OUI" },
  ]);
});

test("OUI rule pages use a bounded prefix cursor and support source-aware search", async () => {
  const database = new Database(`oui-pages-${crypto.randomUUID()}`);
  await database.importOui([
    { prefix: "001122", vendor: "Acme", source: "vendors-a.csv" },
    { prefix: "112233", vendor: "Other", source: "vendors-b.csv" },
    { prefix: "AABBCC", vendor: "Third", source: "vendors-c.csv" },
  ]);
  const originalGetAll = globalThis.IDBObjectStore.prototype.getAll;
  globalThis.IDBObjectStore.prototype.getAll = function forbiddenGetAll() { throw new Error("OUI rule paging must not materialize the full store"); };
  try {
    const first = await database.ouiPage({ limit: 2 });
    assert.deepEqual(first.rows.map(({ prefix }) => prefix), ["001122", "112233"]);
    assert.equal(first.hasMore, true);
    const last = await database.ouiPage({ afterPrefix: first.nextCursor, limit: 2 });
    assert.deepEqual(last.rows.map(({ prefix }) => prefix), ["AABBCC"]);
    assert.equal(last.hasMore, false);
    const search = await database.ouiPage({ query: "vendors-b.csv" });
    assert.deepEqual(search.rows.map(({ vendor }) => vendor), ["Other"]);
  } finally {
    globalThis.IDBObjectStore.prototype.getAll = originalGetAll;
  }
});

test("Final, Inventory and History are committed and restored", async () => {
  const database = new Database(`test-${crypto.randomUUID()}`);
  const first = [
    { id: "device-a", mac: "00:11:22:33:44:55", ip: "10.0.0.1", switchIp: "10.0.0.254", address: "Москва, офис 1", model: "A" },
    { id: "device-b", mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.2", model: "B" },
  ];
  await database.saveFinal({ id: "final-1", name: "First", createdAt: "2026-01-01T00:00:00Z", devices: first });
  await database.saveFinal({
    id: "final-2",
    name: "Second",
    createdAt: "2026-01-02T00:00:00Z",
    processingTimeMs: 1250,
    devices: [{ ...first[0], ip: "10.0.0.10" }],
    comparison: {
      modified: [{ after: { ...first[0], ip: "10.0.0.10" }, changes: [{ field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.10", timestamp: "2026-01-02T00:00:00Z" }] }],
      added: [],
      absent: [first[1]],
    },
  });
  const active = await database.activeSnapshot();
  assert.equal(active.id, "final-2");
  assert.equal(active.devices.length, 1);
  assert.equal(active.processingTimeMs, 1250);
  const inventory = await readInventory(database);
  assert.equal(inventory.length, 2);
  assert.equal(inventory.find((item) => item.id === "device-a").observationCount, 2);
  assert.equal(inventory.find((item) => item.id === "device-b").present, false);
  assert.equal(inventory.find((item) => item.id === "device-b").observationCount, 1);
  const history = (await database.historyPage("device-a")).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].newValue, "10.0.0.10");
  const evidence = await readSwitchAddressEvidence(database);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((item) => item.switchIp === "10.0.0.254" && item.address === "Москва, офис 1"));
});

test("Final switch-address evidence stays exact across chunked writes", async () => {
  const database = new Database(`switch-address-chunks-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `evidence-${index}`,
    mac: `00:11:22:${String(index >> 16).padStart(2, "0")}:${String((index >> 8) & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    switchIp: "10.0.0.1",
    address: index === 499 || index === 500 ? "Repeated address" : `Address ${index}`,
  }));
  await database.saveFinal({ id: "switch-address-chunked-final", devices, updateInventory: false });

  const evidence = await readStore(database, "switchAddressEvidence");
  assert.equal(evidence.length, 1_204);
  assert.equal(evidence.find(({ address }) => address === "Repeated address").deviceCount, 2);
  assert.deepEqual(evidence.find(({ address }) => address === "Repeated address").sampleMacs, [devices[499].mac, devices[500].mac]);
});

test("streamed Final comparison writes exact History and Inventory absences atomically", async () => {
  const database = new Database(`streamed-history-${crypto.randomUUID()}`);
  const previous = [
    { id: "stream-modified", mac: "00:11:22:33:44:01", ip: "10.0.0.1" },
    { id: "stream-absent", mac: "00:11:22:33:44:02", model: "Old" },
  ];
  const current = [
    { id: "stream-modified", mac: "00:11:22:33:44:01", ip: "10.0.0.10" },
    { id: "stream-added", mac: "00:11:22:33:44:03", model: "New" },
  ];
  await database.saveFinal({ id: "stream-before", createdAt: "2026-01-01T00:00:00Z", devices: previous });
  const previousIdentityIndex = buildIdentityIndex(previous);
  const comparisonStream = createFinalHistoryComparisonStream(previous, "2026-01-02T00:00:00Z", { previousIdentityIndex });
  await database.saveFinal({ id: "stream-after", createdAt: "2026-01-02T00:00:00Z", devices: current, comparisonStream, consumeDevices: true });
  assert.equal(current.length, 0, "successful chunked persistence releases consumed output devices");
  const history = await readStore(database, "history");
  assert.deepEqual(history.map(({ type, deviceId, field, newValue }) => [type, deviceId, field || "", newValue || ""]).sort(), [
    ["absent", "stream-absent", "", ""],
    ["added", "stream-added", "", ""],
    ["modified", "stream-modified", "ip", "10.0.0.10"],
  ]);
  assert.equal((await readInventory(database)).find(({ id }) => id === "stream-absent").present, false);
  assert.equal((await database.activeSnapshotMetadata()).id, "stream-after");
});

test("staged History plans stream into the Final transaction and roll back with a failed commit", async () => {
  const database = new Database(`history-plan-atomic-${crypto.randomUUID()}`);
  const before = [
    { id: "plan-modified", mac: "00:11:22:33:44:11", ip: "10.0.0.1" },
    { id: "plan-absent", mac: "00:11:22:33:44:12", model: "Old" },
  ];
  const after = [
    { id: "plan-modified", mac: "00:11:22:33:44:11", ip: "10.0.0.10" },
    { id: "plan-added", mac: "00:11:22:33:44:13", model: "New" },
  ];
  await database.saveFinal({ id: "history-plan-before", createdAt: "2026-01-01T00:00:00Z", devices: before });
  const queryId = `history-plan:${crypto.randomUUID()}`;
  await database.appendFinalHistoryPlanEvents(queryId, [
    { type: "modified", row: { after: { id: "plan-modified", mac: after[0].mac }, changes: [{ field: "ip", label: "IP устройства", oldValue: "10.0.0.1", newValue: "10.0.0.10", timestamp: "2026-01-02T00:00:00Z" }] } },
    { type: "added", device: { id: "plan-added", mac: after[1].mac } },
    { type: "absent", device: { id: "plan-absent", mac: before[1].mac } },
  ]);
  await database.saveFinal({ id: "history-plan-after", createdAt: "2026-01-02T00:00:00Z", devices: after, historyPlanId: queryId, historyPlanEventCount: 3 });

  const history = await readStore(database, "history");
  assert.deepEqual(history.map(({ type, deviceId, field, newValue }) => [type, deviceId, field || "", newValue || ""]).sort(), [
    ["absent", "plan-absent", "", ""],
    ["added", "plan-added", "", ""],
    ["modified", "plan-modified", "ip", "10.0.0.10"],
  ]);
  assert.equal((await readInventory(database)).find(({ id }) => id === "plan-absent").present, false);
  assert.equal((await readInventory(database)).find(({ id }) => id === "plan-added").present, true);
  assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId: id }) => id === queryId), false);

  const failedQueryId = `history-plan:${crypto.randomUUID()}`;
  await database.appendFinalHistoryPlanEvents(failedQueryId, [{ type: "added", device: { id: "should-not-commit", mac: "AA:BB:CC:DD:EE:FF" } }]);
  await assert.rejects(database.saveFinal({
    id: "history-plan-failed",
    devices: [{ id: "another-device", mac: "AA:BB:CC:DD:EE:01" }],
    historyPlanId: failedQueryId,
    historyPlanEventCount: 2,
  }), /temporary plan|History/i);
  assert.equal(await database.getSetting("activeSnapshotId"), "history-plan-after");
  assert.equal((await readStore(database, "history")).some(({ snapshotId }) => snapshotId === "history-plan-failed"), false);
  assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId: id }) => id === failedQueryId), true);
  await database.clearAnalyticsAggregateQuery(failedQueryId);
});

test("History plan commit refuses a Previous Final changed after the plan was staged", async () => {
  const database = new Database(`history-plan-baseline-revision-${crypto.randomUUID()}`);
  const baseline = await database.saveFinal({ id: "history-plan-revision-baseline", devices: [{ id: "baseline-device", mac: "00:11:22:33:44:21" }] });
  const signature = finalAnalyticsIndexSignature(baseline);
  const queryId = `history-plan:${crypto.randomUUID()}`;
  await database.appendFinalHistoryPlanEvents(queryId, [{ type: "added", device: { id: "new-device", mac: "00:11:22:33:44:22" } }]);
  const db = await database.open();
  const tx = db.transaction("snapshots", "readwrite");
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const request = tx.objectStore("snapshots").get(baseline.id);
  request.onsuccess = () => tx.objectStore("snapshots").put({ ...request.result, dataRevision: Number(request.result.dataRevision || 0) + 1 });
  await done;

  await assert.rejects(database.saveFinal({
    id: "history-plan-revision-rejected",
    devices: [{ id: "new-device", mac: "00:11:22:33:44:22" }],
    historyPlanId: queryId,
    historyPlanEventCount: 1,
    historyPlanBaselineId: baseline.id,
    historyPlanBaselineSignature: signature,
  }), /Previous Final изменился/);
  assert.equal(await database.getSetting("activeSnapshotId"), baseline.id);
  assert.equal((await readStore(database, "history")).some(({ snapshotId }) => snapshotId === "history-plan-revision-rejected"), false);
  assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId: id }) => id === queryId), true);
  await database.clearAnalyticsAggregateQuery(queryId);
  db.close();
});

test("streamed Final identity diagnostics persist exact counts and bounded sample identities", async () => {
  const database = new Database(`streamed-history-diagnostics-${crypto.randomUUID()}`);
  const previous = [
    { id: "ambiguous-a", deviceId: "shared-device-id", mac: "00:11:22:33:44:01" },
    { id: "ambiguous-b", deviceId: "shared-device-id", mac: "00:11:22:33:44:02" },
    { id: "conflict-id", deviceId: "old-device-id", mac: "00:11:22:33:44:03" },
    { id: "conflict-alternative", deviceId: "new-device-id", mac: "00:11:22:33:44:04" },
  ];
  await database.saveFinal({ id: "diagnostics-before", devices: previous });
  const current = [
    { deviceId: "shared-device-id", mac: "00:11:22:33:44:05" },
    { id: "conflict-id", deviceId: "new-device-id", mac: "00:11:22:33:44:03" },
  ];
  const metadata = await database.saveFinal({
    id: "diagnostics-after",
    devices: current,
    diagnostics: { counts: { finalUnique: current.length } },
    comparisonStream: createFinalHistoryComparisonStream(previous, "2026-01-02T00:00:00Z", { previousIdentityIndex: buildIdentityIndex(previous) }),
    updateInventory: false,
  });
  const diagnostics = metadata.diagnostics.historyComparison;
  assert.deepEqual([diagnostics.ambiguousCount, diagnostics.identityConflictCount, diagnostics.diagnosticSamplesTruncated], [2, 1, 0]);
  assert.deepEqual(diagnostics.diagnosticSamples.map(({ type }) => type), ["ambiguous", "identity-conflict"]);
  assert.deepEqual((await database.listSnapshots()).find(({ id }) => id === "diagnostics-after").diagnostics.historyComparison, diagnostics);
  assert.deepEqual((await readStore(database, "history")).map(({ type }) => type), []);
});

test("consuming Final saves preserve chunk order and exact metadata while releasing each committed batch", async () => {
  const database = new Database(`consume-final-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_001 }, (_, index) => ({ id: `consume-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}` }));
  Object.defineProperty(devices, "slice", { value() { throw new Error("consuming writes must sanitize the source range without a second chunk reference array"); } });
  const metadata = await database.saveFinal({ id: "consume-final", devices, consumeDevices: true, updateInventory: false });
  assert.equal(devices.length, 0);
  assert.equal(metadata.deviceCount, 1_001);
  assert.equal(metadata.chunkCount, 3);
  const restored = [];
  await database.forEachSnapshotChunk(metadata.id, (chunk) => restored.push(...chunk));
  assert.equal(restored.length, 1_001);
  assert.equal(restored[0].id, "consume-0");
  assert.equal(restored.at(-1).id, "consume-1000");
});

test("a consuming Final write failure after an earlier chunk keeps the old active Final atomic", async () => {
  const database = new Database(`consume-final-abort-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "consume-kept", devices: [{ id: "kept", mac: "00:11:22:33:44:55" }] });
  const devices = Array.from({ length: 1_001 }, (_, index) => ({ id: `consume-fail-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}` }));
  const objectStorePut = globalThis.IDBObjectStore.prototype.put;
  globalThis.IDBObjectStore.prototype.put = function failSecondConsumedChunk(value, key) {
    if (this.name === "snapshotChunks" && value?.snapshotId === "consume-rejected" && value.index === 1) {
      throw new globalThis.DOMException("Injected DataCloneError", "DataCloneError");
    }
    return objectStorePut.call(this, value, key);
  };
  try {
    await assert.rejects(database.saveFinal({ id: "consume-rejected", devices, consumeDevices: true }), /DataCloneError/);
  } finally {
    globalThis.IDBObjectStore.prototype.put = objectStorePut;
  }
  assert.equal(devices.length, 1_001);
  assert.ok(devices.slice(0, 500).every((device) => device === null), "the first chunk is released before the second chunk fails");
  assert.equal(devices[500].id, "consume-fail-500", "the failing chunk remains available");
  assert.equal(await database.getSetting("activeSnapshotId"), "consume-kept");
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["consume-kept"]);
  assert.deepEqual((await readInventory(database)).map(({ id }) => id), ["kept"]);
  assert.equal((await readStore(database, "history")).length, 0);
});

test("streamed comparison failure aborts Final, History, Inventory, and active pointer together", async () => {
  const database = new Database(`streamed-history-abort-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "stream-abort-before", devices: [{ id: "preserved", mac: "00:11:22:33:44:01" }] });
  await assert.rejects(database.saveFinal({
    id: "stream-abort-after",
    devices: [{ id: "new-device", mac: "00:11:22:33:44:02" }],
    comparisonEvents: () => { throw new Error("comparison failure"); },
  }), /comparison failure/);
  assert.equal((await database.activeSnapshotMetadata()).id, "stream-abort-before");
  assert.equal((await readStore(database, "snapshots")).some(({ id }) => id === "stream-abort-after"), false);
  assert.equal((await readStore(database, "history")).length, 0);
  assert.equal((await readInventory(database)).some(({ id }) => id === "new-device"), false);
});

test("active Final metadata validates chunks without loading the device array", async () => {
  const database = new Database(`active-metadata-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 501 }, (_, index) => ({ id: `active-${index}`, mac: `00:11:22:33:44:${String(index % 256).padStart(2, "0")}` }));
  await database.saveFinal({ id: "active-metadata-final", devices });
  const metadata = await database.activeSnapshotMetadata();
  assert.equal(metadata.id, "active-metadata-final");
  assert.equal(metadata.deviceCount, devices.length);
  assert.equal(Object.hasOwn(metadata, "devices"), false);
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete([metadata.id, 1]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Chunk metadata test transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("Chunk metadata test transaction failed"));
  });
  assert.equal(await database.activeSnapshotMetadata(), null);
});

test("a partial IndexedDB Final cannot publish a Dashboard summary", async () => {
  const database = new Database(`partial-dashboard-${crypto.randomUUID()}`);
  const snapshotId = "partial-dashboard-final";
  await database.saveFinal({
    id: snapshotId,
    updateInventory: false,
    devices: Array.from({ length: 501 }, (_, index) => ({ id: `dashboard-${index}`, mac: `00:11:22:33:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}` })),
  });
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete([snapshotId, 1]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Partial Dashboard fixture transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("Partial Dashboard fixture transaction failed"));
  });

  let accepted = 0;
  let summaryPainted = false;
  let detailsScheduled = false;
  await assert.rejects(runAnalyticsInStages({
    calculatePair: async () => {
      await feedAnalyticsDatasetRows({
        snapshotId,
        visitChunks: (id, visit) => database.forEachSnapshotChunk(id, visit),
        accept: (chunk) => { accepted += chunk.length; },
      });
      return { comparison: { added: 0, modified: 0, absent: 0 } };
    },
    calculateDetails: async () => ({ details: [] }),
    isCurrent: () => true,
    paintSummary: () => { summaryPainted = true; },
    paintDetails: () => {},
    schedule: () => { detailsScheduled = true; },
  }), /Final-снимок повреждён: отсутствует или неполон блок 2/);
  assert.equal(accepted, 500, "the first chunk may be consumed internally before the missing chunk is discovered");
  assert.equal(summaryPainted, false, "partial comparison results never reach the Dashboard");
  assert.equal(detailsScheduled, false, "extended calculations do not run after a partial Final read");
});

test("Final catalog pages read only the requested chunk range across chunk boundaries", async () => {
  const database = new Database(`snapshot-page-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_120 }, (_, index) => ({ id: `device-${index}`, mac: `00:11:22:33:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`, model: `Model ${index}` }));
  await database.saveFinal({ id: "paged-final", name: "Paged Final", createdAt: "2026-04-01T00:00:00Z", devices });
  const page = await database.loadSnapshotPage("paged-final", { page: 5, limit: 120 });
  assert.equal(page.total, 1_120);
  assert.equal(page.page, 5);
  assert.equal(page.pageCount, 10);
  assert.equal(page.devices.length, 120);
  assert.equal(page.devices[0].id, "device-480");
  assert.equal(page.hasPrevious, true);
  assert.equal(page.hasNext, true);
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete(["paged-final", 2]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Chunk test transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("Chunk test transaction failed"));
  });
  assert.equal((await database.loadSnapshotPage("paged-final", { page: 1, limit: 120 })).devices.length, 120);
  await assert.rejects(database.loadSnapshotPage("paged-final", { page: 9, limit: 120 }), /блок 3/);
});

test("topology loads exact switch/port and unassigned device pages from snapshot chunks", async () => {
  const database = new Database(`topology-device-page-${crypto.randomUUID()}`);
  const devices = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `port-${index}`, mac: `00:11:22:33:44:0${index + 1}`, switchIp: "10.0.0.1", switchPort: "Gi1/0/1" })),
    { id: "other-port", mac: "00:11:22:33:44:10", switchIp: "10.0.0.1", switchPort: "Gi1/0/2" },
    ...Array.from({ length: 3 }, (_, index) => ({ id: `unassigned-${index}`, mac: `AA:BB:CC:DD:EE:0${index + 1}`, switchIp: "", switchPort: "Unknown" })),
  ];
  await database.saveFinal({ id: "topology-final", createdAt: "2026-06-01T00:00:00Z", devices });
  const secondPortPage = await database.loadSnapshotDevicePage("topology-final", { switchIp: "10.0.0.1", switchPort: "Gi1/0/1", page: 2, limit: 2 });
  assert.equal(secondPortPage.total, 5);
  assert.equal(secondPortPage.pageCount, 3);
  assert.deepEqual(secondPortPage.devices.map(({ id }) => id), ["port-2", "port-3"]);
  const secondUnassignedPage = await database.loadSnapshotDevicePage("topology-final", { unassigned: true, page: 2, limit: 2 });
  assert.equal(secondUnassignedPage.total, 3);
  assert.deepEqual(secondUnassignedPage.devices.map(({ id }) => id), ["unassigned-2"]);
});

test("analytics unassigned-room roster is read by exact bounded pages from Final chunks", async () => {
  const database = new Database(`unassigned-room-page-${crypto.randomUUID()}`);
  const devices = [
    ...Array.from({ length: 103 }, (_, index) => ({ id: `no-room-${index}`, mac: `00:11:22:${(index >> 16).toString(16).padStart(2, "0")}:${(index >> 8 & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}` })),
    { id: "room-assigned", mac: "AA:BB:CC:DD:EE:01", room: "101" },
    { id: "smartroom-assigned", mac: "AA:BB:CC:DD:EE:02", smartroomId: "SR-2" },
  ];
  await database.saveFinal({ id: "unassigned-final", devices });
  const second = await database.loadSnapshotUnassignedRoomPage("unassigned-final", { page: 2, limit: 50 });
  assert.equal(second.total, 103);
  assert.equal(second.pageCount, 3);
  assert.equal(second.devices.length, 50);
  assert.equal(second.devices[0].id, "no-room-50");
  const last = await database.loadSnapshotUnassignedRoomPage("unassigned-final", { page: 99, limit: 50 });
  assert.equal(last.page, 3);
  assert.equal(last.devices.length, 3);
  assert.equal(last.hasNext, false);
  assert.deepEqual(last.devices.map(({ id }) => id), ["no-room-100", "no-room-101", "no-room-102"]);
  const filtered = await database.loadSnapshotUnassignedRoomPage("unassigned-final", {
    page: 1,
    limit: 10,
    filters: { query: "no-room-10" },
  });
  assert.equal(filtered.total, 4);
  assert.deepEqual(filtered.devices.map(({ id }) => id), ["no-room-10", "no-room-100", "no-room-101", "no-room-102"]);
});

test("streamed added and absent Final pages match exact full comparison across IndexedDB chunks", async () => {
  const database = new Database(`absence-comparison-page-${crypto.randomUUID()}`);
  const previous = Array.from({ length: 1_203 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:${(index >> 16 & 255).toString(16).padStart(2, "0")}:${(index >> 8 & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    model: `Model ${index}`,
  }));
  const additions = Array.from({ length: 203 }, (_, index) => ({
    id: `new-${index}`,
    mac: `00:22:33:44:${(index >> 8 & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    model: `New model ${index}`,
  }));
  const current = [...previous.filter((_, index) => index % 3 === 0).map((device) => ({ ...device, ...(device.id.endsWith("0") ? { model: `${device.model} updated` } : {}) })), ...additions];
  await database.saveFinal({ id: "absence-before", devices: previous });
  await database.saveFinal({ id: "absence-after", devices: current });
  const baseline = [];
  await database.forEachSnapshotChunk("absence-before", (chunk) => baseline.push(...chunk));
  const expected = compareFinals(previous, current).absent;
  const page = await compareFinalAbsencePage(
    baseline,
    (visit) => database.forEachSnapshotChunk("absence-after", visit),
    { offset: 600, limit: 100 },
  );
  assert.equal(page.total, expected.length);
  assert.equal(page.devices.length, 100);
  assert.deepEqual(page.devices.map(({ id }) => id), expected.slice(600, 700).map(({ id }) => id));
  assert.equal(page.hasPrevious, true);
  assert.equal(page.hasNext, true);
  const expectedAdded = compareFinals(previous, current).added;
  const addedPage = await compareFinalAdditionPage(
    baseline,
    (visit) => database.forEachSnapshotChunk("absence-after", visit),
    { offset: 100, limit: 100 },
  );
  assert.equal(addedPage.total, expectedAdded.length);
  assert.equal(addedPage.devices.length, 100);
  assert.deepEqual(addedPage.devices.map(({ id }) => id), expectedAdded.slice(100, 200).map(({ id }) => id));
  assert.equal(addedPage.hasPrevious, true);
  assert.equal(addedPage.hasNext, true);
  const expectedChanges = compareFinals(previous, current).modified.flatMap((row) => row.changes);
  const modificationPage = await compareFinalModificationEventPage(
    baseline,
    (visit) => database.forEachSnapshotChunk("absence-after", visit),
    { offset: 3, limit: 25 },
  );
  assert.equal(modificationPage.total, expectedChanges.length);
  assert.deepEqual(modificationPage.events.map(({ device, change }) => `${device.id}:${change.field}`),
    compareFinals(previous, current).modified.flatMap((row) => row.changes.map((change) => `${row.after.id}:${change.field}`)).slice(3, 28));
});

test("Dashboard modified-device groups page chunked Final data without splitting device changes", async () => {
  const database = new Database(`dashboard-change-groups-${crypto.randomUUID()}`);
  const previous = Array.from({ length: 220 }, (_, index) => ({
    id: `dashboard-group-${index}`,
    deviceId: `dashboard-asset-${index}`,
    ip: `10.0.0.${index + 1}`,
    ...(index === 99 ? { model: "Before", room: "Room 1" } : {}),
  }));
  const current = previous.map((device, index) => ({
    ...device,
    ip: `10.1.0.${index + 1}`,
    ...(index === 99 ? { model: "After", room: "Room 2" } : {}),
  }));
  await database.saveFinal({ id: "dashboard-group-before", devices: previous });
  await database.saveFinal({ id: "dashboard-group-after", devices: current });
  const baseline = [];
  await database.forEachSnapshotChunk("dashboard-group-before", (chunk) => baseline.push(...chunk));
  const pages = [];
  for (let offset = 0; ; ) {
    const page = await compareFinalModificationDeviceGroupPage(
      baseline,
      (visit) => database.forEachSnapshotChunk("dashboard-group-after", visit),
      { offset, limit: 100 },
    );
    pages.push(page);
    if (!page.hasNext) break;
    offset += page.groups.length;
  }
  const groups = pages.flatMap((page) => page.groups);
  assert.deepEqual(pages.map(({ total, totalEvents, groups: pageGroups }) => [total, totalEvents, pageGroups.length]), [
    [220, 222, 100], [220, 222, 100], [220, 222, 20],
  ]);
  assert.equal(new Set(groups.map(({ device }) => device.deviceId)).size, 220);
  assert.deepEqual(groups[99].changes.map(({ field }) => field), ["ip", "room", "model"]);
});

test("room anomaly roster pages all matching devices and reconciles only a unique missing Smartroom ID", async () => {
  const database = new Database(`room-anomaly-page-${crypto.randomUUID()}`);
  const room = { smartroomId: "SR-1", businessUnit: "ЦА", city: "Москва", site: "Площадка", floor: "3", room: "Переговорная 1" };
  const devices = Array.from({ length: 205 }, (_, index) => ({
    id: `anomaly-${index}`,
    smartroomId: index === 202 ? "" : room.smartroomId,
    businessUnit: room.businessUnit,
    city: room.city,
    site: room.site,
    floor: room.floor,
    room: room.room,
    switchIp: index === 203 ? "999.0.0.1" : index === 204 ? "" : index < 151 ? "10.0.0.1" : "10.0.0.2",
  }));
  await database.saveFinal({ id: "room-anomaly-final", createdAt: "2026-07-01T00:00:00Z", devices });
  const anomaly = analyzeRoomSwitchAnomalies(devices)[0];
  const roomKey = locationKey(room);
  const pages = [];
  for (let page = 1; page <= 3; page += 1) pages.push(await database.loadSnapshotRoomAnomalyPage("room-anomaly-final", { roomKey, page, limit: 100 }));
  assert.deepEqual(pages.map((result) => result.total), [205, 205, 205]);
  assert.deepEqual(pages.map((result) => result.devices.length), [100, 100, 5]);
  assert.equal(pages[2].hasNext, false);
  const roster = pages.flatMap((result) => result.devices);
  assert.equal(new Set(roster.map(({ id }) => id)).size, 205);
  assert.equal(roster.length, anomaly.deviceCount);
  assert.equal(anomaly.deviationCount, 52);
  assert.equal(anomaly.dominantIp, "10.0.0.1");
  const switchCounts = new Map();
  let unknownSwitchIpCount = 0;
  for (const device of roster) {
    const switchIp = normalizeIp(device.switchIp);
    if (!switchIp) {
      unknownSwitchIpCount += 1;
      continue;
    }
    switchCounts.set(switchIp, (switchCounts.get(switchIp) || 0) + 1);
  }
  assert.equal(unknownSwitchIpCount, anomaly.missingSwitchDevices);
  assert.equal(Object.values(anomaly.switches).reduce((sum, count) => sum + count, 0), anomaly.deviceCount - anomaly.missingSwitchDevices);
  assert.deepEqual(Object.fromEntries([...switchCounts].sort(([left], [right]) => left.localeCompare(right))), anomaly.switches);
  assert.equal(roster.some((device) => device.id === "anomaly-202" && device.smartroomId === ""), true);
  assert.equal(roster.some((device) => device.id === "anomaly-203" && device.switchIp === "999.0.0.1"), true);
  assert.equal(roster.some((device) => device.id === "anomaly-204" && !device.switchIp), true);
  const ambiguousDatabase = new Database(`room-anomaly-ambiguous-${crypto.randomUUID()}`);
  await ambiguousDatabase.saveFinal({ id: "ambiguous-final", devices: [
    { ...room, id: "sr1", switchIp: "10.0.0.1" },
    { ...room, smartroomId: "SR-2", id: "sr2", switchIp: "10.0.0.1" },
    { ...room, smartroomId: "", id: "anonymous", switchIp: "10.0.0.2" },
  ] });
  const sr1 = await ambiguousDatabase.loadSnapshotRoomAnomalyPage("ambiguous-final", { roomKey, limit: 100 });
  assert.deepEqual(sr1.devices.map(({ id }) => id), ["sr1"]);
});

test("global history search filters by MAC, date, type, field and source with exact paged totals", async () => {
  const database = new Database(`history-search-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction(["history", "inventory"], "readwrite");
  const store = tx.objectStore("history");
  [
    { id: 1, timestamp: "2026-01-01T10:00:00.000Z", deviceId: "history-device", mac: "00:11:22:33:44:55", type: "modified", field: "room", label: "Помещение", source: "SmartRoom.xlsx" },
    { id: 2, timestamp: "2026-01-01T10:00:00.000Z", mac: "00:11:22:33:44:55", type: "modified", field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2", source: "Main.csv" },
    { id: 3, timestamp: "2026-01-02T10:00:00.000Z", mac: "AA:BB:CC:DD:EE:FF", type: "added", field: "device", label: "Устройство", source: "Main.csv" },
    { id: 4, timestamp: "2026-01-03T10:00:00.000Z", mac: "00:11:22:33:44:55", type: "modified", field: "room", label: "Помещение", source: "SmartRoom.xlsx" },
    { id: 5, timestamp: "2026-01-03T12:00:00.000Z", mac: "00:11:22:33:44:99", type: "absent", field: "device", label: "Устройство", source: "Main.csv" },
    { id: 6, timestamp: "2026-01-03T13:00:00.000Z", mac: "00:11:22:33:44:55", type: "modified", field: "switchPort", label: "Порт", oldValue: "1", newValue: "2", source: "Main.csv" },
  ].forEach((event) => store.put(event));
  tx.objectStore("inventory").put({ id: "history-device", mac: "00:11:22:33:44:55", alternateMacs: "00:11:22:33:44:66", manufacturer: "Acme", model: "Board", address: "Site A", room: "101" });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  const first = await database.historySearchPage({ mac: "001122", from: "2026-01-01", to: "2026-01-03", type: "modified", field: "помещ", source: "smartroom" }, { limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].id, 1);
  assert.equal(first.rows[0].device.manufacturer, "Acme");
  assert.equal(first.hasMore, true);
  const second = await database.historySearchPage({ mac: "001122", from: "2026-01-01", to: "2026-01-03", type: "modified", field: "помещ", source: "smartroom" }, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.total, 2);
  assert.equal(second.rows[0].id, 4);
  assert.equal(second.hasMore, false);
  const streamed = [];
  const streamedCount = await database.forEachHistorySearch({ mac: "001122", from: "2026-01-01", to: "2026-01-03", type: "modified", field: "помещ", source: "smartroom" }, (row) => streamed.push(row.id));
  assert.equal(streamedCount, 2);
  assert.deepEqual(streamed, [first.rows[0].id, second.rows[0].id]);
  const byAlternateMac = await database.historySearchPage({ mac: "001122334466" });
  assert.equal(byAlternateMac.total, 1);
  assert.equal(byAlternateMac.rows[0].id, 1);
  assert.equal(byAlternateMac.rows[0].device.alternateMacs, "00:11:22:33:44:66");
  const streamedAlternate = [];
  assert.equal(await database.forEachHistorySearch({ mac: "001122334466" }, (row) => streamedAlternate.push(row)), 1);
  assert.equal(streamedAlternate[0].id, 1);
  assert.equal(streamedAlternate[0].device.alternateMacs, "00:11:22:33:44:66");
  const byDeviceContext = await database.historySearchPage({ manufacturer: "acme", model: "board", room: "101" });
  assert.equal(byDeviceContext.total, 1);
  assert.equal(byDeviceContext.rows[0].id, 1);
  assert.equal(byDeviceContext.rows[0].device.room, "101");
  const dashboardSearch = await database.historySearchPage({ query: "board", manufacturer: "Acme", room: "101" });
  assert.equal(dashboardSearch.total, 1);
  assert.ok(dashboardSearch.rows.every(({ device }) => device?.manufacturer === "Acme" && device.room === "101"));
  const dashboardMacSearch = await database.historySearchPage({ query: "001122334455" });
  assert.equal(dashboardMacSearch.total, 4);
  const streamedDashboardMac = [];
  assert.equal(await database.forEachHistorySearch({ query: "001122334455" }, (row) => streamedDashboardMac.push(row.id)), 4);
  assert.deepEqual(streamedDashboardMac, [1, 2, 4, 6]);
  await assert.rejects(database.forEachHistorySearch({}, () => { throw new Error("visitor failed"); }), /visitor failed/);
  const critical = await database.historySearchPage({ from: "2026-01-01", to: "2026-01-03", severity: "critical" }, { limit: 1 });
  assert.equal(critical.total, 2);
  assert.equal(critical.rows[0].id, 2);
  assert.equal(critical.hasMore, true);
  const criticalNext = await database.historySearchPage({ from: "2026-01-01", to: "2026-01-03", severity: "critical" }, { cursor: critical.nextCursor, limit: 1 });
  assert.equal(criticalNext.rows[0].id, 5);
  assert.equal(criticalNext.total, 2);
  for (const filters of [
    { from: "2026-01-01", to: "2026-01-03" },
    { from: "2026-01-01", to: "2026-01-03", query: "board", manufacturer: "Acme", room: "101" },
  ]) {
    const [all, criticalCount, addedCount, absentCount, modifiedCount] = await Promise.all([
      database.historySearchPage(filters, { limit: 1 }),
      database.historySearchPage({ ...filters, severity: "critical" }, { limit: 1 }),
      database.historySearchPage({ ...filters, type: "added" }, { limit: 1 }),
      database.historySearchPage({ ...filters, type: "absent" }, { limit: 1 }),
      database.historySearchPage({ ...filters, type: "modified" }, { limit: 1 }),
    ]);
    const prototype = globalThis.IDBIndex.prototype;
    const originalOpenCursor = prototype.openCursor;
    let historyCursorOpens = 0;
    prototype.openCursor = function (...args) {
      if (this.objectStore.name === "history" && this.name === "by_timestamp") historyCursorOpens += 1;
      return originalOpenCursor.apply(this, args);
    };
    let counts;
    try {
      counts = await database.historyChangeCategoryCounts(filters);
    } finally {
      prototype.openCursor = originalOpenCursor;
    }
    assert.equal(historyCursorOpens, 1, "all five category totals are computed in one History cursor pass");
    assert.deepEqual(counts, {
      all: all.total,
      critical: criticalCount.total,
      added: addedCount.total,
      absent: absentCount.total,
      modified: modifiedCount.total,
    });
  }
  await database.setSetting("changeReportSettings", { mode: "period", from: "2026-01-01", to: "2026-01-31" });
  assert.deepEqual(await new Database(database.name).getSetting("changeReportSettings"), { mode: "period", from: "2026-01-01", to: "2026-01-31" });
  await assert.rejects(database.historySearchPage({ from: "2026-01-03", to: "2026-01-01" }), /Начальная дата позже конечной/);
});

test("selected history deletion removes only requested events and preserves Final and Inventory", async () => {
  const database = new Database(`history-delete-${crypto.randomUUID()}`);
  const first = [
    { id: "delete-a", mac: "00:11:22:33:44:55", ip: "10.0.0.1", room: "100" },
    { id: "delete-b", mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.2", room: "200" },
  ];
  await database.saveFinal({ id: "delete-final-1", name: "Before", createdAt: "2026-01-01T00:00:00Z", devices: first });
  await database.saveFinal({
    id: "delete-final-2", name: "After", createdAt: "2026-01-02T00:00:00Z", devices: [{ ...first[0], ip: "10.0.0.3" }],
    comparison: {
      modified: [{ before: first[0], after: { ...first[0], ip: "10.0.0.3" }, changes: [{ field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.3" }] }],
      added: [], absent: [first[1]],
    },
  });
  const events = await database.historyPage("delete-a");
  const activeBefore = await database.activeSnapshot();
  const inventoryBefore = await readInventory(database);
  assert.equal(await database.deleteHistoryEvents([events.rows[0].id, events.rows[0].id]), 1);
  assert.equal((await database.historyPage("delete-a")).total, 0);
  assert.equal((await database.historyPage("delete-b")).total, 1);
  const activeAfter = await database.activeSnapshot();
  assert.equal(activeAfter.id, activeBefore.id);
  assert.deepEqual(await readInventory(database), inventoryBefore);
  assert.equal(await database.deleteHistoryEvents([999999]), 0);
  await assert.rejects(database.deleteHistoryEvents([{}]), /Некорректный ID/);
});

test("filtered history deletion cursor-removes every matching event across pages and preserves other records", async () => {
  const database = new Database(`history-filter-delete-${crypto.randomUUID()}`);
  const db = await database.open();
  const tx = db.transaction(["history", "inventory"], "readwrite");
  tx.objectStore("inventory").put({ id: "filtered-delete-device", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board", room: "101" });
  const history = tx.objectStore("history");
  for (let index = 0; index < 230; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    history.put({
      timestamp,
      deviceId: "filtered-delete-device",
      mac: "00:11:22:33:44:55",
      type: index % 2 ? "modified" : "added",
      field: "room",
      label: "Помещение",
      source: index % 2 ? "SmartRoom.csv" : "Main.csv",
    });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  assert.equal((await database.historySearchPage({ source: "SmartRoom", manufacturer: "acme" }, { limit: 100 })).total, 115);
  assert.equal(await database.deleteHistoryEventsByFilters({ source: "SmartRoom", manufacturer: "acme" }), 115);
  assert.equal((await database.historySearchPage({ source: "SmartRoom", manufacturer: "acme" })).total, 0);
  assert.equal((await database.historySearchPage({ source: "Main", manufacturer: "acme" })).total, 115);
  assert.equal((await database.historySearchPage({ source: "SmartRoom", manufacturer: "other" })).total, 0);
  database.connection?.close();
  database.connection = null;
});

test("device history deletion cursor-removes every event for one ID and preserves Finals and Inventory", async () => {
  const database = new Database(`device-history-delete-${crypto.randomUUID()}`);
  const device = { id: "history-delete-device", mac: "00:11:22:33:44:55", ip: "10.0.0.1", room: "100" };
  const other = { id: "history-delete-other", mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.2", room: "200" };
  await database.saveFinal({ id: "device-delete-1", name: "Baseline", createdAt: "2026-01-01T00:00:00Z", devices: [device, other] });
  const changed = { ...device, ip: "10.0.0.3" };
  await database.saveFinal({
    id: "device-delete-2", name: "Changed", createdAt: "2026-01-02T00:00:00Z", devices: [changed, other],
    comparison: { modified: [{ before: device, after: changed, changes: [
      { field: "ip", label: "IP", oldValue: device.ip, newValue: changed.ip },
    ] }], added: [], absent: [] },
  });
  const changedAgain = { ...changed, mac: "00:11:22:33:44:56", room: "102" };
  await database.saveFinal({
    id: "device-delete-3", name: "Changed again", createdAt: "2026-01-03T00:00:00Z", devices: [changedAgain, other],
    comparison: { modified: [{ before: changed, after: changedAgain, changes: [
      { field: "mac", label: "MAC", oldValue: changed.mac, newValue: changedAgain.mac },
      { field: "room", label: "Помещение", oldValue: changed.room, newValue: changedAgain.room },
    ] }], added: [], absent: [] },
  });
  const activeBefore = await database.activeSnapshot();
  const snapshotsBefore = await database.listSnapshots();
  const inventoryBefore = await readInventory(database);
  assert.equal((await database.historyPage(device.id)).total, 3);
  const fullHistory = await database.historyPage(device.id, { limit: 10 });
  assert.deepEqual(new Set(fullHistory.rows.map(({ mac }) => mac)), new Set([device.mac, changedAgain.mac]));
  assert.equal((await database.historyPage(other.id)).total, 0);
  assert.equal(await database.deleteDeviceHistoryEvents(device.id), 3);
  assert.equal((await database.historyPage(device.id)).total, 0);
  assert.equal(await database.deleteDeviceHistoryEvents(device.id), 0);
  assert.equal((await database.activeSnapshot()).id, activeBefore.id);
  assert.deepEqual(await database.listSnapshots(), snapshotsBefore);
  assert.deepEqual(await readInventory(database), inventoryBefore);
  await assert.rejects(database.deleteDeviceHistoryEvents(""), /требуется ID устройства/);
});

test("switch IP can be compared with accumulated Inventory after a device missed a Final", async () => {
  const database = new Database(`switch-history-${crypto.randomUUID()}`);
  const oldDevice = { id: "switch-device", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1" };
  await database.saveFinal({
    id: "old-switch-final",
    name: "Old switch IP",
    createdAt: "2026-10-01T00:00:00Z",
    devices: [oldDevice],
  });
  await database.saveFinal({
    id: "intervening-final",
    name: "Device absent",
    createdAt: "2026-10-02T00:00:00Z",
    devices: [],
    comparison: { modified: [], added: [], absent: [oldDevice] },
  });
  const returningDevice = { ...oldDevice, id: "new-source-id", switchIp: "10.0.0.2", ip: "192.0.2.5", possibleIps: ["192.0.2.6"] };
  const records = await database.inventoryCandidatesForDevices([returningDevice, { id: "missing", mac: "00:11:22:33:44:99" }, returningDevice]);
  assert.deepEqual([...records.keys()], ["new-source-id"]);
  assert.equal(records.get("new-source-id").exactId, false);
  assert.equal(records.get("new-source-id").records[0].switchIp, "10.0.0.1");
  assert.equal(records.get("new-source-id").records[0].snapshotId, "old-switch-final");
  assert.equal(records.get("new-source-id").records[0].present, false);
  assert.deepEqual(compareSwitchIpHistory([
    returningDevice,
  ], records).map(({ previousIp, currentIp, deviceIp, possibleIps }) => ({ previousIp, currentIp, deviceIp, possibleIps })), [{
    previousIp: "10.0.0.1", currentIp: "10.0.0.2", deviceIp: "192.0.2.5", possibleIps: ["192.0.2.6"],
  }]);
});

test("Inventory candidate lookup yields bounded pages and clears each page after synchronous consumption", async () => {
  const database = new Database(`inventory-candidate-pages-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "inventory-page-final",
    name: "Inventory candidates",
    createdAt: "2026-10-18T00:00:00Z",
    devices: [
      { id: "page-device-a", mac: "00:11:22:33:44:01" },
      { id: "page-device-b", mac: "00:11:22:33:44:02" },
      { id: "page-device-c", mac: "00:11:22:33:44:03" },
    ],
  });
  const devices = ["page-device-a", "page-device-b", "page-device-c"].map((id) => ({ id }));
  const pages = [];
  const pageReferences = [];
  const returned = await database.inventoryCandidatesForDevices(devices, {
    batchSize: 2,
    onPage: (page, offset) => {
      pageReferences.push(page);
      pages.push({ offset, ids: [...page.keys()], size: page.size });
    },
  });
  assert.equal(returned.size, 0, "callback mode does not return a second full candidate map");
  assert.deepEqual(pages, [
    { offset: 0, ids: ["page-device-a", "page-device-b"], size: 2 },
    { offset: 2, ids: ["page-device-c"], size: 1 },
  ]);
  assert.deepEqual(pageReferences.map(({ size }) => size), [0, 0], "consumed page maps release their candidate records");

  const allCandidates = await database.inventoryCandidatesForDevices(devices);
  assert.deepEqual([...allCandidates.keys()], devices.map(({ id }) => id));
  assert.equal(allCandidates.size, 3);
});

test("Inventory candidate lookup can include exact-ID aliases for strong-conflict diagnostics", async () => {
  const database = new Database(`inventory-exact-aliases-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "inventory-exact-aliases-final", devices: [
    { id: "exact-record", deviceId: "asset-old", mac: "00:11:22:33:44:01" },
    { id: "alias-record", deviceId: "asset-current", mac: "00:11:22:33:44:02" },
  ] });
  const current = { id: "exact-record", deviceId: "asset-current", mac: "00:11:22:33:44:01" };
  const defaultCandidates = await database.inventoryCandidatesForDevices([current]);
  assert.deepEqual(defaultCandidates.get(current.id).records.map(({ id }) => id), ["exact-record"]);
  const conflictCandidates = await database.inventoryCandidatesForDevices([current], { includeExactAliases: true });
  assert.equal(conflictCandidates.get(current.id).exactId, true);
  assert.deepEqual(conflictCandidates.get(current.id).records.map(({ id }) => id), ["exact-record", "alias-record"]);
});

test("switch-IP history event stores DDIO possible IP context without modifying device IP", async () => {
  const database = new Database(`switch-ddio-history-${crypto.randomUUID()}`);
  const before = { id: "switch-ddio-device", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1", ip: "192.0.2.1" };
  await database.saveFinal({ id: "switch-ddio-1", name: "Before", createdAt: "2026-10-01T00:00:00Z", devices: [before] });
  const after = { ...before, switchIp: "10.0.0.2", possibleIps: ["192.0.2.10"], possibleIpsTruncated: false };
  await database.saveFinal({
    id: "switch-ddio-2", name: "After", createdAt: "2026-10-02T00:00:00Z", devices: [after],
    comparison: { modified: [{ before, after, changes: [{ field: "switchIp", label: "IP коммутатора", oldValue: before.switchIp, newValue: after.switchIp }] }], added: [], absent: [] },
  });
  const history = await database.historySearchPage({ mac: "001122334455" });
  const switchEvent = history.rows.find((item) => item.field === "switchIp");
  assert.deepEqual(switchEvent.possibleIps, ["192.0.2.10"]);
  assert.equal(switchEvent.oldValue, "10.0.0.1");
  assert.equal(switchEvent.newValue, "10.0.0.2");
  assert.equal(switchEvent.device.ip, "192.0.2.1");
});

test("Inventory resolves a returning device through its alternate MAC after a primary MAC change", async () => {
  const database = new Database(`alternate-mac-candidates-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "alternate-mac-old-final", name: "Old", createdAt: "2026-10-01T00:00:00Z",
    devices: [{ id: "old-id", mac: "00:11:22:33:44:55", alternateMacs: "00:11:22:33:44:66", switchIp: "10.0.0.1" }],
  });
  const returning = {
    id: "new-id", mac: "00:11:22:33:44:77", alternateMacs: "00:11:22:33:44:66", switchIp: "10.0.0.2",
  };
  const candidates = await database.inventoryCandidatesForDevices([returning]);
  assert.equal(candidates.get("new-id").exactId, false);
  assert.equal(candidates.get("new-id").records.length, 1);
  assert.deepEqual(compareSwitchIpHistory([returning], candidates).map(({ previousIp, currentIp }) => ({ previousIp, currentIp })), [
    { previousIp: "10.0.0.1", currentIp: "10.0.0.2" },
  ]);
});

test("manual IP mappings update the active Final in place and preserve known addresses", async () => {
  const database = new Database(`mapping-${crypto.randomUUID()}`);
  const devices = [
    { id: "fill", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1", address: "" },
    { id: "keep", mac: "00:11:22:33:44:66", switchIp: "10.0.0.1", address: "Текущий адрес" },
    { id: "other", mac: "00:11:22:33:44:77", switchIp: "10.0.0.2", address: "" },
  ];
  await database.saveFinal({ id: "same-final", name: "Current", createdAt: "2026-10-14T10:00:00Z", devices });
  const historyCache = { weekly: [], history: { snapshots: 1, deviceTotal: 3, uniqueMacs: 3 } };
  const signature = snapshotHistorySignature(await database.listSnapshots());
  assert.equal(await database.saveSnapshotHistoryCache(signature, historyCache), true);
  assert.equal(await database.saveAnalyticsCache("selected-final-dataset-v1", signature, { snapshotId: "same-final", dataset: { summary: { devices: 3 } } }), true);
  const beforeMetadata = (await database.listSnapshots())[0];
  const finalIndexSignature = finalAnalyticsIndexSignature(beforeMetadata);
  const compactDevices = [{ id: "fill", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1", address: "" }];
  assert.equal(await database.saveFinalAnalyticsIndex("same-final", finalIndexSignature, compactDevices), true);
  await database.saveIpAddressMappings([{ switchIp: "10.0.0.1", address: "Из правила", source: "Ручное правило" }]);
  const result = await database.applyIpAddressMappingsToActiveSnapshot();
  assert.equal(await database.loadSnapshotHistoryCache(signature), null);
  assert.equal(await database.loadAnalyticsCache("selected-final-dataset-v1", signature), null);
  assert.equal(await database.loadFinalAnalyticsIndex("same-final", finalIndexSignature), null);
  const afterMetadata = (await database.listSnapshots())[0];
  assert.equal(afterMetadata.dataRevision, 1);
  assert.notEqual(snapshotHistorySignature([afterMetadata]), signature);
  assert.notEqual(finalAnalyticsIndexSignature(afterMetadata), finalIndexSignature);
  assert.equal(await database.saveAnalyticsCache("selected-final-dataset-v1", signature, { snapshotId: "same-final", dataset: { summary: { devices: 3 } } }), false);
  assert.equal(await database.loadAnalyticsCache("selected-final-dataset-v1", snapshotHistorySignature([afterMetadata])), null);
  const final = await database.activeSnapshot();
  assert.deepEqual(result, { snapshotId: "same-final", filled: 1 });
  assert.equal(final.id, "same-final");
  assert.equal(final.createdAt, "2026-10-14T10:00:00Z");
  assert.equal(final.devices[0].address, "Из правила");
  assert.equal(final.devices[1].address, "Текущий адрес");
  assert.equal(final.devices[2].address, "");
  assert.equal((await readInventory(database)).find((item) => item.id === "fill").address, "Из правила");
  const archive = await readArchive(database);
  assert.ok(archive.settings.some((item) => item.key === "ipAddressMappings"));
});

test("manual IP mapping aborts without edits when active Final chunks are incomplete", async () => {
  const database = new Database(`mapping-broken-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "broken-final", name: "Broken", devices: [{ id: "a", switchIp: "10.0.0.1", address: "" }] });
  await database.saveIpAddressMappings([{ switchIp: "10.0.0.1", address: "New address" }]);
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete(["broken-final", 0]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  await assert.rejects(database.applyIpAddressMappingsToActiveSnapshot(), /Final повреждён/);
});

test("concurrent IP mapping deletions preserve every independent removal", async () => {
  const database = new Database(`ip-mapping-delete-${crypto.randomUUID()}`);
  await database.saveIpAddressMappings([
    { switchIp: "10.0.0.1", address: "Room 1" },
    { switchIp: "10.0.0.2", address: "Room 2" },
    { switchIp: "10.0.0.3", address: "Room 3" },
  ]);

  await Promise.all([
    database.deleteIpAddressMapping("10.0.0.1"),
    database.deleteIpAddressMapping("10.0.0.2"),
  ]);

  assert.deepEqual(await database.ipAddressMappings(), [
    { switchIp: "10.0.0.3", address: "Room 3", source: "Ручное правило" },
  ]);
});

test("concurrent IP mapping merges preserve new rules and auto-detection never overwrites a manual rule", async () => {
  const database = new Database(`ip-mapping-merge-${crypto.randomUUID()}`);
  await database.saveIpAddressMappings([{ switchIp: "10.0.0.1", address: "Manual address", source: "Ручное правило" }]);

  await Promise.all([
    database.mergeIpAddressMappings([{ switchIp: "10.0.0.2", address: "Imported 2", source: "File 2" }]),
    database.mergeIpAddressMappings([{ switchIp: "10.0.0.3", address: "Imported 3", source: "File 3" }]),
  ]);
  const merged = await database.mergeIpAddressMappings([
    { switchIp: "10.0.0.1", address: "Detected replacement", source: "Автоопределение" },
    { switchIp: "10.0.0.4", address: "Detected 4", source: "Автоопределение" },
  ], { overwriteExisting: false });

  assert.deepEqual(merged, [
    { switchIp: "10.0.0.1", address: "Manual address", source: "Ручное правило" },
    { switchIp: "10.0.0.2", address: "Imported 2", source: "File 2" },
    { switchIp: "10.0.0.3", address: "Imported 3", source: "File 3" },
    { switchIp: "10.0.0.4", address: "Detected 4", source: "Автоопределение" },
  ]);
});

test("IP mapping merge consumes an async record stream, deduplicates it, and preserves newer stored rules", async () => {
  const database = new Database(`ip-mapping-stream-${crypto.randomUUID()}`);
  await database.saveIpAddressMappings([{ switchIp: "10.0.0.1", address: "Manual", source: "Ручное правило" }]);
  async function* records() {
    yield { switchIp: "10.0.0.2", address: "Old import", source: "File" };
    yield { switchIp: "10.0.0.1", address: "Imported overwrite", source: "File" };
    yield { switchIp: "10.0.0.2", address: "Latest import", source: "File" };
    yield { switchIp: "invalid", address: "Rejected", source: "File" };
  }

  const merged = await database.mergeIpAddressMappings(records(), { overwriteExisting: false });
  assert.deepEqual(merged, [
    { switchIp: "10.0.0.1", address: "Manual", source: "Ручное правило" },
    { switchIp: "10.0.0.2", address: "Latest import", source: "File" },
  ]);
});

test("portable archive roundtrip keeps snapshots", async () => {
  const source = new Database(`source-${crypto.randomUUID()}`);
  const sourceMappingPreferences = {
    main: [{ headers: ["mac", "device id"], mapping: { mac: 1, deviceId: 0 } }],
    smartroom: [],
    ddio: [],
  };
  await source.setSetting("sourceMappingPreferences", sourceMappingPreferences);
  const original = new globalThis.Blob(["original csv"], { type: "text/csv" });
  const historyComparison = { ambiguousCount: 2, identityConflictCount: 1, diagnosticSamples: [{ type: "ambiguous", identity: "device-a", candidates: ["device-b"] }], diagnosticSamplesTruncated: 0 };
  await source.saveFinal({ id: "one", name: "One", processingTimeMs: 2100, diagnostics: { historyComparison }, devices: [{ id: "a", mac: "00:11:22:33:44:55", switchIp: "10.0.0.254", address: "Москва, офис 1" }], originalFiles: [{ role: "main", file: { name: "main.csv", type: original.type, size: original.size, slice: (...args) => original.slice(...args) } }] });
  await source.recordPerformanceMetric("enrichment", 2100, "2026-10-15T12:00:00Z");
  await source.recordApplicationLog("ui_error", "QuotaExceededError", "2026-10-15T12:00:01Z");
  const analysisResult = { filename: "standalone.csv", headers: ["MAC"], mapping: { mac: 0 }, mappingMode: "auto", detection: {}, summary: { rows: 1, valid: 1 }, devices: [{ id: "analysis-device", mac: "AA:BB:CC:DD:EE:FF" }], diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [], identityConflictCount: 0, duplicateRows: 0 } };
  await source.saveSingleAnalysis({ id: "standalone-analysis", filename: "standalone.csv", result: analysisResult, processedAt: "2026-10-15T12:00:00Z" });
  await source.attachSingleAnalysisSnapshot("standalone-analysis", "one");
  const archive = await readArchive(source);
  assert.equal(archive.inventory.find((item) => item.id === "a").observationCount, 1);
  assert.deepEqual(archive.snapshots.find(({ id }) => id === "one").diagnostics.historyComparison, historyComparison);
  const target = new Database(`target-${crypto.randomUUID()}`);
  await target.importArchive(archive);
  assert.deepEqual(await target.getSetting("sourceMappingPreferences"), sourceMappingPreferences);
  assert.equal((await target.listSnapshots()).length, 1);
  assert.deepEqual((await target.listSnapshots()).find(({ id }) => id === "one").diagnostics.historyComparison, historyComparison);
  assert.equal((await target.activeSnapshot()).devices[0].mac, "00:11:22:33:44:55");
  assert.equal((await target.activeSnapshot()).processingTimeMs, 2100);
  assert.equal((await target.performanceStatistics({ days: 7, now: Date.parse("2026-10-15T12:00:00Z") }))[0].averageMs, 2100);
  assert.deepEqual(await target.applicationLog(), [{ event: "ui_error", errorName: "QuotaExceededError", timestamp: "2026-10-15T12:00:01Z" }]);
  assert.equal((await readInventory(target)).find((item) => item.id === "a").observationCount, 1);
  assert.equal((await readSwitchAddressEvidence(target))[0].address, "Москва, офис 1");
  assert.equal(await target.getOriginalFile("one", "main").then((file) => file.blob.text()), "original csv");
  assert.deepEqual((await target.loadSingleAnalysis("standalone-analysis")).result.devices, analysisResult.devices);
  assert.equal((await target.loadSingleAnalysis("standalone-analysis")).finalSnapshotId, "one");
});

test("Final atomically retains and retrieves the original Main, SmartRoom, and DDIO file bytes", async () => {
  const database = new Database(`original-files-${crypto.randomUUID()}`);
  const sourceBlob = (name, contents, type) => {
    const blob = new globalThis.Blob([contents], { type });
    return { name, type, size: blob.size, lastModified: 1234, slice: (...args) => blob.slice(...args) };
  };
  const originals = [
    { role: "main", file: sourceBlob("main.csv", "device,mac\nA,00:11:22:33:44:55", "text/csv") },
    { role: "smartroom", file: sourceBlob("rooms.xlsx", "smartroom source", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") },
    { role: "ddio", file: sourceBlob("leases.txt", "reservation source", "text/plain") },
  ];
  await database.saveFinal({
    id: "originals-final",
    devices: [{ id: "device-a", mac: "00:11:22:33:44:55" }],
    sourceFiles: originals.map(({ role, file }) => ({ role, name: file.name, size: file.size })),
    originalFiles: originals,
  });
  assert.deepEqual((await database.listSnapshots())[0].originalFileRoles, ["ddio", "main", "smartroom"]);
  const originalGetAll = globalThis.IDBObjectStore.prototype.getAll;
  globalThis.IDBObjectStore.prototype.getAll = function (...args) {
    if (this.name === "originalFiles") throw new Error("Original-file metadata must be read with a cursor");
    return originalGetAll.apply(this, args);
  };
  let listedOriginals;
  try {
    listedOriginals = await database.listOriginalFiles("originals-final");
  } finally {
    globalThis.IDBObjectStore.prototype.getAll = originalGetAll;
  }
  assert.deepEqual(listedOriginals.map(({ role, name }) => [role, name]), [
    ["ddio", "leases.txt"], ["main", "main.csv"], ["smartroom", "rooms.xlsx"],
  ]);
  assert.ok(listedOriginals.every((item) => !Object.hasOwn(item, "blob")));
  const restored = await database.getOriginalFile("originals-final", "main");
  assert.equal(restored.name, "main.csv");
  assert.equal(restored.size, originals[0].file.size);
  assert.equal(await restored.blob.text(), "device,mac\nA,00:11:22:33:44:55");
  await assert.rejects(database.getOriginalFile("originals-final", "unknown"), /Неизвестная роль/);
  assert.equal(await database.getOriginalFile("originals-final", "smartroom").then((file) => file.blob.text()), "smartroom source");
  await assert.rejects(database.saveFinal({
    id: "oversize-source-final",
    devices: [{ id: "device-b" }],
    originalFiles: [{ role: "main", file: { name: "too-large.csv", size: 64 * 1024 * 1024 + 1, slice: () => new globalThis.Blob([]) } }],
  }), /превышает лимит 64 МиБ/);
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["originals-final"]);
  assert.equal(await database.getSetting("activeSnapshotId"), "originals-final");
});

test("reusing a source key never replaces the original bytes attached to its successful Final", async () => {
  const database = new Database(`source-key-original-${crypto.randomUUID()}`);
  const file = (contents) => {
    const blob = new globalThis.Blob([contents], { type: "text/csv" });
    return { name: "same.csv", type: blob.type, size: blob.size, slice: (...args) => blob.slice(...args) };
  };
  await database.saveFinal({ id: "source-final", sourceKey: "same-source", devices: [{ id: "original-device" }], originalFiles: [{ role: "main", file: file("input v1") }] });
  const reused = await database.saveFinal({ id: "new-id-must-not-win", sourceKey: "same-source", devices: [{ id: "different-device" }], originalFiles: [{ role: "main", file: file("input v2") }] });
  assert.equal(reused.id, "source-final");
  assert.equal(reused.reused, true);
  assert.equal(await database.getOriginalFile("source-final", "main").then((record) => record.blob.text()), "input v1");
  assert.deepEqual((await database.activeSnapshot()).devices.map(({ id }) => id), ["original-device"]);
});

test("single-file snapshots stay outside Final deduplication, recovery, and active selection", async () => {
  const database = new Database(`snapshot-kinds-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "kind-final", name: "Final source", sourceKey: "shared-source", createdAt: "2026-10-01T00:00:00Z", devices: [{ id: "final-device" }] });
  const analysis = await database.saveFinal({
    id: "kind-analysis", name: "Single file: source.csv", snapshotType: "single-analysis", sourceKey: "shared-source",
    createdAt: "2026-10-02T00:00:00Z", devices: [{ id: "analysis-device" }], activate: false, updateInventory: false,
  });
  const scheduled = await database.saveFinal({ id: "kind-scheduled", name: "Scheduled task: queue.csv", sourceKey: "scheduled-source", createdAt: "2026-10-03T00:00:00Z", devices: [{ id: "scheduled-device" }], activate: false, updateInventory: false });
  assert.equal(scheduled.snapshotType, "single-analysis", "legacy scheduled-file names must be normalized to the separate history");
  assert.equal(analysis.id, "kind-analysis", "source key reuse must be scoped to snapshot type");
  assert.equal((await database.findSnapshotBySourceKey("shared-source")).id, "kind-final");
  assert.equal((await database.findSnapshotBySourceKey("shared-source", { snapshotType: "single-analysis" })).id, "kind-analysis");
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["kind-final", "kind-analysis", "kind-scheduled"]);
  assert.equal((await database.activeSnapshot()).id, "kind-final");
  const restored = new Database(`snapshot-kinds-restore-${crypto.randomUUID()}`);
  await restored.importArchive(await readArchive(database));
  assert.equal((await restored.activeSnapshot()).id, "kind-final", "portable import must not activate the newest separate analysis");
  assert.equal((await restored.listSnapshots()).find(({ id }) => id === "kind-scheduled").snapshotType, "single-analysis");
  await database.setSetting("activeSnapshotId", "kind-analysis");
  assert.equal(await database.activeSnapshot(), null, "a stale pointer to a single analysis must not be exposed as active Final");
  assert.deepEqual(await database.recoverActiveSnapshot(), { snapshotId: "kind-final", recovered: true });
  const deleted = await database.deleteSnapshots(["kind-final"]);
  assert.equal(deleted.activeSnapshotId, "", "deleting the last Final must not promote a single analysis");
  assert.equal(await database.activeSnapshot(), null);
  assert.equal((await database.listSnapshots()).some(({ id }) => id === "kind-analysis"), true);
  assert.equal((await database.listSnapshots()).some(({ id }) => id === "kind-scheduled"), true);
  await assert.rejects(database.saveFinal({ id: "active-analysis-rejected", snapshotType: "single-analysis", devices: [] }), /не может стать активным Final/);
});

test("portable archive file import streams Final chunks into staging and restores additively", async () => {
  const source = new Database("stream-import-source-" + crypto.randomUUID());
  const devices = Array.from({ length: 1_101 }, (_, index) => ({
    id: "stream-device-" + index,
    mac: "02:01:00:" + Math.floor(index / 256).toString(16).padStart(2, "0") + ":" + (index % 256).toString(16).padStart(2, "0") + ":01",
    model: "Conference device",
  }));
  const streamOriginal = new globalThis.Blob(["streamed original source"], { type: "text/csv" });
  await source.saveFinal({ id: "stream-final", name: "Stream Final", createdAt: "2026-10-14T00:00:00Z", devices,
    originalFiles: [{ role: "main", file: { name: "stream.csv", type: streamOriginal.type, size: streamOriginal.size, slice: (...args) => streamOriginal.slice(...args) } }],
  });
  await source.saveFinal({ id: "stream-single-analysis", name: "Single file: later.csv", snapshotType: "single-analysis", createdAt: "2026-10-15T00:00:00Z", devices: [{ id: "analysis-only" }], activate: false, updateInventory: false });
  await source.setSetting("portableSetting", "kept");
  const archive = await readArchive(source);
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  let wholeReads = 0;
  const file = {
    name: "backup.madb", size: blob.size, slice: (...args) => blob.slice(...args),
    arrayBuffer: () => { wholeReads += 1; throw new Error("whole archive reads are forbidden"); },
    text: () => { wholeReads += 1; throw new Error("whole archive reads are forbidden"); },
  };
  const header = await inspectPortableArchiveHeader(file);
  const target = new Database("stream-import-target-" + crypto.randomUUID());
  const result = await target.importArchiveEvents(header, readPortableArchiveEvents(file));
  assert.equal(wholeReads, 0);
  assert.equal(result.snapshotCount, 2);
  assert.equal((await target.activeSnapshot()).devices.length, 1_101);
  assert.equal((await target.activeSnapshot()).id, "stream-final", "streamed archive import must not activate its newest single-file analysis");
  assert.equal((await target.listSnapshots()).find(({ id }) => id === "stream-single-analysis").snapshotType, "single-analysis");
  assert.equal(await target.getOriginalFile("stream-final", "main").then((file) => file.blob.text()), "streamed original source");
  assert.equal(await target.inventoryCount(), 1_101);
  assert.equal(await target.getSetting("portableSetting"), "kept");
  assert.equal((await target.listLocalArchives()).length, 0);
  const stagedRecordCount = async () => {
    const db = await target.open();
    const tx = db.transaction("archiveRecords", "readonly");
    const count = await new Promise((resolve, reject) => {
      const request = tx.objectStore("archiveRecords").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return count;
  };
  assert.equal(await stagedRecordCount(), 0);

  const invalidBlob = new globalThis.Blob([JSON.stringify({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    snapshots: [
      { id: "duplicate", devices: [{ id: "staged-only" }] },
      { id: "duplicate", devices: [{ id: "staged-only-2" }] },
    ],
  })]);
  const invalidFile = { size: invalidBlob.size, slice: (...args) => invalidBlob.slice(...args) };
  await assert.rejects(target.importArchiveEvents(
    await inspectPortableArchiveHeader(invalidFile), readPortableArchiveEvents(invalidFile),
  ), /повторяющийся ID Final/);
  assert.equal((await target.listSnapshots()).length, 2);
  assert.equal((await target.activeSnapshot()).id, "stream-final");
  assert.equal((await target.listLocalArchives()).length, 0);
  assert.equal(await stagedRecordCount(), 0);

  const malformedLaterSection = new globalThis.Blob([JSON.stringify({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    inventory: [{ id: "staged-before-validation-failure", lastSeen: "2026-10-15T00:00:00Z" }],
    history: [{ id: "invalid-history-date", timestamp: "2026-02-31T00:00:00Z" }],
  })]);
  const malformedLaterFile = { size: malformedLaterSection.size, slice: (...args) => malformedLaterSection.slice(...args) };
  await assert.rejects(target.importArchiveEvents(
    await inspectPortableArchiveHeader(malformedLaterFile), readPortableArchiveEvents(malformedLaterFile),
  ), /Некорректная запись History в архиве/);
  assert.equal((await target.listSnapshots()).length, 2, "invalid later archive data must not replace existing Finals");
  assert.equal((await target.activeSnapshot()).id, "stream-final");
  assert.equal(await target.inventoryCount(), 1_101, "valid earlier sections remain staged only and are never merged");
  assert.equal((await target.listLocalArchives()).length, 0);
  assert.equal(await stagedRecordCount(), 0, "failed streamed imports remove all staging rows");
});

test("streamed portable originals stage bounded Blob chunks instead of retaining decoded file buffers", async () => {
  const NativeBlob = globalThis.Blob;
  const chunkBytes = 192 * 1024;
  const fileBytes = Uint8Array.from({ length: chunkBytes * 2 + 17 }, (_, index) => index % 251);
  const original = new NativeBlob([fileBytes], { type: "text/csv" });
  const source = new Database(`bounded-original-source-${crypto.randomUUID()}`);
  await source.saveFinal({
    id: "bounded-original-final", devices: [],
    originalFiles: [{ role: "main", file: { name: "large.csv", type: original.type, size: original.size, slice: (...args) => original.slice(...args) } }],
  });
  const archive = await readArchive(source);
  const encoded = new NativeBlob([JSON.stringify(archive)]);
  const file = { size: encoded.size, slice: (...args) => encoded.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  const typedArrayWrites = [];
  const blobCompositions = [];
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, args) {
      const parts = args[0] || [];
      const byteParts = parts.filter((part) => part instanceof Uint8Array);
      if (byteParts.length) typedArrayWrites.push(byteParts.map((part) => part.byteLength));
      if (parts.length > 1 && parts.every((part) => part instanceof NativeBlob)) blobCompositions.push(parts.length);
      return Reflect.construct(target, args, target);
    },
  });
  try {
    const target = new Database(`bounded-original-target-${crypto.randomUUID()}`);
    await target.importArchiveEvents(header, readPortableArchiveEvents(file));
    const restored = await target.getOriginalFile("bounded-original-final", "main");
    assert.equal(restored.blob.size, original.size);
    assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), fileBytes);
  } finally {
    globalThis.Blob = NativeBlob;
  }
  assert.deepEqual(typedArrayWrites, [[chunkBytes], [chunkBytes], [17]], "each decoded archive buffer is wrapped and staged by itself");
  assert.deepEqual(blobCompositions, [3], "the final original is composed from staged Blob chunks");
});

test("reference MAC Analyzer v2 archive imports Final, Inventory, and movement history additively", async () => {
  const target = new Database("reference-archive-import-" + crypto.randomUUID());
  await target.saveFinal({ id: "local-final", name: "Local Final", createdAt: "2026-10-13T00:00:00Z", devices: [{ id: "local-device", mac: "00:11:22:33:44:52" }] });
  await target.setSetting("keep-local-setting", true);
  await target.saveIpAddressMappings([{ switchIp: "10.0.0.2", address: "Local room", source: "Local mapping" }]);
  await target.importOui([{ prefix: "001122", vendor: "Local vendor rule", source: "Пользовательский справочник" }]);
  await target.saveMac5Model("0011223344", "Local model rule");
  const reference = {
    format: "mac-analyzer-full-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    analytics: {}, workspace: {
      theme: "dark", historyEnrichmentSettings: { enabled: false, priorityHistory: false, useOuiMatch: false, useMac5Match: true }, dashboardSettings: {
        status: "changed", query: "MAC-101", vendor: "Reference vendor", room: "Conf A",
        changeMode: "period", changeDateFrom: "2026-10-01", changeDateTo: "2026-10-15",
      },
      visibleColumns: ["vendor", "macFormatted", "serialNumber", "oui"],
      columnOrder: ["macFormatted", "vendor", "oui", "serialNumber"],
      ouiLength: 5,
      files: [{ id: "imported-file", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01", fileDateSource: "filename", rowCount: 42, mapping: { mac: 0 } }],
      ipMappings: [{ switchIp: "10.0.0.1", address: "Reference room", source: "Reference mapping" }],
      localVendorMappings: { "001122": "Reference vendor rule" },
      localModelMappings: { "0011223344": "Reference model rule" },
    },
    currentDevices: [{ internalDeviceId: "CURRENT-1", mac: "00:11:22:33:44:61", vendor: "Current vendor" }],
    invalidRows: [{ rowNumber: 4, reason: "MAC is empty" }],
    allDevices: [{ internalDeviceId: "DEV-1", mac: "00:11:22:33:44:51", vendor: "Reference vendor", lastSeen: "2026-10-14T10:00:00Z" }],
    movementHistory: [{ mac: "00:11:22:33:44:51", type: "Изменено", field: "vendor", before: "Old", after: "Reference vendor", changedAt: "2026-10-14T12:00:00Z" }],
    snapshots: [{ metadata: { id: "reference-final", name: "Reference Final", source: "Main.csv", kind: "Final", fileCreatedAt: "2026-10-14T10:00:00Z", savedAt: "2026-10-14T10:01:00Z", deviceCount: 1, invalidCount: 0 }, devices: [{ internalDeviceId: "DEV-1", mac: "00:11:22:33:44:51", vendor: "Reference vendor", model: "Model A" }] }],
  };
  const blob = new globalThis.Blob([JSON.stringify(reference)]);
  const file = { name: "reference.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args), text: () => { throw new Error("archive import must stream"); } };
  const header = await inspectPortableArchiveHeader(file);
  const result = await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  assert.equal(result.snapshotCount, 2);
  assert.equal((await target.listSnapshots()).length, 2);
  assert.equal((await target.activeSnapshot()).id, "reference-final");
  const inventory = await readInventory(target);
  assert.deepEqual(new Set(inventory.map((item) => item.id)), new Set(["local-device", "DEV-1"]));
  assert.equal(inventory.find((item) => item.id === "DEV-1").manufacturer, "Reference vendor");
  assert.equal(await target.getSetting("keep-local-setting"), true);
  assert.equal(await target.getSetting("legacyAppSetting:theme"), "dark");
  assert.deepEqual(await target.getSetting("historyEnrichmentSettings"), {
    enabled: false, priorityHistory: false, precedenceProfile: "pyqt", useOuiMatch: false, useMac5Match: true,
  });
  assert.deepEqual(await target.getSetting("legacyAppSetting:sourceFiles"), [{
    id: "imported-file", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01", fileDateSource: "filename", rowCount: 42, mapping: { mac: 0 },
  }]);
  const importedColumnConfig = await target.getSetting("inventoryColumnConfig");
  assert.deepEqual(importedColumnConfig.columns.filter(({ key }) => ["rowNumber", "mac", "manufacturer", "oui5", "serial"].includes(key)).map(({ key, visible }) => [key, visible]), [
    ["rowNumber", true], ["mac", true], ["manufacturer", true], ["oui5", true], ["serial", true],
  ]);
  const importedDashboard = await target.getSetting("legacyAppSetting:dashboard");
  assert.deepEqual(legacyAnalyticsDashboardSettings(importedDashboard), {
    autoRefresh: true,
    refreshIntervalSeconds: 60,
    comparisonMode: "period",
    comparisonDateFrom: "2026-10-01",
    comparisonDateTo: "2026-10-15",
    filters: { query: "MAC-101", manufacturer: "Reference vendor", room: "Conf A", status: "changed" },
    widgets: {
      "kpi:devices": true, "kpi:modified": true, "kpi:absent": true, "kpi:unchanged": true,
      "kpi:manufacturers": true, "kpi:rooms": true, "chart:totals": true, "chart:vendors": true,
      "chart:fields": true, "chart:absent-vendors": true, "chart:presence-churn": true,
    },
  });
  assert.deepEqual(new Set((await target.ipAddressMappings()).map(({ switchIp }) => switchIp)), new Set(["10.0.0.1", "10.0.0.2"]));
  assert.equal((await target.ouiIndexForMacs(["00:11:22:33:44:61"])).get("001122"), "Local vendor rule", "archive import preserves a colliding local vendor rule");
  assert.equal((await target.mac5ModelsForMacs(["00:11:22:33:44:61"])).get("0011223344"), "Local model rule", "archive import preserves a colliding local model rule");
  const importedCurrentAnalysis = await target.loadSingleAnalysis("reference-current-20261015000000-1-1");
  assert.equal(importedCurrentAnalysis.deviceCount, 1);
  assert.equal(importedCurrentAnalysis.result.devices[0].id, "CURRENT-1");
  assert.equal(importedCurrentAnalysis.result.devices[0].manufacturer, "Current vendor");
  assert.deepEqual(importedCurrentAnalysis.result.diagnostics.invalid, [{ rowNumber: 4, reason: "MAC is empty" }]);
  const history = await readStore(target, "history");
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].type, history[0].field, history[0].oldValue, history[0].newValue], ["modified", "vendor", "Old", "Reference vendor"]);
  await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  assert.equal((await target.listSnapshots()).length, 2, "reimport must not duplicate the Final with the same stable ID");
  assert.equal((await target.listSingleAnalyses({ query: "MAC Analyzer Pro", limit: 100 })).total, 1, "reimport must not duplicate current analysis");
  assert.equal((await readInventory(target)).length, 2, "reimport must not duplicate Inventory identities");
  assert.equal((await readStore(target, "history")).length, 1, "reimport must not duplicate the same movement event");
});

test("reference MAC Analyzer v2 export streams compatible device aliases and restores into Next", async () => {
  const source = new Database(`reference-archive-export-${crypto.randomUUID()}`);
  const first = [{ id: "persistent-reference-device", deviceId: "DEVICE-1", mac: "00:11:22:33:44:51", alternateMacs: ["00:11:22:33:44:52"], manufacturer: "Old Vendor", model: "Board", ip: "192.0.2.51", switchIp: "198.51.100.1", switchPort: "Gi1/0/1", deviceType: "Codec", room: "Conf A" }];
  const second = [{ ...first[0], manufacturer: "Current Vendor" }];
  await source.saveFinal({ id: "reference-export-old", name: "Before", createdAt: "2026-10-14T10:00:00Z", source: "main-before.csv", devices: first });
  const comparison = compareFinals(first, second, "2026-10-15T10:00:00Z");
  await source.saveFinal({ id: "reference-export-current", name: "Current", createdAt: "2026-10-15T10:00:00Z", source: "main-current.csv", devices: second, comparison });
  await source.setSetting("theme", "dark");
  await source.setSetting("legacyAppSetting:historyEnrichment", {
    enabled: false, priorityHistory: false, precedenceProfile: "web", useOuiMatch: true, useMac5Match: false,
  });
  await source.setSetting("ipEnrichmentSettings", { enabled: false, partialMatch: false, overwrite: true });
  await source.setSetting("legacyAppSetting:sourceFiles", [{
    id: "source-file", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01",
    fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3 },
  }]);
  await source.setSetting("analyticsDashboardSettings", {
    autoRefresh: true,
    refreshIntervalSeconds: 45,
    comparisonMode: "period",
    comparisonDateFrom: "2026-10-01",
    comparisonDateTo: "2026-10-15",
    filters: { query: "Search text", manufacturer: "Vendor X", room: "Conf B", status: "missing" },
    widgets: { "kpi:devices": false, "chart:totals": false, "chart:presence-churn": false },
  });
  await source.setSetting("inventoryColumnConfig", { columns: [
    { key: "rowNumber", visible: true }, { key: "manufacturer", visible: true },
    { key: "oui5", visible: true }, { key: "serial", visible: false }, { key: "mac", visible: true },
  ] });
  await source.saveIpAddressMappings([{ switchIp: "192.0.2.1", address: "Conference A", source: "Manual" }]);
  await source.importOui([{ prefix: "AABBCC", vendor: "Archive vendor", source: "Пользовательский справочник" }]);
  await source.saveMac5Model("AABBCCDDEE", "Archive model");
  const [legacyInventoryRow] = await readInventory(source);
  legacyInventoryRow.alternateMacs = "00:11:22:33:44:52,00:11:22:33:44:51";
  const inventoryTx = (await source.open()).transaction("inventory", "readwrite");
  inventoryTx.objectStore("inventory").put(legacyInventoryRow);
  await new Promise((resolve, reject) => { inventoryTx.oncomplete = resolve; inventoryTx.onerror = () => reject(inventoryTx.error); inventoryTx.onabort = () => reject(inventoryTx.error); });

  const blob = await new globalThis.Response(source.exportReferenceArchiveStream()).blob();
  const archive = JSON.parse(await blob.text());
  assert.deepEqual([archive.format, archive.version], ["mac-analyzer-full-json", 2]);
  assert.deepEqual(archive.workspace.columnOrder, ["vendor", "oui", "serialNumber", "macFormatted"]);
  assert.deepEqual(archive.workspace.visibleColumns, ["vendor", "oui", "macFormatted"]);
  assert.equal(archive.workspace.ouiLength, 5);
  assert.deepEqual(archive.workspace.historyEnrichmentSettings, {
    enabled: false, priorityHistory: false, precedenceProfile: "web", useOuiMatch: true, useMac5Match: false,
  });
  assert.deepEqual(archive.workspace.ipEnrichmentSettings, { enabled: false, partialMatch: false, overwrite: true, historicalAddress: true });
  assert.deepEqual(archive.workspace.files, [{
    id: "source-file", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01",
    fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3 },
  }]);
  assert.equal(archive.snapshots.length, 2);
  assert.equal(archive.snapshots.at(-1).metadata.id, "reference-export-current");
  assert.equal(archive.currentDevices[0].internalDeviceId, "persistent-reference-device");
  assert.equal(archive.currentDevices[0].vendor, "Current Vendor");
  assert.equal(archive.currentDevices[0].ip, "192.0.2.51");
  assert.equal(archive.currentDevices[0].switchIp, "198.51.100.1");
  assert.equal(archive.currentDevices[0].mac2, "00:11:22:33:44:52");
  assert.equal(archive.allDevices[0].vendor, "Current Vendor");
  assert.equal(archive.allDevices[0].mac2, "00:11:22:33:44:52");
  assert.deepEqual(archive.allDevices[0].alternateMacs, ["00:11:22:33:44:52"]);
  assert.ok(archive.movementHistory.some((event) => event.field === "manufacturer" && event.after === "Current Vendor"));
  assert.deepEqual(archive.workspace.dashboardSettings, {
    autoRefresh: true,
    refreshInterval: 45,
    query: "Search text",
    vendor: "Vendor X",
    room: "Conf B",
    status: "missing",
    changeMode: "period",
    changeDateFrom: "2026-10-01",
    changeDateTo: "2026-10-15",
    visibleCards: { total: false, changed: true, missing: true, unchanged: true, vendors: true, rooms: true },
    visibleCharts: { dynamics: false, vendors: true, fields: true, missing: true, presenceChurn: false },
  });
  assert.deepEqual(archive.workspace.ipMappings, [{ switchIp: "192.0.2.1", address: "Conference A", source: "Manual" }]);
  assert.deepEqual(archive.workspace.localVendorMappings, { AABBCC: "Archive vendor" });
  assert.deepEqual(archive.workspace.localModelMappings, { AABBCCDDEE: "Archive model" });

  const file = { name: "next-export.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args), text: () => { throw new Error("archive import must stream"); } };
  const header = await inspectPortableArchiveHeader(file);
  const target = new Database(`reference-archive-export-roundtrip-${crypto.randomUUID()}`);
  const result = await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  assert.equal(result.snapshotCount, 2);
  assert.equal((await target.activeSnapshot()).id, "reference-export-current");
  assert.equal((await target.activeSnapshot()).devices[0].manufacturer, "Current Vendor");
  assert.deepEqual(await target.ipAddressMappings(), [{ switchIp: "192.0.2.1", address: "Conference A", source: "Manual" }]);
  assert.equal((await target.ouiIndexForMacs(["AA:BB:CC:DD:EE:01"])).get("AABBCC"), "Archive vendor");
  assert.equal((await target.mac5ModelsForMacs(["AA:BB:CC:DD:EE:01"])).get("AABBCCDDEE"), "Archive model");
  assert.equal((await readInventory(target)).length, 1);
  assert.equal(await target.getSetting("legacyAppSetting:theme"), "dark");
  assert.deepEqual(await target.getSetting("historyEnrichmentSettings"), archive.workspace.historyEnrichmentSettings);
  assert.deepEqual(await target.getSetting("ipEnrichmentSettings"), archive.workspace.ipEnrichmentSettings);
  assert.deepEqual(await target.getSetting("legacyAppSetting:sourceFiles"), archive.workspace.files);
  assert.deepEqual(legacyAnalyticsDashboardSettings(await target.getSetting("legacyAppSetting:dashboard")).filters,
    { query: "Search text", manufacturer: "Vendor X", room: "Conf B", status: "missing" });
  assert.equal(legacyAnalyticsDashboardSettings(await target.getSetting("legacyAppSetting:dashboard")).comparisonMode, "period");
  assert.equal(legacyAnalyticsDashboardSettings(await target.getSetting("legacyAppSetting:dashboard")).comparisonDateFrom, "2026-10-01");
  const roundTripColumnConfig = await target.getSetting("inventoryColumnConfig");
  assert.deepEqual(roundTripColumnConfig.columns.filter(({ key }) => ["mac", "manufacturer", "oui5", "serial"].includes(key)).map(({ key, visible }) => [key, visible]), [
    ["manufacturer", true], ["oui5", true], ["serial", false], ["mac", true],
  ]);
  assert.equal((await readStore(target, "history")).length, archive.movementHistory.length);
});

test("reference export streams the latest single analysis devices and invalid rows across chunk boundaries", async () => {
  const source = new Database(`reference-current-analysis-export-${crypto.randomUUID()}`);
  await source.saveFinal({
    id: "reference-current-analysis-final",
    createdAt: "2026-10-14T00:00:00Z",
    devices: [{ id: "final-device", mac: "00:11:22:33:44:01" }],
  });
  const devices = Array.from({ length: 501 }, (_, index) => ({
    id: `analysis-device-${index + 1}`,
    mac: `02:00:00:${String((index >> 16) & 255).padStart(2, "0")}:${String((index >> 8) & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
  }));
  const invalid = Array.from({ length: 503 }, (_, index) => ({ rowNumber: index + 2, reason: `Invalid row ${index + 1}` }));
  await source.saveSingleAnalysis({
    id: "latest-analysis",
    filename: "latest-source.csv",
    processedAt: "2026-10-15T00:00:00Z",
    result: {
      headers: ["MAC"], mapping: { mac: 0 }, detection: {}, mappingMode: "manual", summary: {}, devices,
      diagnostics: { invalid, invalidMacs: [], ambiguous: [], identityConflicts: [], identityConflictCount: 0, duplicateRows: 0 },
    },
  });

  const archive = JSON.parse(await new globalThis.Response(source.exportReferenceArchiveStream()).text());
  assert.equal(archive.currentDevices.length, 501);
  assert.equal(archive.currentDevices[500].internalDeviceId, "analysis-device-501");
  assert.equal(archive.invalidRows.length, 503);
  assert.deepEqual(archive.invalidRows[502], invalid[502]);

  const target = new Database(`reference-current-analysis-export-target-${crypto.randomUUID()}`);
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  const file = { name: "reference-current-roundtrip.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  const current = (await target.listSingleAnalyses({ query: "MAC Analyzer Pro", limit: 10 })).rows[0];
  assert.ok(current);
  assert.equal(current.deviceCount, 501);
  assert.equal(current.diagnosticCounts.invalid, 503);
  assert.deepEqual((await target.loadSingleAnalysis(current.id)).result.diagnostics.invalid, invalid);
  assert.equal((await target.activeSnapshot()).id, "reference-current-analysis-final");
});

test("reference current analysis archive import keeps device and invalid rows aligned across 500-row chunks", async () => {
  const reference = {
    format: "mac-analyzer-full-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    currentDevices: Array.from({ length: 501 }, (_, index) => ({
      internalDeviceId: `CURRENT-${index + 1}`,
      mac: `02:00:00:${String((index >> 16) & 255).padStart(2, "0")}:${String((index >> 8) & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    })),
    invalidRows: [{ rowNumber: 7, reason: "MAC is empty" }, { rowNumber: 9, reason: "MAC is malformed" }],
    snapshots: [],
  };
  const blob = new globalThis.Blob([JSON.stringify(reference)]);
  const file = { name: "reference-current.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  const target = new Database(`reference-current-analysis-chunks-${crypto.randomUUID()}`);
  await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  const imported = await target.loadSingleAnalysis("reference-current-20261015000000-501-2");
  assert.equal(imported.chunkCount, 2);
  assert.equal(imported.result.devices.length, 501);
  assert.equal(imported.result.devices[500].id, "CURRENT-501");
  assert.deepEqual(imported.result.diagnostics.invalid.map(({ rowNumber }) => rowNumber), [7, 9]);
});

test("reference device-export archive merges Inventory without changing the active Final", async () => {
  const target = new Database(`reference-device-export-${crypto.randomUUID()}`);
  await target.saveFinal({
    id: "active-before-device-export",
    createdAt: "2026-10-14T00:00:00Z",
    devices: [{ id: "LOCAL-1", mac: "00:11:22:33:44:72" }],
  });
  const reference = {
    format: "mac-analyzer-devices-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    devices: [{ internalDeviceId: "DEVICE-EXPORT-1", mac: "00:11:22:33:44:71", vendor: "Export vendor" }],
  };
  const blob = new globalThis.Blob([JSON.stringify(reference)]);
  const file = { name: "mac-analysis.json", size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  await target.importArchiveEvents(header, readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat }));
  assert.equal((await target.activeSnapshot()).id, "active-before-device-export");
  assert.equal((await target.listSnapshots()).length, 1);
  const inventory = await readInventory(target);
  assert.equal(inventory.length, 2);
  assert.equal(inventory.find((device) => device.id === "DEVICE-EXPORT-1").manufacturer, "Export vendor");
});

test("authentication timestamps persist in Final snapshots and portable archives", async () => {
  const source = new Database(`auth-time-source-${crypto.randomUUID()}`);
  const authenticationTime = "2025-12-09T12:00:00.000Z";
  await source.saveFinal({ id: "auth-time-final", devices: [{ id: "auth-time-device", mac: "00:11:22:33:44:55", authenticationTime }] });
  assert.equal((await source.activeSnapshot()).devices[0].authenticationTime, authenticationTime);
  const target = new Database(`auth-time-target-${crypto.randomUUID()}`);
  await target.importArchive(await readArchive(source));
  assert.equal((await target.activeSnapshot()).devices[0].authenticationTime, authenticationTime);
});

test("legacy SQLite restore merges snapshots and mappings without switching the active Final", async () => {
  const target = new Database(`sqlite-restore-${crypto.randomUUID()}`);
  await target.saveFinal({ id: "sqlite-local-active", createdAt: "2026-10-01T00:00:00Z", devices: [{ id: "local-device", mac: "00:11:22:33:44:55" }] });
  await target.saveIpAddressMappings([{ switchIp: "192.0.2.1", address: "Local address" }]);
  async function* events() {
    yield { type: "snapshotChunk", ordinal: 0, index: 0, devices: [{ id: "legacy-device", mac: "00:11:22:33:44:66" }] };
    yield { type: "snapshot", ordinal: 0, value: { id: "legacy-snapshot", name: "Imported snapshot", createdAt: "2026-10-15T00:00:00Z", deviceCount: 1, chunkCount: 1, schemaVersion: 1 } };
    yield { type: "records", collection: "inventory", records: [{ id: "legacy-device", mac: "00:11:22:33:44:66", ip: "198.51.100.6", firstSeen: "2026-10-15T00:00:00Z", lastSeen: "2026-10-15T00:00:00Z" }] };
    yield { type: "records", collection: "history", records: [{ id: "legacy-movement-1", type: "modified", mac: "00:11:22:33:44:66", deviceId: "", field: "switchIp", oldValue: "192.0.2.1", newValue: "192.0.2.2", timestamp: "2026-10-15T00:00:00Z", source: "Импорт SQLite" }] };
    yield { type: "records", collection: "settings", records: [{ key: "ipAddressMappings", value: [
      { switchIp: "192.0.2.1", address: "Imported conflict", source: "Импорт SQLite" },
      { switchIp: "192.0.2.2", address: "Imported address", source: "Импорт SQLite" },
    ] }] };
  }
  const result = await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events(), { preserveActiveSnapshot: true });
  assert.equal(result.activeSnapshotId, "sqlite-local-active");
  assert.equal((await target.getSetting("activeSnapshotId")), "sqlite-local-active");
  assert.ok((await target.listSnapshots()).some((snapshot) => snapshot.id === "legacy-snapshot"));
  const legacyHistory = await target.historySearchPage({ mac: "00:11:22:33:44:66" }, { limit: 10 });
  assert.equal(legacyHistory.total, 1);
  assert.equal(legacyHistory.rows[0].id, "legacy-movement-1");
  assert.equal(legacyHistory.rows[0].deviceId, "");
  assert.deepEqual(await target.ipAddressMappings(), [
    { switchIp: "192.0.2.1", address: "Local address", source: "Ручное правило" },
    { switchIp: "192.0.2.2", address: "Imported address", source: "Импорт SQLite" },
  ]);
  assert.ok((await readInventory(target)).some((device) => device.id === "legacy-device"));
});

test("SQLite source references stay local to fileHandles, resolve source namespaces, and stay out of archives", async () => {
  const target = new Database(`sqlite-source-reference-${crypto.randomUUID()}`);
  const sourceNamespace = "a".repeat(24);
  await target.recordLegacySqliteImportSource({ importId: "legacy-import-a", sourceIdbName: "sqlite-source-a.db", fileName: "customer.db", sourceBytes: 2048, integrity: "ok", sourceNamespace });
  const references = await readStore(target, "fileHandles");
  assert.deepEqual(references[0], {
    key: "legacySqliteImport:legacy-import-a",
    importId: "legacy-import-a",
    sourceIdbName: "sqlite-source-a.db",
    fileName: "customer.db",
    sourceBytes: 2048,
    integrity: "ok",
    sourceNamespace,
    importedAt: references[0].importedAt,
  });
  assert.equal(references.length, 2);
  assert.equal((await target.legacySqliteSourceForTask(`legacy-task-${sourceNamespace}-0123456789abcdef`)).sourceIdbName, "sqlite-source-a.db");
  assert.equal(await target.recordLegacySqliteImportSource({
    importId: "legacy-import-b", sourceIdbName: "sqlite-source-b.db", fileName: "customer.db", sourceBytes: 2048,
    integrity: "ok", sourceNamespace,
  }), "sqlite-source-a.db", "replacing a namespace returns the previous private SQLite copy for cleanup");
  assert.equal((await target.legacySqliteSourceForTask(`legacy-task-${sourceNamespace}-0123456789abcdef`)).sourceIdbName, "sqlite-source-b.db");
  assert.equal(await target.legacySqliteSourceForTask("legacy-task-other-0123456789abcdef"), null);
  const archive = await readArchive(target);
  assert.equal(archive.settings.some((item) => String(item.value || "").includes("sqlite-source-a.db")), false);
  assert.equal(await target.removeLegacySqliteImportSource(sourceNamespace), "sqlite-source-b.db");
  assert.equal(await target.legacySqliteSourceForTask(`legacy-task-${sourceNamespace}-0123456789abcdef`), null);
  assert.equal((await readStore(target, "fileHandles")).length, 0, "removing an unused source deletes both private reference records");
});

test("MAC timeline recovers prior values from persisted Final snapshots with missing fields", async () => {
  const database = new Database(`timeline-backfill-${crypto.randomUUID()}`);
  const mac = "00:11:22:33:44:55";
  const observations = [
    ["2026-04-01T00:00:00Z", "Model A"],
    ["2026-04-02T00:00:00Z", ""],
    ["2026-04-03T00:00:00Z", "Model A"],
    ["2026-04-04T00:00:00Z", ""],
    ["2026-04-05T00:00:00Z", "Model B"],
  ];
  for (const [createdAt, model] of observations) {
    await database.saveFinal({ createdAt, devices: [{ id: "timeline-device", mac, model, room: "301" }] });
  }
  const metadata = await database.listSnapshots();
  const snapshots = await Promise.all(metadata.map(({ id, ...snapshot }) => database.loadSnapshot(id).then(({ devices }) => ({ ...snapshot, devices }))));
  const events = buildMacTimeline(mac, snapshots);
  assert.equal(events.at(-1).changes.find((change) => change.field === "model").oldValue, "Model A");
  assert.equal(events[2].changes.some((change) => change.field === "model"), false);
});

test("large portable archive streams snapshot chunks and store records without getAll", async () => {
  const source = new Database(`stream-archive-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_100 }, (_, index) => ({
    id: `device-${String(index).padStart(3, "0")}`,
    mac: `02:00:00:${Math.floor(index / 65536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "2")}:${(index % 256).toString(16).padStart(2, "2")}`,
    manufacturer: "Vendor",
  }));
  await source.saveFinal({ id: "large-final", name: "Large", devices });

  const originalGetAll = globalThis.IDBObjectStore.prototype.getAll;
  globalThis.IDBObjectStore.prototype.getAll = function rejectFullStoreRead() {
    throw new Error("getAll must not be used by portable archive export");
  };
  let archive;
  try {
    archive = await readArchive(source);
  } finally {
    globalThis.IDBObjectStore.prototype.getAll = originalGetAll;
  }
  assert.equal(archive.snapshots[0].devices.length, 1_100);
  assert.equal(archive.inventory.length, 1_100);
  assert.equal(archive.snapshots[0].devices[1_099].id, "device-1099");
});

test("archive import preserves newer local Final, Inventory, settings and colliding History rows", async () => {
  const source = new Database(`archive-source-${crypto.randomUUID()}`);
  const archivedMappings = { main: [{ headers: ["mac", "id"], mapping: { mac: 0, deviceId: 1 } }], smartroom: [], ddio: [] };
  await source.setSetting("sourceMappingPreferences", archivedMappings);
  await source.saveFinal({
    id: "archive-final",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [{ id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Old Vendor", model: "Old Model" }],
    comparison: { added: [{ id: "device-a", mac: "00:11:22:33:44:55" }], modified: [], absent: [] },
  });
  const archive = await readArchive(source);
  archive.settings.push({ key: "userPreference", value: "archive" });

  const target = new Database(`archive-target-${crypto.randomUUID()}`);
  await target.saveFinal({
    id: "local-newer",
    createdAt: "2026-02-01T00:00:00Z",
    devices: [{ id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Current Vendor", model: "Current Model" }],
    comparison: { added: [{ id: "device-a", mac: "00:11:22:33:44:55" }], modified: [], absent: [] },
  });
  await target.setSetting("userPreference", "current");
  const localMappings = { main: [{ headers: ["mac", "name"], mapping: { mac: 0, hostname: 1 } }], smartroom: [], ddio: [] };
  await target.setSetting("sourceMappingPreferences", localMappings);
  await target.importArchive(archive);

  assert.equal((await target.getSetting("activeSnapshotId")), "local-newer");
  assert.equal((await target.getSetting("userPreference")), "current");
  assert.deepEqual(await target.getSetting("sourceMappingPreferences"), localMappings);
  const inventory = (await readInventory(target)).find((item) => item.id === "device-a");
  assert.equal(inventory.manufacturer, "Current Vendor");
  assert.equal(inventory.model, "Current Model");
  const history = (await target.historyPage("device-a")).rows;
  assert.equal(history.length, 2);
  assert.equal((await target.listSnapshots()).length, 2);

  const missingPointer = new Database(`archive-no-pointer-${crypto.randomUUID()}`);
  await missingPointer.saveFinal({ id: "newest-local", createdAt: "2026-03-01T00:00:00Z", devices: [] });
  await missingPointer.setSetting("activeSnapshotId", "");
  await missingPointer.importArchive(archive);
  assert.equal(await missingPointer.getSetting("activeSnapshotId"), "newest-local");
});

test("archive settings restore keeps existing values through add conflicts without per-key reads", async () => {
  const target = new Database(`archive-settings-add-${crypto.randomUUID()}`);
  await target.setSetting("userPreference", "local");
  const queriedKeys = [];
  const originalGet = globalThis.IDBObjectStore.prototype.get;
  globalThis.IDBObjectStore.prototype.get = function trackSettingsReads(key) {
    if (this.name === "settings") queriedKeys.push(key);
    return originalGet.call(this, key);
  };
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, (async function* () {
      yield { type: "records", collection: "settings", records: [
        { key: "userPreference", value: "archive" },
        { key: "archiveOnlyPreference", value: "imported" },
      ] };
    }()));
  } finally {
    globalThis.IDBObjectStore.prototype.get = originalGet;
  }
  assert.equal(await target.getSetting("userPreference"), "local");
  assert.equal(await target.getSetting("archiveOnlyPreference"), "imported");
  assert.equal(queriedKeys.includes("userPreference"), false);
  assert.equal(queriedKeys.includes("archiveOnlyPreference"), false);
  assert.ok(queriedKeys.includes("activeSnapshotId"));
});

test("restoring a stale empty portable archive preserves the browser Final, rules, IP and Smartroom mappings", async () => {
  const target = new Database(`stale-empty-directory-restore-${crypto.randomUUID()}`);
  await target.saveFinal({ id: "browser-final", createdAt: "2026-10-16T12:00:00Z", devices: [
    { id: "browser-device", mac: "00:11:22:33:44:55", smartroomId: "SR-BROWSER", room: "Browser room" },
  ] });
  await target.setSetting("theme", "dark");
  await target.setSetting("vendorDetectorSettings", { enabled: true, useOui3: true });
  await target.setSetting("ipEnrichmentSettings", { enabled: false, partialMatch: false, overwrite: true });
  await target.saveIpAddressMappings([{ switchIp: "192.0.2.254", address: "Browser address" }]);
  await target.importOui([{ prefix: "001122", vendor: "Browser Vendor", source: "Local reference" }]);
  await target.saveMac5Model("0011223344", "Browser Model");
  const localRoomMapping = (await target.smartroomRoomMappingsForIds(["SR-BROWSER"]))[0];
  assert.equal(localRoomMapping.sourceFinalId, "browser-final");

  async function* staleEmptyArchive() {
    yield { type: "records", collection: "settings", records: [
      { key: "activeSnapshotId", value: "" },
      { key: "theme", value: "" },
      { key: "vendorDetectorSettings", value: {} },
      { key: "ipEnrichmentSettings", value: { enabled: true, partialMatch: true, overwrite: false } },
      { key: "ipAddressMappings", value: [] },
    ] };
  }
  const result = await target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 },
    staleEmptyArchive(),
  );

  assert.equal(result.activeSnapshotId, "browser-final");
  assert.equal((await target.activeSnapshot()).devices[0].id, "browser-device");
  assert.equal(await target.getSetting("theme"), "dark");
  assert.deepEqual(await target.getSetting("vendorDetectorSettings"), { enabled: true, useOui3: true });
  assert.deepEqual(await target.getSetting("ipEnrichmentSettings"), { enabled: false, partialMatch: false, overwrite: true });
  assert.deepEqual(await target.ipAddressMappings(), [
    { switchIp: "192.0.2.254", address: "Browser address", source: "Ручное правило" },
  ]);
  assert.deepEqual((await target.ouiPage({ limit: 10 })).rows.map(({ prefix, vendor }) => ({ prefix, vendor })), [
    { prefix: "001122", vendor: "Browser Vendor" },
  ]);
  assert.equal((await target.mac5ModelPage({ limit: 10 })).rows[0].model, "Browser Model");
  assert.deepEqual(await target.smartroomRoomMappingsForIds(["SR-BROWSER"]), [localRoomMapping]);
});

test("invalid archive structure is rejected before any snapshot or database write", async () => {
  const target = new Database(`invalid-archive-${crypto.randomUUID()}`);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE",
    version: 1,
    snapshots: [{ id: "duplicate", devices: [] }, { id: "duplicate", devices: [] }],
  }), /повторяющийся ID Final/);
  assert.equal((await target.listSnapshots()).length, 0);
  const malformed = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, inventory: "not-an-array" };
  await assert.rejects(target.importArchive(malformed), /Некорректная структура архива/);
  assert.equal((await target.inventoryCount()), 0);
  const duplicateObservation = { id: "observation-duplicate", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T00:00:00Z", payload: { mac: "00:11:22:33:44:55" } };
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    legacyObservations: [duplicateObservation, duplicateObservation],
  }), /повторное legacy-наблюдение/);
  assert.equal((await target.legacyObservationPage({ kind: "mac_history" })).rows.length, 0);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE",
    version: 1,
    snapshots: [],
    smartroomRoomMappings: [{ smartroomIdKey: "sr-1", smartroomId: "SR-1", room: "Room", status: "confirmed", sourceFinalId: "missing-final", createdAt: "2026-01-01T00:00:00Z", alternatives: [{ room: "Room" }], sampleMacs: [] }],
  }), /свидетельство Smartroom/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    dataQualityReports: [{ id: "invalid-report", snapshotId: "missing-final", createdAt: "2026-02-31T10:00:00Z", score: 50, grade: "C", report: {} }],
  }), /Некорректный отчёт качества данных/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    legacySmartroomRoomMappings: [{ id: "sr-invalid\u0000SR-INVALID", smartroomId: "SR-INVALID", smartroomIdKey: "sr-invalid", room: "Room", source: "archive", updatedAt: "2026-02-31T10:00:00Z" }],
  }), /Некорректная legacy Smartroom-маппинг-запись/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    snapshots: [{ id: "invalid-date-final", createdAt: "2026-02-31T10:00:00Z", devices: [] }],
  }), /Некорректная структура Final/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    singleAnalyses: [{ id: "invalid-date-analysis", filename: "devices.csv", processedAt: "2026-02-31T10:00:00Z", deviceCount: 0, chunkCount: 0, storedRecordCounts: { invalid: 0, invalidMacs: 0, ambiguous: 0, identityConflicts: 0 } }],
  }), /Некорректные метаданные анализа одного файла/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    legacyObservations: [{ id: "invalid-date-observation", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-02-31T10:00:00Z", payload: {} }],
  }), /Некорректная запись legacy-наблюдения/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    inventory: [{ id: "invalid-date-inventory", lastSeen: "2026-02-31T10:00:00Z" }],
  }), /Некорректная запись Inventory/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    history: [{ snapshotId: "missing-final", timestamp: "2026-02-31T10:00:00Z" }],
  }), /Некорректная запись History/);
  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    snapshots: [{ id: "mapping-source-final", devices: [] }],
    smartroomRoomMappings: [{ smartroomIdKey: "sr-invalid", smartroomId: "SR-INVALID", room: "Room", status: "confirmed", sourceFinalId: "mapping-source-final", createdAt: "2026-02-31T10:00:00Z", alternatives: [], sampleMacs: [] }],
  }), /свидетельство Smartroom/);
  const invalidDateEvents = async function* () {
    yield { type: "snapshot", ordinal: 0, value: { id: "invalid-stream-date", createdAt: "2026-02-31T10:00:00Z", devices: [] } };
  };
  await assert.rejects(target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, invalidDateEvents()), /Некорректная структура Final/);
  const invalidInventoryEvents = async function* () {
    yield { type: "records", collection: "inventory", records: [{ id: "invalid-stream-inventory", updatedAt: "2026-02-31T10:00:00Z" }] };
  };
  await assert.rejects(target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, invalidInventoryEvents()), /Некорректная запись Inventory/);
  assert.equal((await target.inventoryCount()), 0);
  assert.equal((await target.dataQualityReportsPage()).total, 0);
  assert.deepEqual(await target.legacySmartroomRoomMappingsForIds(["SR-INVALID"]), []);
  assert.equal((await target.listSnapshots()).length, 0);
});

test("portable switch-address evidence requires its source Final in object and streaming archives", async () => {
  const target = new Database(`portable-switch-evidence-${crypto.randomUUID()}`);
  const evidence = {
    switchIp: "10.0.0.254", address: "Building A", snapshotId: "evidence-source-final",
    createdAt: "2026-10-15T12:00:00Z", deviceCount: 2, sampleMacs: ["00:11:22:33:44:55"],
  };

  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, snapshots: [], switchAddressEvidence: [evidence],
  }), /Некорректное свидетельство switch IP → адрес/);
  assert.equal((await target.listSnapshots()).length, 0);
  assert.deepEqual(await readStore(target, "switchAddressEvidence"), []);

  const invalidEvents = async function* () {
    yield { type: "snapshot", ordinal: 0, value: { id: "different-final", devices: [] } };
    yield { type: "records", collection: "switchAddressEvidence", records: [evidence] };
  };
  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, invalidEvents(),
  ), /Некорректное свидетельство switch IP → адрес/);
  assert.equal((await target.listSnapshots()).length, 0);
  assert.deepEqual(await readStore(target, "switchAddressEvidence"), []);

  const validArchive = {
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    snapshots: [{ id: evidence.snapshotId, createdAt: "2026-10-15T12:00:00Z", devices: [] }],
    switchAddressEvidence: [evidence],
  };
  await target.importArchive(validArchive);
  assert.deepEqual(await readStore(target, "switchAddressEvidence"), [evidence]);

  const validEvents = async function* () {
    yield { type: "records", collection: "switchAddressEvidence", records: [evidence] };
    yield { type: "snapshot", ordinal: 0, value: { id: evidence.snapshotId, createdAt: "2026-10-15T12:00:00Z", devices: [] } };
  };
  const streamed = new Database(`portable-switch-evidence-stream-${crypto.randomUUID()}`);
  await streamed.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, validEvents(),
  );
  assert.deepEqual(await readStore(streamed, "switchAddressEvidence"), [evidence]);
});

test("object portable import preserves colliding local switch-address evidence", async () => {
  const target = new Database(`portable-evidence-collision-${crypto.randomUUID()}`);
  await target.saveFinal({
    id: "evidence-collision-final", createdAt: "2026-10-15T12:00:00Z",
    devices: [{ id: "local-device", mac: "00:11:22:33:44:55", switchIp: "10.0.0.254", address: "Local room" }],
  });
  const local = (await readStore(target, "switchAddressEvidence"))[0];
  const conflicting = {
    ...local, snapshotName: "Imported replacement", deviceCount: local.deviceCount + 100,
    sampleMacs: ["AA:BB:CC:DD:EE:FF"],
  };

  await target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    snapshots: [{ id: local.snapshotId, createdAt: local.createdAt, devices: [] }],
    switchAddressEvidence: [conflicting],
  });

  assert.deepEqual(await readStore(target, "switchAddressEvidence"), [local]);
});

test("object portable archive import is idempotent for repeated History events", async () => {
  const source = new Database(`portable-history-idempotent-source-${crypto.randomUUID()}`);
  await source.saveFinal({
    id: "portable-history-idempotent-final", createdAt: "2026-10-15T12:00:00Z",
    devices: [{ id: "idempotent-device", mac: "00:11:22:33:44:55" }],
    comparison: { added: [{ id: "idempotent-device", mac: "00:11:22:33:44:55" }], modified: [], absent: [] },
  });
  const archive = await readArchive(source);
  const target = new Database(`portable-history-idempotent-target-${crypto.randomUUID()}`);

  await target.importArchive(archive);
  const firstImport = await readStore(target, "history");
  assert.equal(firstImport.length, 1);
  await target.importArchive(archive);

  assert.deepEqual(await readStore(target, "history"), firstImport);
});

test("object archive import deduplicates idless legacy History events without a Final reference", async () => {
  const target = new Database(`portable-idless-history-object-${crypto.randomUUID()}`);
  const archive = {
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    history: [
      { type: "modified", field: "room", before: "A", after: "B", mac: "00:11:22:33:44:55", timestamp: "2026-10-15T12:00:00Z" },
      { mac: "00:11:22:33:44:55", after: "10.0.0.2", field: "ip", before: "10.0.0.1", timestamp: "2026-10-15T12:00:00Z", type: "modified" },
    ],
  };

  await target.importArchive(archive);
  const firstImport = await readStore(target, "history");
  assert.equal(firstImport.length, 2);
  archive.history = archive.history.map((event) => Object.fromEntries(Object.entries(event).reverse()));
  await target.importArchive(archive);

  assert.deepEqual(await readStore(target, "history"), firstImport);
});

test("streamed archive import deduplicates idless legacy History events without a Final reference", async () => {
  const target = new Database(`portable-idless-history-stream-${crypto.randomUUID()}`);
  const event = { type: "modified", field: "room", before: "A", after: "B", mac: "00:11:22:33:44:55", timestamp: "2026-10-15T12:00:00Z" };
  const makeEvents = () => (async function* () {
    yield { type: "records", collection: "history", records: [event] };
  }());
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };

  await target.importArchiveEvents(header, makeEvents());
  const firstImport = await readStore(target, "history");
  assert.equal(firstImport.length, 1);
  await target.importArchiveEvents(header, makeEvents());

  assert.deepEqual(await readStore(target, "history"), firstImport);
});

test("streamed archive restores Inventory in bounded batches without losing imported devices", async () => {
  const target = new Database(`portable-inventory-batched-restore-${crypto.randomUUID()}`);
  const idb = await target.open();
  const nativeTransaction = idb.transaction.bind(idb);
  let inventoryImportTransactions = 0;
  idb.transaction = (stores, ...options) => {
    const names = Array.isArray(stores) ? stores : [stores];
    if (options[0] === "readwrite" && names.includes("inventory")) inventoryImportTransactions += 1;
    return nativeTransaction(stores, ...options);
  };
  const makeRecord = (index, overrides = {}) => ({
    id: `inventory-${index}`,
    mac: `02:01:00:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256 % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    manufacturer: `Vendor ${index}`,
    model: `Model ${index}`,
    lastSeen: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  });
  const records = [
    ...Array.from({ length: 5_002 }, (_, index) => makeRecord(index)),
    makeRecord(999, { manufacturer: "Newest Vendor", model: "", lastSeen: "2026-10-24T00:00:00.000Z" }),
  ];
  async function* events() {
    for (let offset = 0; offset < records.length; offset += 137) {
      yield { type: "records", collection: "inventory", records: records.slice(offset, offset + 137) };
    }
  }
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalGet = prototype.get;
  const originalAdd = prototype.add;
  let inventoryReads = 0;
  let readsQueuedBeforeFirstSuccess = 0;
  let stagedInventoryRows = 0;
  let restoreInventoryTotal = 0;
  const inventoryStagingSuccessHandlers = [];
  const inventoryStagingErrorHandlers = [];
  prototype.get = function (...args) {
    const request = originalGet.apply(this, args);
    if (this.name === "inventory") {
      inventoryReads += 1;
      request.addEventListener("success", () => {
        if (!readsQueuedBeforeFirstSuccess) readsQueuedBeforeFirstSuccess = inventoryReads;
      }, { once: true });
    }
    return request;
  };
  prototype.add = function (...args) {
    const request = originalAdd.apply(this, args);
    if (this.name === "archiveRecords" && args[0]?.collection === "inventory") {
      globalThis.queueMicrotask(() => {
        inventoryStagingSuccessHandlers.push(request.onsuccess);
        inventoryStagingErrorHandlers.push(request.onerror);
      });
      request.addEventListener("success", () => { stagedInventoryRows += 1; }, { once: true });
    }
    return request;
  };
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events(), {
      allowDuplicateInventoryIds: true,
      onProgress: (progress) => {
        if (progress.stage === "restoring" && progress.collection === "inventory") restoreInventoryTotal = progress.totalRecords;
      },
    });
  } finally {
    prototype.get = originalGet;
    prototype.add = originalAdd;
  }

  const restored = await readInventory(target);
  assert.equal(restored.length, 5_002);
  assert.equal(restored.find(({ id }) => id === "inventory-999")?.manufacturer, "Newest Vendor");
  assert.equal(restored.find(({ id }) => id === "inventory-999")?.model, "Model 999", "a newer duplicate restored from an earlier key page must retain the known model from an older observation");
  assert.equal(restored.find(({ id }) => id === "inventory-5001")?.model, "Model 5001");
  assert.equal(inventoryImportTransactions, 2, "5,003 Inventory observations must restore in two bounded 5,000-record transactions");
  assert.equal(stagedInventoryRows, 5_002, "repeated source IDs are merged in the temporary archive before restore");
  assert.equal(inventoryStagingSuccessHandlers.length, 5_003);
  assert.equal(new Set(inventoryStagingSuccessHandlers).size, 2, "Inventory staging shares one success handler per 5,000-row transaction");
  assert.equal(new Set(inventoryStagingErrorHandlers).size, 2, "Inventory duplicate merging shares one error handler per 5,000-row transaction");
  assert.equal(restoreInventoryTotal, 5_002, "restore progress reports unique destination records rather than raw source observations");
  assert.equal(inventoryReads, 0, "merged staging prevents duplicate destination reads");
  assert.equal(readsQueuedBeforeFirstSuccess, 0);
});

test("streamed archive restores Final chunks in bounded transactions after validating every chunk", async () => {
  const target = new Database(`portable-snapshot-chunk-batched-restore-${crypto.randomUUID()}`);
  const idb = await target.open();
  const nativeTransaction = idb.transaction.bind(idb);
  let restoring = false;
  let snapshotChunkWriteTransactions = 0;
  idb.transaction = (stores, ...options) => {
    const names = Array.isArray(stores) ? stores : [stores];
    if (restoring && options[0] === "readwrite" && names.includes("snapshotChunks")) snapshotChunkWriteTransactions += 1;
    return nativeTransaction(stores, ...options);
  };
  const originalRestore = target.restoreLocalArchive.bind(target);
  target.restoreLocalArchive = async (...args) => {
    restoring = true;
    try { return await originalRestore(...args); }
    finally { restoring = false; }
  };
  const chunkCount = 18;
  async function* events({ omitLastChunk = false } = {}) {
    yield {
      type: "snapshot", ordinal: 0,
      value: { id: "batched-snapshot", createdAt: "2026-10-24T10:00:00.000Z", deviceCount: chunkCount, chunkCount },
    };
    for (let index = 0; index < chunkCount - Number(omitLastChunk); index += 1) {
      yield { type: "snapshotChunk", ordinal: 0, index, devices: [{ id: `device-${index}`, mac: `02:00:00:00:00:${index.toString(16).padStart(2, "0")}` }] };
    }
  }

  await target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 },
    events(),
  );

  const chunks = await readStore(target, "snapshotChunks");
  assert.equal(chunks.length, chunkCount);
  assert.deepEqual(chunks.map(({ index, devices }) => [index, devices[0].id]),
    Array.from({ length: chunkCount }, (_, index) => [index, `device-${index}`]));
  assert.equal(snapshotChunkWriteTransactions, 2, "18 chunks restore in two bounded 16-chunk transactions instead of 18 per-chunk transactions");

  const invalid = new Database(`portable-snapshot-chunk-batched-invalid-${crypto.randomUUID()}`);
  await assert.rejects(
    invalid.importArchiveEvents(
      { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 },
      events({ omitLastChunk: true }),
    ),
    /отсутствует чанк batched-snapshot\/17/,
  );
  assert.deepEqual(await readStore(invalid, "snapshots"), [], "all chunks are checked before snapshot restoration begins");
  assert.deepEqual(await readStore(invalid, "snapshotChunks"), []);
});

test("re-importing streamed application logs ignores duplicate IDs without per-row reads", async () => {
  const target = new Database(`portable-app-log-idempotence-${crypto.randomUUID()}`);
  const observation = {
    id: "app-log-source-row-1",
    kind: "app_logs",
    sourceTable: "app_logs",
    observedAt: "2026-10-22T00:00:00.000Z",
    payload: { action: "Save final state" },
  };
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const events = () => (async function* () {
    yield { type: "records", collection: "legacyObservations", records: [observation] };
  }());
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalGet = prototype.get;
  let observationGets = 0;
  prototype.get = function (...args) {
    if (this.name === "legacyObservations") observationGets += 1;
    return originalGet.apply(this, args);
  };
  try {
    await target.importArchiveEvents(header, events());
    await target.importArchiveEvents(header, events());
  } finally {
    prototype.get = originalGet;
  }

  assert.equal(observationGets, 0);
  assert.deepEqual(await readStore(target, "legacyObservations"), [observation]);
});
test("archive event restore reports staged rows and bounded collection progress", async () => {
  const target = new Database(`portable-restore-progress-${crypto.randomUUID()}`);
  const progress = [];
  const events = async function* () {
    yield { type: "records", collection: "inventory", records: [
      { id: "progress-device-1", lastSeen: "", updatedAt: "" },
      { id: "progress-device-2", lastSeen: "", updatedAt: "" },
    ] };
    yield { type: "records", collection: "legacyObservations", records: [
      { id: "progress-observation-1", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-23T00:00:00.000Z", payload: { vendor: "Progress Vendor" } },
      { id: "progress-observation-2", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-23T00:00:01.000Z", payload: { vendor: "Progress Vendor" } },
    ] };
  };
  try {
    await target.importArchiveEvents(
      { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 },
      events(),
      { onProgress: (entry) => progress.push(entry) },
    );
    assert.deepEqual(progress.filter(({ stage }) => stage === "staging").map(({ collection, recordsProcessed }) => [collection, recordsProcessed]), [
      ["inventory", 2],
      ["legacyObservations", 2],
    ]);
    assert.deepEqual(progress.filter(({ stage }) => stage === "validating").map(({ recordsProcessed, totalRecords }) => [recordsProcessed, totalRecords]), [[4, 4]]);
    assert.deepEqual(progress.filter(({ stage }) => stage === "restoring").map(({ collection, recordsProcessed, totalRecords }) => [collection, recordsProcessed, totalRecords]), [
      ["inventory", 2, 2],
      ["legacyObservations", 2, 2],
    ]);
    assert.equal((await readStore(target, "inventory")).length, 2);
    assert.equal((await readStore(target, "legacyObservations")).length, 2);
  } finally {
    target.connection?.close();
    target.connection = null;
  }
});

test("streamed legacy observation restore batches inserts and vendor prefix evidence without per-row reads", async () => {
  const target = new Database(`portable-legacy-observation-batch-${crypto.randomUUID()}`);
  const db = await target.open();
  const existing = {
    id: "vendor-history-existing",
    kind: "vendor_model_history",
    sourceTable: "vendor_model_history",
    observedAt: "2026-10-20T00:00:00.000Z",
    mac: "00:11:22:33:44:55",
    payload: { vendor: "Vendor A", model: "Model A", times_seen: 1 },
  };
  const seedTx = db.transaction(["legacyObservations", "legacyVendorModelPrefixCounts"], "readwrite");
  seedTx.objectStore("legacyObservations").put(existing);
  seedTx.objectStore("legacyVendorModelPrefixCounts").put({
    prefixLength: 10, prefix: "0011223344", field: "vendor", value: "Vendor A", weight: 1, confidence: 0.8, count: 7,
  });
  await new Promise((resolve, reject) => { seedTx.oncomplete = resolve; seedTx.onerror = () => reject(seedTx.error); seedTx.onabort = () => reject(seedTx.error); });
  const observations = [
    { ...existing, payload: { vendor: "Must not replace existing", model: "Model X" } },
    ...Array.from({ length: 1_001 }, (_, index) => ({
      id: `mac-history-${index}`,
      kind: "mac_history",
      sourceTable: "mac_history",
      observedAt: "2026-10-22T00:00:00.000Z",
      mac: `02:00:00:00:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
      payload: { room: `Room ${index}` },
    })),
    {
      id: "vendor-history-new",
      kind: "vendor_model_history",
      sourceTable: "vendor_model_history",
      observedAt: "2026-10-23T00:00:00.000Z",
      mac: "00:11:22:33:44:55",
      payload: { vendor: "Vendor A", model: "Model A", times_seen: 2 },
    },
  ];
  async function* events() {
    yield { type: "records", collection: "legacyObservations", records: observations };
  }
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalGet = prototype.get;
  const originalAdd = prototype.add;
  let observationGets = 0;
  let prefixCountGets = 0;
  let stagedObservationEncoding = "";
  let stagedObservationIndexCount = 0;
  let stagedObservationPageBytes = 0;
  let oldObservationPageBytes = 0;
  const legacyObservationRequests = [];
  let idIndexRowsAtRestore = -1;
  let observationPagesAfterRestore = -1;
  prototype.get = function (...args) {
    if (this.name === "legacyObservations") observationGets += 1;
    if (this.name === "legacyVendorModelPrefixCounts") prefixCountGets += 1;
    return originalGet.apply(this, args);
  };
  prototype.add = function (record, ...args) {
    if (this.name === "archiveRecords" && record?.collection === "legacyObservationPages" && !stagedObservationEncoding) {
      stagedObservationEncoding = "json-page";
      assert.equal(typeof record.valueJson, "string");
      assert.equal(record.valueEncoding, "json-pairs-v3", "page entries use compact key/value tuples");
      const page = JSON.parse(record.valueJson);
      stagedObservationPageBytes = record.valueJson.length;
      oldObservationPageBytes = JSON.stringify(page.map(([key, value]) => ({
        key,
        value: value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : value,
      }))).length;
    }
    if (this.name === "legacyObservationImportIds") stagedObservationIndexCount += 1;
    const request = originalAdd.call(this, record, ...args);
    if (this.name === "legacyObservations") legacyObservationRequests.push({ id: record?.id, request });
    return request;
  };
  const countArchiveCollection = async (archiveId, collection) => {
    const currentDb = await target.open();
    const storeName = collection === "legacyObservationImportIds" ? collection : "archiveRecords";
    const tx = currentDb.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const range = collection === "legacyObservationImportIds"
      ? globalThis.IDBKeyRange.bound([archiveId, ""], [archiveId, []])
      : globalThis.IDBKeyRange.bound([archiveId, collection, ""], [archiveId, collection, "\uffff"]);
    let count = 0;
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Archive staging count aborted"));
      const request = store.count(range);
      request.onsuccess = () => { count = request.result; };
      request.onerror = () => reject(request.error);
    });
  };
  const originalRestore = target.restoreLocalArchive.bind(target);
  target.restoreLocalArchive = async (archiveId, options) => {
    idIndexRowsAtRestore = await countArchiveCollection(archiveId, "legacyObservationImportIds");
    const result = await originalRestore(archiveId, options);
    observationPagesAfterRestore = await countArchiveCollection(archiveId, "legacyObservationPages");
    return result;
  };
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events());
  } finally {
    prototype.get = originalGet;
    prototype.add = originalAdd;
  }

  const restoredDb = await target.open();
  const restoredTx = restoredDb.transaction("legacyObservations", "readonly");
  const restoredStore = restoredTx.objectStore("legacyObservations");
  const restoredCountRequest = restoredStore.count();
  const existingRequest = restoredStore.get(existing.id);
  const lastRequest = restoredStore.get("mac-history-1000");
  const newVendorRequest = restoredStore.get("vendor-history-new");
  const restored = await new Promise((resolve, reject) => {
    restoredTx.oncomplete = () => resolve({
      count: restoredCountRequest.result,
      existing: existingRequest.result,
      last: lastRequest.result,
      newVendor: newVendorRequest.result,
    });
    restoredTx.onerror = () => reject(restoredTx.error);
    restoredTx.onabort = () => reject(restoredTx.error || new Error("Observation restore read aborted"));
  });
  assert.equal(observationGets, 0, "restoration must not serialize one identity read per history row");
  assert.equal(legacyObservationRequests.length, observations.length, "all source observations are inserted");
  assert.deepEqual(legacyObservationRequests.filter(({ request }) => typeof request.onsuccess === "function").map(({ id }) => id), [
    "vendor-history-existing", "vendor-history-new",
  ], "only successful vendor-prefix candidates need an IndexedDB success callback; ordinary History rows avoid it");
  const ordinaryObservationErrors = legacyObservationRequests
    .filter(({ id }) => id.startsWith("mac-history-"))
    .map(({ request }) => request.onerror);
  const vendorObservationErrors = legacyObservationRequests
    .filter(({ id }) => id.startsWith("vendor-history-"))
    .map(({ request }) => request.onerror);
  assert.ok(ordinaryObservationErrors.every((handler) => handler === ordinaryObservationErrors[0]),
    "ordinary History rows share one duplicate handler instead of allocating one closure per row");
  assert.ok(vendorObservationErrors.every((handler) => handler === vendorObservationErrors[0]),
    "vendor/model rows share one duplicate handler per restore page");
  assert.equal(stagedObservationEncoding, "json-page", "temporary archive staging stores legacy observations in compact pages");
  assert.ok(stagedObservationPageBytes < oldObservationPageBytes, "single-pass page encoding reduces the staged JSON payload size");
  assert.equal(stagedObservationIndexCount, observations.length, "each source row is checked for duplicate IDs while staging");
  assert.equal(idIndexRowsAtRestore, 0, "the duplicate-ID index is deleted before destination restoration begins");
  assert.equal(observationPagesAfterRestore, 0, "consumed compact pages are removed as History is restored");
  assert.equal(restored.count, 1_003);
  assert.equal(restored.existing?.payload.vendor, "Vendor A", "existing stable IDs remain untouched");
  assert.equal(restored.last?.payload.room, "Room 1000");
  const counts = await readStore(target, "legacyVendorModelPrefixCounts");
  assert.equal(restored.newVendor?.payload.times_seen, 2);
  assert.equal(prefixCountGets, 1, "only the one prefix key already present in the destination needs a read");
  assert.equal(counts.find(({ prefixLength, field, value }) => prefixLength === 10 && field === "vendor" && value === "Vendor A")?.count, 9,
    "only the newly inserted vendor/model observation contributes its times_seen weight");
});

test("compact legacy observation restore coalesces packed pages into bounded writes and consumes them", async () => {
  const target = new Database(`portable-legacy-observation-page-stream-${crypto.randomUUID()}`);
  const archiveId = crypto.randomUUID();
  const db = await target.open();
  const tx = db.transaction(["archives", "archiveRecords"], "readwrite");
  tx.objectStore("archives").put({ id: archiveId, status: "ready", createdAt: new Date().toISOString(), counts: {} });
  const records = tx.objectStore("archiveRecords");
  for (let index = 0; index < 130; index += 1) {
    const observation = {
      id: `packed-observation-${index}`,
      kind: "mac_history",
      sourceTable: "mac_history",
      observedAt: "2026-10-23T00:00:00.000Z",
      mac: `02:00:00:00:00:${index.toString(16).padStart(2, "0")}`,
      payload: { room: `Room ${index}` },
    };
    records.put({
      archiveId,
      collection: "legacyObservationPages",
      recordKey: String(index).padStart(10, "0"),
      valueEncoding: "json-values-v2",
      valueJson: JSON.stringify([{ key: observation.id, value: observation }]),
    });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

  const nativeTransaction = db.transaction.bind(db);
  let observationWriteTransactions = 0;
  let archivePageDeleteTransactions = 0;
  db.transaction = (stores, ...options) => {
    const names = Array.isArray(stores) ? stores : [stores];
    if (options[0] === "readwrite" && names.includes("legacyObservations")) observationWriteTransactions += 1;
    if (options[0] === "readwrite" && names.includes("archiveRecords")) archivePageDeleteTransactions += 1;
    return nativeTransaction(stores, ...options);
  };
  const prototype = globalThis.IDBIndex.prototype;
  const originalOpenCursor = prototype.openCursor;
  const originalStringify = JSON.stringify;
  let observationPageCursorCalls = 0;
  let serializedObservationIds = 0;
  prototype.openCursor = function (range, ...args) {
    const isObservationPage = this.name === "by_archive_collection" && range?.lower?.[1] === "legacyObservationPages";
    const request = originalOpenCursor.call(this, range, ...args);
    if (isObservationPage) observationPageCursorCalls += 1;
    return request;
  };
  JSON.stringify = function (value, ...args) {
    if (typeof value === "string" && value.startsWith("packed-observation-")) serializedObservationIds += 1;
    return originalStringify.call(this, value, ...args);
  };
  try {
    await target.restoreLocalArchive(archiveId, { consumeStagedLegacyObservationPages: true });
  } finally {
    prototype.openCursor = originalOpenCursor;
    JSON.stringify = originalStringify;
  }

  assert.equal(observationPageCursorCalls, 131, "each packed JSON record is fetched separately, followed by one exhausted read");
  assert.equal(serializedObservationIds, 0, "restoring expanded legacy rows does not allocate JSON strings for IDs that no consumer reads");
  assert.equal(observationWriteTransactions, 1, "130 compact pages fit in one bounded 20,000-observation write batch");
  assert.equal(archivePageDeleteTransactions, 1, "consumed compact pages are deleted in one transaction per restored batch");
  const resultDb = await target.open();
  const resultTx = resultDb.transaction(["legacyObservations", "archiveRecords"], "readonly");
  const countRequest = resultTx.objectStore("legacyObservations").count();
  const lastRequest = resultTx.objectStore("legacyObservations").get("packed-observation-129");
  const remainingPagesRequest = resultTx.objectStore("archiveRecords").count(globalThis.IDBKeyRange.bound([archiveId, "legacyObservationPages", ""], [archiveId, "legacyObservationPages", "\uffff"]));
  const restored = await new Promise((resolve, reject) => {
    resultTx.oncomplete = () => resolve({ count: countRequest.result, last: lastRequest.result, pages: remainingPagesRequest.result });
    resultTx.onerror = () => reject(resultTx.error);
    resultTx.onabort = () => reject(resultTx.error || new Error("Compact observation page restore read aborted"));
  });
  assert.equal(restored.count, 130);
  assert.equal(restored.last?.payload.room, "Room 129");
  assert.equal(restored.pages, 0, "consumed packed pages are removed during restoration");
});

test("legacy vendor prefix rows reuse cached weighted counts across restore pages", async () => {
  const target = new Database(`portable-vendor-prefix-page-cache-${crypto.randomUUID()}`);
  const archiveId = crypto.randomUUID();
  const observationCount = 25_000;
  const db = await target.open();
  const tx = db.transaction(["archives", "archiveRecords"], "readwrite");
  tx.objectStore("archives").put({ id: archiveId, status: "ready", createdAt: new Date().toISOString(), counts: { legacyObservations: observationCount } });
  const records = tx.objectStore("archiveRecords");
  let firstPageJson = "";
  for (let pageIndex = 0; pageIndex < observationCount / 5_000; pageIndex += 1) {
    const values = Array.from({ length: 5_000 }, (_, offset) => {
      const index = pageIndex * 5_000 + offset;
      return {
        key: `vendor-prefix-${index}`,
        value: {
          id: `vendor-prefix-${index}`, kind: "vendor_model_history", sourceTable: "vendor_model_history",
          observedAt: new Date(Date.UTC(2026, 9, 23) + index * 1_000).toISOString(), mac: "00:11:22:33:44:55",
          payload: { vendor: "Vendor A", model: "Model A", times_seen: 1 },
        },
      };
    });
    const valueJson = JSON.stringify(values);
    if (pageIndex === 0) firstPageJson = valueJson;
    records.put({
      archiveId, collection: "legacyObservationPages", recordKey: String(pageIndex).padStart(10, "0"),
      valueEncoding: "json-values-v2", valueJson,
    });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

  const prototype = globalThis.IDBObjectStore.prototype;
  const originalAdd = prototype.add;
  const originalGet = prototype.get;
  const originalStringify = JSON.stringify;
  let prefixAdds = 0;
  let prefixGets = 0;
  let serializedPrefixKeys = 0;
  const restoreProgress = [];
  prototype.add = function (...args) {
    if (this.name === "legacyVendorModelPrefixCounts") prefixAdds += 1;
    return originalAdd.apply(this, args);
  };
  prototype.get = function (...args) {
    if (this.name === "legacyVendorModelPrefixCounts") prefixGets += 1;
    return originalGet.apply(this, args);
  };
  JSON.stringify = function (value, ...args) {
    if (Array.isArray(value) && value.length === 4 && [6, 8, 10].includes(value[0]) && ["vendor", "model"].includes(value[2])) {
      serializedPrefixKeys += 1;
    }
    return originalStringify.call(this, value, ...args);
  };
  try {
    await target.restoreLocalArchive(archiveId, {
      onProgress: (entry) => {
        if (entry.stage === "restoring" && entry.collection === "legacyObservations") restoreProgress.push(entry);
      },
    });
  } finally {
    prototype.add = originalAdd;
    prototype.get = originalGet;
    JSON.stringify = originalStringify;
  }

  const counts = await readStore(target, "legacyVendorModelPrefixCounts");
  assert.equal(counts.length, 6);
  assert.ok(counts.every(({ count }) => count === observationCount), "all repeated observations contribute their exact times_seen weight");
  assert.equal(prefixAdds, 6, "all observations combine their weights before inserting each unique prefix key once");
  assert.equal(prefixGets, 0, "the bounded cross-page count cache avoids rereading frequently repeated prefix keys");
  assert.equal(serializedPrefixKeys, 30, "25,000 observations serialize only the six unique prefix keys in each of five bounded restore pages");
  assert.deepEqual(restoreProgress.map(({ recordsProcessed }) => recordsProcessed), [5_000, 10_000, 15_000, 20_000, 25_000]);
  assert.ok(restoreProgress.every(({ totalRecords }) => totalRecords === observationCount), "restore progress reports an exact total for every bounded page");
  const retainedPagesTx = db.transaction("archiveRecords", "readonly");
  const retainedPageStore = retainedPagesTx.objectStore("archiveRecords");
  const retainedPagesRequest = retainedPageStore.count(
    globalThis.IDBKeyRange.bound([archiveId, "legacyObservationPages", ""], [archiveId, "legacyObservationPages", "\uffff"]),
  );
  const firstPageRequest = retainedPageStore.get([archiveId, "legacyObservationPages", "0000000000"]);
  const retainedPages = await new Promise((resolve, reject) => {
    retainedPagesTx.oncomplete = () => resolve({ count: retainedPagesRequest.result, firstPage: firstPageRequest.result });
    retainedPagesTx.onerror = () => reject(retainedPagesTx.error);
    retainedPagesTx.onabort = () => reject(retainedPagesTx.error || new Error("Compact pages should remain unless consume mode is enabled"));
  });
  assert.equal(retainedPages.count, observationCount / 5_000, "regular archive restores retain all source compact pages unless explicit consume mode is enabled");
  assert.equal(retainedPages.firstPage.valueJson, firstPageJson, "release of the read cursor's JSON string must not mutate persisted archive content");
});

test("legacy vendor prefix restore cache retains keys beyond the former bounded limit", async () => {
  const target = new Database(`portable-vendor-prefix-page-cache-capacity-${crypto.randomUUID()}`);
  const archiveId = crypto.randomUUID();
  const pageSize = 5_000;
  const uniqueMacCount = 2_048;
  const db = await target.open();
  const tx = db.transaction(["archives", "archiveRecords"], "readwrite");
  tx.objectStore("archives").put({ id: archiveId, status: "ready", createdAt: new Date().toISOString(), counts: { legacyObservations: pageSize * 2 } });
  const records = tx.objectStore("archiveRecords");
  const octet = (value) => (value & 0xff).toString(16).padStart(2, "0").toUpperCase();
  const observations = Array.from({ length: uniqueMacCount }, (_, index) => {
    const mac = [2, index >> 16, index >> 8, index, index * 73, 1].map(octet).join(":");
    return {
      mac,
      payload: { vendor: "Vendor A", model: `Model ${index}`, times_seen: 1 },
    };
  });
  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const values = Array.from({ length: pageSize }, (_, index) => {
      const { mac, payload } = observations[index % uniqueMacCount];
      return {
      key: `unique-vendor-prefix-${pageIndex}-${index}`,
      value: {
        id: `unique-vendor-prefix-${pageIndex}-${index}`, kind: "vendor_model_history", sourceTable: "vendor_model_history",
        observedAt: new Date(Date.UTC(2026, 9, 23) + (pageIndex * pageSize + index) * 1_000).toISOString(), mac, payload,
      },
      };
    });
    records.put({
      archiveId, collection: "legacyObservationPages", recordKey: String(pageIndex).padStart(10, "0"),
      valueEncoding: "json-values-v2", valueJson: JSON.stringify(values),
    });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

  const prototype = globalThis.IDBObjectStore.prototype;
  const originalAdd = prototype.add;
  const originalGet = prototype.get;
  let prefixGets = 0;
  prototype.get = function (...args) {
    if (this.name === "legacyVendorModelPrefixCounts") prefixGets += 1;
    return originalGet.apply(this, args);
  };
  try {
    await target.restoreLocalArchive(archiveId);
  } finally {
    prototype.add = originalAdd;
    prototype.get = originalGet;
  }

  const counts = await readStore(target, "legacyVendorModelPrefixCounts");
  assert.ok(counts.length > 8_192, "fixture exceeds the former bounded cache capacity");
  assert.ok(counts.every(({ count }) => Number.isFinite(count) && count > 0), "all unique prefix weights are preserved across both pages");
  assert.equal(prefixGets, 0, "the bounded cache retains all unique keys from one prior 5,000-row page");
});

test("legacy observation restore consumes packed values without per-row archive wrappers", async () => {
  const target = new Database(`portable-legacy-observation-values-only-${crypto.randomUUID()}`);
  const archiveId = crypto.randomUUID();
  const observation = {
    id: "legacy-observation-values-only",
    kind: "test_observation",
    sourceTable: "test_observation",
    source: "fixture",
    observedAt: "2026-10-26T00:00:00.000Z",
    mac: "00:11:22:33:44:55",
    payload: { marker: "preserved" },
  };
  const db = await target.open();
  const tx = db.transaction(["archives", "archiveRecords"], "readwrite");
  tx.objectStore("archives").put({
    id: archiveId, status: "ready", createdAt: new Date().toISOString(), counts: { legacyObservations: 1 },
  });
  tx.objectStore("archiveRecords").put({
    archiveId,
    collection: "legacyObservationPages",
    recordKey: "0000000001",
    valueEncoding: "json-values-v2",
    valueJson: JSON.stringify([{ key: observation.id, value: observation }]),
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  const originalPush = Array.prototype.push;
  let archiveWrappers = 0;
  Array.prototype.push = function (...values) {
    archiveWrappers += values.filter((value) => value?.archiveId === archiveId
      && value?.collection === "legacyObservations" && Object.hasOwn(value, "value")).length;
    return originalPush.apply(this, values);
  };
  try {
    await target.restoreLocalArchive(archiveId);
  } finally {
    Array.prototype.push = originalPush;
  }

  assert.equal(archiveWrappers, 0, "restore pages keep only the decoded observation values");
  assert.deepEqual(await readStore(target, "legacyObservations"), [observation]);
});

test("legacy observation restore decodes older individually serialized archive records", async () => {
  const target = new Database(`portable-legacy-observation-json-record-${crypto.randomUUID()}`);
  const archiveId = crypto.randomUUID();
  const observation = {
    id: "legacy-observation-json-record",
    kind: "test_observation",
    sourceTable: "test_observation",
    source: "legacy fixture",
    observedAt: "2026-10-25T00:00:00.000Z",
    mac: "00:11:22:33:44:56",
    payload: { marker: "legacy-json" },
  };
  const db = await target.open();
  const tx = db.transaction(["archives", "archiveRecords"], "readwrite");
  tx.objectStore("archives").put({
    id: archiveId, status: "ready", createdAt: new Date().toISOString(), counts: { legacyObservations: 1 },
  });
  tx.objectStore("archiveRecords").put({
    archiveId,
    collection: "legacyObservations",
    recordKey: JSON.stringify(observation.id),
    valueEncoding: "json",
    valueJson: JSON.stringify(observation),
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  await target.restoreLocalArchive(archiveId);

  assert.deepEqual(await readStore(target, "legacyObservations"), [observation]);
});

test("legacy observation page restore remains compatible with the prior per-value JSON encoding", async () => {
  const target = new Database(`portable-history-legacy-page-${crypto.randomUUID()}`);
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalAdd = prototype.add;
  let converted = false;
  prototype.add = function (record, ...args) {
    if (this.name === "archiveRecords" && record?.collection === "legacyObservationPages" && !converted) {
      const pairs = JSON.parse(record.valueJson);
      const entries = pairs.map(([key, value]) => ({ key, value: JSON.stringify(value) }));
      const legacyRecord = { ...record };
      delete legacyRecord.valueEncoding;
      legacyRecord.valueJson = JSON.stringify(entries);
      converted = true;
      return originalAdd.call(this, legacyRecord, ...args);
    }
    return originalAdd.call(this, record, ...args);
  };
  try {
    async function* events() {
      yield {
        type: "records",
        collection: "legacyObservations",
        records: [{
          id: "legacy-json-page-row",
          kind: "mac_history",
          sourceTable: "mac_history",
          observedAt: "2026-10-23T00:00:00Z",
          mac: "00:11:22:33:44:55",
          payload: { room: "Legacy page" },
        }],
      };
    }
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events());
  } finally {
    prototype.add = originalAdd;
  }
  assert.equal(converted, true);
  assert.deepEqual((await readStore(target, "legacyObservations")).map(({ id, payload }) => [id, payload.room]), [
    ["legacy-json-page-row", "Legacy page"],
  ]);
});
test("streamed archive restores History in bounded batches without dropping or rewriting stable events", async () => {
  const target = new Database(`portable-history-batched-restore-${crypto.randomUUID()}`);
  const idb = await target.open();
  const nativeTransaction = idb.transaction.bind(idb);
  let historyImportTransactions = 0;
  idb.transaction = (stores, ...options) => {
    const names = Array.isArray(stores) ? stores : [stores];
    if (options[0] === "readwrite" && names.includes("history")) historyImportTransactions += 1;
    return nativeTransaction(stores, ...options);
  };
  const prototype = globalThis.IDBObjectStore.prototype;
  const nativeGet = prototype.get;
  let historyGetRequests = 0;
  prototype.get = function (...args) {
    if (this.name === "history") historyGetRequests += 1;
    return nativeGet.apply(this, args);
  };
  const records = Array.from({ length: 2_001 }, (_, index) => ({
    id: `history-${index}`,
    type: "modified",
    field: "room",
    before: `Room ${index}`,
    after: `Room ${index + 1}`,
    mac: `02:00:00:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256 % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    timestamp: "2026-10-22T00:00:00.000Z",
  }));
  async function* events() {
    for (let offset = 0; offset < records.length; offset += 137) {
      yield { type: "records", collection: "history", records: records.slice(offset, offset + 137) };
    }
  }
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events());
  } finally {
    prototype.get = nativeGet;
  }

  const restored = await readStore(target, "history");
  assert.equal(restored.length, records.length);
  assert.equal(restored.find(({ id }) => id === "history-0")?.after, "Room 1");
  assert.equal(restored.find(({ id }) => id === "history-2000")?.after, "Room 2001");
  assert.equal(historyImportTransactions, 2, "2,001 History rows must commit in two 2,000-row transactions");
  assert.equal(historyGetRequests, 0, "stable-ID rows restore to empty History without one read per row");
});
test("archive import uses stable History IDs without scanning the whole History store", async () => {
  const target = new Database(`portable-history-stable-id-${crypto.randomUUID()}`);
  await target.open();
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalOpenCursor = prototype.openCursor;
  let historyCursorOpens = 0;
  prototype.openCursor = function (...args) {
    if (this.name === "history") historyCursorOpens += 1;
    return originalOpenCursor.apply(this, args);
  };
  try {
    await target.importArchive({
      format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
      history: [{ id: "stable-history-id", type: "modified", field: "room", before: "A", after: "B", timestamp: "2026-10-15T12:00:00Z" }],
    });
  } finally {
    prototype.openCursor = originalOpenCursor;
  }

  assert.equal(historyCursorOpens, 0);
  assert.equal((await readStore(target, "history")).length, 1);
});

test("large same-snapshot History restore uses stable IDs without rescanning prior events", async () => {
  const source = new Database(`portable-history-snapshot-source-${crypto.randomUUID()}`);
  await source.saveFinal({
    id: "same-snapshot-history-source",
    createdAt: "2026-10-25T12:00:00Z",
    devices: [],
    comparison: { added: [], modified: [], absent: [] },
  });
  const archive = await readArchive(source);
  const snapshotId = archive.snapshots[0]?.id;
  assert.ok(snapshotId);
  const records = Array.from({ length: 2_001 }, (_, index) => ({
    id: `snapshot-history-${index}`,
    snapshotId,
    type: "modified",
    field: "room",
    before: `Room ${index}`,
    after: `Room ${index + 1}`,
    mac: `02:20:00:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256 % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    timestamp: "2026-10-25T12:00:00Z",
  }));
  records.push({ ...records[0], id: "distinct-stable-history-id" });
  archive.history = records;

  const target = new Database(`portable-history-snapshot-target-${crypto.randomUUID()}`);
  await target.open();
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  const file = { size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalOpenCursor = prototype.openCursor;
  const originalGet = prototype.get;
  let historyCursorOpens = 0;
  let historyGetRequests = 0;
  let snapshotValidationGets = 0;
  let historyValidationEvents = 0;
  let finalHistoryValidationProgress = null;
  prototype.openCursor = function (...args) {
    if (this.name === "history") historyCursorOpens += 1;
    return originalOpenCursor.apply(this, args);
  };
  prototype.get = function (key, ...args) {
    if (this.name === "history") historyGetRequests += 1;
    if (this.name === "archiveRecords" && Array.isArray(key) && key[1] === "snapshots") snapshotValidationGets += 1;
    return originalGet.call(this, key, ...args);
  };
  try {
    await target.importArchiveEvents(header, readPortableArchiveEvents(file), {
      onProgress: (progress) => {
        if (progress.stage === "validating" && progress.collection === "history") {
          historyValidationEvents += 1;
          finalHistoryValidationProgress = progress;
        }
      },
    });
  } finally {
    prototype.openCursor = originalOpenCursor;
    prototype.get = originalGet;
  }

  const restored = await readStore(target, "history");
  assert.equal(restored.length, records.length);
  assert.equal(historyCursorOpens, 0, "new stable-ID events in one large snapshot must not scan previously restored History");
  assert.equal(historyGetRequests, 0, "an empty History store must not issue a read per stable-ID event");
  assert.equal(snapshotValidationGets, 1, "all events sharing a snapshot should reuse one bounded cached existence check");
  assert.ok(historyValidationEvents > 1, "validation should report progress at bounded page boundaries");
  assert.deepEqual(finalHistoryValidationProgress, {
    stage: "validating",
    collection: "history",
    recordsProcessed: records.length,
    totalRecords: records.length,
  });
  assert.equal(restored.filter(({ type, field, mac }) => type === archive.history[0].type
    && field === archive.history[0].field && mac === archive.history[0].mac).length >= 1, true);
  assert.ok(restored.some(({ id }) => id === "distinct-stable-history-id"), "distinct stable IDs remain distinct archive records");
});

test("streamed History restore queues a full bounded page of ID lookups before awaiting them", async () => {
  const target = new Database(`portable-history-batched-id-lookups-${crypto.randomUUID()}`);
  const db = await target.open();
  const seedTx = db.transaction("history", "readwrite");
  seedTx.objectStore("history").put({ id: "existing-history", type: "modified", mac: "00:00:00:00:00:01", timestamp: "2026-10-20T00:00:00Z" });
  await new Promise((resolve, reject) => {
    seedTx.oncomplete = resolve;
    seedTx.onerror = () => reject(seedTx.error);
    seedTx.onabort = () => reject(seedTx.error);
  });

  const records = Array.from({ length: 2_001 }, (_, index) => ({
    id: `batched-history-${index}`,
    type: "modified",
    field: "room",
    before: `Room ${index}`,
    after: `Room ${index + 1}`,
    mac: `02:10:00:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256 % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    timestamp: "2026-10-22T00:00:00.000Z",
  }));
  async function* events() {
    yield { type: "records", collection: "history", records };
  }
  const prototype = globalThis.IDBObjectStore.prototype;
  const nativeGet = prototype.get;
  let historyGetCalls = 0;
  let callsWhenFirstLookupResolved = null;
  prototype.get = function (...args) {
    const request = nativeGet.apply(this, args);
    if (this.name === "history") {
      historyGetCalls += 1;
      if (callsWhenFirstLookupResolved === null) {
        request.addEventListener("success", () => { callsWhenFirstLookupResolved = historyGetCalls; }, { once: true });
      }
    }
    return request;
  };
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events());
  } finally {
    prototype.get = nativeGet;
  }

  assert.equal(callsWhenFirstLookupResolved, 2_000, "every lookup in the first bounded History page must be queued before its first result");
  assert.equal(historyGetCalls, records.length);
  const restored = await readStore(target, "history");
  assert.equal(restored.length, 2_002);
  assert.equal(restored.find(({ id }) => id === "existing-history")?.type, "modified");
  assert.equal(restored.find(({ id }) => id === "batched-history-2000")?.after, "Room 2001");
});

test("object archive import preserves a colliding History ID and remains idempotent", async () => {
  const target = new Database(`portable-history-id-collision-object-${crypto.randomUUID()}`);
  const existing = { id: "shared-history-id", type: "modified", field: "room", before: "A", after: "Local", timestamp: "2026-10-15T12:00:00Z" };
  const imported = { id: "shared-history-id", type: "modified", field: "room", before: "A", after: "Archive", timestamp: "2026-10-15T12:00:00Z" };
  await target.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, history: [existing] });
  const archive = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, history: [imported] };

  await target.importArchive(archive);
  const firstImport = await readStore(target, "history");
  assert.equal(firstImport.length, 2);
  await target.importArchive(archive);

  assert.deepEqual(await readStore(target, "history"), firstImport);
});

test("streamed archive import preserves a colliding History ID and remains idempotent", async () => {
  const target = new Database(`portable-history-id-collision-stream-${crypto.randomUUID()}`);
  const existing = { id: "shared-history-id", type: "modified", field: "room", before: "A", after: "Local", timestamp: "2026-10-15T12:00:00Z" };
  const imported = { id: "shared-history-id", type: "modified", field: "room", before: "A", after: "Archive", timestamp: "2026-10-15T12:00:00Z" };
  await target.importArchive({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, history: [existing] });
  const makeEvents = () => (async function* () {
    yield { type: "records", collection: "history", records: [imported] };
  }());
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };

  await target.importArchiveEvents(header, makeEvents());
  const firstImport = await readStore(target, "history");
  assert.equal(firstImport.length, 2);
  await target.importArchiveEvents(header, makeEvents());

  assert.deepEqual(await readStore(target, "history"), firstImport);
});

test("portable quality reports require their source Final regardless of stream field order", async () => {
  const target = new Database(`portable-quality-link-${crypto.randomUUID()}`);
  const report = {
    id: "orphan-quality-report", snapshotId: "missing-quality-final", createdAt: "2026-10-15T12:00:00Z",
    score: 92, grade: "A", report: { summary: {}, issues: [], recommendations: [] },
  };

  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, snapshots: [], dataQualityReports: [report],
  }), /Отчёт качества данных не связан с Final архива/);
  assert.deepEqual(await readStore(target, "dataQualityReports"), []);

  const invalidEvents = async function* () {
    yield { type: "records", collection: "dataQualityReports", records: [report] };
    yield { type: "snapshot", ordinal: 0, value: { id: "other-quality-final", devices: [] } };
  };
  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, invalidEvents(),
  ), /Отчёт качества данных не связан с Final архива/);
  assert.deepEqual(await readStore(target, "dataQualityReports"), []);

  const valid = new Database(`portable-quality-link-valid-${crypto.randomUUID()}`);
  const validEvents = async function* () {
    yield { type: "records", collection: "dataQualityReports", records: [{ ...report, snapshotId: "quality-final" }] };
    yield { type: "snapshot", ordinal: 0, value: { id: "quality-final", devices: [] } };
  };
  await valid.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, validEvents(),
  );
  assert.deepEqual((await valid.dataQualityReportsPage({ snapshotId: "quality-final" })).rows.map(({ id }) => id), [report.id]);
});

test("streamed archive cancellation before restoration leaves user data unchanged and removes staging", async () => {
  const target = new Database(`portable-cancelled-import-${crypto.randomUUID()}`);
  const controller = new globalThis.AbortController();
  const events = (async function* () {
    yield { type: "records", collection: "settings", records: [{ key: "theme", value: "dark" }] };
    controller.abort(new globalThis.DOMException("Импорт отменён", "AbortError"));
  }());

  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events, { signal: controller.signal },
  ), { name: "AbortError", message: "Импорт отменён" });
  assert.equal(await target.getSetting("theme"), null);
  assert.deepEqual(await readStore(target, "archives"), []);
  assert.deepEqual(await readStore(target, "archiveRecords"), []);
});

test("streamed archive cancellation during cross-reference validation stops before restore", async () => {
  const target = new Database(`portable-cancel-validation-${crypto.randomUUID()}`);
  const controller = new globalThis.AbortController();
  const events = (async function* () {
    yield { type: "records", collection: "dataQualityReports", records: [{
      id: "report-one", snapshotId: "missing-final", createdAt: "2026-10-24T00:00:00Z",
      score: 90, grade: "A", report: { summary: {}, issues: [], recommendations: [] },
    }] };
  }());

  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events, {
      signal: controller.signal,
      onProgress: ({ stage }) => {
        if (stage === "validating") controller.abort(new globalThis.DOMException("Проверка отменена", "AbortError"));
      },
    },
  ), { name: "AbortError", message: "Проверка отменена" });
  assert.deepEqual(await readStore(target, "dataQualityReports"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
  assert.deepEqual(await readStore(target, "archiveRecords"), []);
});

test("streamed archive rejects duplicate Final IDs and removes all staged rows", async () => {
  const target = new Database(`portable-duplicate-final-stream-${crypto.randomUUID()}`);
  const events = async function* () {
    yield { type: "snapshot", ordinal: 0, value: { id: "duplicate-final-id", createdAt: "2026-10-15T12:00:00Z", devices: [{ id: "first-device" }] } };
    yield { type: "snapshot", ordinal: 1, value: { id: "duplicate-final-id", createdAt: "2026-10-16T12:00:00Z", devices: [{ id: "replacement-device" }] } };
  };

  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events(),
  ), /повторяющийся ID Final/);
  assert.deepEqual(await readStore(target, "snapshots"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("streamed archive validates original-file metadata before saving any Final", async () => {
  const invalidMetadata = [
    { snapshotId: "original-metadata-final", role: "main", size: 0, type: "text/csv" },
    { snapshotId: "original-metadata-final", role: "main", name: "main.csv", size: 0, type: 42 },
    { snapshotId: "original-metadata-final", role: "main", name: "main.csv", size: 0, type: "text/csv", lastModified: -1 },
  ];
  for (const metadata of invalidMetadata) {
    const target = new Database(`portable-original-metadata-${crypto.randomUUID()}`);
    const events = async function* () {
      yield { type: "snapshot", ordinal: 0, value: { id: "original-metadata-final", createdAt: "2026-10-15T12:00:00Z", devices: [] } };
      yield { type: "originalFileStart", metadata };
      yield { type: "originalFileEnd" };
    };

    await assert.rejects(target.importArchiveEvents(
      { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events(),
    ), /Некорректное начало оригинала исходного файла/);
    assert.deepEqual(await readStore(target, "snapshots"), []);
    assert.deepEqual(await readStore(target, "originalFiles"), []);
    assert.deepEqual(await readStore(target, "archives"), []);
  }
});

test("object archive rejects duplicate Inventory and History IDs before writing records", async () => {
  const target = new Database(`portable-duplicate-record-ids-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };

  await assert.rejects(target.importArchive({
    ...header,
    inventory: [{ id: "duplicate-inventory-id", mac: "00:11:22:33:44:55" }, { id: "duplicate-inventory-id", mac: "00:11:22:33:44:56" }],
  }), /повторный ID Inventory/);
  assert.deepEqual(await readStore(target, "inventory"), []);

  await assert.rejects(target.importArchive({
    ...header,
    history: [
      { id: 77, type: "modified", field: "room", before: "A", after: "B", timestamp: "2026-10-15T12:00:00Z" },
      { id: 77, type: "modified", field: "room", before: "A", after: "C", timestamp: "2026-10-15T12:00:00Z" },
    ],
  }), /повторный ID History/);
  assert.deepEqual(await readStore(target, "history"), []);

  for (const [collection, records] of [
    ["inventory", [{ id: "duplicate-inventory-id" }, { id: "duplicate-inventory-id" }]],
    ["history", [
      { id: 77, type: "modified", field: "room", before: "A", after: "B", timestamp: "2026-10-15T12:00:00Z" },
      { id: 77, type: "modified", field: "room", before: "A", after: "C", timestamp: "2026-10-15T12:00:00Z" },
    ]],
  ]) {
    const events = async function* () {
      yield { type: "records", collection, records };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), new RegExp(`повторную запись в ${collection}`));
  }
  assert.deepEqual(await readStore(target, "inventory"), []);
  assert.deepEqual(await readStore(target, "history"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("object and streamed archives reject invalid History IDs before retaining Finals", async () => {
  const target = new Database(`portable-invalid-history-ids-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const snapshot = { id: "invalid-history-id-final", devices: [] };
  const invalidIds = [{}, [], "", 1.5, Number.NaN];

  for (const id of invalidIds) {
    const history = [{ id, snapshotId: snapshot.id, timestamp: "2026-10-20T12:00:00Z", type: "modified", field: "room" }];
    await assert.rejects(target.importArchive({ ...header, snapshots: [snapshot], history }), /Некорректная запись History/);
    const events = async function* () {
      yield { type: "snapshot", ordinal: 0, value: snapshot };
      yield { type: "records", collection: "history", records: history };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), /Некорректная запись History/);
  }
  assert.deepEqual(await readStore(target, "snapshots"), []);
  assert.deepEqual(await readStore(target, "history"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("object and streamed archives reject duplicate known-model MAC keys", async () => {
  const target = new Database(`portable-duplicate-model-macs-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const records = [
    { mac: "00:11:22:33:44:55", model: "Model A" },
    { mac: "00:11:22:33:44:55", model: "Model B" },
  ];

  await assert.rejects(target.importArchive({ ...header, knownModels: records }), /повторный ключ knownModels/);
  assert.deepEqual(await readStore(target, "knownModels"), []);

  const events = async function* () {
    yield { type: "records", collection: "knownModels", records };
  };
  await assert.rejects(target.importArchiveEvents(header, events()), /повторную запись в knownModels/);
  assert.deepEqual(await readStore(target, "knownModels"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("object and streamed archives report duplicate settings and switch evidence keys before commit", async () => {
  const target = new Database(`portable-duplicate-simple-keys-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const evidence = { switchIp: "10.0.0.1", address: "Room 1", snapshotId: "duplicate-evidence-final" };
  const cases = [
    {
      collection: "settings",
      records: [{ key: "theme", value: "light" }, { key: "theme", value: "dark" }],
      error: /повторный ключ настроек/,
    },
    {
      collection: "switchAddressEvidence",
      snapshot: { id: "duplicate-evidence-final", devices: [] },
      records: [evidence, { ...evidence, deviceCount: 3 }],
      error: /повторное свидетельство switch IP/,
    },
  ];

  for (const { collection, snapshot, records, error } of cases) {
    await assert.rejects(target.importArchive({
      ...header,
      ...(snapshot ? { snapshots: [snapshot] } : {}),
      [collection]: records,
    }), error);
    const events = async function* () {
      if (snapshot) yield { type: "snapshot", ordinal: 0, value: snapshot };
      yield { type: "records", collection, records };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), new RegExp(`повторную запись в ${collection}`));
  }
  assert.deepEqual(await readStore(target, "settings"), []);
  assert.deepEqual(await readStore(target, "switchAddressEvidence"), []);
  assert.deepEqual(await readStore(target, "snapshots"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("streamed archive staging does not read each record before writing it", async () => {
  const target = new Database(`portable-batched-stage-writes-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const records = Array.from({ length: 500 }, (_, index) => ({ key: `migration-setting-${index}`, value: `value-${index}` }));
  const objectStorePrototype = globalThis.IDBObjectStore.prototype;
  const originalGet = objectStorePrototype.get;
  let archiveRecordGets = 0;
  objectStorePrototype.get = function (...args) {
    if (this.name === "archiveRecords") archiveRecordGets += 1;
    return originalGet.apply(this, args);
  };
  try {
    const events = async function* () {
      yield { type: "records", collection: "settings", records };
    };
    await target.importArchiveEvents(header, events());
  } finally {
    objectStorePrototype.get = originalGet;
  }

  assert.equal(archiveRecordGets, 0);
  const settings = await readStore(target, "settings");
  assert.equal(settings.filter(({ key }) => key.startsWith("migration-setting-")).length, records.length);
});

test("streamed archive coalesces consecutive record pages into fixed-size staging writes", async () => {
  const importPages = async (pageSize) => {
    const database = new Database(`mac-analyzer-pro-next-test-archive-stage-${crypto.randomUUID()}`);
    const idb = await database.open();
    const nativeTransaction = idb.transaction.bind(idb);
    let archiveRecordTransactions = 0;
    let observationIdTransactions = 0;
    let observationImportTransactions = 0;
    const observationIdHandlers = [];
    const storePrototype = globalThis.IDBObjectStore.prototype;
    const originalAdd = storePrototype.add;
    storePrototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === "legacyObservationImportIds") globalThis.queueMicrotask(() => observationIdHandlers.push(request.onerror));
      return request;
    };
    idb.transaction = (stores, ...options) => {
      const names = Array.isArray(stores) ? stores : [stores];
      if (options[0] === "readwrite" && names.includes("archiveRecords")) archiveRecordTransactions += 1;
      if (options[0] === "readwrite" && names.includes("legacyObservationImportIds")) observationIdTransactions += 1;
      if (options[0] === "readwrite" && names.includes("legacyObservations")) observationImportTransactions += 1;
      return nativeTransaction(stores, ...options);
    };
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      id: `app-log-${index}`,
      kind: "app_logs",
      sourceTable: "app_logs",
      observedAt: "2026-10-22T00:00:00.000Z",
      payload: { action: "Save final state" },
    }));
    async function* events() {
      for (let offset = 0; offset < records.length; offset += pageSize) {
        yield { type: "records", collection: "legacyObservations", records: records.slice(offset, offset + pageSize) };
      }
    }
    try {
      await database.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events());
      assert.equal((await database.legacyObservationSearchPage({ kind: "app_logs" }, { limit: 1 })).total, records.length);
    } finally {
      storePrototype.add = originalAdd;
    }
    assert.equal(new Set(observationIdHandlers).size, 2, "10,000 duplicate-ID checks share one error handler per 5,000-row staging transaction");
    return { archiveRecordTransactions, observationIdTransactions, observationImportTransactions };
  };

  assert.deepEqual(await importPages(2_500), { archiveRecordTransactions: 5, observationIdTransactions: 4, observationImportTransactions: 3 }, "10,000 observations use bounded staging and restore pages, isolated ID keys, one-range index cleanup, and fixed archive bookkeeping");
  assert.deepEqual(await importPages(1_000), { archiveRecordTransactions: 5, observationIdTransactions: 4, observationImportTransactions: 3 }, "source page size must not multiply IndexedDB staging or import transactions");
});

test("streamed archive rejects legacy observation IDs duplicated across compact staging pages", async () => {
  const target = new Database(`portable-duplicate-compact-observation-${crypto.randomUUID()}`);
  const records = Array.from({ length: 1_001 }, (_, index) => ({
    id: index === 1_000 ? "compact-observation-0" : `compact-observation-${index}`,
    kind: "mac_history",
    sourceTable: "mac_history",
    observedAt: "2026-10-22T00:00:00.000Z",
    payload: { room: `Room ${index}` },
  }));
  async function* events() {
    yield { type: "records", collection: "legacyObservations", records };
  }

  await assert.rejects(target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, events()), /повторную запись в legacyObservations/);
  assert.deepEqual(await readStore(target, "legacyObservations"), []);
  assert.deepEqual(await readStore(target, "archiveRecords"), [], "the disk-backed duplicate-ID index and staged pages are removed after rejection");
  assert.deepEqual(await readStore(target, "legacyObservationImportIds"), [], "the out-of-line duplicate-ID store is cleared after rejection");
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("streamed legacy observation ID keys avoid JSON wrappers and range cleanup includes every string", async () => {
  const target = new Database(`portable-observation-id-range-${crypto.randomUUID()}`);
  const id = "mac-history-\uffff-tail";
  const records = [{
    id,
    kind: "mac_history",
    sourceTable: "mac_history",
    observedAt: "2026-10-22T00:00:00.000Z",
    payload: { mac: "00:11:22:33:44:55" },
  }];
  const originalAdd = globalThis.IDBObjectStore.prototype.add;
  const observationKeys = [];
  globalThis.IDBObjectStore.prototype.add = function (value, key) {
    if (this.name === "legacyObservationImportIds") observationKeys.push(key);
    return originalAdd.call(this, value, key);
  };
  try {
    await target.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, (async function* () {
      yield { type: "records", collection: "legacyObservations", records };
    }()));
  } finally {
    globalThis.IDBObjectStore.prototype.add = originalAdd;
  }
  assert.equal(observationKeys.length, 1);
  assert.equal(observationKeys[0][1], id, "string IDs are indexed directly without JSON.stringify allocation");
  assert.deepEqual(await readStore(target, "legacyObservations"), records);
  assert.deepEqual(await readStore(target, "legacyObservationImportIds"), [], "the cleanup sentinel includes every possible string key");
});

test("object and streamed archives reject noncanonical OUI and MAC5 prefixes", async () => {
  const target = new Database(`portable-noncanonical-prefixes-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const cases = [
    { collection: "oui", record: { prefix: "00:11:22", vendor: "Vendor" }, message: /Некорректное OUI-правило/ },
    { collection: "mac5Models", record: { prefix: "00:11:22:33:44", model: "Model" }, message: /Некорректное правило MAC5/ },
  ];

  for (const { collection, record, message } of cases) {
    await assert.rejects(target.importArchive({ ...header, [collection]: [record] }), message);
    const events = async function* () {
      yield { type: "records", collection, records: [record] };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), message);
  }
  assert.deepEqual(await readStore(target, "oui"), []);
  assert.deepEqual(await readStore(target, "mac5Models"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("object and streamed archives reject unusable known-model records", async () => {
  const target = new Database(`portable-invalid-known-model-${crypto.randomUUID()}`);
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const records = [
    { mac: "00:11:22:33:44:55", model: "" },
    { mac: "00:11:22:33:44:56", model: { name: "not a text model" } },
    { mac: "001122334457", model: "Model" },
    { mac: 123, model: "Model" },
  ];

  for (const record of records) {
    await assert.rejects(target.importArchive({ ...header, knownModels: [record] }), /Некорректная запись известной модели/);
    const events = async function* () {
      yield { type: "records", collection: "knownModels", records: [record] };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), /Некорректная запись известной модели/);
  }
  assert.deepEqual(await readStore(target, "knownModels"), []);
  assert.deepEqual(await readStore(target, "archives"), []);
});

test("streamed queue files match object metadata bounds and accept an optional MIME type", async () => {
  const header = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 };
  const target = new Database(`portable-queue-file-metadata-${crypto.randomUUID()}`);
  const invalidMetadata = [
    { id: "q".repeat(513), taskId: "task-1", filename: "source.xlsx", size: 1 },
    { id: "queue-1", taskId: "t".repeat(513), filename: "source.xlsx", size: 1 },
    { id: "queue-1", taskId: "task-1", filename: "f".repeat(1025), size: 1 },
    { id: "queue-1", taskId: "task-1", filename: "source.xlsx", type: "m".repeat(257), size: 1 },
    { id: "queue-1", taskId: "task-1", filename: "source.xlsx", type: 7, size: 1 },
  ];

  for (const metadata of invalidMetadata) {
    const observationId = metadata.id;
    const events = async function* () {
      yield {
        type: "records", collection: "legacyObservations", records: [{
          id: observationId, kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-20T12:00:00Z",
          payload: { taskId: metadata.taskId, filename: metadata.filename },
        }],
      };
      yield { type: "legacyTaskQueueFileStart", metadata };
    };
    await assert.rejects(target.importArchiveEvents(header, events()), /Некорректное начало файла очереди/);
  }
  assert.deepEqual(await readStore(target, "legacyObservations"), []);
  assert.deepEqual(await readStore(target, "archives"), []);

  const optionalType = new Database(`portable-queue-file-optional-type-${crypto.randomUUID()}`);
  const events = async function* () {
    yield {
      type: "records", collection: "legacyObservations", records: [{
        id: "queue-without-type", kind: "task_file_queue", sourceTable: "task_file_queue", observedAt: "2026-10-20T12:00:00Z",
        payload: { taskId: "task-without-type", filename: "legacy.bin" },
      }],
    };
    yield { type: "legacyTaskQueueFileStart", metadata: { id: "queue-without-type", taskId: "task-without-type", filename: "legacy.bin", size: 1 } };
    yield { type: "legacyTaskQueueFileChunk", chunk: "YQ==" };
    yield { type: "legacyTaskQueueFileEnd" };
  };
  await optionalType.importArchiveEvents(header, events());
  const restoredFile = await optionalType.legacyTaskQueueLocalFile("queue-without-type");
  assert.equal(restoredFile.blob.type, "application/octet-stream");
  assert.equal(await new globalThis.Response(restoredFile.blob).text(), "a");
});

test("portable History references must resolve to an included Final", async () => {
  const target = new Database(`portable-history-link-${crypto.randomUUID()}`);
  const event = {
    id: "orphan-history-event", snapshotId: "missing-history-final", deviceId: "device-1",
    type: "modified", timestamp: "2026-10-15T12:00:00Z", field: "room", oldValue: "A", newValue: "B",
  };

  await assert.rejects(target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, snapshots: [], history: [event],
  }), /Запись History ссылается на отсутствующий Final/);
  assert.deepEqual(await readStore(target, "history"), []);

  const invalidEvents = async function* () {
    yield { type: "records", collection: "history", records: [event] };
    yield { type: "snapshot", ordinal: 0, value: { id: "different-history-final", devices: [] } };
  };
  await assert.rejects(target.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, invalidEvents(),
  ), /Запись History ссылается на отсутствующий Final/);
  assert.equal((await target.listSnapshots()).length, 0);
  assert.deepEqual(await readStore(target, "history"), []);

  const valid = new Database(`portable-history-link-valid-${crypto.randomUUID()}`);
  const validEvents = async function* () {
    yield { type: "records", collection: "history", records: [{ ...event, snapshotId: "history-final" }] };
    yield { type: "snapshot", ordinal: 0, value: { id: "history-final", devices: [] } };
  };
  await valid.importArchiveEvents(
    { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, validEvents(),
  );
  assert.deepEqual((await readStore(valid, "history")).map(({ snapshotId }) => snapshotId), ["history-final"]);
});

test("startup recovery restores only the newest complete Final and rejects broken chunks", async () => {
  const database = new Database(`recovery-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "older-complete", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "old-device", mac: "00:11:22:33:44:01" }] });
  await database.saveFinal({
    id: "newer-incomplete",
    createdAt: "2026-02-01T00:00:00Z",
    devices: Array.from({ length: 501 }, (_, index) => ({ id: `device-${index}`, mac: `00:11:22:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}:01` })),
  });
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete(["newer-incomplete", 1]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  await assert.rejects(database.forEachSnapshotChunk("newer-incomplete", () => {}), /повреждён.*блок 2/);
  await database.setSetting("activeSnapshotId", "stale-autosave-id");
  database.listSnapshots = async () => { throw new Error("Recovery must scan metadata by cursor"); };
  const recovery = await database.recoverActiveSnapshot();
  assert.deepEqual(recovery, { snapshotId: "older-complete", recovered: true });
  assert.equal(await database.getSetting("activeSnapshotId"), "older-complete");
  assert.equal((await database.activeSnapshot()).devices.length, 1);

  const unavailable = new Database(`recovery-empty-${crypto.randomUUID()}`);
  await unavailable.setSetting("activeSnapshotId", "stale-reference");
  assert.deepEqual(await unavailable.recoverActiveSnapshot(), { snapshotId: "", recovered: false, unavailable: true });
  assert.equal(await unavailable.getSetting("activeSnapshotId"), "stale-reference");
  assert.equal(await unavailable.activeSnapshot(), null, "an unknown local ID must not resolve to an unverified snapshot");
  assert.equal(await unavailable.activeSnapshotMetadata(), null, "the browser-only store must not reinterpret an unknown ID as a backend snapshot");

  const transient = new Database(`recovery-read-error-${crypto.randomUUID()}`);
  await transient.saveFinal({ id: "keep-active", devices: [] });
  transient.forEachSnapshotChunk = async () => { throw new Error("Temporary IndexedDB read error"); };
  await assert.rejects(transient.recoverActiveSnapshot(), /Temporary IndexedDB read error/);
  assert.equal(await transient.getSetting("activeSnapshotId"), "keep-active");
});

test("active Final accessors propagate transient IndexedDB read failures and preserve the active pointer", async () => {
  const database = new Database(`active-read-error-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "active-final", devices: [{ id: "device-1", mac: "00:11:22:33:44:55" }] });
  const readFailure = new Error("Temporary IndexedDB read failure");
  database.forEachSnapshotChunk = async () => { throw readFailure; };

  await assert.rejects(database.activeSnapshotMetadata(), (error) => error === readFailure);
  await assert.rejects(database.activeSnapshot(), (error) => error === readFailure);
  assert.equal(await database.getSetting("activeSnapshotId"), "active-final");
});

test("startup recovery cursors past broken dated Finals and retains date-less legacy fallback order", async () => {
  const database = new Database(`recovery-cursor-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "legacy-date-less", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "legacy-device", mac: "00:11:22:33:44:01" }] });
  await database.saveFinal({ id: "newer-damaged", createdAt: "2026-02-01T00:00:00Z", devices: [{ id: "damaged-device", mac: "00:11:22:33:44:02" }] });
  const db = await database.open();
  const tx = db.transaction(["snapshots", "snapshotChunks"], "readwrite");
  const snapshots = tx.objectStore("snapshots");
  const legacyRequest = snapshots.get("legacy-date-less");
  legacyRequest.onsuccess = () => {
    const metadata = legacyRequest.result;
    delete metadata.createdAt;
    snapshots.put(metadata);
  };
  tx.objectStore("snapshotChunks").delete(["newer-damaged", 0]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["legacy-date-less", "newer-damaged"]);
  await database.setSetting("activeSnapshotId", "missing-active-id");
  database.listSnapshots = async () => { throw new Error("Recovery must not collect snapshot metadata"); };

  assert.deepEqual(await database.recoverActiveSnapshot(), { snapshotId: "legacy-date-less", recovered: true });
  assert.equal(await database.getSetting("activeSnapshotId"), "legacy-date-less");
});

test("IndexedDB version upgrade preserves legacy stores and creates historical mapping evidence", async () => {
  const name = `legacy-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("legacyData", { keyPath: "id" }).put({ id: "keep", value: 42 });
  const legacy = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  legacy.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("legacyData"));
  assert.ok(upgraded.objectStoreNames.contains("switchAddressEvidence"));
  assert.ok(upgraded.objectStoreNames.contains("mac5Models"));
  assert.ok(upgraded.objectStoreNames.contains("dataQualityReports"));
  const tx = upgraded.transaction("legacyData", "readonly");
  const preserved = await new Promise((resolve, reject) => {
    const read = tx.objectStore("legacyData").get("keep");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.deepEqual(preserved, { id: "keep", value: 42 });
});

test("version 29 migration adds an unindexed transient History ID store and preserves staged archives", async () => {
  const name = `archive-id-index-v29-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 29);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("archives", { keyPath: "id" }).put({ id: "preserved-archive", status: "ready" });
    const archiveRecords = db.createObjectStore("archiveRecords", { keyPath: ["archiveId", "collection", "recordKey"] });
    archiveRecords.createIndex("by_archive", "archiveId");
    archiveRecords.createIndex("by_archive_collection", ["archiveId", "collection", "recordKey"]);
    archiveRecords.put({ archiveId: "preserved-archive", collection: "settings", recordKey: "theme", value: "dark" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const transient = upgraded.transaction("legacyObservationImportIds", "readonly").objectStore("legacyObservationImportIds");
  assert.equal(transient.keyPath, null, "temporary source IDs use only the compact primary key and no secondary indexes");
  assert.equal(transient.indexNames.length, 0);
  assert.deepEqual(await readStore(database, "archiveRecords"), [
    { archiveId: "preserved-archive", collection: "settings", recordKey: "theme", value: "dark" },
  ]);
  const seed = upgraded.transaction("legacyObservationImportIds", "readwrite");
  seed.objectStore("legacyObservationImportIds").add(true, ["preserved-archive", "legacy-observation-1"]);
  await new Promise((resolve, reject) => { seed.oncomplete = resolve; seed.onerror = () => reject(seed.error); seed.onabort = () => reject(seed.error); });
  await database.deleteLocalArchive("preserved-archive");
  assert.deepEqual(await readStore(database, "legacyObservationImportIds"), [], "archive cleanup also removes migrated transient-key rows");
  assert.deepEqual(await readStore(database, "archives"), []);
});

test("version 20 upgrade adds imported Smartroom mappings and preserves existing stores", async () => {
  const name = `smartroom-map-v20-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 20);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("snapshots", { keyPath: "id" }).put({ id: "preserved" });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_smartroom", "smartroomId");
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_snapshot", "snapshotId");
    history.createIndex("by_device", "deviceId");
    history.createIndex("by_timestamp", "timestamp");
    const settings = db.createObjectStore("settings", { keyPath: "key" });
    settings.put({ key: "legacySmartroomRoom:SR-OLD", value: { room: "Old Room", source: "manual", updatedAt: "2026-10-15T00:00:00Z" } });
    settings.put({ key: "legacySmartroomRoom:SR-INVALID-DATE", value: { room: "Legacy Room", source: "manual", updatedAt: "2026-02-31T10:00:00Z" } });
    const observations = db.createObjectStore("legacyObservations", { keyPath: "id" });
    observations.createIndex("by_kind_observed", ["kind", "observedAt", "id"]);
    observations.createIndex("by_mac_observed", ["mac", "observedAt", "id"]);
    observations.createIndex("by_observed_id", ["observedAt", "id"]);
    const prefixCounts = db.createObjectStore("legacyVendorModelPrefixCounts", { keyPath: ["prefixLength", "prefix", "field", "value"] });
    prefixCounts.createIndex("by_prefix", ["prefixLength", "prefix"]);
    db.createObjectStore("legacyObservationQueryScratch", { keyPath: ["queryId", "metric", "value"] });
    const reports = db.createObjectStore("dataQualityReports", { keyPath: "id" });
    reports.createIndex("by_created", "createdAt");
    reports.createIndex("by_snapshot_created", ["snapshotId", "createdAt"]);
    reports.put({ id: "quality-preserved", snapshotId: "preserved", createdAt: "2026-10-15T00:00:00.000Z", score: 90, grade: "A", report: {} });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const mappings = upgraded.transaction("legacySmartroomRoomMappings", "readonly").objectStore("legacySmartroomRoomMappings");
  assert.ok(mappings.indexNames.contains("by_updated_at"));
  assert.deepEqual(await database.legacySmartroomRoomMappingsForIds(["SR-OLD"]), [{
    id: "sr-old\u0000SR-OLD", smartroomIdKey: "sr-old", smartroomId: "SR-OLD", room: "Old Room", source: "manual", updatedAt: "2026-10-15T00:00:00Z",
  }]);
  assert.deepEqual(await database.legacySmartroomRoomMappingsForIds(["SR-INVALID-DATE"]), [{
    id: "sr-invalid-date\u0000SR-INVALID-DATE", smartroomIdKey: "sr-invalid-date", smartroomId: "SR-INVALID-DATE", room: "Legacy Room", source: "manual", updatedAt: "1970-01-01T00:00:00.000Z",
  }]);
  assert.deepEqual(await readStore(database, "snapshots"), [{ id: "preserved" }]);
  assert.equal((await readStore(database, "dataQualityReports"))[0].id, "quality-preserved");
});

test("version 21 migration indexes MAC history without losing events and includes alternate-MAC device history", async () => {
  const name = `mac-history-v21-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 21);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("snapshots", { keyPath: "id" }).createIndex("by_created", "createdAt");
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_alternate_mac", "alternateMacs", { multiEntry: true });
    inventory.put({ id: "device-1", mac: "AA:BB:CC:00:00:01", alternateMacs: ["00:11:22:33:44:55"] });
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_snapshot", "snapshotId");
    history.createIndex("by_device", "deviceId");
    history.createIndex("by_timestamp", "timestamp");
    history.createIndex("by_device_timestamp", ["deviceId", "timestamp"]);
    history.put({ id: 1, snapshotId: "final-1", deviceId: "device-1", mac: "0011.2233.4455", type: "modified", timestamp: "2026-10-14T10:00:00Z", field: "room", oldValue: "101", newValue: "102" });
    history.put({ id: 2, snapshotId: "final-2", deviceId: "device-1", mac: "AA:BB:CC:00:00:01", type: "modified", timestamp: "2026-10-15T10:00:00Z", field: "room", oldValue: "102", newValue: "103" });
    history.put({ id: 3, snapshotId: "final-3", deviceId: "device-1", type: "modified", timestamp: "2026-10-16T10:00:00Z", field: "room", oldValue: "103", newValue: "104" });
    db.createObjectStore("settings", { keyPath: "key" });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.transaction("history", "readonly").objectStore("history").indexNames.contains("by_mac_timestamp"));
  const migrated = await readStore(database, "history");
  assert.equal(migrated[0].macKey, "00:11:22:33:44:55");
  assert.equal(migrated[1].macKey, "AA:BB:CC:00:00:01");
  const macEvents = [];
  const macEventCount = await database.forEachMacHistoryPage("00-11-22-33-44-55", (page) => {
    assert.ok(page.length <= 500);
    macEvents.push(...page);
  });
  assert.equal(macEventCount, 3);
  assert.deepEqual(macEvents.map(({ id }) => id), [1, 2, 3], "the exact MAC index retains primary, alternate-MAC, and missing-MAC events for the matching Inventory identity");
  assert.equal(macEvents[0].newValue, "102");
  database.connection.close();
  database.connection = null;
});

test("version 22 migration adds strong-identity Inventory indexes without losing records", async () => {
  const name = `inventory-identity-v22-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 22);
  request.onupgradeneeded = () => {
    const inventory = request.result.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_alternate_mac", "alternateMacs", { multiEntry: true });
    inventory.put({ id: "legacy-device-id", deviceId: "asset-42", mac: "00:11:22:33:44:01", serial: "SN-42" });
    inventory.put({ id: "legacy-device-serial", deviceId: "", mac: "00:11:22:33:44:02", serial: "SN-43" });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const inventory = upgraded.transaction("inventory", "readonly").objectStore("inventory");
  assert.ok(inventory.indexNames.contains("by_device_id"));
  assert.ok(inventory.indexNames.contains("by_serial_identity"));
  assert.ok(inventory.indexNames.contains("by_device_id_normalized"));
  assert.ok(inventory.indexNames.contains("by_serial_normalized"));
  assert.deepEqual(await readInventory(database), [
    { id: "legacy-device-id", deviceId: "asset-42", mac: "00:11:22:33:44:01", serial: "SN-42", deviceIdKey: "asset-42", serialKey: "sn-42", alternateMacKeys: [] },
    { id: "legacy-device-serial", deviceId: "", mac: "00:11:22:33:44:02", serial: "SN-43", deviceIdKey: "", serialKey: "sn-43", alternateMacKeys: [] },
  ]);
  const candidates = await database.inventoryCandidatesForDevices([
    { id: "new-device-id", deviceId: "asset-42" },
    { id: "new-device-serial", serial: "SN-43" },
  ]);
  assert.equal(candidates.get("new-device-id").records[0].id, "legacy-device-id");
  assert.equal(candidates.get("new-device-serial").records[0].id, "legacy-device-serial");
  database.connection.close();
  database.connection = null;
});

test("version 23 migration adds count-ordered analytics scratch index and preserves old rows", async () => {
  const name = `analytics-scratch-v23-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 23);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("legacyObservationQueryScratch", { keyPath: ["queryId", "metric", "value"] });
    store.put({ queryId: "legacy-query", metric: "vendor", value: "Acme" });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const store = upgraded.transaction("legacyObservationQueryScratch", "readonly").objectStore("legacyObservationQueryScratch");
  assert.ok(store.indexNames.contains("by_query_metric_count"));
  assert.ok(store.indexNames.contains("by_query_metric_rank"));
  assert.deepEqual((await readStore(database, "legacyObservationQueryScratch")).find(({ queryId }) => queryId === "legacy-query"), {
    queryId: "legacy-query", metric: "vendor", value: "Acme",
  });
});

test("version 24 migration adds ranked analytics index without dropping scratch rows", async () => {
  const name = `analytics-rank-v24-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 24);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("legacyObservationQueryScratch", { keyPath: ["queryId", "metric", "value"] });
    store.createIndex("by_query_metric_count", ["queryId", "metric", "count", "value"], { unique: false });
    store.put({ queryId: "preserve", metric: "cluster", value: "row", count: 2, data: { label: "row" } });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const store = upgraded.transaction("legacyObservationQueryScratch", "readonly").objectStore("legacyObservationQueryScratch");
  assert.ok(store.indexNames.contains("by_query_metric_rank"));
  assert.deepEqual((await readStore(database, "legacyObservationQueryScratch"))[0], {
    queryId: "preserve", metric: "cluster", value: "row", count: 2, data: { label: "row" },
  });
});

test("version 25 migration backfills normalized Inventory identity keys without losing records", async () => {
  const name = `inventory-normalized-identity-v25-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 25);
  request.onupgradeneeded = () => {
    const inventory = request.result.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    inventory.put({ id: "legacy-device", deviceId: "  Asset-A  ", serial: "SN-001", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1", custom: "preserved" });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const store = upgraded.transaction("inventory", "readonly").objectStore("inventory");
  assert.ok(store.indexNames.contains("by_device_id_normalized"));
  assert.ok(store.indexNames.contains("by_serial_normalized"));
  const record = await new Promise((resolve, reject) => {
    const read = store.get("legacy-device");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.equal(record.deviceIdKey, "asset-a");
  assert.equal(record.serialKey, "sn-001");
  assert.equal(record.custom, "preserved");

  const candidates = await database.inventoryCandidatesForDevices([
    { id: "new-device-id", deviceId: "ASSET-A", serial: "sn-001", switchIp: "10.0.0.2" },
  ]);
  assert.equal(candidates.get("new-device-id").records.length, 1);
  assert.equal(candidates.get("new-device-id").records[0].id, "legacy-device");
  assert.equal(candidates.get("new-device-id").records[0].switchIp, "10.0.0.1");
  database.connection.close();
  database.connection = null;
});

test("version 26 migration adds a device/type history index and counts all modifications without dropping events", async () => {
  const name = `history-type-index-v26-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 26);
  request.onupgradeneeded = () => {
    const inventory = request.result.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    inventory.put({ id: "device-a", mac: "00:11:22:33:44:55" });
    const history = request.result.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_snapshot", "snapshotId");
    history.createIndex("by_device", "deviceId");
    history.createIndex("by_timestamp", "timestamp");
    history.createIndex("by_device_timestamp", ["deviceId", "timestamp"]);
    history.createIndex("by_mac_timestamp", ["macKey", "timestamp"]);
    history.put({ id: 1, snapshotId: "final-1", deviceId: "device-a", type: "modified", timestamp: "2026-01-01T00:00:00Z", field: "vendor" });
    history.put({ id: 2, snapshotId: "final-2", deviceId: "device-a", type: "added", timestamp: "2026-01-02T00:00:00Z" });
    history.put({ id: 3, snapshotId: "final-3", deviceId: "device-a", type: "modified", timestamp: "2026-01-03T00:00:00Z", field: "model" });
    history.put({ id: 4, snapshotId: "final-4", deviceId: "device-b", type: "modified", timestamp: "2026-01-04T00:00:00Z", field: "room" });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.transaction("history", "readonly").objectStore("history").indexNames.contains("by_device_type"));
  const page = await database.historyPage("device-a", { limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.modifiedTotal, 2);
  assert.equal(page.rows.length, 1);
  assert.equal((await readStore(database, "history")).length, 4);
  database.connection.close();
  database.connection = null;
});

test("version 27 migration adds the FinalAnalytics identity lookup without replacing cached or user data", async () => {
  const name = `final-analytics-identity-index-v27-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 27);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.createIndex("by_source_key", "sourceKey");
    snapshots.put({ id: "preserved-final", createdAt: "2026-10-01T00:00:00Z", deviceCount: 1, chunkCount: 1 });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] })
      .put({ snapshotId: "preserved-final", index: 0, devices: [{ id: "device-1", mac: "00:11:22:33:44:55" }] });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_smartroom", "smartroomId");
    inventory.put({ id: "device-1", mac: "00:11:22:33:44:55", customValue: "preserve" });
    const analytics = db.createObjectStore("finalAnalytics", { keyPath: ["snapshotId", "generation", "index"] });
    analytics.createIndex("by_snapshot", ["snapshotId", "generation"]);
    analytics.put({ snapshotId: "preserved-final", generation: "legacy-generation", index: 0, devices: [{ id: "device-1", mac: "00:11:22:33:44:55" }] });
    db.createObjectStore("finalAnalyticsMetadata", { keyPath: "snapshotId" }).put({
      snapshotId: "preserved-final", generation: "legacy-generation", signature: "legacy-signature", schemaVersion: 4,
      deviceCount: 1, chunkCount: 1,
    });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const analytics = upgraded.transaction("finalAnalytics", "readonly").objectStore("finalAnalytics");
  assert.ok(analytics.indexNames.contains("by_identity_lookup"));
  assert.equal(analytics.index("by_identity_lookup").multiEntry, true);
  assert.deepEqual(await database.loadSnapshot("preserved-final"), {
    id: "preserved-final", createdAt: "2026-10-01T00:00:00Z", deviceCount: 1, chunkCount: 1,
    devices: [{ id: "device-1", mac: "00:11:22:33:44:55" }],
  });
  assert.equal((await readInventory(database))[0].customValue, "preserve");
  assert.equal((await database.loadFinalAnalyticsIndex("preserved-final", "legacy-signature", 4))[0].id, "device-1");
  database.connection.close();
  database.connection = null;
});

test("version 28 migration builds a normalized multiEntry Inventory MAC index from packed aliases", async () => {
  const name = `packed-inventory-mac-index-v28-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 28);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.createIndex("by_source_key", "sourceKey");
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_alternate_mac", "alternateMacs", { multiEntry: true });
    inventory.put({ id: "legacy-device", mac: "00:11:22:33:44:55", alternateMacs: "AA-BB-CC-DD-EE-FF,11:22:33:44:55:66" });
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_mac_timestamp", ["macKey", "timestamp"]);
    history.createIndex("by_device_timestamp", ["deviceId", "timestamp"]);
    history.put({ id: 1, snapshotId: "legacy-final", deviceId: "legacy-device", mac: "00:11:22:33:44:55", macKey: "00:11:22:33:44:55", type: "modified", timestamp: "2026-10-01T00:00:00Z" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const tx = upgraded.transaction("inventory", "readonly");
  const store = tx.objectStore("inventory");
  assert.ok(store.indexNames.contains("by_alternate_mac_normalized"));
  const indexed = await new Promise((resolve, reject) => {
    const read = store.index("by_alternate_mac_normalized").get("AA:BB:CC:DD:EE:FF");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.equal(indexed.id, "legacy-device");
  assert.deepEqual(indexed.alternateMacKeys, ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"]);
  assert.equal(indexed.alternateMacs, "AA-BB-CC-DD-EE-FF,11:22:33:44:55:66", "migration must preserve the source payload");
  const matches = await database.inventoryCandidatesForDevices([{ id: "returning-device", mac: "AA:BB:CC:DD:EE:00", alternateMacs: "AA:BB:CC:DD:EE:FF" }]);
  assert.equal(matches.get("returning-device").records[0].id, "legacy-device");
  const historyRows = [];
  assert.equal(await database.forEachMacHistoryPage("AA:BB:CC:DD:EE:FF", (page) => historyRows.push(...page)), 1);
  assert.deepEqual(historyRows.map(({ id }) => id), [1], "the same normalized index supplies History context through the packed alias");
});

test("normalized Inventory identity indexes update on Final and additive archive writes", async () => {
  const database = new Database(`normalized-identity-write-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "normalized-identity-old", name: "Old", createdAt: "2026-10-01T00:00:00Z", devices: [
    { id: "old-device-id", mac: "00:11:22:33:44:55", deviceId: "Device-A", serial: "Serial-01", switchIp: "10.0.0.1" },
  ] });
  const candidates = await database.inventoryCandidatesForDevices([
    { id: "new-device-id", mac: "AA:BB:CC:DD:EE:FF", deviceId: "device-a", serial: "SERIAL-01", switchIp: "10.0.0.2" },
  ]);
  assert.equal(candidates.get("new-device-id").records.length, 1);
  assert.equal(compareSwitchIpHistory([
    { id: "new-device-id", mac: "AA:BB:CC:DD:EE:FF", deviceId: "device-a", serial: "SERIAL-01", switchIp: "10.0.0.2" },
  ], candidates)[0].previousIp, "10.0.0.1");

  const target = new Database(`normalized-identity-archive-${crypto.randomUUID()}`);
  await target.importArchive({
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1,
    inventory: [{ id: "archive-device", deviceId: "Archive-A", serial: "Archive-SN", mac: "00:11:22:33:44:66" }],
  });
  const imported = await target.inventoryCandidatesForDevices([
    { id: "new-archive-id", deviceId: "archive-a", serial: "archive-sn" },
  ]);
  assert.equal(imported.get("new-archive-id").records[0].id, "archive-device");
  database.connection.close();
  target.connection.close();
  database.connection = null;
  target.connection = null;
});

test("analytics aggregate scratch merges exact counts and reads all rows in bounded cursor pages", async () => {
  const database = new Database(`analytics-aggregate-${crypto.randomUUID()}`);
  await database.clearAnalyticsAggregateQuery("clusters:test");
  await database.mergeAnalyticsAggregateBatch("clusters:test", "cluster", [
    { value: "Acme\u0000Room A", count: 2, data: { label: "Acme · Room A", fields: { vendor: "Acme", room: "Room A" } } },
    { value: "Acme\u0000Room B", count: 1, data: { label: "Acme · Room B", fields: { vendor: "Acme", room: "Room B" } } },
  ]);
  await database.mergeAnalyticsAggregateBatch("clusters:test", "cluster", [
    { value: "Acme\u0000Room A", count: 3 },
    { value: "Other\u0000Room C", count: 1, data: { label: "Other · Room C", fields: { vendor: "Other", room: "Room C" } } },
  ]);
  const first = await database.analyticsAggregatePage("clusters:test", "cluster", { limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].count, 5);
  assert.equal(first.rows[0].data.label, "Acme · Room A");
  const second = await database.analyticsAggregatePage("clusters:test", "cluster", { after: first.nextCursor, limit: 2 });
  assert.equal(second.hasMore, false);
  assert.equal(second.rows.length, 1);
  assert.equal(second.total, 3);
  assert.equal(await database.analyticsAggregateCount("clusters:test", "other-metric"), 0);
  await database.clearAnalyticsAggregateQuery("clusters:test", "cluster");
  assert.equal(await database.analyticsAggregateCount("clusters:test", "cluster"), 0);
});

test("temporal MAC scratch deduplicates batches and compares adjacent sets with cursor memory", async () => {
  const database = new Database(`temporal-mac-scratch-${crypto.randomUUID()}`);
  const queryId = `temporal:${crypto.randomUUID()}`;
  await database.addAnalyticsDistinctBatch(queryId, "ever", ["mac-a", "mac-b", "mac-a"]);
  await database.addAnalyticsDistinctBatch(queryId, "ever", ["mac-b", "mac-c"]);
  await database.addAnalyticsDistinctBatch(queryId, "period-0", ["mac-a", "mac-c", "mac-c"], "ever");
  await database.addAnalyticsDistinctBatch(queryId, "period-1", ["mac-b", "mac-c", "mac-d"]);

  assert.equal(await database.analyticsAggregateCount(queryId, "ever"), 3);
  assert.deepEqual(await database.compareAnalyticsDistinctMetrics(queryId, "period-0", "period-1"), {
    previousCount: 2,
    currentCount: 3,
    added: 2,
    removed: 1,
  });
  await database.clearAnalyticsAggregateQuery(queryId);
  assert.equal(await database.analyticsAggregateCount(queryId, "ever"), 0);
});

test("temporal cursor comparison counts every MAC with exact overlap", async () => {
  const database = new Database(`temporal-cursor-batches-${crypto.randomUUID()}`);
  const queryId = `temporal:${crypto.randomUUID()}`;
  const previous = Array.from({ length: 100 }, (_, index) => `mac-${String(index).padStart(3, "0")}`);
  const current = Array.from({ length: 100 }, (_, index) => `mac-${String(index + 50).padStart(3, "0")}`);
  const db = await database.open();
  const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const store = tx.objectStore("legacyObservationQueryScratch");
  for (const value of previous) store.put({ queryId, metric: "period-0", value, count: 1, rankCount: -1, updatedAt: 1 });
  for (const value of current) store.put({ queryId, metric: "period-1", value, count: 1, rankCount: -1, updatedAt: 1 });
  for (const value of new Set([...previous, ...current])) store.put({ queryId, metric: "ever", value, count: 1, rankCount: -1, updatedAt: 1 });
  await done;
  assert.equal(await database.analyticsAggregateCount(queryId, "ever"), 150);
  const compared = await database.compareAnalyticsDistinctMetrics(queryId, "period-0", "period-1");
  assert.deepEqual(compared, { previousCount: 100, currentCount: 100, added: 50, removed: 50 });
  await database.clearAnalyticsAggregateQuery(queryId);
});

test("temporal scratch expiry removes only stale temporal rows and retains active and unrelated analytics", async () => {
  const database = new Database(`temporal-scratch-expiry-${crypto.randomUUID()}`);
  await database.addAnalyticsDistinctBatch("temporal:stale", "ever", ["mac-a"]);
  await database.addAnalyticsDistinctBatch("temporal:stale", "period-0", ["mac-a"]);
  await database.addAnalyticsDistinctBatch("temporal:active", "ever", ["mac-b"]);
  await database.addAnalyticsDistinctBatch("dashboard:active", "vendor", ["Acme"]);
  const db = await database.open();
  const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const staleLease = tx.objectStore("legacyObservationQueryScratch").get(["temporal:stale", "", "lease"]);
  staleLease.onsuccess = () => tx.objectStore("legacyObservationQueryScratch").put({ ...staleLease.result, updatedAt: 1 });
  const stale = tx.objectStore("legacyObservationQueryScratch").get(["temporal:stale", "ever", "mac-a"]);
  stale.onsuccess = () => tx.objectStore("legacyObservationQueryScratch").put({ ...stale.result, updatedAt: Date.now() });
  const oldPeriod = tx.objectStore("legacyObservationQueryScratch").get(["temporal:stale", "period-0", "mac-a"]);
  oldPeriod.onsuccess = () => tx.objectStore("legacyObservationQueryScratch").put({ ...oldPeriod.result, updatedAt: Date.now() });
  const oldActiveMac = tx.objectStore("legacyObservationQueryScratch").get(["temporal:active", "ever", "mac-b"]);
  oldActiveMac.onsuccess = () => tx.objectStore("legacyObservationQueryScratch").put({ ...oldActiveMac.result, updatedAt: 1 });
  await done;

  assert.equal(await database.clearExpiredAnalyticsAggregateQueries("temporal:", 100), 3);
  assert.equal(await database.analyticsAggregateCount("temporal:stale", "ever"), 0);
  assert.equal(await database.analyticsAggregateCount("temporal:active", "ever"), 1);
  assert.equal(await database.analyticsAggregateCount("dashboard:active", "vendor"), 1);
});

test("temporal history computes exact MAC totals through disposable IndexedDB scratch", async () => {
  const database = new Database(`temporal-statistics-${crypto.randomUUID()}`);
  const queryId = `temporal:${crypto.randomUUID()}`;
  const stats = new TemporalStatisticsAccumulator("day", { macStore: database, queryId });
  await stats.startSnapshot({ id: "day-1", name: "Day 1", createdAt: "2026-04-01T08:00:00Z", deviceCount: 3 });
  await stats.observeChunk([
    { mac: "AA:BB:CC:00:00:01", manufacturer: "Acme", room: "101" },
    { mac: "AA:BB:CC:00:00:02", manufacturer: "Acme", room: "101" },
    { mac: "AA:BB:CC:00:00:02", manufacturer: "Acme", room: "101" },
  ]);
  await stats.startSnapshot({ id: "day-2", name: "Day 2", createdAt: "2026-04-02T08:00:00Z", deviceCount: 2 });
  assert.equal(stats.current.macs, null);
  assert.equal(stats.everMacs, null);
  await stats.observeChunk([
    { mac: "AA:BB:CC:00:00:02", manufacturer: "Acme", room: "101" },
    { mac: "AA:BB:CC:00:00:03", manufacturer: "Acme", room: "102" },
  ]);
  const result = await stats.finish();
  assert.equal(result.summary.uniqueMacs, 3);
  assert.deepEqual(result.periods.map(({ uniqueMacs, added, removed }) => [uniqueMacs, added, removed]), [[2, 2, 0], [2, 1, 1]]);
  await stats.cleanup();
  assert.equal(await database.analyticsAggregateCount(queryId, "ever"), 0);
  assert.equal(await database.analyticsAggregateCount(queryId, "period-1"), 0);
});

test("analytics aggregate batches merge several metrics and retain exact locale-ranked top rows", async () => {
  const database = new Database(`analytics-top-${crypto.randomUUID()}`);
  await database.mergeAnalyticsAggregateBatches("rankings:test", {
    vendor: [
      { value: "Zeta", count: 2, data: { label: "Zeta" } },
      { value: "ёж", count: 1, data: { label: "ёж" } },
      { value: "Ёлка", count: 1, data: { label: "Ёлка" } },
    ],
    model: [{ value: "Model A", count: 3, data: { label: "Model A" } }],
  });
  await database.mergeAnalyticsAggregateBatches("rankings:test", {
    vendor: [{ value: "Zeta", count: 1 }],
  });
  const top = await database.analyticsAggregateTop("rankings:test", "vendor", 3);
  assert.deepEqual(top.map(({ value, count }) => [value, count]), [["Zeta", 3], ["ёж", 1], ["Ёлка", 1]]);
  assert.equal((await database.analyticsAggregateTop("rankings:test", "model", 10))[0].count, 3);
  assert.equal(await database.analyticsAggregateCount("rankings:test", "vendor"), 3);
});

test("topology analytics returns ranked switch and value-ordered port pages with exact totals", async () => {
  const database = new Database(`topology-aggregate-${crypto.randomUUID()}`);
  await database.mergeAnalyticsAggregateBatches("topology:test", {
    "topology-switch": [
      { value: "10.0.0.1", count: 8, data: { label: "10.0.0.1" } },
      { value: "10.0.0.2", count: 3, data: { label: "10.0.0.2" } },
      { value: "10.0.0.3", count: 1, data: { label: "10.0.0.3" } },
    ],
    "topology-port:10.0.0.1": [
      { value: "1", count: 4, data: { label: "1" } },
      { value: "10", count: 2, data: { label: "10" } },
      { value: "2", count: 2, data: { label: "2" } },
    ],
  });
  const firstSwitches = await database.analyticsAggregateRankedPage("topology:test", "topology-switch", { limit: 2 });
  assert.deepEqual(firstSwitches.rows.map(({ value, count }) => [value, count]), [["10.0.0.1", 8], ["10.0.0.2", 3]]);
  assert.equal(firstSwitches.total, 3);
  assert.equal(firstSwitches.hasMore, true);
  const nextSwitches = await database.analyticsAggregateRankedPage("topology:test", "topology-switch", { after: firstSwitches.nextCursor, limit: 2 });
  assert.deepEqual(nextSwitches.rows.map(({ value, count }) => [value, count]), [["10.0.0.3", 1]]);
  assert.equal(nextSwitches.hasMore, false);
  const previousSwitches = await database.analyticsAggregateRankedPage("topology:test", "topology-switch", { before: nextSwitches.firstCursor, limit: 2 });
  assert.deepEqual(previousSwitches.rows.map(({ value }) => value), ["10.0.0.1", "10.0.0.2"]);
  const firstPorts = await database.analyticsAggregateValuePage("topology:test", "topology-port:10.0.0.1", { limit: 2 });
  assert.deepEqual(firstPorts.rows.map(({ value }) => value), ["1", "10"]);
  assert.equal(firstPorts.total, 3);
  const nextPorts = await database.analyticsAggregateValuePage("topology:test", "topology-port:10.0.0.1", { after: firstPorts.nextCursor, limit: 2 });
  assert.deepEqual(nextPorts.rows.map(({ value }) => value), ["2"]);
  const previousPorts = await database.analyticsAggregateValuePage("topology:test", "topology-port:10.0.0.1", { before: nextPorts.firstCursor, limit: 2 });
  assert.deepEqual(previousPorts.rows.map(({ value }) => value), ["1", "10"]);
});

test("Dashboard manufacturer and occupancy rankings page the complete aggregate set", async () => {
  const database = new Database(`dashboard-ranked-details-${crypto.randomUUID()}`);
  const source = Array.from({ length: 205 }, (_, index) => ({
    value: `Group ${String(index).padStart(3, "0")}`,
    count: index % 9 + 1,
    data: { label: `Group ${String(index).padStart(3, "0")}` },
  }));
  for (const metric of ["vendor", "occupancy-room"]) {
    for (let offset = 0; offset < source.length; offset += 100) {
      await database.mergeAnalyticsAggregateBatches(`dashboard-ranked:${metric}`, {
        [metric]: source.slice(offset, offset + 100),
      });
    }
    const expected = [...source].sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "ru"));
    const actual = [];
    let cursor = null;
    let pages = 0;
    while (true) {
      const page = await database.analyticsAggregateRankedPage(`dashboard-ranked:${metric}`, metric, { after: cursor, limit: 100 });
      actual.push(...page.rows.map(({ value, count }) => ({ value, count })));
      assert.equal(page.total, source.length);
      pages += 1;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(pages, 3);
    assert.deepEqual(actual, expected.map(({ value, count }) => ({ value, count })));
  }
});

test("high-cardinality analytics keeps exact totals while materializing only the requested ranking", async () => {
  const database = new Database(`analytics-high-cardinality-${crypto.randomUUID()}`);
  const expected = [];
  const total = 2_005;
  for (let offset = 0; offset < total; offset += 250) {
    const rows = Array.from({ length: Math.min(250, total - offset) }, (_, index) => {
      const position = offset + index;
      const row = { value: `Vendor ${String(position).padStart(5, "0")}`, count: position % 7 + 1, data: { label: `Vendor ${String(position).padStart(5, "0")}` } };
      expected.push(row);
      return row;
    });
    await database.mergeAnalyticsAggregateBatches("rankings:large", { vendor: rows });
  }
  const top = await database.analyticsAggregateTop("rankings:large", "vendor", 50);
  const sorted = expected.sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "ru"));
  assert.equal(await database.analyticsAggregateCount("rankings:large", "vendor"), total);
  assert.equal(top.length, 50);
  assert.deepEqual(top.map(({ value, count }) => [value, count]), sorted.slice(0, 50).map(({ value, count }) => [value, count]));
});

test("deleting a Final removes only its derived cluster aggregate rows", async () => {
  const database = new Database(`analytics-aggregate-delete-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "cluster-delete", name: "Cluster Final", devices: [{ id: "device" }] });
  await database.mergeAnalyticsAggregateBatch("analytics-final-v2:cluster-delete", "cluster", [{ value: "Acme", count: 1 }]);
  await database.mergeAnalyticsAggregateBatch("analytics-final-v2:keep-final", "cluster", [{ value: "Other", count: 1 }]);
  await database.deleteSnapshots(["cluster-delete"]);
  assert.equal(await database.analyticsAggregateCount("analytics-final-v2:cluster-delete", "cluster"), 0);
  assert.equal(await database.analyticsAggregateCount("analytics-final-v2:keep-final", "cluster"), 1);
});

test("version 3 Inventory upgrades sort indexes and backfills keys without losing rows", async () => {
  const name = `inventory-v3-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 3);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("inventory", { keyPath: "id" });
    store.createIndex("by_mac", "mac");
    store.createIndex("by_smartroom", "smartroomId");
    store.put({ id: "keep", mac: "00:11:22:33:44:55", manufacturer: "Acme", smartroomId: "", deviceId: "ASSET-A", serial: "SN-01" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.transaction("inventory", "readonly").objectStore("inventory").indexNames.contains("by_sort_mac"));
  const results = await database.searchInventory({ query: "acme", pageSize: 10 });
  assert.equal(results.total, 1);
  assert.equal(results.items[0].id, "keep");
  const stored = await readInventory(database);
  assert.equal(stored[0].manufacturer, "Acme");
  assert.equal(stored[0].room, "");
  assert.equal(stored[0].deviceIdKey, "asset-a");
  assert.equal(stored[0].serialKey, "sn-01");
});

test("version 4 databases gain MAC-prefix model rules without losing stored records", async () => {
  const name = `inventory-v4-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 4);
  request.onupgradeneeded = () => {
    const inventory = request.result.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_smartroom", "smartroomId");
    inventory.put({ id: "preserved", mac: "00:11:22:33:44:55", smartroomId: "" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("mac5Models"));
  assert.equal((await readInventory(database)).length, 1);
  await database.saveMac5Model("00:11:22:33", "Rule Model");
  assert.deepEqual(await database.mac5ModelPage({ limit: 1 }).then(({ rows }) => rows.map(({ prefix, model }) => [prefix, model])), [["00112233", "Rule Model"]]);
});

test("version 5 upgrades add analytics and Smartroom mapping stores without losing user records", async () => {
  const name = `analytics-v5-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 5);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "preserved-final", name: "Preserved", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_smartroom", "smartroomId");
    inventory.put({ id: "preserved-device", mac: "00:11:22:33:44:55", manufacturer: "Acme" });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    const settings = db.createObjectStore("settings", { keyPath: "key" });
    settings.put({ key: "activeSnapshotId", value: "preserved-final" });
    db.createObjectStore("knownModels", { keyPath: "mac" });
    db.createObjectStore("mac5Models", { keyPath: "prefix" });
    db.createObjectStore("oui", { keyPath: "prefix" });
    db.createObjectStore("archives", { keyPath: "id" });
    const evidence = db.createObjectStore("switchAddressEvidence", { keyPath: ["switchIp", "address", "snapshotId"] });
    evidence.createIndex("by_switch", "switchIp");
    evidence.createIndex("by_snapshot", "snapshotId");
  };
  const v5 = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  v5.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("analyticsCache"));
  assert.ok(upgraded.objectStoreNames.contains("smartroomRoomMappings"));
  assert.equal((await database.getSetting("activeSnapshotId")), "preserved-final");
  assert.equal((await readInventory(database))[0].manufacturer, "Acme");
  assert.equal((await database.listSnapshots())[0].name, "Preserved");
});

test("version 6 migration adds Smartroom room evidence while preserving Final and analytics cache", async () => {
  const name = `smartroom-v6-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 6);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "existing-final", name: "Existing", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac");
    inventory.createIndex("by_smartroom", "smartroomId");
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    const settings = db.createObjectStore("settings", { keyPath: "key" });
    settings.put({ key: "activeSnapshotId", value: "existing-final" });
    db.createObjectStore("knownModels", { keyPath: "mac" });
    db.createObjectStore("mac5Models", { keyPath: "prefix" });
    db.createObjectStore("oui", { keyPath: "prefix" });
    db.createObjectStore("archives", { keyPath: "id" });
    db.createObjectStore("analyticsCache", { keyPath: "key" }).put({ key: "cache", schemaVersion: 1, signature: "keep", value: { count: 1 } });
    const evidence = db.createObjectStore("switchAddressEvidence", { keyPath: ["switchIp", "address", "snapshotId"] });
    evidence.createIndex("by_switch", "switchIp");
    evidence.createIndex("by_snapshot", "snapshotId");
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("smartroomRoomMappings"));
  assert.equal((await database.listSnapshots())[0].id, "existing-final");
  assert.deepEqual(await database.loadAnalyticsCache("cache", "keep"), { count: 1 });
});

test("version 7 migration adds local archive stores and preserves existing data", async () => {
  const name = `archives-v7-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 7);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("snapshots", { keyPath: "id" }).put({ id: "kept-final", name: "Kept", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    db.createObjectStore("inventory", { keyPath: "id" }).put({ id: "kept-device", mac: "00:11:22:33:44:55" });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    db.createObjectStore("settings", { keyPath: "key" }).put({ key: "activeSnapshotId", value: "kept-final" });
    db.createObjectStore("knownModels", { keyPath: "mac" });
    db.createObjectStore("mac5Models", { keyPath: "prefix" });
    db.createObjectStore("oui", { keyPath: "prefix" });
    db.createObjectStore("archives", { keyPath: "id" });
    db.createObjectStore("analyticsCache", { keyPath: "key" });
    db.createObjectStore("smartroomRoomMappings", { keyPath: "smartroomIdKey" });
    db.createObjectStore("switchAddressEvidence", { keyPath: ["switchIp", "address", "snapshotId"] });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("archiveRecords"));
  const archiveRecords = upgraded.transaction("archiveRecords", "readonly").objectStore("archiveRecords");
  assert.ok(archiveRecords.indexNames.contains("by_archive_collection"));
  assert.equal((await database.listSnapshots())[0].id, "kept-final");
  assert.equal((await readInventory(database))[0].id, "kept-device");
});

test("version 8 migration stores a browser directory handle without exporting it in portable archives", async () => {
  const name = `directory-v8-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 8);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("settings", { keyPath: "key" }).put({ key: "keep", value: "preserved" });
    request.result.createObjectStore("snapshots", { keyPath: "id" }).put({ id: "old-final", name: "Old", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("fileHandles"));
  assert.equal(await database.getSetting("keep"), "preserved");
  const handle = { kind: "directory", name: "shared-data", marker: "local-only" };
  await database.setDataDirectoryHandle(handle);
  assert.deepEqual(await database.dataDirectoryHandle(), handle);
  const archive = await readArchive(database);
  assert.equal(JSON.stringify(archive).includes("local-only"), false);
  assert.equal(archive.fileHandles, undefined);
});

test("workspace file handles persist metadata locally, stay out of archives, and clear atomically", async () => {
  const database = new Database(`workspace-source-handles-${crypto.randomUUID()}`);
  await database.open();
  const directoryHandle = { kind: "directory", name: "data-folder", marker: "preserve" };
  await database.setDataDirectoryHandle(directoryHandle);
  await database.saveWorkspaceSourceFileHandle("main", { kind: "file", name: "Main.csv", marker: "main-handle" }, {
    name: "Main.csv", type: "text/csv", size: 123, lastModified: 456,
  });
  await database.saveWorkspaceSourceFileHandle("ddio", { kind: "file", name: "DDIO.xlsx", marker: "ddio-handle" }, {
    name: "DDIO.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 789, lastModified: 321,
  });
  assert.deepEqual((await database.workspaceSourceFileHandles()).map(({ role, name, size }) => [role, name, size]), [
    ["main", "Main.csv", 123], ["ddio", "DDIO.xlsx", 789],
  ]);
  const archive = await readArchive(database);
  assert.equal(archive.fileHandles, undefined);
  assert.equal(JSON.stringify(archive).includes("main-handle"), false);
  await database.deleteWorkspaceSourceFileHandles();
  assert.deepEqual(await database.workspaceSourceFileHandles(), []);
  const remaining = await readStore(database, "fileHandles");
  assert.deepEqual(remaining.map(({ key }) => key), ["data-directory"]);
  assert.deepEqual(await database.dataDirectoryHandle(), directoryHandle);
});

test("mass-merge directory handles persist per role without entering portable archives", async () => {
  const database = new Database(`workspace-batch-handles-${crypto.randomUUID()}`);
  await database.open();
  const directoryHandle = { kind: "directory", name: "Main", marker: "main-directory" };
  const smartroomHandle = { kind: "directory", name: "SmartRoom", marker: "smartroom-directory" };
  await database.setDataDirectoryHandle({ kind: "directory", name: "data-folder", marker: "preserve" });
  await database.saveWorkspaceBatchDirectoryHandle("main", directoryHandle);
  await database.saveWorkspaceBatchDirectoryHandle("smartroom", smartroomHandle);
  assert.deepEqual((await database.workspaceBatchDirectoryHandles()).map(({ role, name }) => [role, name]), [
    ["main", "Main"], ["smartroom", "SmartRoom"],
  ]);
  const archive = await readArchive(database);
  assert.equal(archive.fileHandles, undefined);
  assert.equal(JSON.stringify(archive).includes("main-directory"), false);
  await database.deleteWorkspaceBatchDirectoryHandle("main");
  assert.deepEqual((await database.workspaceBatchDirectoryHandles()).map(({ role }) => role), ["smartroom"]);
  const remaining = await readStore(database, "fileHandles");
  assert.deepEqual(remaining.map(({ key }) => key), ["data-directory", "workspace-batch-directory:smartroom"]);
});

test("version 9 migration backfills a timestamp index without losing history events", async () => {
  const name = `history-v9-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 9);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "legacy-final", createdAt: "2026-02-02T00:00:00.000Z" });
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_snapshot", "snapshotId");
    history.createIndex("by_device", "deviceId");
    history.createIndex("by_timestamp", "timestamp");
    history.add({ snapshotId: "legacy-final", deviceId: "legacy-device", value: "missing timestamp" });
    history.add({ snapshotId: "legacy-final", deviceId: "legacy-device", value: "known timestamp", timestamp: "2026-02-01T00:00:00.000Z" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.transaction("history", "readonly").objectStore("history").indexNames.contains("by_device_timestamp"));
  const page = await database.historyPage("legacy-device");
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map((item) => item.value), ["known timestamp", "missing timestamp"]);
  assert.equal(page.rows[1].timestamp, "2026-02-02T00:00:00.000Z");
});

test("version 10 migration counts Inventory observations from stored chunks without dropping records", async () => {
  const name = `inventory-count-v10-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 10);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    const chunks = db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    inventory.put({ id: "device-a", mac: "00:11:22:33:44:55", switchIp: "10.0.0.1" });
    inventory.put({ id: "device-b", mac: "00:11:22:33:44:66", switchIp: "10.0.0.2" });
    inventory.put({ id: "device-never-seen", mac: "00:11:22:33:44:77" });
    db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    snapshots.put({ id: "snapshot-one", createdAt: "2026-01-01T00:00:00Z" });
    snapshots.put({ id: "snapshot-two", createdAt: "2026-01-02T00:00:00Z" });
    chunks.put({ snapshotId: "snapshot-one", index: 0, devices: [
      { id: "device-a" }, { id: "device-b" },
    ] });
    chunks.put({ snapshotId: "snapshot-two", index: 0, devices: [{ id: "device-a" }] });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  assert.equal((await database.open()).version, 30);
  const records = await database.inventoryCandidatesForDevices([
    { id: "device-a", mac: "00:11:22:33:44:55" },
    { id: "device-b", mac: "00:11:22:33:44:66" },
    { id: "device-never-seen", mac: "00:11:22:33:44:77" },
  ]);
  assert.equal(records.get("device-a").records[0].observationCount, 2);
  assert.equal(records.get("device-b").records[0].observationCount, 1);
  assert.equal(records.get("device-never-seen").records[0].observationCount, 0);
  assert.equal(records.get("device-b").records[0].switchIp, "10.0.0.2");
});

test("version 11 migration adds switch and multi-entry alternate MAC indexes without losing Inventory", async () => {
  const name = `inventory-index-v11-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 11);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    for (const field of ["mac", "ip", "switchIp", "switchPort", "manufacturer", "model", "deviceType", "hostname", "serial", "smartroomId", "room", "address", "authenticationTime"]) {
      inventory.createIndex(`by_sort_${field}`, [field, "id"], { unique: false });
    }
    inventory.put({ id: "legacy-device", mac: "00:11:22:33:44:55", alternateMacs: ["00:11:22:33:44:66"], switchIp: "10.0.0.1" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const tx = upgraded.transaction("inventory", "readonly");
  const store = tx.objectStore("inventory");
  assert.ok(store.indexNames.contains("by_switch"));
  assert.ok(store.indexNames.contains("by_alternate_mac"));
  assert.equal((await new Promise((resolve, reject) => {
    const read = store.index("by_alternate_mac").get("00:11:22:33:44:66");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  })).id, "legacy-device");
  assert.equal((await new Promise((resolve, reject) => {
    const read = store.get("legacy-device");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  })).switchIp, "10.0.0.1");
});

test("version 11 database upgrade preserves Final, History, Inventory, original files, and settings", async () => {
  const name = `full-preservation-migration-v11-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 11);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "legacy-v11-final", name: "Legacy v11", createdAt: "2026-01-01T00:00:00.000Z", deviceCount: 1, chunkCount: 1, sourceKey: "legacy-source" });
    const chunks = db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    chunks.put({ snapshotId: "legacy-v11-final", index: 0, devices: [{ id: "legacy-device", mac: "00:11:22:33:44:55", ip: "192.0.2.10" }] });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    inventory.put({ id: "legacy-device", mac: "00:11:22:33:44:55", ip: "192.0.2.10", customValue: "preserve me" });
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.add({ snapshotId: "legacy-v11-final", deviceId: "legacy-device", mac: "00:11:22:33:44:55", field: "room", oldValue: "101", newValue: "102", timestamp: "2026-01-01T00:00:00.000Z" });
    const originals = db.createObjectStore("originalFiles", { keyPath: ["snapshotId", "role"] });
    originals.put({ snapshotId: "legacy-v11-final", role: "main", name: "legacy.csv", type: "text/csv", size: 11, lastModified: 1, blob: new globalThis.Blob(["legacy,data\n"], { type: "text/csv" }) });
    const settings = db.createObjectStore("settings", { keyPath: "key" });
    settings.put({ key: "activeSnapshotId", value: "legacy-v11-final" });
    settings.put({ key: "theme", value: "dark" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.deepEqual((await database.loadSnapshot("legacy-v11-final")).devices, [
    { id: "legacy-device", mac: "00:11:22:33:44:55", ip: "192.0.2.10" },
  ]);
  assert.equal((await readInventory(database)).find(({ id }) => id === "legacy-device").customValue, "preserve me");
  assert.equal((await database.historyPage("legacy-device")).rows[0].newValue, "102");
  assert.deepEqual((await database.listOriginalFiles("legacy-v11-final")).map(({ role, name, size }) => [role, name, size]), [["main", "legacy.csv", 11]]);
  assert.equal(await (await database.getOriginalFile("legacy-v11-final", "main")).blob.text(), "legacy,data\n");
  assert.equal(await database.getSetting("activeSnapshotId"), "legacy-v11-final");
  assert.equal(await database.getSetting("theme"), "dark");
  database.connection?.close();
  database.connection = null;
});

test("version 12 migration adds FinalAnalytics stores while preserving Final and Inventory", async () => {
  const name = `final-analytics-migration-v12-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 12);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.createIndex("by_source_key", "sourceKey");
    const chunks = db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    chunks.put({ snapshotId: "legacy-final", index: 0, devices: [{ id: "legacy-device", mac: "00:11:22:33:44:55" }] });
    snapshots.put({ id: "legacy-final", name: "Legacy Final", createdAt: "2026-01-01T00:00:00Z", deviceCount: 1, chunkCount: 1 });
    const inventory = db.createObjectStore("inventory", { keyPath: "id" });
    inventory.createIndex("by_mac", "mac", { unique: false });
    inventory.createIndex("by_smartroom", "smartroomId", { unique: false });
    inventory.put({ id: "legacy-device", mac: "00:11:22:33:44:55", observationCount: 3 });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const upgraded = await new Database(name).open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("finalAnalytics"));
  assert.ok(upgraded.objectStoreNames.contains("finalAnalyticsMetadata"));
  const final = await new Database(name).loadSnapshots(["legacy-final"]).then((rows) => rows[0]);
  assert.equal(final.name, "Legacy Final");
  assert.deepEqual((await new Database(name).loadSnapshot("legacy-final")).devices, [{ id: "legacy-device", mac: "00:11:22:33:44:55" }]);
  const tx = upgraded.transaction("inventory", "readonly");
  const preserved = await new Promise((resolve, reject) => {
    const read = tx.objectStore("inventory").get("legacy-device");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.equal(preserved.observationCount, 3);
});

test("version 13 migration adds original source-file storage without changing existing Final rows", async () => {
  const name = `original-files-migration-v13-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 13);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "legacy-final", name: "Legacy", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("originalFiles"));
  assert.deepEqual((await database.listSnapshots()).map(({ id, name: label }) => [id, label]), [["legacy-final", "Legacy"]]);
  assert.deepEqual(await database.listOriginalFiles("legacy-final"), []);
});

test("version 14 migration adds chunked single-file analysis history without changing Final", async () => {
  const name = `single-analysis-migration-v14-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 14);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "existing-final", name: "Existing Final", createdAt: "2026-01-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();

  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("singleAnalyses"));
  assert.ok(upgraded.objectStoreNames.contains("singleAnalysisChunks"));
  assert.deepEqual((await database.listSnapshots()).map(({ id, name: label }) => [id, label]), [["existing-final", "Existing Final"]]);
});

test("version 15 migration adds indexed legacy observations without losing Final or History", async () => {
  const name = `legacy-observations-migration-v15-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 15);
  request.onupgradeneeded = () => {
    const db = request.result;
    const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
    snapshots.createIndex("by_created", "createdAt");
    snapshots.put({ id: "before-16", name: "Before migration", createdAt: "2026-10-01T00:00:00Z", deviceCount: 0, chunkCount: 0 });
    db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
    const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
    history.createIndex("by_snapshot", "snapshotId");
    history.createIndex("by_device", "deviceId");
    history.createIndex("by_timestamp", "timestamp");
    history.createIndex("by_device_timestamp", ["deviceId", "timestamp"]);
    history.put({ id: 1, snapshotId: "before-16", timestamp: "2026-10-01T00:00:00Z", type: "modified", mac: "00:11:22:33:44:55" });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("legacyObservations"));
  const observations = upgraded.transaction("legacyObservations", "readonly").objectStore("legacyObservations");
  assert.ok(observations.indexNames.contains("by_kind_observed"));
  assert.ok(observations.indexNames.contains("by_mac_observed"));
  assert.deepEqual((await database.listSnapshots()).map(({ id }) => id), ["before-16"]);
  assert.equal((await readStore(database, "history")).length, 1);
});

test("version 16 migration builds compact legacy vendor/model prefix counts and preserves observations", async () => {
  const name = `legacy-prefix-migration-v16-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 16);
  request.onupgradeneeded = () => {
    const db = request.result;
    const observations = db.createObjectStore("legacyObservations", { keyPath: "id" });
    observations.createIndex("by_kind_observed", ["kind", "observedAt", "id"]);
    observations.createIndex("by_mac_observed", ["mac", "observedAt", "id"]);
    observations.put({ id: "legacy-prefix-row", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T10:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Vendor A", model: "Model A" } });
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  const countStore = upgraded.transaction("legacyVendorModelPrefixCounts", "readonly").objectStore("legacyVendorModelPrefixCounts");
  assert.ok(countStore.indexNames.contains("by_prefix"));
  assert.deepEqual(await readStore(database, "legacyObservations"), [{ id: "legacy-prefix-row", kind: "vendor_model_history", sourceTable: "vendor_model_history", observedAt: "2026-10-15T10:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Vendor A", model: "Model A" } }]);
  assert.deepEqual((await database.legacyVendorModelSuggestionsForMacs(["00:11:22:33:44:99"])).get("00:11:22:33:44:99"), {
    vendor: "Vendor A", model: "Model A", source: "vendor_model_history_prefix", confidence: 0.504,
    matchedPrefix: "0011223344", matches: 1, vendorConfidence: 0.504, modelConfidence: 0.504,
    vendorSource: "vendor_model_history_prefix", modelSource: "vendor_model_history_prefix",
    vendorMatchedPrefix: "0011223344", modelMatchedPrefix: "0011223344",
  });
});

test("version 17 migration adds chronological legacy observation index without dropping data", async () => {
  const name = `legacy-observation-index-migration-v17-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 17);
  request.onupgradeneeded = () => {
    const db = request.result;
    const observations = db.createObjectStore("legacyObservations", { keyPath: "id" });
    observations.createIndex("by_kind_observed", ["kind", "observedAt", "id"]);
    observations.createIndex("by_mac_observed", ["mac", "observedAt", "id"]);
    observations.put({ id: "older", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-01T00:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme" } });
    observations.put({ id: "newer", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-02T00:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme" } });
    const counts = db.createObjectStore("legacyVendorModelPrefixCounts", { keyPath: ["prefixLength", "prefix", "field", "value"] });
    counts.createIndex("by_prefix", ["prefixLength", "prefix"]);
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.transaction("legacyObservations", "readonly").objectStore("legacyObservations").indexNames.contains("by_observed_id"));
  const page = await database.legacyObservationSearchPage({ kind: "mac_history" }, { limit: 1 });
  assert.deepEqual(page.rows.map(({ id }) => id), ["newer"]);
  assert.equal(page.total, 2);
});

test("version 18 migration adds bounded query scratch storage without replacing legacy observations", async () => {
  const name = `legacy-observation-stats-migration-v18-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 18);
  request.onupgradeneeded = () => {
    const db = request.result;
    const observations = db.createObjectStore("legacyObservations", { keyPath: "id" });
    observations.createIndex("by_kind_observed", ["kind", "observedAt", "id"]);
    observations.createIndex("by_mac_observed", ["mac", "observedAt", "id"]);
    observations.createIndex("by_observed_id", ["observedAt", "id"]);
    observations.put({ id: "kept-observation", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-01T00:00:00Z", mac: "00:11:22:33:44:55", payload: { vendor: "Acme", model: "Router", room: "Room A", source_file: "source.csv" } });
    const counts = db.createObjectStore("legacyVendorModelPrefixCounts", { keyPath: ["prefixLength", "prefix", "field", "value"] });
    counts.createIndex("by_prefix", ["prefixLength", "prefix"]);
  };
  const old = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const database = new Database(name);
  const upgraded = await database.open();
  assert.equal(upgraded.version, 30);
  assert.ok(upgraded.objectStoreNames.contains("legacyObservationQueryScratch"));
  const page = await database.legacyObservationSearchPage({});
  assert.deepEqual(page.summary, { uniqueMacs: 1, vendors: 1, models: 1, rooms: 1, sources: 1 });
  assert.deepEqual((await database.legacyObservationPage({ kind: "mac_history" })).rows.map(({ id }) => id), ["kept-observation"]);
  assert.deepEqual(await readStore(database, "legacyObservationQueryScratch"), []);
});

test("single-file analysis history stores and restores bounded chunks, filters metadata, and deletes atomically", async () => {
  const database = new Database(`single-analysis-history-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_005 }, (_, index) => ({ id: `device-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`, model: `Model ${index % 4}`, ...(index === 0 ? { sourceRowRanges: [[2, 1_501]] } : {}) }));
  const result = {
    filename: "devices.csv", headers: ["MAC", "Model"], mapping: { mac: 0, model: 1 }, mappingMode: "manual",
    detection: { warnings: [], conflicts: [] }, summary: { rows: 2_210, valid: devices.length, invalid: 1_205, invalidMacs: 1_005, ambiguous: 1, models: [{ label: "Model 0", value: 252 }] },
    devices,
    diagnostics: {
      invalid: [{ row: 1007, reason: "missing id", values: ["", "bad"] }, { row: 1008, reason: "missing id", values: ["", "bad"] }],
      invalidMacs: [{ row: 1007, value: "bad" }],
      ambiguous: [{ row: 1008, candidates: [{ id: "device-1" }] }],
      identityConflicts: [{ row: 1009, selected: "device-1", alternative: "device-2" }],
      invalidTotal: 1_205, invalidMacsTotal: 1_005, ambiguousTotal: 1,
      identityConflictCount: 1, duplicateRows: 3,
    },
  };
  await database.saveFinal({ id: "analysis-baseline", createdAt: "2026-10-14T10:00:00Z", devices: [] });
  const final = await database.saveFinal({
    id: "analysis-final",
    name: "Single file: devices.csv",
    createdAt: "2026-10-15T10:00:00Z",
    devices,
    comparison: { added: devices, absent: [], modified: [], timestamp: "2026-10-15T10:00:00Z" },
    activate: false,
    updateInventory: true,
  });
  await database.saveSingleAnalysis({ id: "analysis-a", filename: "devices.csv", sheetName: "Sheet 1", result, processedAt: "2026-10-15T10:00:00Z", finalSnapshotId: final.id });
  await database.saveSingleAnalysis({ id: "analysis-b", filename: "other.csv", result: { ...result, devices: [], diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [] } }, processedAt: "2026-10-15T11:00:00Z" });
  assert.deepEqual((await database.listSingleAnalyses({ query: "DEVICES.CSV" })).rows.map(({ id }) => id), ["analysis-a"]);
  const restored = await database.loadSingleAnalysis("analysis-a");
  assert.equal(restored.sheetName, "Sheet 1");
  assert.equal(restored.finalSnapshotId, final.id);
  assert.equal(await database.getSetting("activeSnapshotId", ""), "analysis-baseline");
  assert.equal(await database.inventoryCount(), devices.length);
  assert.equal(restored.deviceCount, 1_005);
  assert.deepEqual(restored.result.devices, devices);
  assert.deepEqual(restored.result.devices[0].sourceRowRanges, [[2, 1_501]]);
  assert.deepEqual(restored.result.diagnostics.ambiguous, result.diagnostics.ambiguous);
  assert.equal(restored.result.diagnostics.identityConflictCount, 1);
  assert.equal(restored.result.diagnostics.invalid.length, 2);
  assert.equal(restored.result.diagnostics.invalidTotal, 1_205);
  assert.equal(restored.result.diagnostics.invalidTruncated, 1_203);
  assert.equal(restored.result.diagnostics.invalidMacsTotal, 1_005);
  assert.equal(restored.result.diagnostics.invalidMacsTruncated, 1_004);
  assert.equal(restored.result.diagnostics.ambiguousTotal, 1);
  const preview = await database.loadSingleAnalysis("analysis-a", { previewOnly: true, previewLimit: 7 });
  assert.equal(preview.result.singleAnalysisId, "analysis-a");
  assert.equal(preview.result.devices.length, 7);
  assert.deepEqual(preview.result.devices, devices.slice(0, 7));
  assert.equal(preview.result.preview.length, 7);
  assert.equal(preview.result.diagnostics.invalid.length, 2);
  assert.equal(preview.result.diagnostics.invalidTotal, 1_205);
  assert.equal(preview.result.diagnostics.invalidTruncated, 1_203);
  const deviceBatches = [];
  for await (const batch of database.singleAnalysisDeviceChunks("analysis-a")) deviceBatches.push(batch);
  assert.equal(deviceBatches.reduce((total, batch) => total + batch.length, 0), devices.length);
  assert.deepEqual(deviceBatches.flat(), devices);
  assert.equal(await database.deleteSingleAnalysis("analysis-a"), true);
  assert.equal(await database.loadSingleAnalysis("analysis-a"), null);
  assert.equal((await database.listSingleAnalyses()).total, 1);
});

test("single-file analysis persistence reads staged device pages and stores the complete roster", async () => {
  const database = new Database(`single-analysis-staged-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_003 }, (_, index) => ({ id: `staged-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}` }));
  const deviceStore = {
    count: devices.length,
    async readPage(offset, limit) { return devices.slice(offset, offset + limit); },
  };
  const metadata = await database.saveSingleAnalysis({
    id: "staged-analysis",
    filename: "staged.csv",
    result: {
      devices: devices.slice(0, 20),
      headers: ["MAC"],
      diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [] },
      summary: { valid: devices.length },
    },
    deviceStore,
  });
  assert.equal(metadata.deviceCount, devices.length);
  const restored = await database.loadSingleAnalysis("staged-analysis");
  assert.deepEqual(restored.result.devices, devices);
});

test("scheduled staged analysis persists its full roster before Final consumes the stage", async () => {
  const database = new Database(`scheduled-staged-analysis-${crypto.randomUUID()}`);
  const stageId = `final-device-stage:${crypto.randomUUID()}`;
  const devices = Array.from({ length: 501 }, (_, index) => ({
    id: `scheduled-${index}`,
    mac: `00:22:33:${String(index >> 16).padStart(2, "0")}:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
  }));
  try {
    for (let offset = 0; offset < devices.length; offset += 500) {
      await database.appendFinalDeviceStageChunk(stageId, devices.slice(offset, offset + 500), { offset, total: devices.length });
    }
    await database.finalizeFinalDeviceStage(stageId, devices.length);
    const deviceStore = {
      count: devices.length,
      readPage: (offset, limit) => database.finalDeviceStagePage(stageId, { offset, limit }),
    };
    const analysis = await database.saveSingleAnalysis({
      id: "scheduled-staged-analysis",
      filename: "scheduled.csv",
      deviceStore,
      result: {
        devices: await deviceStore.readPage(0, 20),
        headers: ["MAC"],
        diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [] },
        summary: { valid: devices.length },
      },
    });
    assert.equal(analysis.deviceCount, devices.length);
    const final = await database.saveFinal({
      id: "scheduled-staged-final",
      name: "Scheduled task: scheduled.csv",
      snapshotType: SINGLE_ANALYSIS_SNAPSHOT_TYPE,
      stagedDeviceQueryId: stageId,
      stagedDeviceCount: devices.length,
      activate: false,
      updateInventory: true,
    });
    await database.attachSingleAnalysisSnapshot(analysis.id, final.id);
    const restored = await database.loadSingleAnalysis(analysis.id);
    assert.equal(restored.result.devices.length, devices.length);
    assert.deepEqual(restored.result.devices[0], devices[0]);
    assert.deepEqual(restored.result.devices.at(-1), devices.at(-1));
    assert.equal(restored.finalSnapshotId, final.id);
    assert.equal(final.deviceCount, devices.length);
    assert.equal((await readStore(database, "inventory")).length, devices.length);
    assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId }) => queryId === stageId), false);
  } finally {
    await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
    (await database.open()).close();
  }
});

test("current Smartroom room evidence aggregates in paged scratch with conflict safety", async () => {
  const database = new Database(`current-smartroom-room-evidence-${crypto.randomUUID()}`);
  const queryId = `final-device-stage:${crypto.randomUUID()}`;
  try {
    await database.appendFinalCurrentRoomEvidencePage(queryId, [
      { smartroomId: "SR-A", room: "Room A", mac: "00:11:22:33:44:01" },
      { smartroomId: "sr-a", room: "Room A", mac: "00:11:22:33:44:02" },
      { smartroomId: "SR-B", room: "Room B", mac: "00:11:22:33:44:03" },
    ]);
    await database.appendFinalCurrentRoomEvidencePage(queryId, [
      { smartroomId: "sr-b", room: "Room C", mac: "00:11:22:33:44:04" },
      { smartroomId: "SR-C", room: "", mac: "00:11:22:33:44:05" },
    ]);

    const evidence = await database.finalCurrentRoomEvidenceForIds(queryId, ["sr-a", "sr-b", "sr-c"]);
    assert.deepEqual(evidence.get("sr-a"), {
      smartroomId: "SR-A", room: "Room A", status: "confirmed", deviceCount: 2,
      sampleMacs: ["00:11:22:33:44:01", "00:11:22:33:44:02"],
    });
    assert.deepEqual(evidence.get("sr-b"), {
      smartroomId: "SR-B", room: "", status: "review", deviceCount: 2,
      sampleMacs: ["00:11:22:33:44:03", "00:11:22:33:44:04"],
    });
    assert.equal(evidence.has("sr-c"), false);
    await database.clearAnalyticsAggregateQuery(queryId);
    assert.equal((await readStore(database, "legacyObservationQueryScratch")).some(({ queryId: id }) => id === queryId), false);
  } finally {
    await database.clearAnalyticsAggregateQuery(queryId).catch(() => {});
    (await database.open()).close();
  }
});

test("FinalAnalytics index is chunked, signature checked, replaced, and invalidated with its Final", async () => {
  const database = new Database(`final-analytics-index-${crypto.randomUUID()}`);
  const snapshotId = "indexed-final";
  const records = Array.from({ length: 1120 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:00:00:00:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    alternateMacs: index % 2 ? [`AA:00:00:00:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`] : [],
    fieldSources: { model: "Main" },
    historicalEvidence: { model: { snapshotId: "older" } },
  }));
  const signature = JSON.stringify(["fixture", 1]);
  await database.saveFinalAnalyticsIndex(snapshotId, signature, records, 1);
  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1), records);
  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1, ({ id, mac }) => ({ id, mac })), records.map(({ id, mac }) => ({ id, mac })));
  const trimmedRecords = await database.loadFinalAnalyticsIndex(snapshotId, signature, 1, trimComparisonDeviceInPlace);
  assert.deepEqual(trimmedRecords[0], { id: records[0].id, mac: records[0].mac });
  const packedRecords = await database.loadFinalAnalyticsIndex(snapshotId, signature, 1, trimComparisonDeviceInPlace);
  packAlternateMacsInPlace(packedRecords);
  assert.equal(packedRecords[1].alternateMacs, records[1].alternateMacs[0]);
  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1), records, "Dashboard baseline packing must not mutate persisted FinalAnalytics");
  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1), records, "mutating a detached index chunk must not alter stored FinalAnalytics");
  assert.equal(await database.loadFinalAnalyticsIndex(snapshotId, "stale-signature", 1), null);
  assert.equal(await database.loadFinalAnalyticsIndex(snapshotId, signature, 2), null);
  await database.saveFinalAnalyticsIndex(snapshotId, signature, records.slice(0, 3), 1);
  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1), records.slice(0, 3));
  const db = await database.open();
  const chunksTx = db.transaction("finalAnalytics", "readonly");
  const chunkCount = await new Promise((resolve, reject) => {
    const count = chunksTx.objectStore("finalAnalytics").count();
    count.onsuccess = () => resolve(count.result);
    count.onerror = () => reject(count.error);
  });
  assert.equal(chunkCount, 1);
  await database.saveFinal({ id: snapshotId, name: "Replaced Final", createdAt: "2026-02-01T00:00:00Z", devices: [{ id: "replacement" }] });
  assert.equal(await database.loadFinalAnalyticsIndex(snapshotId, signature, 1), null);
  const afterFinalTx = db.transaction("finalAnalytics", "readonly");
  const afterFinalCount = await new Promise((resolve, reject) => {
    const count = afterFinalTx.objectStore("finalAnalytics").count();
    count.onsuccess = () => resolve(count.result);
    count.onerror = () => reject(count.error);
  });
  assert.equal(afterFinalCount, 0);
});

test("FinalAnalytics v2 index is rebuilt as v5 without replacing Final or Inventory", async () => {
  const database = new Database(`final-analytics-v2-upgrade-${crypto.randomUUID()}`);
  const devices = [
    { id: "device-1", mac: "00:11:22:33:44:51", model: "Board A" },
    { id: "device-2", mac: "00:11:22:33:44:52", model: "Board B" },
  ];
  const snapshotId = "preserved-v2-final";
  await database.saveFinal({ id: snapshotId, createdAt: "2026-08-01T00:00:00Z", devices });
  const metadata = await database.activeSnapshotMetadata();
  const staleSignature = JSON.stringify(["final-analytics-index", 2, snapshotId, metadata.createdAt, metadata.deviceCount, metadata.chunkCount, metadata.dataRevision || 0]);
  const oldIndex = compactFinalDevices(devices);
  await database.saveFinalAnalyticsIndex(snapshotId, staleSignature, oldIndex, 2);

  assert.equal(FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, 5);
  assert.equal(await database.loadFinalAnalyticsIndex(snapshotId, staleSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), null);
  const rebuilt = [];
  await database.forEachSnapshotChunk(snapshotId, (chunk) => rebuilt.push(...chunk.map(compactComparisonDevice)));
  const currentSignature = finalAnalyticsIndexSignature(metadata);
  await database.saveFinalAnalyticsIndex(snapshotId, currentSignature, rebuilt, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);

  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, currentSignature, 5), rebuilt);
  assert.equal((await database.activeSnapshotMetadata()).id, snapshotId);
  assert.equal((await database.loadSnapshot(snapshotId)).devices.length, devices.length);
  assert.equal((await readInventory(database)).length, devices.length);
  const db = await database.open();
  const tx = db.transaction("finalAnalytics", "readonly");
  const count = await new Promise((resolve, reject) => {
    const request = tx.objectStore("finalAnalytics").count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(count, 1);
});

test("FinalAnalytics v3 projection upgrades to v5 without replacing device snapshots", async () => {
  const database = new Database(`final-analytics-v3-upgrade-${crypto.randomUUID()}`);
  const devices = [
    { id: "device-1", mac: "00:11:22:33:44:61", room: "A", model: "Board A", fieldSources: { model: "Main" } },
    { id: "device-2", mac: "00:11:22:33:44:62", room: "B", model: "Board B", historicalEvidence: { model: { snapshotId: "older" } } },
  ];
  const snapshotId = "preserved-v3-final";
  await database.saveFinal({ id: snapshotId, createdAt: "2026-09-01T00:00:00Z", devices });
  const metadata = await database.activeSnapshotMetadata();
  const staleSignature = JSON.stringify(["final-analytics-index", 3, snapshotId, metadata.createdAt, metadata.deviceCount, metadata.chunkCount, metadata.dataRevision || 0]);
  const oldIndex = compactFinalDevices(devices);
  await database.saveFinalAnalyticsIndex(snapshotId, staleSignature, oldIndex, 3);

  assert.equal(FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, 5);
  assert.equal(await database.loadFinalAnalyticsIndex(snapshotId, staleSignature, 4), null);
  const projected = [];
  await database.forEachSnapshotChunk(snapshotId, (chunk) => projected.push(...chunk.map(compactComparisonDevice)));
  const currentSignature = finalAnalyticsIndexSignature(metadata);
  await database.saveFinalAnalyticsIndex(snapshotId, currentSignature, projected, 5);

  assert.deepEqual(await database.loadFinalAnalyticsIndex(snapshotId, currentSignature, 5), projected);
  assert.equal((await database.activeSnapshotMetadata()).id, snapshotId);
  assert.equal((await database.loadSnapshot(snapshotId)).devices.length, devices.length);
  assert.equal((await readInventory(database)).length, devices.length);
});

test("historical comparison backfill writes bounded derived index chunks with exact identity resolution", async () => {
  const database = new Database(`mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const historyId = "backfill-index-history";
  const baselineId = "backfill-index-baseline";
  const derivedId = `__mac_analyzer_comparison_backfill__:${baselineId}`;
  await database.saveFinal({
    id: historyId,
    createdAt: "2026-01-01T00:00:00Z",
    devices: [{ id: "device-1", mac: "00:11:22:33:44:55", model: "Recovered model" }],
  });
  await database.saveFinal({
    id: baselineId,
    createdAt: "2026-01-02T00:00:00Z",
    devices: [{ id: "device-1", mac: "00:11:22:33:44:55", model: "" }],
  });
  const snapshots = await database.listSnapshots();
  const history = snapshots.find(({ id }) => id === historyId);
  const baseline = snapshots.find(({ id }) => id === baselineId);
  const historySignature = finalAnalyticsIndexSignature(history);
  const baselineSignature = finalAnalyticsIndexSignature(baseline);
  await database.saveFinalAnalyticsIndexFromSnapshot(
    historyId,
    historySignature,
    (visit) => database.forEachSnapshotChunk(historyId, visit),
    compactComparisonDevice,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
  );
  const derivedSignature = JSON.stringify(["comparison-backfill-index", baselineSignature, [historySignature]]);
  await database.saveFinalAnalyticsIndexFromSnapshot(
    derivedId,
    derivedSignature,
    (visit) => database.forEachSnapshotChunk(baselineId, async (chunk) => {
      for (const device of chunk) trimComparisonDeviceInPlace(device);
      const restored = await backfillComparisonDevices(
        chunk,
        [history],
        (snapshotId, snapshotVisit) => database.forEachSnapshotChunk(snapshotId, snapshotVisit),
        {
          inPlace: true,
          resolveSnapshotIdentityIndex: (snapshot, devices) => database.buildFinalAnalyticsIdentityIndex(
            snapshot.id,
            finalAnalyticsIndexSignature(snapshot),
            FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
            devices,
          ),
        },
      );
      for (const device of restored.devices) trimComparisonDeviceInPlace(device);
      await visit(restored.devices);
    }),
    null,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
  );

  const restored = await database.loadFinalAnalyticsIndex(derivedId, derivedSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);
  assert.deepEqual(restored, [{ id: "device-1", mac: "00:11:22:33:44:55", model: "Recovered model" }]);
  assert.equal(await database.loadFinalAnalyticsIndex(baselineId, baselineSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), null);
});

test("FinalAnalytics streams the baseline and resolves exact identity candidates by indexed chunk", async () => {
  const database = new Database(`final-analytics-identity-${crypto.randomUUID()}`);
  const baselineId = "identity-baseline";
  const currentId = "identity-current";
  const devices = Array.from({ length: 505 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:33:${(index >> 8).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    ...(index === 499 ? { alternateMacs: ["AA:BB:CC:DD:EE:99"] } : {}),
    hostname: [0, 500, 504].includes(index) ? "shared-host" : `host-${index}`,
    model: "Board A",
  }));
  await database.saveFinal({ id: baselineId, createdAt: "2026-10-01T00:00:00Z", devices });
  const baselineMetadata = await database.activeSnapshotMetadata();
  const signature = finalAnalyticsIndexSignature(baselineMetadata);
  assert.equal(await database.saveFinalAnalyticsIndexFromSnapshot(
    baselineId,
    signature,
    (visit) => database.forEachSnapshotChunk(baselineId, visit),
    compactComparisonDevice,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
  ), true);
  assert.equal(await database.hasFinalAnalyticsIndex(baselineId, signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), true);

  const exactCandidates = await database.findFinalAnalyticsIdentityCandidates(
    baselineId,
    signature,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    { id: "device-500", mac: "00:11:22:33:FF:FF" },
  );
  assert.deepEqual(exactCandidates.candidates.map(({ id }) => id), ["device-500"]);
  assert.equal(exactCandidates.overflowTokenKeys.size, 0);
  const weakCandidates = await database.findFinalAnalyticsIdentityCandidates(
    baselineId,
    signature,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    { hostname: "shared-host" },
  );
  assert.equal(weakCandidates.candidates.length, 3);
  assert.equal(weakCandidates.overflowTokenKeys.has("hostname:shared-host"), true);
  assert.equal(await database.findFinalAnalyticsIdentityCandidates(
    baselineId,
    "stale-signature",
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    { id: "device-500" },
  ), null);

  const identityIndex = await database.buildFinalAnalyticsIdentityIndex(baselineId, signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, [
    { id: "device-500", mac: "00:11:22:33:FF:FF" },
    { id: "new-device", hostname: "shared-host" },
  ]);
  assert.ok(identityIndex);
  const exact = findIdentityMatch({ id: "device-500", mac: "00:11:22:33:FF:FF" }, identityIndex);
  assert.equal(exact.status, "matched");
  assert.equal(exact.position, 500);
  assert.equal(exact.match.id, "device-500");
  assert.equal(exact.identityConflicts.length, 0);
  const alternateMacIndex = await database.buildFinalAnalyticsIdentityIndex(baselineId, signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, [
    { mac: "AA:BB:CC:DD:EE:99" },
  ]);
  const alternateMacMatch = findIdentityMatch({ mac: "AA:BB:CC:DD:EE:99" }, alternateMacIndex);
  assert.equal(alternateMacMatch.status, "matched");
  assert.equal(alternateMacMatch.position, 499);
  const overflow = findIdentityMatch({ id: "new-device", hostname: "shared-host" }, identityIndex);
  assert.equal(overflow.status, "ambiguous");
  assert.equal(overflow.strongIdentityUnmatched, true);
  assert.deepEqual([...identityIndex.overflowTokenKeys], ["hostname:shared-host"]);

  const currentDevices = [
    { ...devices[1] },
    { ...devices[500], model: "Board B" },
    { id: "new-device", mac: "00:11:22:33:EE:01", hostname: "new-host", model: "Board C" },
  ];
  await database.saveFinal({ id: currentId, createdAt: "2026-10-02T00:00:00Z", devices: currentDevices });
  const storedCurrent = [];
  await database.forEachSnapshotChunk(currentId, (chunk) => storedCurrent.push(...chunk));
  assert.equal(storedCurrent[1].model, "Board B");
  const visitCurrent = (visit) => database.forEachSnapshotChunk(currentId, visit);
  const resolveIdentityChunk = (chunk) => database.buildFinalAnalyticsIdentityIndex(
    baselineId,
    signature,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    chunk,
  );
  const added = await compareFinalAdditionPage([], visitCurrent, { resolveIdentityChunk });
  assert.deepEqual(added.devices.map(({ id }) => id), ["new-device"]);
  const visitBaselineChunks = (visit) => database.forEachFinalAnalyticsIndexChunk(
    baselineId,
    signature,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    visit,
  );
  const absent = await compareFinalAbsencePage([], visitCurrent, {
    resolveIdentityChunk,
    previousCount: devices.length,
    visitPreviousChunks: visitBaselineChunks,
    limit: 500,
  });
  assert.equal(absent.total, 503);
  assert.equal(absent.devices.length, 500);
  const filteredAbsent = await compareFinalAbsencePage([], visitCurrent, {
    resolveIdentityChunk,
    previousCount: devices.length,
    visitPreviousChunks: visitBaselineChunks,
    deviceMatches: ({ hostname }) => hostname === "shared-host",
  });
  assert.deepEqual(filteredAbsent.devices.map(({ id }) => id), ["device-0", "device-504"]);
  const visitCurrentWithWeakAmbiguity = async (visit) => {
    await visit(storedCurrent);
    await visit([{ hostname: "shared-host" }]);
  };
  const unresolvedAbsent = await compareFinalAbsencePage([], visitCurrentWithWeakAmbiguity, {
    resolveIdentityChunk,
    previousCount: devices.length,
    visitPreviousChunks: visitBaselineChunks,
  });
  assert.equal(unresolvedAbsent.total, 501, "weak-token ambiguity must suppress every baseline row carrying that token");
  const diagnosticDevices = [
    { hostname: "shared-host" },
    { id: "device-1", mac: devices[2].mac },
  ];
  const visitDiagnosticDevices = async (visit) => { await visit(diagnosticDevices); };
  const fullDiagnostics = await compareFinalIdentityDiagnosticPage(devices.map(compactComparisonDevice), visitDiagnosticDevices, { offset: 0, limit: 2 });
  const indexedDiagnostics = await compareFinalIdentityDiagnosticPage([], visitDiagnosticDevices, {
    offset: 0,
    limit: 2,
    resolveIdentityChunk,
  });
  assert.deepEqual(indexedDiagnostics, fullDiagnostics);
  assert.equal(indexedDiagnostics.total, 3);
  assert.equal(indexedDiagnostics.ambiguousCount, 2);
  assert.equal(indexedDiagnostics.identityConflictCount, 1);
  const fullDiagnosticsLastPage = await compareFinalIdentityDiagnosticPage(devices.map(compactComparisonDevice), visitDiagnosticDevices, { offset: 2, limit: 2 });
  const indexedDiagnosticsLastPage = await compareFinalIdentityDiagnosticPage([], visitDiagnosticDevices, {
    offset: 2,
    limit: 2,
    resolveIdentityChunk,
  });
  assert.deepEqual(indexedDiagnosticsLastPage, fullDiagnosticsLastPage);
  const directIndex = await resolveIdentityChunk(storedCurrent);
  const directMatch = findIdentityMatch(currentDevices[1], directIndex);
  assert.equal(directMatch.status, "matched");
  assert.equal(directMatch.match.model, "Board A");
  assert.equal(storedCurrent[1].id, "device-500");
  assert.equal(findIdentityMatch(storedCurrent[1], directIndex).match.model, "Board A");
  assert.equal(compareFinals([directMatch.match], [storedCurrent[1]]).modified.length, 1);
  const modified = await compareFinalModifiedDevicePage([], async (visit) => visit(storedCurrent), { resolveIdentityChunk });
  assert.deepEqual(modified.devices.map(({ id }) => id), ["device-500"]);
  assert.equal(modified.total, 1);
  const unchanged = await compareFinalUnchangedPage([], async (visit) => visit(storedCurrent), { resolveIdentityChunk });
  assert.deepEqual(unchanged.devices.map(({ id }) => id), ["device-1"]);
  const events = await compareFinalModificationEventPage([], async (visit) => visit(storedCurrent), { resolveIdentityChunk });
  assert.deepEqual(events.events.map(({ device, change }) => [device.id, change.field]), [["device-500", "model"]]);
  const groups = await compareFinalModificationDeviceGroupPage([], async (visit) => visit(storedCurrent), { resolveIdentityChunk });
  assert.deepEqual(groups.groups.map(({ device }) => device.id), ["device-500"]);
  assert.deepEqual(await database.loadFinalAnalyticsIndex(baselineId, signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), devices.map(compactComparisonDevice));
});

test("Previous Final identity lookup hydrates only matched rows from bounded snapshot chunks", async () => {
  const database = new Database(`previous-final-index-${crypto.randomUUID()}`);
  const field = "custom_32345678-1234-4234-8234-123456789abc";
  const devices = Array.from({ length: 1_005 }, (_, index) => ({
    id: `previous-${index}`,
    mac: `00:11:22:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    model: `Model ${index}`,
    ...(index === 700 ? {
      customFields: { [field]: "Переговорная 700" },
      customFieldSources: { [field]: "legacy.sqlite:Main" },
      vendorConfidence: 0.93,
      vendorSource: "legacy.sqlite:oui_vendor_history",
    } : {}),
    rawSpreadsheetRow: Array(250).fill("discarded source payload"),
  }));
  try {
    const snapshot = await database.saveFinal({ id: "previous-final-bounded-identity", devices });
    const originalVisit = database.forEachSnapshotChunk.bind(database);
    const visitedChunkLengths = [];
    database.forEachSnapshotChunk = (id, visit, options) => originalVisit(id, async (chunk, index, metadata) => {
      visitedChunkLengths.push(chunk.length);
      return visit(chunk, index, metadata);
    }, options);

    const index = await database.buildPreviousFinalIdentityIndex(snapshot.id, [
      { id: "previous-700", mac: "00:11:22:00:02:BC" },
      { id: "missing-device", mac: "AA:BB:CC:DD:EE:FF" },
    ]);
    const candidates = [];
    index.forEachCandidate((device, position) => candidates.push({ device, position }));

    assert.deepEqual(visitedChunkLengths, [500, 500, 5]);
    assert.equal(index.devices.length, 1_005);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].position, 700);
    assert.equal(candidates[0].device.model, "Model 700");
    assert.equal(candidates[0].device.customFields[field], "Переговорная 700");
    assert.equal(candidates[0].device.customFieldSources[field], "legacy.sqlite:Main");
    assert.equal(candidates[0].device.vendorConfidence, 0.93);
    assert.equal(Object.hasOwn(candidates[0].device, "rawSpreadsheetRow"), false);
    assert.equal(await database.hasFinalAnalyticsIndex(snapshot.id, finalAnalyticsIndexSignature(snapshot), FINAL_ANALYTICS_INDEX_SCHEMA_VERSION), true);
    await assert.rejects(database.buildPreviousFinalIdentityIndex(snapshot.id, [{ id: "previous-700" }], "stale-signature"), /изменился/);
    assert.equal(await database.assertSnapshotSignature(snapshot.id, finalAnalyticsIndexSignature(snapshot)), true);
    index.tokens.clear();
  } finally {
    (await database.open()).close();
  }
});

test("FinalAnalytics bounds identity lookup cursors to one 250-key transaction batch", async () => {
  const database = new Database(`final-analytics-identity-batch-${crypto.randomUUID()}`);
  const snapshotId = "identity-batch-baseline";
  await database.saveFinal({ id: snapshotId, createdAt: "2026-10-01T00:00:00Z", devices: [
    { id: "baseline-device-1", mac: "00:11:22:33:44:55", hostname: "shared-host", model: "Board A" },
    { id: "baseline-device-2", mac: "00:11:22:33:44:56", hostname: "shared-host", model: "Board B" },
    { id: "baseline-device-3", mac: "00:11:22:33:44:57", hostname: "shared-host", model: "Board C" },
  ] });
  const metadata = await database.activeSnapshotMetadata();
  const signature = finalAnalyticsIndexSignature(metadata);
  assert.equal(await database.saveFinalAnalyticsIndexFromSnapshot(
    snapshotId,
    signature,
    (visit) => database.forEachSnapshotChunk(snapshotId, visit),
    compactComparisonDevice,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
  ), true);

  const prototype = globalThis.IDBIndex.prototype;
  const originalOpenCursor = prototype.openCursor;
  const cursorsByTransaction = new WeakMap();
  let maximumCursorsPerTransaction = 0;
  let totalCursors = 0;
  prototype.openCursor = function (...args) {
    const transaction = this.objectStore.transaction;
    const count = (cursorsByTransaction.get(transaction) || 0) + 1;
    cursorsByTransaction.set(transaction, count);
    maximumCursorsPerTransaction = Math.max(maximumCursorsPerTransaction, count);
    totalCursors += 1;
    return originalOpenCursor.apply(this, args);
  };

  let identityIndex;
  try {
    const currentDevices = Array.from({ length: 600 }, (_, index) => ({
      id: `current-${index}`,
      deviceId: `asset-${index}`,
      hostname: "shared-host",
    }));
    identityIndex = await database.buildFinalAnalyticsIdentityIndex(
      snapshotId,
      signature,
      FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
      currentDevices,
    );
  } finally {
    prototype.openCursor = originalOpenCursor;
  }

  assert.ok(identityIndex);
  assert.equal(totalCursors, 1_202);
  assert.equal(maximumCursorsPerTransaction, 250);
  assert.ok(identityIndex.overflowTokenKeys.has("hostname:shared-host"));
  const weakFallback = findIdentityMatch({ id: "new-device", hostname: "shared-host" }, identityIndex);
  assert.equal(weakFallback.status, "ambiguous");
  assert.equal(weakFallback.strongIdentityUnmatched, true);
});

test("FinalAnalytics identity lookup refuses unsafe persisted device counts", async () => {
  const database = new Database(`final-analytics-unsafe-count-${crypto.randomUUID()}`);
  const snapshotId = "unsafe-count-baseline";
  await database.saveFinal({ id: snapshotId, createdAt: "2026-10-01T00:00:00Z", devices: [
    { id: "baseline-device", mac: "00:11:22:33:44:55", model: "Board A" },
  ] });
  const metadata = await database.activeSnapshotMetadata();
  const signature = finalAnalyticsIndexSignature(metadata);
  assert.equal(await database.saveFinalAnalyticsIndexFromSnapshot(
    snapshotId,
    signature,
    (visit) => database.forEachSnapshotChunk(snapshotId, visit),
    compactComparisonDevice,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
  ), true);

  const db = await database.open();
  const tx = db.transaction("finalAnalyticsMetadata", "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Failed to corrupt test metadata"));
    tx.onabort = () => reject(tx.error || new Error("Test metadata transaction aborted"));
  });
  const store = tx.objectStore("finalAnalyticsMetadata");
  const request = store.get(snapshotId);
  request.onerror = () => { try { tx.abort(); } catch {} };
  request.onsuccess = () => {
    const record = request.result;
    record.deviceCount = Number.MAX_SAFE_INTEGER + 1;
    record.chunkCount = Math.ceil(record.deviceCount / 500);
    store.put(record);
  };
  await done;

  assert.equal(await database.buildFinalAnalyticsIdentityIndex(
    snapshotId,
    signature,
    FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
    [{ id: "current-device", mac: "00:11:22:33:44:56" }],
  ), null);
});

test("history pages are chronological, bounded, and use an exclusive cursor across duplicate timestamps", async () => {
  const database = new Database(`history-pages-${crypto.randomUUID()}`);
  const changes = Array.from({ length: 205 }, (_, index) => ({
    after: { id: "device-a", mac: "00:11:22:33:44:55" },
    changes: [{
      label: "Модель",
      oldValue: String(index),
      newValue: String(index + 1),
      timestamp: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 2))).toISOString(),
    }],
  }));
  await database.saveFinal({ id: "history-final", createdAt: "2027-01-01T00:00:00.000Z", devices: [], comparison: { modified: changes, added: [], absent: [] } });
  const pages = [];
  let cursor = null;
  do {
    const page = await database.historyPage("device-a", { cursor, limit: 100 });
    assert.ok(page.rows.length <= 100);
    assert.equal(page.total, 205);
    pages.push(...page.rows);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
    assert.ok(cursor);
  } while (cursor);
  assert.equal(pages.length, 205);
  assert.deepEqual(pages.map((row) => row.newValue), changes.flatMap((row) => row.changes.map((change) => change.newValue)));
  assert.deepEqual(pages.map((row) => row.timestamp), [...pages.map((row) => row.timestamp)].sort());
});

test("named local archives stream portable data and restore additively", async () => {
  const source = new Database(`local-archive-source-${crypto.randomUUID()}`);
  const originalBlob = new globalThis.Blob(["local backup source file"], { type: "text/plain" });
  await source.saveFinal({
    id: "archived-final", name: "Archived", createdAt: "2026-01-01T00:00:00Z",
    devices: [{ id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Archive vendor" }],
    originalFiles: [{ role: "main", file: { name: "archived.csv", type: originalBlob.type, size: originalBlob.size, slice: (...args) => originalBlob.slice(...args) } }],
    comparison: { added: [{ id: "device-a", mac: "00:11:22:33:44:55" }], modified: [], absent: [] },
  });
  const sourceDb = await source.open();
  const fallbackHistoryTx = sourceDb.transaction("history", "readwrite");
  fallbackHistoryTx.objectStore("history").put({
    id: "archive-history-timestamp-fallback",
    snapshotId: "archived-final",
    deviceId: "device-a",
    type: "modified",
    field: "model",
  });
  await new Promise((resolve, reject) => {
    fallbackHistoryTx.oncomplete = resolve;
    fallbackHistoryTx.onerror = () => reject(fallbackHistoryTx.error);
    fallbackHistoryTx.onabort = () => reject(fallbackHistoryTx.error);
  });
  const analysis = { filename: "history.csv", headers: ["MAC"], mapping: { mac: 0 }, mappingMode: "manual", detection: {}, summary: { valid: 1 }, devices: [{ id: "history-device", mac: "00:00:00:00:00:01" }], diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [], identityConflictCount: 0, duplicateRows: 0 } };
  await source.saveSingleAnalysis({ id: "local-single-analysis", filename: "history.csv", result: analysis, processedAt: "2026-01-01T12:00:00Z" });
  const archive = await source.createLocalArchive("Before update");
  assert.equal(archive.snapshotCount, 1);
  assert.ok(archive.recordCount > 0);
  assert.equal((await source.listLocalArchives()).length, 1);
  const exported = await new globalThis.Response(await source.exportLocalArchiveStream(archive.id)).json();
  assert.equal(exported.snapshots[0].devices.length, 1);
  assert.equal(exported.snapshots[0].id, "archived-final");
  assert.equal(exported.originalFiles.length, 1);
  assert.equal(exported.originalFiles[0].chunks.join(""), "bG9jYWwgYmFja3VwIHNvdXJjZSBmaWxl");
  assert.equal(exported.singleAnalyses[0].id, "local-single-analysis");
  assert.equal(exported.singleAnalysisChunks[0].analysisId, "local-single-analysis");

  await source.saveFinal({ id: "current-final", name: "Current", createdAt: "2026-01-02T00:00:00Z", devices: [{ id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Current vendor" }] });
  const db = await source.open();
  const remove = db.transaction(["snapshots", "snapshotChunks", "history"], "readwrite");
  remove.objectStore("snapshots").delete("archived-final");
  remove.objectStore("snapshotChunks").delete(["archived-final", 0]);
  remove.objectStore("history").delete("archive-history-timestamp-fallback");
  await new Promise((resolve, reject) => {
    remove.oncomplete = resolve;
    remove.onerror = () => reject(remove.error);
    remove.onabort = () => reject(remove.error);
  });
  const listSnapshots = source.listSnapshots.bind(source);
  source.listSnapshots = async () => { throw new Error("archive restore must not materialize all snapshot metadata"); };
  let restored;
  try {
    restored = await source.restoreLocalArchive(archive.id);
  } finally {
    source.listSnapshots = listSnapshots;
  }
  assert.equal(restored.activeSnapshotId, "current-final");
  assert.equal((await source.listSnapshots()).length, 2);
  assert.equal((await source.historyPage("device-a")).rows.find(({ id }) => id === "archive-history-timestamp-fallback")?.timestamp, "2026-01-01T00:00:00Z");
  assert.equal(await source.getOriginalFile("archived-final", "main").then((file) => file.blob.text()), "local backup source file");
  assert.deepEqual((await source.loadSingleAnalysis("local-single-analysis")).result.devices, analysis.devices);
  assert.equal((await readInventory(source)).find((item) => item.id === "device-a").manufacturer, "Current vendor");
  const historyCount = (await source.historyPage("device-a")).total;
  await source.restoreLocalArchive(archive.id);
  assert.equal((await source.historyPage("device-a")).total, historyCount);
  await source.deleteLocalArchive(archive.id);
  assert.equal((await source.listLocalArchives()).length, 0);
});

test("local archive restore writes simple collections once per page instead of once per record", async () => {
  const database = new Database(`local-archive-page-restore-${crypto.randomUUID()}`);
  const db = await database.open();
  const seed = db.transaction("oui", "readwrite");
  for (let index = 0; index < 1_001; index += 1) seed.objectStore("oui").put({ prefix: index.toString(16).padStart(6, "0").toUpperCase(), vendor: `Vendor ${index}` });
  await new Promise((resolve, reject) => { seed.oncomplete = resolve; seed.onerror = () => reject(seed.error); seed.onabort = () => reject(seed.error); });
  const archive = await database.createLocalArchive("OUI batch restore");
  const stagedRecords = (await readStore(database, "archiveRecords")).filter((record) => record.archiveId === archive.id);
  assert.equal(stagedRecords.length, 1_001);
  assert.ok(stagedRecords.every((record) => !Object.hasOwn(record, "sourceKey")), "the indexed compound recordKey already contains the retrieval key");
  const remove = db.transaction("oui", "readwrite");
  remove.objectStore("oui").clear();
  await new Promise((resolve, reject) => { remove.oncomplete = resolve; remove.onerror = () => reject(remove.error); remove.onabort = () => reject(remove.error); });

  const nativeTransaction = db.transaction.bind(db);
  let ouiWriteTransactions = 0;
  db.transaction = (stores, mode, options) => {
    const names = typeof stores === "string" ? [stores] : [...stores];
    if (mode === "readwrite" && names.includes("oui")) ouiWriteTransactions += 1;
    return nativeTransaction(stores, mode, options);
  };
  await database.restoreLocalArchive(archive.id);
  assert.equal(ouiWriteTransactions, 2);
  assert.equal((await readStore(database, "oui")).length, 1_001);
  await database.deleteLocalArchive(archive.id);
});

test("snapshot history analytics cache is signed, readable, and invalidated on new Final", async () => {
  const database = new Database(`analytics-cache-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "first", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "a", mac: "00:11:22:33:44:55" }] });
  const metadata = await database.listSnapshots();
  const signature = snapshotHistorySignature(metadata);
  const connection = await database.open();
  const unrelated = connection.transaction("snapshots", "readwrite");
  unrelated.objectStore("snapshots").put({
    id: "single-analysis-outside-final-cache-signature",
    snapshotType: "single-analysis",
    name: "Single file: devices.csv",
    createdAt: "2026-01-01T12:00:00.000Z",
    deviceCount: 1,
    chunkCount: 1,
  });
  await new Promise((resolve, reject) => {
    unrelated.oncomplete = resolve;
    unrelated.onerror = () => reject(unrelated.error);
    unrelated.onabort = () => reject(unrelated.error);
  });
  const value = { history: { snapshots: 1, deviceTotal: 1, uniqueMacs: 1 }, weekly: [], totals: [] };
  assert.equal(await database.loadSnapshotHistoryCache(signature), null);
  assert.equal(await database.saveSnapshotHistoryCache(signature, value), true);
  assert.deepEqual(await database.loadSnapshotHistoryCache(signature), value);
  const filteredValue = { ...value, totals: [{ label: "Final 1", value: 1 }] };
  const manufacturerFilters = { query: "DEV-1", manufacturer: "Acme", room: "", status: "all" };
  await database.saveSnapshotHistoryCache(signature, filteredValue, manufacturerFilters);
  assert.deepEqual(await database.loadSnapshotHistoryCache(signature, { ...manufacturerFilters, status: "missing" }), filteredValue);
  assert.equal(await database.loadSnapshotHistoryCache(signature, { ...manufacturerFilters, manufacturer: "Other" }), null);
  const cacheProgress = [];
  assert.equal(await database.saveAnalyticsCache("temporal-day-30", signature, value, 1, { onProgress: ({ phase }) => cacheProgress.push(phase) }), true);
  assert.deepEqual(cacheProgress, ["started", "serialize-start", "serialize-complete", "put-complete", "transaction-complete", "complete"]);
  assert.deepEqual(await database.loadAnalyticsCache("temporal-day-30", signature), value);
  assert.equal(await database.loadAnalyticsCache("temporal-day-30", signature, 2), null);
  assert.equal(await database.loadSnapshotHistoryCache("stale-signature"), null);
  await database.saveFinal({ id: "second", createdAt: "2026-01-02T00:00:00Z", devices: [] });
  assert.equal(await database.saveSnapshotHistoryCache(signature, value), false);
  assert.equal(await database.loadAnalyticsCache("temporal-day-30", signature), null);
  assert.equal(await database.loadSnapshotHistoryCache(signature), null);
});

test("full Dashboard report restores from the signed cache after reopening IndexedDB", async () => {
  const name = `dashboard-report-restart-${crypto.randomUUID()}`;
  const database = new Database(name);
  const devices = [
    { id: "device-1", mac: "00:11:22:33:44:01", manufacturer: "Acme", model: "Room Hub", room: "101", ip: "10.0.0.1", address: "North" },
    { id: "device-2", mac: "00:11:22:33:44:02", manufacturer: "Acme", model: "Room Hub", room: "101", ip: "10.0.0.2", address: "North" },
    { id: "device-3", mac: "00:11:22:33:44:03", manufacturer: "Other", model: "Panel", room: "202", ip: "10.0.0.3", address: "South" },
  ];
  await database.saveFinal({
    id: "dashboard-report-final",
    createdAt: "2026-10-17T12:00:00.000Z",
    devices,
  });
  const snapshot = (await database.listSnapshots())[0];
  const signature = snapshotHistorySignature(await database.listSnapshots());
  const dataset = buildDatasetAnalytics(devices, { includeTopologyDevices: false });
  const filters = { status: "all", query: "", manufacturer: "", room: "" };
  const cacheKey = `selected-final-dataset-v6:${JSON.stringify([signature, "", snapshot.id, filters])}`;
  const cachedValue = { snapshotId: `${snapshot.id}:dashboard:all`, dataset };

  assert.equal(await database.saveAnalyticsCache(cacheKey, signature, cachedValue, 6), true);
  database.connection?.close();

  const reopened = new Database(name);
  const restored = await reopened.loadAnalyticsCache(cacheKey, signature, 6);
  assert.equal(restored.snapshotId, cachedValue.snapshotId);
  assert.deepEqual(restored.dataset, dataset);
  assert.match(restored.dataset.reportText, /Всего устройств: 3/);
  assert.match(restored.dataset.reportText, /Acme: 2 \(66\.7%\)/);
  await reopened.saveFinal({ id: "dashboard-report-next-final", createdAt: "2026-10-18T12:00:00.000Z", devices: [] });
  assert.equal(await reopened.loadAnalyticsCache(cacheKey, signature, 6), null);
});

test("custom MAC-prefix model rules survive archive transfer", async () => {
  const source = new Database(`model-rule-source-${crypto.randomUUID()}`);
  await source.saveMac5Model("0011223344", "Conference Model");
  const archive = await readArchive(source);
  const target = new Database(`model-rule-target-${crypto.randomUUID()}`);
  await target.importArchive(archive);
  assert.equal((await target.mac5ModelPage({ limit: 1 })).rows[0].model, "Conference Model");
});

test("Final learns portable Smartroom room mappings and retains conflicting IDs for review", async () => {
  const source = new Database(`smartroom-map-source-${crypto.randomUUID()}`);
  await source.saveFinal({ id: "mapping-final", name: "Mapping Final", createdAt: "2026-10-14T12:00:00Z", devices: [
    { id: "a", mac: "00:11:22:33:44:01", smartroomId: "SR-101", room: "Room 101" },
    { id: "b", mac: "00:11:22:33:44:02", smartroomId: "sr-101", room: "Room 101" },
    { id: "c", mac: "00:11:22:33:44:03", smartroomId: "SR-102", room: "Room A" },
    { id: "d", mac: "00:11:22:33:44:04", smartroomId: "SR-102", room: "Room B" },
  ] });
  const mappings = await source.smartroomRoomMappingsForIds(["SR-101", "SR-102"]);
  assert.equal(mappings.length, 2);
  assert.equal(mappings.find((item) => item.smartroomIdKey === "sr-101")?.room, "Room 101");
  assert.equal(mappings.find((item) => item.smartroomIdKey === "sr-102")?.status, "review");
  assert.ok(mappings.every((item) => item.sourceFinalId === "mapping-final" && item.createdAt === "2026-10-14T12:00:00Z"));
  const archive = await readArchive(source);
  const target = new Database(`smartroom-map-target-${crypto.randomUUID()}`);
  await target.importArchive(archive);
  assert.deepEqual(await target.smartroomRoomMappingsForIds(["SR-101", "SR-102"]), mappings);
});

test("chunked Smartroom evidence preserves the source room order for its five sample MACs", async () => {
  const database = new Database(`smartroom-sample-order-${crypto.randomUUID()}`);
  const devices = [
    { id: "a-first", mac: "00:11:22:33:44:01", smartroomId: "SR-SAMPLES", room: "Room A" },
    { id: "b-first", mac: "00:11:22:33:44:02", smartroomId: "SR-SAMPLES", room: "Room B" },
    ...Array.from({ length: 498 }, (_, index) => index === 0
      ? { id: "early-mapping", mac: "00:11:22:33:44:06", smartroomId: "SR-EARLY", room: "Early room" }
      : { id: `filler-${index}`, mac: "", smartroomId: "", room: "" }),
    { id: "b-second", mac: "00:11:22:33:44:04", smartroomId: "SR-SAMPLES", room: "Room B" },
    { id: "a-second", mac: "00:11:22:33:44:03", smartroomId: "SR-SAMPLES", room: "Room A" },
    { id: "c-first", mac: "00:11:22:33:44:05", smartroomId: "SR-SAMPLES", room: "Room C" },
  ];
  await database.saveFinal({ id: "smartroom-sample-order-final", devices, updateInventory: false });

  const [mapping] = await database.smartroomRoomMappingsForIds(["SR-SAMPLES"]);
  assert.deepEqual(mapping.sampleMacs, [
    "00:11:22:33:44:01", "00:11:22:33:44:03", "00:11:22:33:44:02", "00:11:22:33:44:04", "00:11:22:33:44:05",
  ]);
  assert.ok(mapping.alternatives.every((alternative) => !Object.hasOwn(alternative, "roomOrder") && !Object.hasOwn(alternative, "sampleMacs")));
  const [earlyMapping] = await database.smartroomRoomMappingsForIds(["SR-EARLY"]);
  assert.deepEqual(earlyMapping.alternatives, [{ room: "Early room", deviceCount: 1 }]);
});

test("Final bounds Smartroom room alternatives across chunks and leaves truncated mappings unresolved", async () => {
  const database = new Database(`room-alternatives-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 650 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    smartroomId: "SR-COLLISION",
    room: `Room ${index}`,
  }));
  await database.saveFinal({ id: "many-rooms", devices, updateInventory: false });
  const [mapping] = await database.smartroomRoomMappingsForIds(["SR-COLLISION"]);
  assert.equal(mapping.status, "review");
  assert.equal(mapping.room, "");
  assert.equal(mapping.alternatives.length, 100);
  assert.equal(mapping.alternativesTruncated, true);
  assert.equal(mapping.deviceCount, 650);
});

test("Final history learns exact-MAC models and ignores placeholder labels", async () => {
  const database = new Database(`exact-model-history-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "one", devices: [
    { id: "real-model", mac: "00-11-22-33-44-55", model: "Conference Kit" },
    { id: "placeholder", mac: "AA:BB:CC:DD:EE:FF", model: "Не указано" },
  ] });
  assert.equal(database.knownModels, undefined);
  const learnedModels = await database.knownModelsForMacs(["00:11:22:33:44:55", "AA:BB:CC:DD:EE:FF", "not a mac"]);
  assert.equal(learnedModels.get("00:11:22:33:44:55"), "Conference Kit");
  assert.equal(learnedModels.has("AA:BB:CC:DD:EE:FF"), false);
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55"]],
    mappings: { main: { mac: 0 } },
    knownModels: learnedModels,
  });
  assert.equal(result.devices[0].model, "Conference Kit");
  assert.equal(result.devices[0].fieldSources.model, "Known Models");
});

test("repeating the same source key reuses the successful Final without adding History", async () => {
  const database = new Database(`repeat-${crypto.randomUUID()}`);
  const input = {
    id: "first-run",
    name: "Main.csv",
    sourceKey: "main.csv|size=100|date=2026-09-01|mapping=mac:0",
    createdAt: "2026-09-01T00:00:00Z",
    devices: [{ id: "device-a", mac: "00:11:22:33:44:55" }],
  };
  const first = await database.saveFinal(input);
  const repeated = await database.saveFinal({ ...input, id: "should-not-replace", createdAt: "2026-09-02T00:00:00Z" });
  assert.equal(first.id, repeated.id);
  assert.equal(repeated.reused, true);
  assert.equal((await database.listSnapshots()).length, 1);
  assert.equal((await readInventory(database)).find((item) => item.id === "device-a").observationCount, 1);
  assert.equal((await database.getSetting("activeSnapshotId")), first.id);
  assert.equal((await database.historyPage("device-a")).total, 0);
});

test("saving Final does not load all Inventory and empty values keep known fields", async () => {
  const name = `inventory-merge-${crypto.randomUUID()}`;
  const database = new Database(name);
  assert.equal(database.inventory, undefined);
  await database.saveFinal({
    id: "first",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [{
      id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Conference Kit",
      vendorConfidence: 0.95, vendorSource: "IEEE OUI", modelConfidence: 0.84, modelSource: "MAC5 rule",
    }],
  });
  await database.saveFinal({
    id: "second",
    createdAt: "2026-01-02T00:00:00Z",
    devices: [{
      id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "", model: "—",
      vendorConfidence: "", vendorSource: "", modelConfidence: "", modelSource: "", sources: [],
    }],
  });
  database.connection?.close();
  database.connection = null;
  const reopened = new Database(name);
  const inventory = await readInventory(reopened);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].manufacturer, "Acme");
  assert.equal(inventory[0].model, "Conference Kit");
  assert.equal(inventory[0].vendorConfidence, 0.95);
  assert.equal(inventory[0].vendorSource, "IEEE OUI");
  assert.equal(inventory[0].modelConfidence, 0.84);
  assert.equal(inventory[0].modelSource, "MAC5 rule");
  assert.equal(inventory[0].firstSeen, "2026-01-01T00:00:00Z");
  assert.equal(inventory[0].lastSeen, "2026-01-02T00:00:00Z");
  const final = await reopened.activeSnapshot();
  assert.equal(final.devices[0].manufacturer, "");
  reopened.connection?.close();
  reopened.connection = null;
});

test("Inventory keeps the latest known value per field across incomplete successive Finals", async () => {
  const database = new Database(`inventory-field-history-${crypto.randomUUID()}`);
  const identity = { id: "device-a", mac: "00:11:22:33:44:55" };
  await database.saveFinal({
    id: "inventory-field-first",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [{ ...identity, manufacturer: "Acme", model: "Codec A", address: "Room A", switchIp: "10.0.0.1" }],
  });
  await database.saveFinal({
    id: "inventory-field-second",
    createdAt: "2026-01-02T00:00:00Z",
    devices: [{ ...identity, manufacturer: "Northwind", model: "", address: "Room B", switchIp: "10.0.0.2" }],
  });
  await database.saveFinal({
    id: "inventory-field-third",
    createdAt: "2026-01-03T00:00:00Z",
    devices: [{ ...identity, manufacturer: "", model: "Codec C", address: "", switchIp: "" }],
  });

  const inventory = await readInventory(database);
  assert.equal(inventory.length, 1);
  assert.deepEqual({
    manufacturer: inventory[0].manufacturer,
    model: inventory[0].model,
    address: inventory[0].address,
    switchIp: inventory[0].switchIp,
    firstSeen: inventory[0].firstSeen,
    lastSeen: inventory[0].lastSeen,
    observationCount: inventory[0].observationCount,
  }, {
    manufacturer: "Northwind",
    model: "Codec C",
    address: "Room B",
    switchIp: "10.0.0.2",
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-03T00:00:00Z",
    observationCount: 3,
  });
  const current = await database.activeSnapshot();
  assert.deepEqual({
    manufacturer: current.devices[0].manufacturer,
    model: current.devices[0].model,
    address: current.devices[0].address,
    switchIp: current.devices[0].switchIp,
  }, { manufacturer: "", model: "Codec C", address: "", switchIp: "" });
});

test("Final persistence removes executable, cyclic, and nested snapshot-copy data", async () => {
  const database = new Database(`sanitize-final-${crypto.randomUUID()}`);
  const device = { id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Acme" };
  device.self = device;
  device.calculate = () => "not persisted";
  device.preview = { label: "preview", devices: [{ id: "duplicate-a", mac: "AA:BB:CC:DD:EE:FF" }] };
  const diagnostics = { conflicts: [], note: "kept", callback: () => {} };
  diagnostics.circular = diagnostics;
  await database.saveFinal({ id: "sanitized", devices: [device], diagnostics });

  const snapshot = await database.activeSnapshot();
  assert.equal(snapshot.devices[0].self, undefined);
  assert.equal(snapshot.devices[0].calculate, undefined);
  assert.deepEqual(snapshot.devices[0].preview, { label: "preview" });
  assert.equal(snapshot.diagnostics.note, "kept");
  assert.equal(snapshot.diagnostics.callback, undefined);
  assert.equal(snapshot.diagnostics.circular, undefined);
  assert.equal((await readInventory(database))[0].preview.devices, undefined);
});

test("database sanitizer enforces configurable byte and node budgets while cleaning unsupported values", () => {
  const cyclic = { label: "safe", callback: () => "ignored" };
  cyclic.self = cyclic;
  assert.deepEqual(sanitizeForDatabase(cyclic), { label: "safe" });
  assert.throws(() => sanitizeForDatabase({ value: "too long" }, { maxBytes: 16 }), { code: "DATABASE_RECORD_LIMIT" });
  assert.throws(() => sanitizeForDatabase([1, 2, 3], { maxNodes: 2 }), { code: "DATABASE_RECORD_LIMIT" });
});

test("oversized Final records abort before replacing the active successful snapshot", async () => {
  const database = new Database(`record-size-limit-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "record-limit-kept", devices: [{ id: "kept-device", mac: "00:11:22:33:44:55" }] });
  const oversizedPayload = new Array(1_500_100).fill(0);
  await assert.rejects(
    database.saveFinal({ id: "record-limit-rejected", devices: [{ id: "large-device", mac: "AA:BB:CC:DD:EE:FF", oversizedPayload }] }),
    (error) => error.code === "DATABASE_RECORD_LIMIT" || /превышает предел подготовки/.test(error.message),
  );
  assert.equal(await database.getSetting("activeSnapshotId"), "record-limit-kept");
  assert.deepEqual((await database.listSnapshots()).map((snapshot) => snapshot.id), ["record-limit-kept"]);
});

test("DataClone and quota failures abort Final writes and preserve the active snapshot", async () => {
  const database = new Database(`clone-failure-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "kept-final", devices: [{ id: "kept-device", mac: "00:11:22:33:44:55" }] });
  const objectStorePut = globalThis.IDBObjectStore.prototype.put;
  let failureId = "rejected-final";
  let failureName = "DataCloneError";
  globalThis.IDBObjectStore.prototype.put = function failSnapshotChunk(value, key) {
    if (this.name === "snapshotChunks" && value?.snapshotId === failureId) {
      if (failureName === "OutOfMemoryError") throw Object.assign(new Error("JavaScript heap out of memory"), { name: failureName });
      throw new globalThis.DOMException(`Injected ${failureName}`, failureName);
    }
    return objectStorePut.call(this, value, key);
  };
  try {
    await assert.rejects(database.saveFinal({ id: failureId, devices: [{ id: "new-device", mac: "AA:BB:CC:DD:EE:FF" }] }), /DataCloneError/);
    failureId = "quota-final";
    failureName = "QuotaExceededError";
    await assert.rejects(database.saveFinal({ id: failureId, devices: [{ id: "quota-device", mac: "AA:BB:CC:DD:EE:00" }] }), /Недостаточно места.*QuotaExceededError/);
    failureId = "memory-final";
    failureName = "OutOfMemoryError";
    await assert.rejects(database.saveFinal({ id: failureId, devices: [{ id: "memory-device", mac: "AA:BB:CC:DD:EE:01" }] }), /Final не сохранён, предыдущий снимок не изменён\. Браузеру не хватило памяти/);
  } finally {
    globalThis.IDBObjectStore.prototype.put = objectStorePut;
  }
  assert.equal(await database.getSetting("activeSnapshotId"), "kept-final");
  assert.deepEqual((await database.listSnapshots()).map((item) => item.id), ["kept-final"]);
  assert.deepEqual((await readInventory(database)).map((item) => item.id), ["kept-device"]);
  assert.equal((await readInventory(database))[0].observationCount, 1);
  assert.equal((await readStore(database, "history")).length, 0, "failed Final writes must not add History rows");
});

test("snapshot chunk visitor releases each storage chunk before reading the next", async () => {
  const database = new Database(`chunk-visit-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 501 }, (_, index) => ({ id: `device-${index}`, mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}` }));
  await database.saveFinal({ id: "chunked", devices });
  const db = await database.open();
  const nativeTransaction = db.transaction.bind(db);
  let transactionHooksBeforeReads = 0;
  db.transaction = (stores, mode, options) => {
    const tx = nativeTransaction(stores, mode, options);
    const nativeObjectStore = tx.objectStore.bind(tx);
    tx.objectStore = (name) => {
      const store = nativeObjectStore(name);
      if (name === "snapshots" || name === "snapshotChunks") {
        const nativeGet = store.get.bind(store);
        store.get = (key) => {
          assert.equal(typeof tx.oncomplete, "function", `transaction completion must be observed before reading ${name}`);
          transactionHooksBeforeReads += 1;
          return nativeGet(key);
        };
      }
      return store;
    };
    return tx;
  };
  const visited = [];
  let largestChunk = 0;
  const metadata = await database.forEachSnapshotChunk("chunked", async (chunk, index) => {
    largestChunk = Math.max(largestChunk, chunk.length);
    visited.push([index, chunk.length]);
    await Promise.resolve();
  });
  assert.equal(metadata.deviceCount, 501);
  assert.deepEqual(visited, [[0, 500], [1, 1]]);
  assert.equal(largestChunk, 500);
  assert.equal(transactionHooksBeforeReads, 3);
});

test("snapshot chunk visitor reports read boundaries before invoking the async consumer", async () => {
  const database = new Database(`chunk-visit-progress-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "progress-final", devices: Array.from({ length: 501 }, (_, index) => ({ id: `device-${index}` })) });
  const events = [];
  await database.forEachSnapshotChunk("progress-final", async (_chunk, index) => {
    events.push(`visit:${index}`);
    await Promise.resolve();
  }, { onProgress: ({ phase, index, visitedDevices }) => events.push(`${phase}:${index}:${visitedDevices}`) });
  assert.deepEqual(events, [
    "chunk-start:0:0", "chunk-result:0:0", "chunk-ready:0:500", "visit:0", "chunk-complete:0:500",
    "chunk-start:1:500", "chunk-result:1:500", "chunk-ready:1:501", "visit:1", "chunk-complete:1:501",
  ]);
});

test("snapshot chunk visitor proceeds when readonly transaction completion is delayed", async () => {
  const database = new Database(`chunk-visit-delayed-complete-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "delayed-complete", devices: [{ id: "device-1" }] });
  const db = await database.open();
  const nativeTransaction = db.transaction.bind(db);
  db.transaction = (stores, mode, options) => {
    const tx = nativeTransaction(stores, mode, options);
    if (Array.isArray(stores) ? stores.includes("snapshotChunks") : stores === "snapshotChunks") {
      Object.defineProperty(tx, "oncomplete", { configurable: true, get: () => null, set: () => {} });
    }
    return tx;
  };
  let visited = false;
  await Promise.race([
    database.forEachSnapshotChunk("delayed-complete", (chunk) => {
      visited = true;
      assert.deepEqual(chunk, [{ id: "device-1" }]);
    }),
    new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error("Readonly chunk visitor waited for transaction.complete")), 100)),
  ]);
  assert.equal(visited, true);
});

test("snapshot chunk visitor stops before reading more data when its caller becomes stale", async () => {
  const database = new Database(`chunk-visit-cancel-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_200 }, (_, index) => ({ id: `device-${index}` }));
  await database.saveFinal({ id: "cancelled-chunks", devices });
  const visited = [];
  const metadata = await database.forEachSnapshotChunk("cancelled-chunks", (_chunk, index) => {
    visited.push(index);
    return index < 1;
  });

  assert.equal(metadata.deviceCount, 1_200);
  assert.deepEqual(visited, [0, 1]);
});

test("snapshot device iterator reads exact bounded ranges across chunk boundaries", async () => {
  const database = new Database(`snapshot-row-stream-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_003 }, (_, index) => ({ id: `row-${index}`, mac: `00:11:22:33:${(index >> 8).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}` }));
  await database.saveFinal({ id: "row-stream-final", devices });
  const rows = [];
  for await (const device of database.iterateSnapshotDevices("row-stream-final", { start: 498, limit: 9 })) rows.push(device.id);
  assert.deepEqual(rows, devices.slice(498, 507).map((device) => device.id));
  const complete = [];
  for await (const device of database.iterateSnapshotDevices("row-stream-final")) complete.push(device.id);
  assert.deepEqual(complete, devices.map((device) => device.id));
  let missingSnapshotRows = 0;
  await assert.rejects(async () => {
    for await (const device of database.iterateSnapshotDevices("missing-row-stream-final")) {
      missingSnapshotRows += Number(Boolean(device));
    }
  }, /не найден/);
  assert.equal(missingSnapshotRows, 0);
});

test("extended analytics aggregates each selected Final chunk without topology roster copies", async () => {
  const database = new Database(`streamed-analytics-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `streamed-${index}`,
    mac: `00:11:22:${((index >> 16) & 255).toString(16).padStart(2, "0")}:${((index >> 8) & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    manufacturer: `Vendor ${index % 13}`,
    model: `Model ${index % 37}`,
    room: `Room ${index % 19}`,
    switchIp: `10.0.${Math.floor(index / 250)}.1`,
    switchPort: `Port ${index % 24}`,
  }));
  await database.saveFinal({ id: "streamed-analytics-final", devices });
  const streamed = createDatasetAnalyticsCollector({ includeTopologyDevices: false });
  const chunkSizes = [];
  await database.forEachSnapshotChunk("streamed-analytics-final", (chunk) => {
    chunkSizes.push(chunk.length);
    streamed.accept(chunk);
  });
  const streamedResult = streamed.finish();
  const fullResult = buildDatasetAnalytics(devices, { includeTopologyDevices: false });
  assert.deepEqual(chunkSizes, [500, 500, 205]);
  assert.deepEqual(streamedResult, fullResult);
  assert.equal(streamedResult.topology.summary.linkedDevices, devices.length);
  assert.equal(streamedResult.topology.nodes[0].ports[0].devices, undefined);
});

test("12,249-device Final keeps a 50-row preview separate from complete analytics", async () => {
  const database = new Database(`large-preview-${crypto.randomUUID()}`);
  const deviceCount = 12_249;
  const devices = Array.from({ length: deviceCount }, (_, index) => ({
    id: `large-${index}`,
    mac: `02:00:${((index >> 24) & 255).toString(16).padStart(2, "0")}:${((index >> 16) & 255).toString(16).padStart(2, "0")}:${((index >> 8) & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    switchIp: "10.0.0.1",
    switchPort: "uplink",
  }));
  await database.saveFinal({ id: "large-preview-final", devices, updateInventory: false });

  const preview = await database.loadSnapshotPage("large-preview-final", { page: 1, limit: 50 });
  assert.equal(preview.devices.length, 50);
  assert.equal(preview.total, deviceCount);
  assert.equal(preview.hasNext, true);

  const analytics = createDatasetAnalyticsCollector({ includeTopologyDevices: false });
  let visited = 0;
  await database.forEachSnapshotChunk("large-preview-final", (chunk) => {
    visited += chunk.length;
    analytics.accept(chunk);
  });
  const fullResult = analytics.finish();
  assert.equal(visited, deviceCount);
  assert.equal(fullResult.topology.summary.linkedDevices, deviceCount);
  assert.equal(fullResult.topology.nodes[0].ports[0].deviceCount, deviceCount);
});

test("Inventory search returns a sorted page without materializing the full store", async () => {
  const database = new Database(`inventory-page-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "inventory",
    devices: [
      { id: "b", mac: "00:11:22:33:44:52", manufacturer: "Acme", alternateMacs: ["AA:BB:CC:DD:EE:02"] },
      { id: "a", mac: "00:11:22:33:44:51", manufacturer: "Acme" },
      { id: "c", mac: "00:11:22:33:44:53", manufacturer: "Other" },
    ],
  });
  const page = await database.searchInventory({ query: "acme", page: 1, pageSize: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.pages, 2);
  assert.equal(page.items[0].id, "a");
  const secondPage = await database.searchInventory({ query: "acme", page: 2, pageSize: 1 });
  assert.equal(secondPage.items[0].id, "b");
  const alternateMacSearch = await database.searchInventory({ query: "AA:BB:CC:DD:EE:02", pageSize: 10 });
  assert.equal(alternateMacSearch.total, 1);
  assert.equal(alternateMacSearch.items[0].id, "b");
  const compactMacSearch = await database.searchInventory({ query: "001122334451", pageSize: 10 });
  assert.equal(compactMacSearch.total, 1);
  assert.equal(compactMacSearch.items[0].id, "a");
  assert.deepEqual(await database.inventoryMacs(), ["00:11:22:33:44:51", "00:11:22:33:44:52", "00:11:22:33:44:53", "AA:BB:CC:DD:EE:02"]);
  let visited = 0;
  await database.forEachInventory(() => { visited += 1; });
  assert.equal(visited, 3);
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(database.searchInventory({ signal: controller.signal }), { name: "AbortError" });
});

test("Inventory MAC enumeration handles packed alternate values from legacy records", async () => {
  const database = new Database(`inventory-packed-macs-${crypto.randomUUID()}`);
  const native = await database.open();
  const tx = native.transaction("inventory", "readwrite");
  tx.objectStore("inventory").put({
    id: "legacy-packed-device",
    mac: "00:11:22:33:44:55",
    alternateMacs: "AA-BB-CC-DD-EE-01,0011.2233.4455,11:22:33:44:55:66",
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  assert.deepEqual(await database.inventoryMacs(), [
    "00:11:22:33:44:55", "11:22:33:44:55:66", "AA:BB:CC:DD:EE:01",
  ]);
});

test("MAC history suggestions query primary and alternate MAC prefixes with a bounded result", async () => {
  const database = new Database(`inventory-mac-suggestions-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 120 }, (_, index) => ({
    id: `suggestion-device-${String(index).padStart(3, "0")}`,
    mac: `00:11:22:80:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
  }));
  devices.push({ id: "suggestion-alternate-device", mac: "AA:BB:CC:DD:EE:FF", alternateMacs: ["00:11:22:00:00:FF"] });
  await database.saveFinal({ id: "inventory-mac-suggestions-final", devices });

  const primary = await database.inventoryMacSuggestions("001122", 50);
  assert.equal(primary.length, 50);
  assert.deepEqual(primary, [...primary].sort());
  assert.ok(primary.every((mac) => mac.startsWith("00:11:22:")));
  assert.equal(primary[0], "00:11:22:00:00:FF", "alternate index values take their correct place in the global prefix order");
  assert.deepEqual(await database.inventoryMacSuggestions("00:11:22:00:00:FF", 50), ["00:11:22:00:00:FF"]);
  assert.deepEqual(await database.inventoryMacSuggestions("xx", 50), []);
  assert.deepEqual(await database.inventoryMacSuggestions("00:11:22:ZZ", 50), []);
  assert.deepEqual(await database.inventoryMacSuggestions("0011223344556677", 50), []);
});

test("Inventory search returns exact cursor-backed pages at the 1000-row UI limit", async () => {
  const database = new Database(`inventory-page-size-${crypto.randomUUID()}`);
  const total = 1_205;
  const devices = Array.from({ length: total }, (_, index) => {
    const suffix = index.toString(16).padStart(10, "0");
    return {
      id: `page-size-${index}`,
      mac: `02:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}:${suffix.slice(8, 10)}`,
    };
  });
  await database.saveFinal({ id: "inventory-page-size-final", devices });
  const first = await database.searchInventory({ page: 1, pageSize: 1000 });
  const second = await database.searchInventory({ page: 2, pageSize: 1000 });
  assert.equal(first.total, total);
  assert.equal(first.pages, 2);
  assert.equal(first.items.length, 1000);
  assert.equal(second.total, total);
  assert.equal(second.page, 2);
  assert.equal(second.items.length, 205);
  assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, total);
  const minimumPage = await database.searchInventory({ page: 1, pageSize: 25 });
  assert.equal(minimumPage.items.length, 25);
  assert.equal(minimumPage.pages, 49);
});

test("Inventory keyset pages cover each stored record once with a fixed bound", async () => {
  const database = new Database(`inventory-pages-${crypto.randomUUID()}`);
  const devices = Array.from({ length: 23 }, (_, index) => ({
    id: `device-${String(index).padStart(2, "0")}`,
    mac: `00:11:22:33:44:${String(index).padStart(2, "0")}`,
  }));
  await database.saveFinal({ id: "inventory-page-final", devices });
  const seen = [];
  let afterId = null;
  let largestPage = 0;
  while (true) {
    const page = await database.inventoryPage({ afterId, limit: 7 });
    largestPage = Math.max(largestPage, page.rows.length);
    seen.push(...page.rows.map((item) => item.id));
    if (!page.hasMore) break;
    afterId = page.nextCursor;
  }
  assert.equal(largestPage, 7);
  assert.deepEqual(seen, devices.map((device) => device.id));
});

test("custom Inventory fields persist manually, survive later Final merges and portable archive transfer", async () => {
  const database = new Database(`custom-inventory-${crypto.randomUUID()}`);
  const field = "custom_123e4567-e89b-42d3-a456-426614174000";
  await database.saveFinal({ id: "custom-one", devices: [{ id: "custom-device", mac: "00:11:22:33:44:55", manufacturer: "Acme" }] });
  const updated = await database.updateInventoryCustomField("custom-device", field, "Room owner");
  assert.equal(updated.customFields[field], "Room owner");
  assert.equal(updated.customFieldSources[field], "Manual");
  await database.saveFinal({ id: "custom-two", devices: [{ id: "custom-device", mac: "00:11:22:33:44:55", model: "Board X" }] });
  const inventory = await database.inventoryPage({ limit: 10 });
  assert.equal(inventory.rows[0].customFields[field], "Room owner");
  const imported = new Database(`custom-inventory-import-${crypto.randomUUID()}`);
  await imported.importArchive(await readArchive(database));
  const restored = (await imported.inventoryPage({ limit: 10 })).rows[0];
  assert.equal(restored.customFields[field], "Room owner");
  assert.equal(restored.customFieldSources[field], "Manual");
  const cleared = await database.updateInventoryCustomField("custom-device", field, "");
  assert.equal(Object.hasOwn(cleared.customFields, field), false);
  await assert.rejects(database.updateInventoryCustomField("custom-device", "custom-invalid", "x"), /Некорректный ключ/);
  await assert.rejects(database.updateInventoryCustomField("missing-device", field, "x"), /не найдено/);
});

test("filtered full Inventory table can be encoded from a cursor without getAll", async () => {
  const database = new Database(`inventory-copy-${crypto.randomUUID()}`);
  assert.equal(database.inventory, undefined);
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    id: `copy-${index}`,
    mac: `00:11:22:${((index >> 16) & 255).toString(16).padStart(2, "0")}:${((index >> 8) & 255).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    manufacturer: index % 2 ? "Acme" : "Other",
  }));
  await database.saveFinal({ id: "copy-final", devices });
  const collector = new TableTsvCollector([["mac", "MAC"], ["manufacturer", "Производитель"]], { chunkRows: 100 });
  await database.forEachInventory((device) => {
    if (matchesDeviceSearch(device, "acme")) collector.add(device);
  });
  const result = collector.finish();
  assert.equal(result.rowCount, 602);
  assert.equal(result.chunkCount, 7);
  const text = await result.blob.text();
  assert.match(text, /^MAC\tПроизводитель\r\n/);
  assert.ok(text.includes("00:11:22:00:04:b3\tAcme"));
  assert.equal((text.match(/\r\n/g) || []).length, 602);
});
