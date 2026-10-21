import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { runBrowserDiagnostics } from "../src/core/diagnostics.js";
import { Database } from "../src/data/database.js";

function singleAnalysisResult(mac) {
  return {
    devices: [{ id: mac, mac }],
    diagnostics: { invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [] },
  };
}

test("browser diagnostics checks schema, indexes, full Final integrity and storage without writes", async () => {
  const database = new Database(`diagnostics-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "diagnostics-final", name: "Diagnostics Final", createdAt: "2026-10-15T00:00:00Z",
    devices: [{ id: "one", mac: "00:11:22:33:44:55" }, { id: "two", mac: "00:11:22:33:44:66" }],
  });
  await database.saveFinal({
    id: "diagnostics-final-2", name: "Second Final", createdAt: "2026-10-16T00:00:00Z",
    devices: [{ id: "one", mac: "00:11:22:33:44:55", model: "Model" }],
    comparison: { modified: [{ after: { id: "one", mac: "00:11:22:33:44:55" }, changes: [{ field: "model", label: "Модель", oldValue: "", newValue: "Model" }] }], added: [], absent: [] },
  });
  const beforeActive = await database.getSetting("activeSnapshotId", "");
  let estimateCalls = 0;
  const report = await runBrowserDiagnostics({
    database,
    directoryPermission: "granted",
    storage: { estimate: async () => { estimateCalls += 1; return { usage: 50 * 1024 ** 2, quota: 500 * 1024 ** 2 }; } },
  });
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 0);
  assert.ok(report.checks.some((item) => item.id === "stores" && item.status === "ok"));
  assert.ok(report.checks.some((item) => item.id === "stores" && item.detail.includes("все 22 хранилищ")));
  assert.ok(report.checks.some((item) => item.id === "indexes" && item.status === "ok"));
  assert.ok(report.checks.some((item) => item.id === "indexes" && item.detail.includes("сильной идентичности Inventory") && item.detail.includes("архивов, аналитики и evidence")));
  assert.ok(report.checks.some((item) => item.id === "final-integrity" && item.detail.includes("3 устройств")));
  assert.ok(report.checks.some((item) => item.id === "record-counts" && item.detail.includes("Inventory: 2")));
  assert.ok(report.checks.some((item) => item.id === "backend" && item.status === "info"));
  assert.equal(estimateCalls, 1);
  assert.equal(await database.getSetting("activeSnapshotId", ""), beforeActive);
});

test("browser diagnostics reports corrupt snapshot chunks and does not recover or mutate the database", async () => {
  const database = new Database(`diagnostics-corrupt-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "broken", name: "Broken Final", devices: [{ id: "device" }] });
  const activeId = await database.getSetting("activeSnapshotId", "");
  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  tx.objectStore("snapshotChunks").delete(["broken", 0]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.equal(report.errors, 1);
  assert.ok(report.checks.some((item) => item.id === "final-integrity" && item.status === "error"));
  assert.equal(await database.getSetting("activeSnapshotId", ""), activeId);
  assert.equal((await database.listSnapshots()).length, 1);
});

test("browser diagnostics counts every corrupt Final but retains only five bounded examples", async () => {
  const database = new Database(`diagnostics-many-corrupt-${crypto.randomUUID()}`);
  const snapshotIds = [];
  for (let index = 0; index < 6; index += 1) {
    const id = `broken-${index}`;
    snapshotIds.push(id);
    await database.saveFinal({ id, name: index === 0 ? `Broken ${index}: ${"x".repeat(5000)}` : `Broken ${index}`, devices: [{ id: `device-${index}` }] });
  }

  const db = await database.open();
  const tx = db.transaction("snapshotChunks", "readwrite");
  for (const id of snapshotIds) tx.objectStore("snapshotChunks").delete([id, 0]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  const report = await runBrowserDiagnostics({ database, storage: null });
  const finalIntegrity = report.checks.find((item) => item.id === "final-integrity");
  assert.equal(finalIntegrity.status, "error");
  assert.match(finalIntegrity.detail, /Повреждены 6 снимка:/);
  assert.match(finalIntegrity.detail, /Broken 0:/);
  assert.match(finalIntegrity.detail, /Broken 4:/);
  assert.doesNotMatch(finalIntegrity.detail, /Broken 5:/);
  assert.ok(finalIntegrity.detail.length < 1600, "five displayed examples stay within the per-example message bound");
});

test("browser diagnostics pages every snapshot and never materializes the complete metadata catalogue", async () => {
  const database = new Database(`diagnostics-paged-${crypto.randomUUID()}`);
  const total = 205;
  for (let index = 0; index < total; index += 1) {
    await database.saveFinal({ id: `paged-${String(index).padStart(3, "0")}`, devices: [{ id: `device-${index}` }] });
  }
  const calls = [];
  const pagedDatabase = Object.create(database);
  pagedDatabase.listSnapshots = async () => { throw new Error("Diagnostics must not materialize every snapshot"); };
  pagedDatabase.snapshotMetadataPage = async (options) => {
    calls.push({ ...options });
    assert.ok(options.limit <= 100, "diagnostics keeps each metadata page bounded");
    return database.snapshotMetadataPage(options);
  };

  const report = await runBrowserDiagnostics({ database: pagedDatabase, storage: null });
  const integrity = report.checks.find((item) => item.id === "final-integrity");
  assert.equal(report.errors, 0);
  assert.equal(integrity.status, "ok");
  assert.match(integrity.detail, /205 снимков проверено/);
  assert.match(integrity.detail, /205 устройств/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ limit }) => limit), [100, 100, 100]);
});

