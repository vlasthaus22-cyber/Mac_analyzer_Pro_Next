import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";
import { initSQLite, iterator, useMemoryStorage, withExistDB } from "@subframe7536/sqlite-wasm";
import { useIdbStorage } from "@subframe7536/sqlite-wasm/idb";
import { Database } from "../src/data/database.js";
import { enrich } from "../src/core/enrichment.js";
import { buildImportedSmartroomRoomIndex } from "../src/core/historical-mapping.js";
import { addCustomInventoryColumn, defaultInventoryColumnConfig, inventoryCellText } from "../src/core/inventory-columns.js";
import { importLegacySQLiteFile, LEGACY_SQLITE_TABLES, legacyApiCacheVendorObservation, legacyDevice, legacyMovement, legacyObservation, legacyTaskObservation, readLegacyTaskQueueFileFromSQLite } from "../src/data/sqlite-database-importer.js";

test("legacy SQLite importer recognizes every current PyQt-owned database table", () => {
  const currentPyQtTables = [
    "mac_history", "mac_movements", "oui_vendor_history", "mac5_model_history",
    "history_loads", "daily_stats", "analysis_history", "performance_metrics",
  ];
  const supportedTables = new Set(LEGACY_SQLITE_TABLES);
  assert.deepEqual(currentPyQtTables.filter((table) => !supportedTables.has(table)), []);
});

test("legacy SQLite payload preserves custom field values under the stable imported column key", () => {
  const payload = legacyDevice({
    mac: "00:11:22:33:44:55",
    payload_json: JSON.stringify({ custom_fields: { "[Пользовательская] Площадь": "210 м²" } }),
  });
  const column = addCustomInventoryColumn(defaultInventoryColumnConfig(), "Площадь").columns.at(-1);
  assert.equal(inventoryCellText(payload, column.key), "210 м²");
});

function sqliteFile(name = "legacy.sqlite") {
  return new globalThis.File(["SQLite format 3\0", new Uint8Array(128)], name);
}