test("browser diagnostics rejects a single-analysis snapshot as the active Final", async () => {
  const database = new Database(`diagnostics-single-active-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "actual-final", name: "Current Final", devices: [] });
  await database.saveFinal({
    id: "single-analysis", name: "Single file: source.csv", snapshotType: "single-analysis",
    devices: [], activate: false, updateInventory: false,
  });
  await database.setSetting("activeSnapshotId", "single-analysis");

  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.equal(report.errors, 1);
  assert.ok(report.checks.some((item) => item.id === "active-final" && item.status === "error" && item.detail.includes("не связан с сохранённым Final")));
});

test("browser diagnostics accepts a database containing only single-file snapshots and no active Final", async () => {
  const database = new Database(`diagnostics-single-only-${crypto.randomUUID()}`);
  await database.saveFinal({
    id: "single-analysis-only", name: "Single file: source.csv", snapshotType: "single-analysis",
    devices: [], activate: false, updateInventory: false,
  });

  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.equal(report.errors, 0);
  assert.ok(report.checks.some((item) => item.id === "active-final" && item.status === "ok" && item.detail === "Final пока не сохранён."));
});

test("browser diagnostics pages through single-file analyses and validates chunks without materializing result arrays", async () => {
  const database = new Database("diagnostics-analysis-pages-" + crypto.randomUUID());
  for (const id of ["analysis-c", "analysis-a", "analysis-b"]) {
    await database.saveSingleAnalysis({
      id, filename: id + ".csv", result: singleAnalysisResult("00:11:22:33:44:55"),
    });
  }
  const firstPage = await database.singleAnalysisMetadataPage({ limit: 2 });
  const lastPage = await database.singleAnalysisMetadataPage({ afterId: firstPage.nextCursor, limit: 2 });
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.rows.length, 2);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(lastPage.rows.map(({ id }) => id), ["analysis-c"]);
  assert.equal(lastPage.hasMore, false);

  let streamedDevices = 0;
  const report = await runBrowserDiagnostics({ database, storage: null });
  for (const analysis of firstPage.rows) {
    await database.forEachSingleAnalysisChunk(analysis.id, (chunk) => { streamedDevices += chunk.devices.length; });
  }
  await database.forEachSingleAnalysisChunk(lastPage.rows[0].id, (chunk) => { streamedDevices += chunk.devices.length; });
  assert.equal(streamedDevices, 3);
  assert.equal(report.errors, 0);
  assert.ok(report.checks.some((item) => item.id === "single-analysis-integrity" && item.status === "ok" && item.detail.includes("3 анализов проверено")));
});

test("browser diagnostics reports a missing single-analysis chunk", async () => {
  const database = new Database("diagnostics-analysis-corrupt-" + crypto.randomUUID());
  await database.saveSingleAnalysis({
    id: "broken-analysis", filename: "broken.csv", result: singleAnalysisResult("00:11:22:33:44:55"),
  });
  const db = await database.open();
  const tx = db.transaction("singleAnalysisChunks", "readwrite");
  tx.objectStore("singleAnalysisChunks").delete(["broken-analysis", 0]);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.equal(report.errors, 1);
  assert.ok(report.checks.some((item) => item.id === "single-analysis-integrity" && item.status === "error" && item.detail.includes("broken.csv")));
});

test("browser diagnostics flags a schema missing an analytics store", async () => {
  const database = {
    open: async () => ({ version: 1, objectStoreNames: [], transaction() { throw new Error("store missing"); } }),
    listSnapshots: async () => [],
    getSetting: async () => "",
    forEachSnapshotChunk: async () => {},
  };
  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.ok(report.checks.some((item) => item.id === "stores" && item.status === "error" && item.detail.includes("finalAnalytics")));
});

test("browser diagnostics identifies missing strong-identity Inventory indexes", async () => {
  const source = new Database(`diagnostics-index-${crypto.randomUUID()}`);
  await source.saveFinal({ id: "indexed", devices: [] });
  const database = Object.create(source);
  database.open = async () => {
    const db = await source.open();
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (...args) => {
          const tx = target.transaction(...args);
          return new Proxy(tx, {
            get(transaction, key, txReceiver) {
              if (key !== "objectStore") return Reflect.get(transaction, key, txReceiver);
              return (name) => {
                const store = transaction.objectStore(name);
                if (name !== "inventory") return store;
                return new Proxy(store, {
                  get(objectStore, storeKey, storeReceiver) {
                    if (storeKey !== "indexNames") return Reflect.get(objectStore, storeKey, storeReceiver);
                    return { contains: (indexName) => indexName !== "by_device_id" && objectStore.indexNames.contains(indexName) };
                  },
                });
              };
            },
          });
        };
      },
    });
  };
  const report = await runBrowserDiagnostics({ database, storage: null });
  assert.ok(report.checks.some((item) => item.id === "indexes" && item.status === "error" && item.detail.includes("inventory.by_device_id")));
});