function fakeRuntime({ integrity = "ok", tables = ["app_settings"], rows = [{ key: "theme", value: "dark" }] } = {}) {
  const closeState = { sqliteClosed: false, vfsClosed: false };
  return {
    closeState,
    withExistDB: (_file, options) => options,
    useIdbStorage: async (name, options) => ({ path: name, ...options }),
    initSQLite: async () => ({
      run: async (sql) => {
        if (sql === "PRAGMA integrity_check") return [{ integrity_check: integrity }];
        if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
        if (sql.includes('table_info("app_settings")')) return [{ name: "key" }, { name: "value" }];
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
      close: async () => { closeState.sqliteClosed = true; },
      vfs: { close: () => { closeState.vfsClosed = true; } },
    }),
    iterator: async function* (_sqlite, sql) {
      if (sql === 'SELECT * FROM "app_settings"') yield* rows;
    },
  };
}

function shimFakeIndexedDbTransactionNames() {
  const original = globalThis.IDBDatabase.prototype.transaction;
  globalThis.IDBDatabase.prototype.transaction = function transactionWithSequence(stores, ...args) {
    const names = !Array.isArray(stores) && typeof stores !== "string" && Number.isInteger(stores?.length)
      ? Array.from({ length: stores.length }, (_, index) => stores.item?.(index) ?? stores[index])
      : stores;
    return original.call(this, names, ...args);
  };
  return () => { globalThis.IDBDatabase.prototype.transaction = original; };
}

async function deleteTestIndexedDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Test SQLite database remained open: ${name}`));
  });
}

test("SQLite WASM runtime executes integrity and bounded JSON row queries", async () => {
  const wasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite.wasm", import.meta.url));
  const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
  const sqlite = await initSQLite(await useMemoryStorage({ url }));
  try {
    await sqlite.run("CREATE TABLE snapshots (devices_json TEXT)");
    await sqlite.run("INSERT INTO snapshots VALUES (?)", ['[{"mac":"001122334455"},{"mac":"AABBCCDDEEFF"}]']);
    assert.deepEqual(await sqlite.run("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(await sqlite.run("SELECT json_each.key, json_extract(json_each.value, '$.mac') AS mac FROM snapshots, json_each(snapshots.devices_json) ORDER BY CAST(json_each.key AS INTEGER)"), [
      { key: 0, mac: "001122334455" },
      { key: 1, mac: "AABBCCDDEEFF" },
    ]);
  } finally {
    await sqlite.close();
  }
});

test("legacy SQLite import preserves page data and does not duplicate the last row of a partial batch", async () => {
  const wasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite.wasm", import.meta.url));
  const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
  const sourceStorage = await useMemoryStorage({ url: wasmUrl });
  const seed = await initSQLite({ ...sourceStorage, path: "legacy-source.sqlite" });
  const staged = [];
  const database = {
    async importArchiveEvents(header, events, options) {
      assert.deepEqual(header, { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 });
      assert.deepEqual(options, { preserveActiveSnapshot: true });
      for await (const event of events) staged.push(event);
    },
    async recordLegacySqliteImportSource() {},
  };
  try {
    await seed.run("CREATE TABLE app_settings (key TEXT, value TEXT)");
    await seed.run("BEGIN");
    for (let index = 0; index < 129; index += 1) {
      await seed.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [index === 0 ? "theme" : `setting_${index}`, index === 0 ? "dark" : `value_${index}`]);
    }
    await seed.run("COMMIT");
    const file = new globalThis.File([await seed.dump()], "real-small.sqlite");
    const runtime = {
      initSQLite,
      iterator,
      withExistDB,
      useIdbStorage: async (_name, options) => ({ ...await useMemoryStorage(options), path: "legacy.sqlite" }),
    };
    const report = await importLegacySQLiteFile(file, database, { runtime, wasmUrl });
    assert.equal(report.integrity, "ok");
    assert.deepEqual(report.tables, ["app_settings"]);
    const settings = staged.filter((event) => event.type === "records" && event.collection === "settings")
      .flatMap((event) => event.records);
    assert.equal(settings.length, 129);
    assert.equal(new Set(settings.map((setting) => setting.key)).size, 129);
    assert.ok(settings.some((setting) => setting.key === "legacyAppSetting:theme" && setting.value === "dark"));
  } finally {
    await seed.close();
  }
});

test("legacy SQLite import reports sensitive and unknown tables without reading their contents", async () => {
  const runtime = fakeRuntime({
    tables: ["app_settings", "notification_settings", "app_logs", "engineering_sessions", "future_table"],
  });
  const visitedTables = [];
  const iterator = runtime.iterator;
  runtime.iterator = async function* (sqlite, sql) {
    const table = sql.match(/FROM "([^"]+)"/)?.[1] || "";
    visitedTables.push(table);
    yield* iterator(sqlite, sql);
  };
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) assert.ok(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.deepEqual(report.tables, ["app_settings"]);
  assert.deepEqual(report.skippedTables.map(({ table }) => table), ["app_logs", "engineering_sessions", "future_table", "notification_settings"]);
  assert.match(report.skippedTables.find(({ table }) => table === "notification_settings").reason, /секреты уведомлений/);
  assert.match(report.skippedTables.find(({ table }) => table === "app_logs").reason, /чувствительные сообщения/);
  assert.match(report.skippedTables.find(({ table }) => table === "engineering_sessions").reason, /сессии не переносятся/);
  assert.match(report.skippedTables.find(({ table }) => table === "future_table").reason, /содержимое не импортировано/);
  assert.deepEqual(visitedTables, ["app_settings"]);
});

test("SQLite IndexedDB VFS creates and closes a disposable test database", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (_name, _options, callback) => callback({ name: "test-lock" }) } },
  });
  const restoreTransaction = shimFakeIndexedDbTransactionNames();
  const wasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm", import.meta.url));
  const storage = await useIdbStorage(`sqlite-vfs-test-${crypto.randomUUID()}.db`, {
    url: `data:application/wasm;base64,${wasm.toString("base64")}`,
    lockPolicy: "exclusive",
  });
  const vfs = await storage.vfsFn(storage.path, storage.sqliteModule, storage.vfsOptions);
  try {
    assert.equal(await vfs.jOpen(storage.path, 23, 6, new DataView(new ArrayBuffer(4))), 0, String(vfs.lastError));
    await vfs.jClose(23);
  } finally {
    vfs.close();
    restoreTransaction();
    await deleteTestIndexedDatabase(storage.vfsOptions.idbName);
  }
});

test("legacy SQLite importer validates, streams compatible records, and preserves the active Final", async () => {
  const runtime = fakeRuntime();
  const staged = [];
  let sourceRecord;
  const database = {
    async importArchiveEvents(header, events, options) {
      assert.deepEqual(header, { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 });
      assert.deepEqual(options, { preserveActiveSnapshot: true });
      for await (const event of events) staged.push(event);
    },
    async recordLegacySqliteImportSource(record) { sourceRecord = record; },
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.equal(report.integrity, "ok");
  assert.equal(report.imported.settings, 1);
  assert.match(report.sourceNamespace, /^[0-9a-f]{24}$/);
  assert.equal(staged[0].records[0].key, "legacyAppSetting:theme");
  assert.equal(sourceRecord.sourceIdbName, report.sourceIdbName);
  assert.equal(sourceRecord.sourceNamespace, report.sourceNamespace);
  assert.equal(runtime.closeState.sqliteClosed, true);
  assert.equal(runtime.closeState.vfsClosed, true);
});

test("legacy SQLite IP address mappings normalize streamed rows and preserve last-record precedence", async () => {
  const runtime = fakeRuntime({ tables: ["ip_address_mappings"], rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "ip_address_mappings" }];
      if (sql.includes('table_info("ip_address_mappings")')) return [{ name: "switch_ip" }, { name: "physical_address" }];
      throw new Error(`Unexpected SQL in IP mapping import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql !== 'SELECT * FROM "ip_address_mappings"') return;
    yield { switch_ip: "10.0.0.1", physical_address: "Первый", source: "PyQt" };
    yield { switch_ip: "10.0.0.2", physical_address: "Unknown", source: "PyQt" };
    yield { switch_ip: "10.0.0.1", physical_address: "Последний", source: "PyQt" };
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile("ip-mappings.sqlite"), database, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });

  const settings = staged.flatMap((event) => event.type === "records" && event.collection === "settings" ? event.records : []);
  assert.equal(report.ipMappings, 1);
  assert.deepEqual(settings.find((setting) => setting.key === "ipAddressMappings")?.value, [
    { switchIp: "10.0.0.1", address: "Последний", source: "PyQt" },
  ]);
});

test("a broken legacy autosave that points to a missing Final stays inert during SQLite import", async () => {
  const autosaveState = JSON.stringify({ activeSnapshotId: "missing-legacy-final", finalSnapshotId: "missing-legacy-final" });
  const runtime = fakeRuntime({ tables: ["app_autosaves"], rows: [{ slot: "current", state_json: autosaveState, reason: "interrupted", updated_at: "2026-10-17T10:00:00Z" }] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "app_autosaves" }];
      if (sql.includes('table_info("app_autosaves")')) return [{ name: "slot" }, { name: "state_json" }];
      throw new Error(`Unexpected SQL in legacy autosave import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "app_autosaves"') yield { slot: "current", state_json: autosaveState, reason: "interrupted", updated_at: "2026-10-17T10:00:00Z" };
  };
  const database = new Database(`sqlite-broken-autosave-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "local-active-final", devices: [{ id: "local-device", mac: "00:11:22:33:44:55" }] });

  const report = await importLegacySQLiteFile(sqliteFile("broken-autosave.sqlite"), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });

  assert.equal(report.imported.settings, 1);
  assert.deepEqual(await database.getSetting("legacyAutosave:current"), {
    state: autosaveState,
    reason: "interrupted",
    updatedAt: "2026-10-17T10:00:00Z",
  });
  assert.equal(await database.getSetting("activeSnapshotId"), "local-active-final");
  assert.deepEqual(await database.recoverActiveSnapshot(), { snapshotId: "local-active-final", recovered: false });
  assert.equal((await database.activeSnapshot()).id, "local-active-final");
  assert.equal((await database.listSnapshots()).some((snapshot) => snapshot.id === "missing-legacy-final"), false);
});

test("legacy SQLite OUI and MAC5 history tables restore learned rules", async () => {
  const tables = ["oui_vendor_history", "mac5_model_history"];
  const runtime = fakeRuntime({ tables, rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
      if (sql.includes('table_info("oui_vendor_history")')) return [{ name: "oui_3byte" }, { name: "vendor" }];
      if (sql.includes('table_info("mac5_model_history")')) return [{ name: "mac_5byte" }, { name: "model" }];
      throw new Error(`Unexpected SQL in vendor/model history import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "oui_vendor_history"') yield { oui_3byte: "AA:BB:CC", vendor: "Legacy Vendor", last_seen: "2026-02-03T00:00:00Z" };
    if (sql === 'SELECT * FROM "mac5_model_history"') yield { mac_5byte: "AA:BB:CC:DD:01", model: "Legacy Model", last_seen: "2026-02-04T00:00:00Z" };
  };
  const database = new Database(`mac-analyzer-pro-next-test-sqlite-oui-mac5-${crypto.randomUUID()}`);

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const mac = "AA:BB:CC:DD:01:99";
  assert.deepEqual([...await database.ouiIndexForMacs([mac])], [["AABBCC", "Legacy Vendor"]]);
  assert.deepEqual([...await database.mac5ModelsForMacs([mac])], [["AABBCCDD01", "Legacy Model"]]);
  const result = await enrich({
    mainRows: [[mac]],
    mappings: { main: { mac: 0 } },
    loadOuiIndex: (macs) => database.ouiIndexForMacs(macs),
    loadMac5Models: (macs) => database.mac5ModelsForMacs(macs),
  });
  assert.equal(result.devices[0].manufacturer, "Legacy Vendor");
  assert.equal(result.devices[0].model, "Legacy Model");
  assert.equal(result.devices[0].fieldSources.manufacturer, "OUI");
  assert.equal(result.devices[0].fieldSources.model, "MAC5 rule AABBCCDD01");
  assert.deepEqual(report.skippedTables, []);
  assert.equal(report.imported.oui, 1);
  assert.equal(report.imported.mac5Models, 1);
});

test("legacy SQLite importer restores supported column views and reports only unsupported views", async () => {
  const runtime = fakeRuntime({ tables: ["column_preferences"], rows: [] });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "column_preferences" }];
      if (sql.includes('table_info("column_preferences")')) return [{ name: "view_name" }, { name: "columns_json" }];
      throw new Error(`Unexpected SQL in column preferences import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "column_preferences"') yield* [
      { view_name: " Inventory ", columns_json: '{"columns":["macFormatted"]}' },
      { view_name: "results", columns_json: '{"columns":["hostname"]}' },
      { view_name: "history", columns_json: '{"columns":["event"]}' },
      ...Array.from({ length: 22 }, (_, index) => ({ view_name: `view-${String(index).padStart(2, "0")}`, columns_json: "{}" })),
    ];
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const settings = staged.filter((event) => event.type === "records" && event.collection === "settings").flatMap((event) => event.records);
  assert.deepEqual(settings.map(({ key }) => key), ["legacyColumnPreferences:inventory", "legacyColumnPreferences:results"]);
  assert.equal(report.skippedTables.length, 1);
  assert.equal(report.skippedTables[0].table, "column_preferences");
  assert.match(report.skippedTables[0].reason, /^Next не поддерживает представления: history, view-00, view-01/);
  assert.match(report.skippedTables[0].reason, /дополнительных строк с неподдержанными представлениями: 3$/);
});

test("legacy SQLite importer rejects a non-SQLite header before creating a VFS", async () => {
  const file = new globalThis.File(["not sqlite", new Uint8Array(128)], "wrong.db");
  let runtimeUsed = false;
  await assert.rejects(importLegacySQLiteFile(file, {}, {
    runtime: { initSQLite: () => { runtimeUsed = true; } },
    wasmUrl: "data:application/wasm;base64,AA==",
  }), /не является базой SQLite/);
  assert.equal(runtimeUsed, false);
});

test("legacy SQLite importer closes its VFS and discards untrusted pages when integrity fails", async () => {
  const runtime = fakeRuntime({ integrity: "database disk image is malformed" });
  await assert.rejects(importLegacySQLiteFile(sqliteFile("broken.sqlite"), {}, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
  }), /Проверка целостности SQLite не пройдена/);
  assert.equal(runtime.closeState.sqliteClosed, true);
  assert.equal(runtime.closeState.vfsClosed, true);
});

test("legacy inventory normalization preserves strong IDs and keeps device and switch IP separate", () => {
  const device = legacyDevice({
    internal_device_id: "asset-42",
    mac: "00-11-22-33-44-55",
    ip: "192.0.2.15",
    switch_ip: "192.0.2.1",
    vendor: "Example",
    serial_number: "SN-42",
    field_sources_json: '{"model":"legacy"}',
  });
  assert.equal(device.id, "asset-42");
  assert.equal(device.mac, "00:11:22:33:44:55");
  assert.equal(device.ip, "192.0.2.15");
  assert.equal(device.switchIp, "192.0.2.1");
  assert.equal(device.fieldSources.model, "legacy");
});

test("legacy MAC movement rows map to deterministic change events without inventing a device identity", () => {
  const row = {
    id: 17, mac: "00-11-22-33-44-55", field_name: "switch_ip", from_value: "192.0.2.1",
    to_value: "192.0.2.2", ddio_candidate_ip: "198.51.100.4", ddio_match: "exact_mac", source: "DDIO",
    changed_at: "2026-10-15T12:00:00Z",
  };
  const event = legacyMovement(row);
  assert.equal(event.type, "modified");
  assert.equal(event.mac, "00:11:22:33:44:55");
  assert.equal(event.deviceId, "");
  assert.equal(event.field, "switchIp");
  assert.equal(event.oldValue, "192.0.2.1");
  assert.equal(event.newValue, "192.0.2.2");
  assert.equal(event.ddioCandidateIp, "198.51.100.4");
  assert.equal(event.id, legacyMovement(row).id);
});

test("legacy observations retain each source schema and normalize identity without becoming change events", () => {
  const macHistory = legacyObservation("mac_history", {
    id: 3, mac: "00-11-22-33-44-55", mac_formatted: "00:11:22:33:44:55", vendor: "Vendor",
    ip: "192.0.2.8", switch_ip: "192.0.2.1", source: "Main", recorded_at: "2026-10-15T09:00:00Z",
  });
  const resolved = legacyObservation("resolved_device_history", {
    id: 4, observation_key: "obs-a", internal_device_id: "asset-a", source: "SmartRoom",
    payload_json: '{"mac":"00:11:22:33:44:66","serial":"S-1"}', recorded_at: "2026-10-15T10:00:00Z",
  });
  const vendor = legacyObservation("vendor_model_history", {
    id: 5, mac: "00:11:22:33:44:77", oui: "001122", prefix: "0011223344", vendor: "Vendor",
    model: "Model", source: "Learned", observed_at: "2026-10-15T11:00:00Z",
  });
  assert.equal(macHistory.kind, "mac_history");
  assert.equal(macHistory.mac, "00:11:22:33:44:55");
  assert.equal(macHistory.payload.switch_ip, "192.0.2.1");
  assert.equal(resolved.internalDeviceId, "asset-a");
  assert.equal(resolved.payload.observation_key, "obs-a");
  assert.deepEqual(resolved.payload.decodedPayload, { mac: "00:11:22:33:44:66", serial: "S-1" });
  assert.equal(vendor.kind, "vendor_model_history");
  assert.equal(vendor.payload.model, "Model");
  assert.equal(macHistory.id, legacyObservation("mac_history", {
    id: 3, mac: "00-11-22-33-44-55", mac_formatted: "00:11:22:33:44:55", vendor: "Vendor",
    ip: "192.0.2.8", switch_ip: "192.0.2.1", source: "Main", recorded_at: "2026-10-15T09:00:00Z",
  }).id);
});

test("legacy API vendor cache becomes exact local vendor history without retaining provider credentials", () => {
  const legacy = legacyApiCacheVendorObservation({
    cache_key: "vendor:00-11-22-33-44-55",
    value: "Cached Vendor",
    cached_at: "2026-10-15T09:00:00Z",
  });
  const provider = legacyApiCacheVendorObservation({
    cache_key: "external_vendor:macvendors:001122334466",
    value: "Provider Vendor",
    cached_at: "2026-10-15T10:00:00Z",
  });
  assert.equal(legacy.kind, "vendor_model_history");
  assert.equal(legacy.sourceTable, "vendor_model_history");
  assert.equal(legacy.mac, "00:11:22:33:44:55");
  assert.equal(legacy.payload.vendor, "Cached Vendor");
  assert.equal(legacy.observedAt, "2026-10-15T09:00:00.000Z");
  assert.equal(provider.mac, "00:11:22:33:44:66");
  assert.equal(provider.payload.vendor, "Provider Vendor");
  assert.equal(provider.payload.cache_key, undefined);
  assert.equal(legacyApiCacheVendorObservation({ cache_key: "external_vendor:macvendors:not-a-mac", value: "Vendor" }), null);
});

test("legacy task migration preserves queue files up to the portable archive size limit", () => {
  const task = legacyTaskObservation("scheduled_tasks", {
    id: "task-1", name: "Nightly", interval_minutes: 60, enabled: 1,
    payload_json: '{"failurePolicy":"continue"}', last_run_at: "2026-10-15T09:00:00Z",
    next_run_at: "2026-10-15T10:00:00Z", created_at: "2026-10-14T09:00:00Z",
  });
  const queued = legacyTaskObservation("task_file_queue", {
    id: "file-1", task_id: "task-1", filename: "main.xlsx", content_base64: "Ynl0ZXM=",
    status: "error", result_json: '{"processed":1}', error: "parse failed", created_at: "2026-10-15T09:00:00Z",
  });
  assert.equal(task.kind, "scheduled_tasks");
  assert.equal(task.payload.payload.failurePolicy, "continue");
  assert.equal(task.payload.enabled, true);
  assert.match(task.payload.id, /^legacy-task-legacy-sqlite-/);
  assert.equal(task.id, legacyTaskObservation("scheduled_tasks", {
    id: "task-1", name: "Nightly", interval_minutes: 60, enabled: 1,
    payload_json: '{"failurePolicy":"continue"}', last_run_at: "2026-10-15T09:00:00Z",
    next_run_at: "2026-10-15T10:00:00Z", created_at: "2026-10-14T09:00:00Z",
  }).id);
  assert.equal(queued.kind, "task_file_queue");
  assert.equal(queued.payload.filename, "main.xlsx");
  assert.equal(queued.payload.result.processed, 1);
  assert.equal(queued.payload.contentBase64Chars, 8);
  assert.equal(queued.payload.contentAvailable, true);
  assert.equal(queued.payload.contentBase64, "Ynl0ZXM=");
  assert.equal(queued.payload.contentRetainedInSourceDatabase, true);
  assert.equal(queued.payload.taskId, task.payload.id);
  const namespaceA = legacyTaskObservation("scheduled_tasks", { id: "task-1" }, "a".repeat(24));
  const namespaceB = legacyTaskObservation("scheduled_tasks", { id: "task-1" }, "b".repeat(24));
  assert.notEqual(namespaceA.payload.id, namespaceB.payload.id);
  assert.notEqual(namespaceA.id, namespaceB.id);
  assert.equal(namespaceA.id, legacyTaskObservation("scheduled_tasks", { id: "task-1" }, "a".repeat(24)).id);
  assert.equal(Object.hasOwn(queued.payload, "content_base64"), false);
});

test("legacy SQLite importer streams all three legacy observation tables into their own collection", async () => {
  const tableRows = {
    mac_history: [{ name: "id" }, { name: "mac" }, { name: "timestamp" }],
    resolved_device_history: [{ name: "observation_key" }, { name: "internal_device_id" }, { name: "payload_json" }, { name: "recorded_at" }],
    vendor_model_history: [{ name: "mac" }, { name: "observed_at" }],
  };
  const sourceRows = {
    mac_history: [{ id: 1, mac: "00:11:22:33:44:55", timestamp: "2026-10-15T09:00:00Z" }],
    resolved_device_history: [{ id: 2, observation_key: "obs-1", internal_device_id: "asset-1", payload_json: '{"serial":"S-1"}', recorded_at: "2026-10-15T10:00:00Z" }],
    vendor_model_history: [{ id: 3, mac: "00:11:22:33:44:66", model: "Model", observed_at: "2026-10-15T11:00:00Z" }],
  };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return Object.keys(tableRows).map((name) => ({ name }));
      const table = Object.keys(tableRows).find((name) => sql.includes(`table_info(\"${name}\")`));
      if (table) return tableRows[table];
      throw new Error(`Unexpected SQL in observation test: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    const table = Object.keys(sourceRows).find((name) => sql.includes(`FROM \"${name}\"`));
    if (!table) return;
    if (table === "task_file_queue") yield* sourceRows[table].map((row) => ({ ...row, content_base64_chars: row.content_base64.length }));
    else yield* sourceRows[table];
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.equal(report.imported.legacyObservations, 3);
  assert.deepEqual(report.skippedTables, []);
  const observations = staged.filter((event) => event.type === "records" && event.collection === "legacyObservations").flatMap((event) => event.records);
  assert.deepEqual(observations.map((row) => row.kind).sort(), ["mac_history", "resolved_device_history", "vendor_model_history"]);
});

test("legacy SQLite API cache imports valid MAC vendor values into searchable local history", async () => {
  const tableRows = { api_cache: ["cache_key", "value", "cached_at"].map((name) => ({ name })) };
  const sourceRows = { api_cache: [
    { cache_key: "external_vendor:macvendors:001122334455", value: "Cached Vendor", cached_at: "2026-10-15T09:00:00Z" },
    { cache_key: "vendor:AA:BB:CC:DD:EE:66", value: "Legacy Vendor", cached_at: "2026-10-15T10:00:00Z" },
    { cache_key: "unrelated:key", value: "Ignore", cached_at: "2026-10-15T10:00:00Z" },
  ] };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "api_cache" }];
      if (sql.includes('table_info("api_cache")')) return tableRows.api_cache;
      throw new Error(`Unexpected SQL in API cache import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "api_cache"') yield* sourceRows.api_cache;
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const observations = staged.filter((event) => event.type === "records" && event.collection === "legacyObservations").flatMap((event) => event.records);
  assert.equal(report.imported.legacyObservations, 2);
  assert.deepEqual(report.skippedTables, []);
  assert.deepEqual(observations.map((item) => [item.mac, item.payload.vendor]), [
    ["00:11:22:33:44:55", "Cached Vendor"],
    ["AA:BB:CC:DD:EE:66", "Legacy Vendor"],
  ]);
});

test("legacy SQLite migration databases preserve load, analysis, and performance records", async () => {
  const sourceRows = {
    history_loads: [{ id: 7, filename: "legacy-vendors.xlsx", load_date: "2026-01-03T10:00:00Z", devices_count: 7, new_vendors_added: 1, new_models_added: 2, enriched_from_history: 3 }],
    analysis_history: [{ id: 8, timestamp: "2026-01-04T10:00:00Z", filename: "legacy-analysis.xlsx", devices_count: 11, strategy: "primary", processing_time: 1.2 }],
    performance_metrics: [{ id: 9, operation: "legacy_export", timestamp: "2026-01-05T10:00:00Z", duration_seconds: 2.5, details: "legacy-test-metric" }],
    daily_stats: [{ id: 10, date: "2026-01-06", total_devices: 20, new_devices: 3, vendors_count: 5, rooms_count: 4, devices_with_address: 17, devices_with_room: 18 }],
  };
  const columns = Object.fromEntries(Object.entries(sourceRows).map(([table, rows]) => [table, Object.keys(rows[0])]));
  const runtime = fakeRuntime({ tables: Object.keys(sourceRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return Object.keys(sourceRows).map((name) => ({ name }));
      const table = Object.keys(columns).find((name) => sql.includes(`table_info(\"${name}\")`));
      if (table) return columns[table].map((name) => ({ name }));
      throw new Error(`Unexpected SQL in migration database import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    const table = Object.keys(sourceRows).find((name) => sql === `SELECT * FROM \"${name}\"`);
    if (table) yield* sourceRows[table];
  };
  const database = new Database(`mac-analyzer-pro-next-test-sqlite-migration-${crypto.randomUUID()}`);
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const kinds = ["history_loads", "analysis_history"];
  const observations = await Promise.all(kinds.map(async (kind) => (await database.legacyObservationSearchPage({ kind })).rows[0]));
  assert.equal(report.imported.legacyObservations, 4);
  assert.equal(report.imported.settings, 1);
  assert.deepEqual(report.skippedTables, []);
  assert.deepEqual(observations.map(({ kind, observedAt }) => [kind, observedAt]), [
    ["history_loads", "2026-01-03T10:00:00.000Z"],
    ["analysis_history", "2026-01-04T10:00:00.000Z"],
  ]);
  assert.deepEqual(observations.map((item) => item.payload.devicesCount), [7, 11]);
  assert.deepEqual(observations[0].payload, {
    id: "7", filename: "legacy-vendors.xlsx", loadDate: "2026-01-03T10:00:00Z",
    devicesCount: 7, newVendorsAdded: 1, newModelsAdded: 2, enrichedFromHistory: 3,
  });
  const dailyStats = (await database.legacyObservationSearchPage({ kind: "daily_stats" })).rows[0];
  assert.equal(dailyStats.observedAt, "2026-01-06T00:00:00.000Z");
  assert.deepEqual(dailyStats.payload, {
    date: "2026-01-06", totalDevices: 20, newDevices: 3, vendorsCount: 5,
    roomsCount: 4, devicesWithAddress: 17, devicesWithRoom: 18,
  });
  assert.deepEqual(await database.performanceStatistics({ days: 7, now: Date.parse("2026-01-06T00:00:00Z") }), [
    { operation: "legacy_export", count: 1, totalMs: 2_500, averageMs: 2_500, minMs: 2_500, maxMs: 2_500, latestAt: "2026-01-05T10:00:00.000Z" },
  ]);
  const archive = await new globalThis.Response(database.exportArchiveStream()).json();
  const restored = new Database(`mac-analyzer-pro-next-test-sqlite-metrics-restore-${crypto.randomUUID()}`);
  await restored.importArchive(archive);
  assert.deepEqual(await restored.performanceStatistics({ days: 7, now: Date.parse("2026-01-06T00:00:00Z") }), [
    { operation: "legacy_export", count: 1, totalMs: 2_500, averageMs: 2_500, minMs: 2_500, maxMs: 2_500, latestAt: "2026-01-05T10:00:00.000Z" },
  ]);
  assert.deepEqual(await database.listSnapshots(), []);
});

test("legacy SQLite scheduled tasks and queue results import as searchable records", async () => {
  const tableRows = {
    scheduled_tasks: ["id", "name", "interval_minutes", "payload_json", "created_at"].map((name) => ({ name })),
    task_file_queue: ["id", "task_id", "filename", "content_base64", "status", "created_at"].map((name) => ({ name })),
  };
  const sourceRows = {
    scheduled_tasks: [{ id: "task-1", name: "Nightly", interval_minutes: 60, enabled: 1, payload_json: '{"strategy":"NO_EXPANSION"}', last_run_at: "2026-10-15T09:00:00Z", next_run_at: "2026-10-15T10:00:00Z", created_at: "2026-10-14T09:00:00Z" }],
    task_file_queue: [
      { id: "file-1", task_id: "task-1", filename: "main.xlsx", content_base64: "Ynl0ZXM=", status: "done", result_json: '{"processed":1}', created_at: "2026-10-15T09:00:00Z" },
      { id: "file-2", task_id: "task-1", filename: "large.xlsx", content_base64: "", content_base64_chars: 40 * 1024 * 1024 + 4, status: "pending", created_at: "2026-10-15T10:00:00Z" },
    ],
  };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return Object.keys(tableRows).map((name) => ({ name }));
      const table = Object.keys(tableRows).find((name) => sql.includes(`table_info(\"${name}\")`));
      if (table) return tableRows[table];
      throw new Error(`Unexpected SQL in scheduled task import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    const table = Object.keys(sourceRows).find((name) => sql.includes(`FROM \"${name}\"`));
    if (!table) return;
    if (table === "task_file_queue") {
      assert.match(sql, /CASE WHEN length\("content_base64"\) <= 41943040/);
      yield* sourceRows[table].map((row) => ({ ...row, content_base64_chars: row.content_base64_chars ?? row.content_base64.length }));
    }
    else yield* sourceRows[table];
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const observations = staged.filter((event) => event.type === "records" && event.collection === "legacyObservations").flatMap((event) => event.records);
  assert.equal(report.imported.legacyObservations, 3);
  assert.deepEqual(report.skippedTables, []);
  assert.deepEqual(observations.map((item) => item.kind).sort(), ["scheduled_tasks", "task_file_queue", "task_file_queue"]);
  assert.equal(observations.find((item) => item.kind === "task_file_queue").payload.contentRetainedInSourceDatabase, true);
  assert.equal(observations.find((item) => item.kind === "task_file_queue").payload.contentBase64, "Ynl0ZXM=");
  assert.equal(observations.find((item) => item.kind === "task_file_queue").payload.taskId, observations.find((item) => item.kind === "scheduled_tasks").payload.id);
  assert.match(observations.find((item) => item.kind === "scheduled_tasks").payload.id, /^legacy-task-[0-9a-f]{24}-[0-9a-f]{16}$/);
  const largeQueue = observations.find((item) => item.kind === "task_file_queue" && item.payload.filename === "large.xlsx");
  assert.equal(largeQueue.payload.contentAvailable, false);
  assert.equal(largeQueue.payload.contentRetainedInSourceDatabase, true);
  assert.equal(largeQueue.payload.contentBase64Chars, 40 * 1024 * 1024 + 4);
  assert.equal(Object.hasOwn(largeQueue.payload, "contentBase64"), false);
});

test("large legacy queue files stream from the retained SQLite database in bounded Base64 chunks", async () => {
  const originalBytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
  const binaryParts = [];
  for (let offset = 0; offset < originalBytes.length; offset += 4096) binaryParts.push(String.fromCharCode(...originalBytes.subarray(offset, Math.min(originalBytes.length, offset + 4096))));
  const encoded = globalThis.btoa(binaryParts.join(""));
  const sqlCalls = [];
  let sqliteClosed = false;
  let vfsClosed = false;
  const runtime = {
    useIdbStorage: async (name, options) => ({ name, options }),
    initSQLite: async () => ({
      run: async (sql, params) => {
        sqlCalls.push({ sql, params });
        if (sql.includes("length(content_base64)")) return [{ filename: "large.xlsx", contentBase64Chars: encoded.length }];
        const [, size, fileId, taskId] = params;
        const start = params[0] - 1;
        assert.equal(fileId, "file-9");
        assert.equal(taskId, "task-9");
        return [{ contentChunk: encoded.slice(start, start + size) }];
      },
      close: async () => { sqliteClosed = true; },
      vfs: { close: async () => { vfsClosed = true; } },
    }),
  };
  let capacityBytes = 0;
  let progressCalls = 0;
  const restored = await readLegacyTaskQueueFileFromSQLite(
    { sourceIdbName: "source.db", sourceNamespace: "c".repeat(24) },
    { payload: { id: "file-9", sourceTaskId: "task-9", filename: "fallback.csv" } },
    { runtime, wasmUrl: "data:application/wasm;base64,AA==", beforeRead: (bytes) => { capacityBytes = bytes; }, onProgress: () => { progressCalls += 1; } },
  );
  assert.equal(restored.filename, "large.xlsx");
  assert.equal(restored.blob.size, originalBytes.length);
  assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), originalBytes);
  assert.equal(capacityBytes, Math.ceil(encoded.length * 0.75));
  assert.equal(progressCalls, 2);
  assert.equal(sqlCalls.length, 3);
  assert.equal(sqliteClosed, true);
  assert.equal(vfsClosed, true);
});

test("legacy SQLite quality reports are validated, mapped, and streamed into the report archive collection", async () => {
  const tableRows = { data_quality_reports: ["id", "source", "score", "grade", "report_json", "created_at"].map((name) => ({ name })) };
  const sourceRows = { data_quality_reports: [{ id: "quality-1", source: "Network Final", score: 88, grade: "B", report_json: '{"summary":{"devices":42},"issues":[]}', created_at: "2026-10-15T11:00:00Z" }] };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "data_quality_reports" }];
      if (sql.includes('table_info("data_quality_reports")')) return tableRows.data_quality_reports;
      throw new Error(`Unexpected SQL in quality report import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "data_quality_reports" ORDER BY "created_at", "id"') yield* sourceRows.data_quality_reports;
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.equal(report.imported.dataQualityReports, 1);
  assert.deepEqual(report.skippedTables, []);
  const quality = staged.filter((event) => event.type === "records" && event.collection === "dataQualityReports").flatMap((event) => event.records);
  assert.equal(quality.length, 1);
  assert.equal(quality[0].snapshotName, "Network Final");
  assert.equal(quality[0].report.summary.devices, 42);
  assert.equal(quality[0].score, 88);
});

test("legacy SQLite Smartroom room mappings are normalized and streamed as reusable explicit mappings", async () => {
  const tableRows = { smartroom_room_mappings: ["smartroom_id", "room", "source", "updated_at"].map((name) => ({ name })) };
  const sourceRows = { smartroom_room_mappings: [
    { smartroom_id: " SR-1 ", room: "Room 1", source: "manual", updated_at: "2026-10-15T12:00:00Z" },
    { smartroom_id: "", room: "ignored" },
    { smartroom_id: "SR-2", room: "  " },
  ] };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "smartroom_room_mappings" }];
      if (sql.includes('table_info("smartroom_room_mappings")')) return tableRows.smartroom_room_mappings;
      throw new Error(`Unexpected SQL in Smartroom mapping import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "smartroom_room_mappings"') yield* sourceRows.smartroom_room_mappings;
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.equal(report.imported.legacySmartroomRoomMappings, 1);
  assert.deepEqual(report.skippedTables, []);
  const mappings = staged.filter((event) => event.type === "records" && event.collection === "legacySmartroomRoomMappings").flatMap((event) => event.records);
  assert.deepEqual(mappings.map(({ smartroomId, smartroomIdKey, room }) => ({ smartroomId, smartroomIdKey, room })), [
    { smartroomId: "SR-1", smartroomIdKey: "sr-1", room: "Room 1" },
  ]);
});

test("legacy SQLite Smartroom mappings flow through IndexedDB into enrichment", async () => {
  const tableRows = { smartroom_room_mappings: ["smartroom_id", "room", "source", "updated_at"].map((name) => ({ name })) };
  const sourceRows = { smartroom_room_mappings: [
    { smartroom_id: "SR-FLOW", room: "Recovered Room", source: "manual", updated_at: "2026-10-15T12:00:00Z" },
  ] };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "smartroom_room_mappings" }];
      if (sql.includes('table_info("smartroom_room_mappings")')) return tableRows.smartroom_room_mappings;
      throw new Error(`Unexpected SQL in Smartroom integration: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "smartroom_room_mappings"') yield* sourceRows.smartroom_room_mappings;
  };

  const databaseName = `sqlite-smartroom-flow-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    const mappingIndex = buildImportedSmartroomRoomIndex(await database.legacySmartroomRoomMappingsForIds(["SR-FLOW"]));
    const result = await enrich({
      mainRows: [["00:11:22:33:44:91", "SR-FLOW", ""]],
      mappings: { main: { mac: 0, smartroomId: 1, room: 2 }, smartroom: {}, ddio: {} },
      loadImportedSmartroomRoomIndex: async () => mappingIndex,
    });
    assert.equal(report.imported.legacySmartroomRoomMappings, 1);
    assert.equal(result.devices[0].room, "Recovered Room");
    assert.equal(result.devices[0].fieldSources.room, "Imported SQLite Smartroom room mapping");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

test("legacy SQLite external vendor cache flows through IndexedDB into offline enrichment", async () => {
  const tableRows = { api_cache: ["cache_key", "value", "cached_at"].map((name) => ({ name })) };
  const sourceRows = { api_cache: [
    { cache_key: "external_vendor:macvendors:02AABBCCDDEE", value: "Cached Offline Vendor", cached_at: "2026-10-15T12:00:00Z" },
  ] };
  const runtime = fakeRuntime({ tables: Object.keys(tableRows) });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "api_cache" }];
      if (sql.includes('table_info("api_cache")')) return tableRows.api_cache;
      throw new Error(`Unexpected SQL in API cache integration: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "api_cache"') yield* sourceRows.api_cache;
  };

  const databaseName = `sqlite-api-cache-flow-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    const result = await enrich({
      mainRows: [["02:AA:BB:CC:DD:EE"]],
      mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
      loadLegacyVendorModelSuggestions: (macs) => database.legacyVendorModelSuggestionsForMacs(macs),
    });
    assert.equal(report.imported.legacyObservations, 1);
    assert.equal(result.devices[0].manufacturer, "Cached Offline Vendor");
    assert.equal(result.devices[0].fieldSources.manufacturer, "vendor_model_history_exact");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});
