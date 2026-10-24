import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import "fake-indexeddb/auto";
import { initSQLite, iterator, useMemoryStorage, withExistDB } from "@subframe7536/sqlite-wasm";
import { useIdbStorage } from "@subframe7536/sqlite-wasm/idb";
import { Database } from "../src/data/database.js";
import { enrich } from "../src/core/enrichment.js";
import { buildImportedSmartroomRoomIndex } from "../src/core/historical-mapping.js";
import { addCustomInventoryColumn, customInventoryColumnKey, defaultInventoryColumnConfig, inventoryCellText, inventoryColumnConfigFromLegacyPreferences, visibleInventoryColumns } from "../src/core/inventory-columns.js";
import { VendorModelHistoryAccumulator } from "../src/core/vendor-model-history.js";
import { sha256File } from "../src/core/incremental-sha256.js";
import { createSQLitePageImportStream, importLegacySQLiteFile, LEGACY_SQLITE_TABLES, LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES, LEGACY_SQLITE_TABLE_REQUIREMENTS, legacyApiCacheVendorObservation, legacyAutosaveSnapshotId, legacyDevice, legacyMovement, legacyObservation, legacyTaskObservation, normalizeLegacyTimestamp, readLegacyTaskQueueFileFromSQLite, resolveLegacySQLiteFileSelection } from "../src/data/sqlite-database-importer.js";

test("legacy SQLite importer recognizes every current PyQt-owned database table", () => {
  const currentPyQtTables = [
    "mac_history", "mac_movements", "oui_vendor_history", "mac5_model_history",
    "mac_vendor_history", "mac_model_history", "history_loads", "daily_stats", "analysis_history", "performance_metrics", "exports",
  ];
  const supportedTables = new Set(LEGACY_SQLITE_TABLES);
  assert.deepEqual(currentPyQtTables.filter((table) => !supportedTables.has(table)), []);
});

test("every supported SQLite table has an explicit required-column policy", () => {
  assert.deepEqual(LEGACY_SQLITE_TABLES.filter((table) => !Object.hasOwn(LEGACY_SQLITE_TABLE_REQUIREMENTS, table)), []);
  assert.deepEqual(LEGACY_SQLITE_TABLE_REQUIREMENTS.mac_movements, ["mac", "field_name"]);
  assert.deepEqual(LEGACY_SQLITE_TABLE_REQUIREMENTS.mac5_model_history, ["mac_5byte", "model"]);
  assert.deepEqual(LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES.mac_movements, [["timestamp", "changed_at"]]);
  assert.deepEqual(Object.keys(LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES).filter((table) => !Object.hasOwn(LEGACY_SQLITE_TABLE_REQUIREMENTS, table)), []);
});

test("SQLite schemas missing required movement or MAC5 columns are reported while compatible tables continue", async () => {
  const runtime = fakeRuntime({ tables: ["mac_movements", "mac5_model_history", "app_settings"] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    const baseRun = sqlite.run;
    sqlite.run = async (sql) => {
      if (sql.includes('table_info("mac_movements")')) return [{ name: "mac" }];
      if (sql.includes('table_info("mac5_model_history")')) return [{ name: "mac_5byte" }];
      return baseRun(sql);
    };
    return sqlite;
  };
  const imported = [];
  const database = {
    async importArchiveEvents(_header, events) {
      for await (const event of events) if (event.type === "records") imported.push(...event.records);
    },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile("incomplete-legacy-schema.sqlite"), database, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });

  assert.deepEqual(report.skippedTables.map(({ table }) => table), ["mac_movements", "mac5_model_history"]);
  assert.match(report.skippedTables[0].reason, /field_name.*timestamp или changed_at/);
  assert.match(report.skippedTables[1].reason, /model/);
  assert.deepEqual(imported.map(({ key }) => key), ["legacyAppSetting:theme"]);
});

test("legacy movement schemas accept changed_at when timestamp is not present", async () => {
  const runtime = fakeRuntime({ tables: ["mac_movements", "app_settings"] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    const baseRun = sqlite.run;
    sqlite.run = async (sql) => {
      if (sql.includes('table_info("mac_movements")')) return ["mac", "field_name", "from_value", "to_value", "changed_at"].map((name) => ({ name }));
      return baseRun(sql);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "mac_movements"') yield {
      mac: "00:11:22:33:44:55",
      field_name: "switch_port",
      from_value: "Gi1/0/1",
      to_value: "Gi1/0/2",
      changed_at: "2026-10-15T12:34:56Z",
    };
    else if (sql === 'SELECT * FROM "app_settings"') yield { key: "theme", value: "dark" };
  };
  const events = [];
  const database = {
    async importArchiveEvents(_header, sourceEvents) { for await (const event of sourceEvents) events.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile("legacy-changed-at.sqlite"), database, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });

  assert.equal(report.skippedTables.some(({ table }) => table === "mac_movements"), false);
  const movement = events.flatMap((event) => event.type === "records" && event.collection === "history" ? event.records : [])[0];
  assert.equal(movement.timestamp, "2026-10-15T12:34:56.000Z");
  assert.deepEqual([movement.field, movement.oldValue, movement.newValue], ["switchPort", "Gi1/0/1", "Gi1/0/2"]);
});

test("SQLite importer accounts for every table declared by the untouched PyQt reference", () => {
  const reference = readFileSync("../MAC_ANALYZER финальная.py", "utf8");
  const declarations = [...reference.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*'''/gi)]
    .map((match) => ({
      table: match[1].toLowerCase(),
      columns: new Set([...match[2].matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+(?:INTEGER|REAL|TEXT|BLOB|TIMESTAMP)\b/gi)].map((column) => column[1].toLowerCase())),
    }));
  const declaredTables = declarations.map(({ table }) => table);
  const supportedTables = new Set(LEGACY_SQLITE_TABLES);
  assert.equal(declaredTables.length, 8, "update this audit if the reference declares another SQLite table");
  assert.deepEqual([...new Set(declaredTables)].filter((table) => !supportedTables.has(table)), []);
  const schemaGaps = declarations.flatMap(({ table, columns }) => {
    const required = LEGACY_SQLITE_TABLE_REQUIREMENTS[table] || [];
    const missing = required.filter((column) => !columns.has(column));
    const missingAlternatives = (LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES[table] || [])
      .filter((alternatives) => !alternatives.some((column) => columns.has(column)))
      .map((alternatives) => alternatives.join(" or "));
    return [...missing, ...missingAlternatives].map((column) => `${table}.${column}`);
  });
  assert.deepEqual(schemaGaps, [], "the SQLite importer must require only columns present in the PyQt schema");
});

test("SQLite importer covers the shipped Web database schema without importing private tables", () => {
  const currentWebSchema = {
    app_logs: ["id", "action", "details", "created_at"],
    api_cache: ["cache_key", "value", "cached_at"],
    app_autosaves: ["slot", "state_json", "reason", "updated_at"],
    app_settings: ["key", "value", "updated_at"],
    column_preferences: ["view_name", "columns_json", "updated_at"],
    data_quality_reports: ["id", "source", "score", "grade", "report_json", "created_at"],
    engineering_sessions: ["token_hash", "role", "permissions_json", "created_at", "expires_at", "revoked_at"],
    ip_address_mappings: ["switch_ip", "physical_address", "source", "updated_at"],
    mac_history: ["id", "mac", "mac_formatted", "oui", "vendor", "model", "ip", "address", "room", "switch_ip", "switch_port", "source", "recorded_at", "smartroom_id"],
    mac_movements: ["id", "mac", "field_name", "from_value", "to_value", "source", "changed_at"],
    model_mappings: ["prefix", "model", "source", "updated_at"],
    notification_settings: ["channel", "config_json", "enabled", "updated_at"],
    performance_metrics: ["id", "operation", "duration_ms", "details", "created_at"],
    scheduled_tasks: ["id", "name", "interval_minutes", "enabled", "payload_json", "last_run_at", "next_run_at", "created_at"],
    snapshots: ["id", "name", "source", "device_count", "devices_json", "created_at"],
    task_file_queue: ["id", "task_id", "filename", "content_base64", "status", "result_json", "error", "created_at", "started_at", "finished_at"],
    vendor_mappings: ["oui", "vendor", "source", "updated_at"],
    vendor_model_history: ["id", "mac", "oui", "prefix", "vendor", "model", "source", "observed_at"],
  };
  const omitted = new Set(["engineering_sessions", "notification_settings"]);
  const supported = new Set(LEGACY_SQLITE_TABLES);
  const tableNames = Object.keys(currentWebSchema);

  assert.deepEqual(tableNames.filter((table) => !supported.has(table) && !omitted.has(table)), []);
  assert.deepEqual([...omitted].filter((table) => supported.has(table)), []);
  assert.deepEqual(tableNames.filter((table) => !supported.has(table)), [...omitted].sort());
  for (const table of supported) {
    if (!currentWebSchema[table]) continue;
    const columns = new Set(currentWebSchema[table]);
    const required = LEGACY_SQLITE_TABLE_REQUIREMENTS[table] || [];
    assert.deepEqual(required.filter((column) => !columns.has(column)), [], `${table} required columns`);
    const missingAlternatives = (LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES[table] || [])
      .filter((alternatives) => !alternatives.some((column) => columns.has(column)));
    assert.deepEqual(missingAlternatives, [], `${table} alternative columns`);
  }
});

test("legacy SQLite per-MAC vendor and model histories restore offline suggestions and weighted history", async () => {
  const tables = ["mac_vendor_history", "mac_model_history", "exports"];
  const runtime = fakeRuntime({ tables, rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
      if (sql.includes('table_info("mac_vendor_history")')) return ["id", "mac", "vendor", "vendor_confidence", "source_file", "source_date", "first_seen", "last_seen", "times_seen"].map((name) => ({ name }));
      if (sql.includes('table_info("mac_model_history")')) return ["id", "mac", "model", "model_confidence", "source_file", "source_date", "first_seen", "last_seen", "times_seen"].map((name) => ({ name }));
      if (sql.includes('table_info("exports")')) return ["id", "filename", "export_date", "devices_count", "format_type", "user", "notes"].map((name) => ({ name }));
      throw new Error(`Unexpected SQL in per-MAC history import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "mac_vendor_history"') yield {
      id: 12, mac: "AA:BB:CC:DD:01:02", vendor: "Legacy Vendor", vendor_confidence: 0.97,
      source_file: "vendors.xlsx", source_date: "2025-11-30T00:00:00Z", first_seen: "2025-11-01T00:00:00Z",
      last_seen: "2025-12-01T00:00:00Z", times_seen: 5,
    };
    if (sql === 'SELECT * FROM "mac_vendor_history"') yield {
      id: 13, mac: "11:22:33:44:55:66", vendor: "Counted Vendor",
      source_file: "counted-vendors.xlsx", source_date: "2025-12-01T00:00:00Z", times_seen: 3,
    };
    if (sql === 'SELECT * FROM "mac_model_history"') yield {
      id: 19, mac: "AA:BB:CC:DD:01:02", model: "Legacy Model", model_confidence: 0.91,
      source_file: "models.xlsx", source_date: "2025-12-02T00:00:00Z", first_seen: "2025-11-02T00:00:00Z",
      last_seen: "2025-12-02T00:00:00Z", times_seen: 3,
    };
    if (sql === 'SELECT * FROM "exports"') yield {
      id: 8, filename: "C:\\Users\\Legacy\\Reports\\devices.xlsx", export_date: "2025-12-03T00:00:00Z",
      devices_count: 7, format_type: "xlsx", user: "operator", notes: "Approved report",
    };
  };
  const databaseName = `sqlite-per-mac-vendor-model-${crypto.randomUUID()}`;
  const restoredName = `sqlite-per-mac-vendor-model-restore-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  const restored = new Database(restoredName);
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    const mac = "AA:BB:CC:DD:01:02";
    const suggestions = await database.legacyVendorModelSuggestionsForMacs([mac]);
    assert.equal(suggestions.get(mac).vendor, "Legacy Vendor");
    assert.equal(suggestions.get(mac).model, "Legacy Model");
    assert.deepEqual([suggestions.get(mac).vendorConfidence, suggestions.get(mac).modelConfidence, suggestions.get(mac).source], [0.97, 0.91, "vendor_model_history_exact"]);
    const countedSuggestion = (await database.legacyVendorModelSuggestionsForMacs(["11:22:33:44:55:66"])).get("11:22:33:44:55:66");
    assert.equal(countedSuggestion.vendorConfidence, 0.512);
    const prefixSuggestion = (await database.legacyVendorModelSuggestionsForMacs(["AA:BB:CC:DD:01:FF"])).get("AA:BB:CC:DD:01:FF");
    assert.deepEqual([prefixSuggestion.vendor, prefixSuggestion.model, prefixSuggestion.matches], ["Legacy Vendor", "Legacy Model", 5]);
    const portableArchive = await new globalThis.Response(database.exportArchiveStream()).json();
    await restored.importArchive(portableArchive);
    const restoredPrefixSuggestion = (await restored.legacyVendorModelSuggestionsForMacs(["AA:BB:CC:DD:01:FF"])).get("AA:BB:CC:DD:01:FF");
    assert.deepEqual([restoredPrefixSuggestion.vendor, restoredPrefixSuggestion.model, restoredPrefixSuggestion.matches], ["Legacy Vendor", "Legacy Model", 5]);
    const restoredExactSuggestion = (await restored.legacyVendorModelSuggestionsForMacs([mac])).get(mac);
    assert.deepEqual([restoredExactSuggestion.vendorConfidence, restoredExactSuggestion.modelConfidence], [0.97, 0.91]);

    const history = new VendorModelHistoryAccumulator();
    const observations = await database.legacyObservationPage({ kind: "vendor_model_history", limit: 10 });
    observations.rows.forEach((observation) => history.addObservation(observation));
    const result = history.result();
    assert.deepEqual([result.vendors[0].occurrences, result.vendors[0].firstSeen, result.vendors[0].lastSeen], [5, "2025-11-01T00:00:00Z", "2025-12-01T00:00:00Z"]);
    assert.deepEqual([result.models[0].occurrences, result.models[0].firstSeen, result.models[0].lastSeen], [3, "2025-11-02T00:00:00Z", "2025-12-02T00:00:00Z"]);
    assert.deepEqual([result.loads.find(({ source }) => source === "vendors.xlsx").records, result.loads.find(({ source }) => source === "models.xlsx").records], [5, 3]);
    const exported = (await database.legacyObservationPage({ kind: "exports", limit: 10 })).rows[0];
    assert.equal(exported.sourceTable, "exports");
    assert.equal(exported.observedAt, "2025-12-03T00:00:00.000Z");
    assert.deepEqual([exported.payload.filename, exported.payload.devicesCount, exported.payload.formatType, exported.payload.user], ["devices.xlsx", 7, "xlsx", "operator"]);
    assert.equal(exported.payload.notes, "Approved report");
    assert.equal((await database.legacyObservationSearchPage({ kind: "exports", source: "devices.xlsx" })).total, 1);
    assert.deepEqual(report.skippedTables, []);
    assert.equal(report.imported.legacyObservations, 4);
  } finally {
    database.connection?.close();
    database.connection = null;
    restored.connection?.close();
    restored.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(restoredName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

test("legacy SQLite timestamps reject impossible dates instead of rolling them forward", () => {
  const fallback = "2026-06-18T10:00:00.000Z";
  assert.equal(normalizeLegacyTimestamp("2026-02-30T12:00:00Z", fallback), fallback);
  assert.equal(normalizeLegacyTimestamp("2026-02-28T24:00:00Z", fallback), fallback);
  assert.equal(normalizeLegacyTimestamp("2024-02-29T23:59:59Z", fallback), "2024-02-29T23:59:59.000Z");
  assert.equal(normalizeLegacyTimestamp(Date.UTC(2026, 5, 18, 10), fallback), fallback);

  const before = Date.now();
  const movement = legacyMovement({ mac: "00:11:22:33:44:55", field_name: "ip", changed_at: "2026-02-30T12:00:00Z" });
  const after = Date.now();
  assert.ok(Date.parse(movement.timestamp) >= before && Date.parse(movement.timestamp) <= after);
});

test("legacy autosave resolves only snapshot references imported from the same SQLite database", () => {
  const snapshotIds = new Map([["legacy-final-1", "legacy-sqlite-import-1-legacy-final-1"]]);
  assert.equal(legacyAutosaveSnapshotId(JSON.stringify({ resultSnapshotId: "legacy-final-1" }), snapshotIds), "legacy-sqlite-import-1-legacy-final-1");
  assert.equal(legacyAutosaveSnapshotId(JSON.stringify({ activeSnapshotId: "legacy-final-1" }), snapshotIds), "legacy-sqlite-import-1-legacy-final-1");
  assert.equal(legacyAutosaveSnapshotId(JSON.stringify({ resultSnapshotId: "missing-final" }), snapshotIds), "");
  assert.equal(legacyAutosaveSnapshotId("x".repeat(1_048_577), snapshotIds), "");
});

test("SQLite autosave references are remapped to the imported Final ID without activating it", async () => {
  const autosaveState = JSON.stringify({ resultSnapshotId: "source-final-1" });
  const runtime = fakeRuntime({ tables: ["snapshots", "app_autosaves"] });
  runtime.initSQLite = async () => ({
    run: async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "snapshots" }, { name: "app_autosaves" }];
      if (sql.includes('table_info("snapshots")')) return ["id", "name", "source", "device_count", "created_at", "signature", "devices_json"].map((name) => ({ name }));
      if (sql.includes('table_info("app_autosaves")')) return ["slot", "state_json", "reason", "updated_at"].map((name) => ({ name }));
      throw new Error(`Unexpected SQL in linked legacy autosave test: ${sql}`);
    },
    close: async () => {},
    vfs: { close() {} },
  });
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql.includes('FROM "snapshots" ORDER BY')) yield { id: "source-final-1", name: "Recovered Final", source: "PyQt", device_count: 1, created_at: "2026-10-18T10:00:00Z", signature: "" };
    else if (sql.includes("json_each")) yield { device_json: JSON.stringify({
      mac: "001122334455",
      vendor: "Example Vendor",
      vendorConfidence: 0.91,
      vendorSource: "vendors.xlsx",
      model: "Example Model",
      modelConfidence: 0.84,
      modelSource: "models.xlsx",
    }) };
    else if (sql === 'SELECT "slot", "state_json" FROM "app_autosaves"') yield { slot: "main", state_json: autosaveState };
    else if (sql === 'SELECT * FROM "app_autosaves"') yield { slot: "main", state_json: autosaveState, reason: "restart", updated_at: "2026-10-18T10:05:00Z" };
  };
  const events = [];
  const database = {
    async importArchiveEvents(_header, sourceEvents) { for await (const event of sourceEvents) events.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  await importLegacySQLiteFile(sqliteFile("linked-autosave.sqlite"), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });

  const importedSnapshot = events.find((event) => event.type === "snapshot").value;
  const importedSnapshotDevice = events.find((event) => event.type === "snapshotChunk").devices[0];
  const autosave = events.flatMap((event) => event.type === "records" && event.collection === "settings" ? event.records : [])
    .find(({ key }) => key === "legacyAutosave:main").value;
  assert.equal(autosave.state, autosaveState);
  assert.equal(autosave.snapshotId, importedSnapshot.id);
  assert.notEqual(importedSnapshot.id, "source-final-1");
  assert.deepEqual(
    [importedSnapshotDevice.vendorConfidence, importedSnapshotDevice.vendorSource, importedSnapshotDevice.modelConfidence, importedSnapshotDevice.modelSource],
    [0.91, "vendors.xlsx", 0.84, "models.xlsx"],
  );
});

test("legacy SQLite payload preserves custom field values under the stable imported column key", () => {
  const payload = legacyDevice({
    mac: "00:11:22:33:44:55",
    payload_json: JSON.stringify({
      custom_fields: { "[Пользовательская] Площадь": "210 м²" },
      customFieldSources: { "[Пользовательская] Площадь": "main.xlsx" },
    }),
  });
  const column = addCustomInventoryColumn(defaultInventoryColumnConfig(), "Площадь").columns.at(-1);
  assert.equal(inventoryCellText(payload, column.key), "210 м²");
  assert.deepEqual(payload.customFieldSources, { [column.key]: "main.xlsx" });

  const storedKey = customInventoryColumnKey("Площадь");
  const portablePayload = legacyDevice({
    mac: "00:11:22:33:44:56",
    payload_json: JSON.stringify({ customFields: { [storedKey]: "212 м²" }, customFieldSources: { [storedKey]: "smartroom.xlsx" } }),
  });
  assert.equal(portablePayload.customFields[storedKey], "212 м²");
  assert.equal(portablePayload.customFieldSources[storedKey], "smartroom.xlsx");
});

test("legacy SQLite devices preserve normalized alternate MAC identity aliases", () => {
  const device = legacyDevice({
    mac: "00-11-22-33-44-55",
    secondary_mac: "AA-BB-CC-DD-EE-FF",
    device_name: "Conf Room 101",
    payload_json: JSON.stringify({
      alternateMacs: "aabb.ccdd.eeff,00:11:22:33:44:55,not-a-mac",
      physicalAddress: "West Wing",
      businessUnit: "Operations",
      city: "Moscow",
      site: "HQ",
      floor: "10",
      possibleIps: ["192.0.2.10", "invalid", "192.0.2.10"],
      vendorConfidence: 0.96,
      vendorSource: "legacy.sqlite:oui_vendor_history",
      modelConfidence: "0.88",
      modelSource: "legacy.sqlite:mac5_model_history",
      sources: ["Main.xlsx", "SmartRoom.xlsx", "Main.xlsx"],
      fieldSources: { room: "SmartRoom.xlsx", ip: "DDIO.xlsx" },
      conflicts: [{ field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" }],
    }),
  });
  assert.deepEqual(device.alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
  assert.equal(device.alternateMacsTruncated, undefined);
  assert.equal(device.deviceName, "Conf Room 101");
  assert.equal(device.physicalAddress, "West Wing");
  assert.deepEqual([device.businessUnit, device.city, device.site, device.floor], ["Operations", "Moscow", "HQ", "10"]);
  assert.deepEqual(device.possibleIps, ["192.0.2.10"]);
  assert.deepEqual(
    [device.vendorConfidence, device.vendorSource, device.modelConfidence, device.modelSource],
    [0.96, "legacy.sqlite:oui_vendor_history", 0.88, "legacy.sqlite:mac5_model_history"],
  );
  assert.deepEqual(device.sources, ["Main.xlsx", "SmartRoom.xlsx"]);
  assert.deepEqual(device.fieldSources, { room: "SmartRoom.xlsx", ip: "DDIO.xlsx" });
  assert.deepEqual(device.conflicts, [{ field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" }]);

  const stringConflicts = legacyDevice({ mac: "00:11:22:33:44:55", conflicts_json: '[{"field":"ip","oldValue":"192.0.2.1"}]' });
  assert.deepEqual(stringConflicts.conflicts, [{ field: "ip", oldValue: "192.0.2.1" }]);

  const secondaryOnly = legacyDevice({ secondary_mac: "12:34:56:78:9A:BC" });
  assert.equal(secondaryOnly.mac, "12:34:56:78:9A:BC");
  assert.deepEqual(secondaryOnly.alternateMacs, []);

  const boundedConfidence = legacyDevice({
    mac: "00:11:22:33:44:56",
    payload_json: JSON.stringify({ vendor_confidence: 1.2, modelConfidence: -0.2 }),
  });
  assert.deepEqual([boundedConfidence.vendorConfidence, boundedConfidence.modelConfidence], [1, 0]);
});

test("legacy SQLite identity prepass keeps only fields required for strong matching", () => {
  const device = legacyDevice({
    internal_device_id: "asset-slim-1",
    mac: "00:11:22:33:44:55",
    device_id: "device-slim-1",
    serial_number: "serial-slim-1",
    secondary_mac: "AA:BB:CC:DD:EE:FF",
    payload_json: JSON.stringify({ manufacturer: "Large vendor value", model: "Large model value", room: "Room 12" }),
  }, "", { identityOnly: true });

  assert.deepEqual(device, {
    id: "asset-slim-1",
    internalDeviceId: "asset-slim-1",
    deviceId: "device-slim-1",
    serial: "serial-slim-1",
    mac: "00:11:22:33:44:55",
    alternateMacs: ["AA:BB:CC:DD:EE:FF"],
  });
});

test("legacy resolved inventory preserves device identity and location fields through IndexedDB import", async () => {
  const columns = ["internal_device_id", "mac", "payload_json", "first_seen", "updated_at", "seen_count"].map((name) => ({ name }));
  const sourceRow = {
    internal_device_id: "asset-flow-42",
    mac: "00:11:22:33:44:55",
    payload_json: JSON.stringify({
      secondary_mac: "AA:BB:CC:DD:EE:FF",
      deviceName: "Conf Room 101",
      physicalAddress: "West Wing",
      businessUnit: "Operations",
      city: "Moscow",
      site: "HQ",
      floor: "10",
      possibleIps: ["192.0.2.10", "invalid"],
      vendor_confidence: 0.96,
      vendor_source: "legacy.sqlite:oui_vendor_history",
      modelConfidence: 0.88,
      model_source: "legacy.sqlite:mac5_model_history",
      sources: ["Main.xlsx", "SmartRoom.xlsx"],
      fieldSources: { room: "SmartRoom.xlsx", ip: "DDIO.xlsx" },
      conflicts: [{ field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" }],
      customFields: { [customInventoryColumnKey("Площадь")]: "210 м²" },
      customFieldSources: { [customInventoryColumnKey("Площадь")]: "Main.xlsx" },
    }),
    first_seen: "2026-10-15T09:00:00Z",
    updated_at: "2026-10-18T09:00:00Z",
    seen_count: 4,
  };
  const runtime = fakeRuntime({ tables: ["resolved_device_inventory"] });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "resolved_device_inventory" }];
      if (sql.includes('table_info("resolved_device_inventory")')) return columns;
      throw new Error(`Unexpected SQL in resolved inventory import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "resolved_device_inventory"') yield sourceRow;
  };

  const databaseName = `sqlite-resolved-inventory-flow-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    const { rows } = await database.inventoryPage({ limit: 10 });
    assert.equal(report.imported.inventory, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "asset-flow-42");
    assert.deepEqual(rows[0].alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
    assert.equal(rows[0].deviceName, "Conf Room 101");
    assert.equal(rows[0].physicalAddress, "West Wing");
    assert.deepEqual([rows[0].businessUnit, rows[0].city, rows[0].site, rows[0].floor], ["Operations", "Moscow", "HQ", "10"]);
    assert.deepEqual(rows[0].possibleIps, ["192.0.2.10"]);
    assert.deepEqual(
      [rows[0].vendorConfidence, rows[0].vendorSource, rows[0].modelConfidence, rows[0].modelSource],
      [0.96, "legacy.sqlite:oui_vendor_history", 0.88, "legacy.sqlite:mac5_model_history"],
    );
    assert.deepEqual(rows[0].sources, ["Main.xlsx", "SmartRoom.xlsx"]);
    assert.deepEqual(rows[0].fieldSources, { room: "SmartRoom.xlsx", ip: "DDIO.xlsx" });
    assert.deepEqual(rows[0].conflicts, [{ field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" }]);
    const areaKey = customInventoryColumnKey("Площадь");
    assert.equal(rows[0].customFields[areaKey], "210 м²");
    assert.equal(rows[0].customFieldSources[areaKey], "Main.xlsx");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

test("legacy SQLite inventory tables reconcile strong identity duplicates and report conflicts", async () => {
  const tables = ["device_inventory", "resolved_device_inventory"];
  const resolvedPayloadJson = JSON.stringify({ room: "Room 42" });
  const rowsByTable = {
    device_inventory: [{ mac: "00:11:22:33:44:55", device_id: "device-42", serial_number: "serial-42", vendor: "Legacy Vendor", ip: "10.0.0.42" }],
    resolved_device_inventory: [{
      internal_device_id: "asset-42", mac: "00:11:22:33:44:55", device_id: "device-42", serial_number: "serial-42",
      payload_json: resolvedPayloadJson,
    }],
  };
  assert.equal(legacyDevice(rowsByTable.device_inventory[0]).ip, "10.0.0.42");
  const runtime = fakeRuntime({ tables, rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
      if (sql === 'SELECT COUNT(*) AS count FROM "resolved_device_inventory"') return [{ count: rowsByTable.resolved_device_inventory.length }];
      if (sql.includes('table_info("resolved_device_inventory")')) return ["internal_device_id", "payload_json"].map((name) => ({ name }));
      if (sql.includes('table_info("device_inventory")')) return [{ name: "mac" }];
      throw new Error(`Unexpected SQL in strong identity reconciliation test: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    const match = sql.match(/^SELECT \* FROM "(device_inventory|resolved_device_inventory)"$/);
    if (match) yield* rowsByTable[match[1]];
  };
  const databaseName = `sqlite-inventory-identity-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  let resolvedPayloadParseCount = 0;
  const originalJsonParse = JSON.parse;
  try {
    JSON.parse = function trackedJsonParse(value, ...args) {
      if (value === resolvedPayloadJson) resolvedPayloadParseCount += 1;
      return originalJsonParse.call(this, value, ...args);
    };
    report = await importLegacySQLiteFile(sqliteFile("inventory-identity.sqlite"), database, {
      runtime,
      wasmUrl: "data:application/wasm;base64,AA==",
    });
    JSON.parse = originalJsonParse;
    assert.equal(report.imported.inventory, 2);
    const { rows } = await database.inventoryPage({ limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "asset-42");
    assert.deepEqual([rows[0].ip, rows[0].room], ["10.0.0.42", "Room 42"], JSON.stringify(rows[0]));
    assert.deepEqual(report.identityReconciliation, { linked: 1, ambiguous: 0, conflicts: 0 });
    assert.equal(resolvedPayloadParseCount, 2, "the payload is parsed once in each source pass, without a duplicate parse during identity indexing");
  } finally {
    JSON.parse = originalJsonParse;
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }

  const conflictingRuntime = fakeRuntime({ tables, rows: [] });
  const conflictingInit = conflictingRuntime.initSQLite;
  conflictingRuntime.initSQLite = async (...args) => {
    const sqlite = await conflictingInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
      if (sql === 'SELECT COUNT(*) AS count FROM "resolved_device_inventory"') return [{ count: 1 }];
      if (sql.includes('table_info("resolved_device_inventory")')) return ["internal_device_id", "payload_json"].map((name) => ({ name }));
      if (sql.includes('table_info("device_inventory")')) return [{ name: "mac" }];
      throw new Error(`Unexpected SQL in conflicting identity test: ${sql}`);
    };
    return sqlite;
  };
  conflictingRuntime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "device_inventory"') yield { mac: "00:11:22:33:44:55", device_id: "device-old" };
    if (sql === 'SELECT * FROM "resolved_device_inventory"') yield {
      internal_device_id: "asset-new", mac: "00:11:22:33:44:55", device_id: "device-new", payload_json: "{}",
    };
  };
  const conflictingImported = [];
  const conflictingDatabase = {
    async importArchiveEvents(_header, events) {
      for await (const event of events) if (event.type === "records" && event.collection === "inventory") conflictingImported.push(...event.records);
    },
    async recordLegacySqliteImportSource() {},
  };
  const conflictingReport = await importLegacySQLiteFile(sqliteFile("inventory-conflict.sqlite"), conflictingDatabase, {
    runtime: conflictingRuntime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });
  assert.equal(conflictingImported.length, 2);
  assert.notEqual(conflictingImported[0].id, conflictingImported[1].id);
  assert.deepEqual(conflictingReport.identityReconciliation, { linked: 0, ambiguous: 0, conflicts: 1 });

  const ambiguousRuntime = fakeRuntime({ tables, rows: [] });
  const ambiguousInit = ambiguousRuntime.initSQLite;
  ambiguousRuntime.initSQLite = async (...args) => {
    const sqlite = await ambiguousInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return tables.map((name) => ({ name }));
      if (sql === 'SELECT COUNT(*) AS count FROM "resolved_device_inventory"') return [{ count: 2 }];
      if (sql.includes('table_info("resolved_device_inventory")')) return ["internal_device_id", "payload_json"].map((name) => ({ name }));
      if (sql.includes('table_info("device_inventory")')) return [{ name: "mac" }];
      throw new Error(`Unexpected SQL in ambiguous identity test: ${sql}`);
    };
    return sqlite;
  };
  ambiguousRuntime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "device_inventory"') yield { mac: "00:11:22:33:44:55" };
    if (sql === 'SELECT * FROM "resolved_device_inventory"') {
      yield { internal_device_id: "asset-a", mac: "00:11:22:33:44:55", payload_json: "{}" };
      yield { internal_device_id: "asset-b", mac: "00:11:22:33:44:55", payload_json: "{}" };
    }
  };
  const ambiguousImported = [];
  const ambiguousDatabase = {
    async importArchiveEvents(_header, events) {
      for await (const event of events) if (event.type === "records" && event.collection === "inventory") ambiguousImported.push(...event.records);
    },
    async recordLegacySqliteImportSource() {},
  };
  const ambiguousReport = await importLegacySQLiteFile(sqliteFile("inventory-ambiguous.sqlite"), ambiguousDatabase, {
    runtime: ambiguousRuntime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });
  assert.equal(ambiguousImported.length, 3);
  assert.deepEqual(ambiguousReport.identityReconciliation, { linked: 0, ambiguous: 1, conflicts: 0 });
});

function sqliteFile(name = "legacy.sqlite") {
  const bytes = new Uint8Array(144);
  bytes.set(new globalThis.TextEncoder().encode("SQLite format 3\0"));
  bytes[18] = bytes[19] = 1;
  return new globalThis.File([bytes], name);
}

test("SQLite file selection requires one database and only its matching WAL sidecar", () => {
  const database = new globalThis.File(["db"], "source.db");
  const wal = new globalThis.File([], "source.db-wal");
  assert.deepEqual(resolveLegacySQLiteFileSelection([database]), { file: database, walFile: null });
  assert.deepEqual(resolveLegacySQLiteFileSelection([wal, database]), { file: database, walFile: wal });
  assert.throws(() => resolveLegacySQLiteFileSelection([database, new globalThis.File([], "other.db-wal")]), /только source.db/);
  assert.throws(() => resolveLegacySQLiteFileSelection([database, new globalThis.File([], "other.db")]), /один основной/);
});

test("WAL SQLite import requires a matching sidecar and rejects it for a non-WAL database", async () => {
  const bytes = new Uint8Array(await sqliteFile("source.db").arrayBuffer());
  bytes[18] = bytes[19] = 2;
  const walDatabase = new globalThis.File([bytes], "source.db");
  await assert.rejects(importLegacySQLiteFile(walDatabase, {}, {}), /выберите вместе с ней файл source.db-wal/);
  const regularDatabase = sqliteFile("plain.db");
  await assert.rejects(importLegacySQLiteFile(regularDatabase, {}, { walFile: new globalThis.File(["invalid"], "plain.db-wal") }), /WAL-файл выбран для базы/);
});

test("legacy SQLite import checkpoints a valid WAL into a disposable copy", async () => {
  const databaseBytes = gunzipSync(globalThis.Buffer.from("H4sIAAAAAAAACgsO9MksSVVIyy/KTSxRMGYQYGBiYnBQUGBgYGCEYkoAI4Pe1NO8IJYAhSaNglEwCkbBKBgFo2AUjIJRMApGwSgYBaOAbAAA6rNNQgAQAAA=", "base64"));
  const walBytes = gunzipSync(globalThis.Buffer.from("H4sIAAAAAAAACu3YP0vDQBgG8DdX7SBKilLrIOUGixbURdRNrJJBiIL1BhexVzw1NtGSnIKT4Ojkomv3ri5+AHFxUr+BSIeOzg5y0kB0UXAQ9PnBwXt/Xrj1fWZP0qc08TRElCFjZuP6NXyeG7xvVJYat8MVIrKS59OP7vnyWf5qbdX1tOLbB2EgNZ+iDDFG85wTEeusmOnv+rT/CqPJi7s+89hukt38RgcAAAAAAADAvyasdK5QsAItq76S9fpmpLT29neiZM0Wy05JOFyUFlyHJ2/4WE0dc+Gsi3F+JP1D9V4X4zk/zgUeRnR5b7R/xczsnSgBAAAAAAAAAP6uD7lAd7t4Q/nLtskFmN0i+8Vu/fYHAQAAAAAAAOAnelgqOxB5Wvmy2mulclm9qwK1JcPaGz6DBStoMAAA", "base64"));
  const destinationName = `sqlite-wal-import-${crypto.randomUUID()}`;
  const database = new Database(destinationName);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (_name, _options, callback) => callback({ name: "test-lock" }) } },
  });
  const restoreTransaction = shimFakeIndexedDbTransactionNames();
  try {
    assert.ok(walBytes.length > 32, "fixture contains committed data not checkpointed into the main SQLite file");
    const originalDatabase = new Uint8Array(databaseBytes);
    const originalWal = new Uint8Array(walBytes);
    const wasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm", import.meta.url));
    const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
    const runtime = { initSQLite, iterator, withExistDB, useIdbStorage: async (name, options) => useIdbStorage(name, options) };
    const imported = [];
    const target = {
      async importArchiveEvents(_header, events) { for await (const event of events) if (event.type === "records" && event.collection === "settings") imported.push(...event.records); },
      async recordLegacySqliteImportSource() {},
    };
    const report = await importLegacySQLiteFile(
      new globalThis.File([databaseBytes], "legacy.sqlite"),
      target,
      { runtime, wasmUrl, walFile: new globalThis.File([walBytes], "legacy.sqlite-wal") },
    );
    assert.equal(report.integrity, "ok");
    assert.ok(imported.some((record) => record.key === "legacyAppSetting:theme" && record.value === "dark"));
    assert.ok(imported.some((record) => record.key === "legacyAppSetting:site" && record.value === "lab"));
    assert.notEqual(report.sourceNamespace, (await sha256File(new globalThis.File([databaseBytes], "legacy.sqlite"))).slice(0, 24), "the WAL participates in source identity");
    assert.equal(report.walBytes, walBytes.byteLength);
    assert.deepEqual(new Uint8Array(databaseBytes), originalDatabase);
    assert.deepEqual(new Uint8Array(walBytes), originalWal);

    const corruptedWal = new Uint8Array(walBytes);
    corruptedWal[corruptedWal.length - 1] ^= 1;
    await assert.rejects(importLegacySQLiteFile(
      new globalThis.File([databaseBytes], "legacy.sqlite"),
      { async importArchiveEvents() { assert.fail("invalid WAL must fail before archive restoration"); }, async recordLegacySqliteImportSource() {} },
      { runtime, wasmUrl, walFile: new globalThis.File([corruptedWal], "legacy.sqlite-wal") },
    ), /Контрольная сумма WAL не совпадает/);
  } finally {
    database.connection?.close();
    database.connection = null;
    restoreTransaction();
    await deleteTestIndexedDatabase(destinationName);
  }
});

test("SQLite source connection and VFS close as soon as event staging finishes", async () => {
  const runtime = fakeRuntime();
  const databaseName = `sqlite-source-release-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  const restore = database.restoreLocalArchive.bind(database);
  const deletedSourceDatabases = [];
  let restoreCalled = false;
  database.restoreLocalArchive = async (...args) => {
    assert.deepEqual(runtime.closeState, { sqliteClosed: true, vfsClosed: true });
    assert.equal(deletedSourceDatabases.length, 1, "the unused VFS copy is deleted before destination restore");
    restoreCalled = true;
    return restore(...args);
  };
  try {
    await importLegacySQLiteFile(sqliteFile(), database, {
      runtime,
      wasmUrl: "data:application/wasm;base64,AA==",
      deleteTemporaryDatabase: async (name) => { deletedSourceDatabases.push(name); },
    });
    assert.equal(restoreCalled, true);
    assert.equal(deletedSourceDatabases.length, 1, "early cleanup prevents a duplicate final deletion");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
  }
});

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
        if (sql.includes('table_info("app_logs")')) return [{ name: "id" }, { name: "action" }, { name: "created_at" }, { name: "details" }];
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
      close: async () => { closeState.sqliteClosed = true; },
      vfs: { close: () => { closeState.vfsClosed = true; } },
    }),
    iterator: async function* (_sqlite, sql) {
      if (sql === 'SELECT * FROM "app_settings"') yield* rows;
      if (sql === 'SELECT "id", "action", "created_at" FROM "app_logs"') yield* rows;
    },
  };
}

test("SQLite page import stream emits the parser header before all pages and repairs an unknown page count", async () => {
  for (const declaredPageCount of [2, 0]) {
    const source = new Uint8Array(1024);
    source.set(new globalThis.TextEncoder().encode("SQLite format 3\0"));
    for (let index = 16; index < source.length; index += 1) source[index] = index % 251;
    const view = new DataView(source.buffer);
    view.setUint16(16, 512, false);
    view.setUint32(28, declaredPageCount, false);
    const file = {
      size: source.byteLength,
      slice(start, end) { return { arrayBuffer: async () => source.slice(start, end).buffer }; },
    };
    const chunks = [];
    let sourceDigest = "";
    const progress = [];
    for await (const chunk of createSQLitePageImportStream(file, {
      onSourceDigest: (digest) => { sourceDigest = digest; },
      onProgress: (value) => progress.push(value),
    })) chunks.push(chunk);
    const copied = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      copied.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const expectedHeader = source.slice(0, 32);
    if (declaredPageCount === 0) new DataView(expectedHeader.buffer).setUint32(28, 2, false);
    const expected = new Uint8Array(expectedHeader.byteLength + source.byteLength);
    expected.set(expectedHeader);
    expected.set(source, expectedHeader.byteLength);
    assert.deepEqual(copied, expected);
    assert.equal(copied.byteLength, source.byteLength + 32);
    assert.equal(sourceDigest, await sha256File(file));
    assert.deepEqual(progress, [{ bytesRead: 1024, totalBytes: 1024 }]);
  }
});

test("SQLite page import stream batches progress while hashing each page", async () => {
  const pageSize = 4096;
  const source = new Uint8Array(pageSize * 256);
  source.set(new globalThis.TextEncoder().encode("SQLite format 3\0"));
  for (let index = 16; index < source.length; index += 1) source[index] = index % 251;
  const view = new DataView(source.buffer);
  view.setUint16(16, pageSize, false);
  view.setUint32(28, 256, false);
  const file = {
    size: source.byteLength,
    slice(start, end) { return { arrayBuffer: async () => source.slice(start, end).buffer }; },
  };
  const progress = [];
  let pagesRead = 0;
  let headerRead = false;
  for await (const page of createSQLitePageImportStream(file, { onProgress: (value) => progress.push(value) })) {
    if (!headerRead) {
      assert.equal(page.byteLength, 32, "the parser header precedes copied pages");
      headerRead = true;
      continue;
    }
    assert.equal(page.byteLength, pageSize);
    if (page.byteLength === pageSize) pagesRead += 1;
  }
  assert.equal(pagesRead, 256);
  assert.deepEqual(progress, [
    { bytesRead: 256 * 1024, totalBytes: source.byteLength },
    { bytesRead: 512 * 1024, totalBytes: source.byteLength },
    { bytesRead: 768 * 1024, totalBytes: source.byteLength },
    { bytesRead: source.byteLength, totalBytes: source.byteLength },
  ]);
});

test("cancelling a legacy SQLite import stops page reads and deletes its temporary database", async () => {
  const sourceBytes = new Uint8Array(1024);
  sourceBytes.set(new globalThis.TextEncoder().encode("SQLite format 3\0"));
  sourceBytes[18] = sourceBytes[19] = 1;
  new DataView(sourceBytes.buffer).setUint16(16, 512, false);
  new DataView(sourceBytes.buffer).setUint32(28, 2, false);
  const controller = new globalThis.AbortController();
  let hashingComplete = false;
  let copyPageReads = 0;
  const file = {
    name: "cancellable.sqlite",
    size: sourceBytes.byteLength,
    slice(start, end) {
      return { arrayBuffer: async () => {
        const chunk = sourceBytes.slice(start, end);
        if (hashingComplete && !(start === 0 && end === 32)) {
          copyPageReads += 1;
          if (copyPageReads === 1) controller.abort();
        }
        return chunk.buffer;
      } };
    },
  };
  const runtime = fakeRuntime();
  runtime.withExistDB = (stream, options) => ({ ...options, stream });
  runtime.initSQLite = async ({ stream }) => {
    const reader = stream.getReader();
    assert.equal((await reader.read()).value.byteLength, 32);
    await assert.rejects(reader.read(), { name: "AbortError" });
    throw new globalThis.DOMException("Импорт SQLite отменён", "AbortError");
  };
  const deleted = [];

  await assert.rejects(importLegacySQLiteFile(file, {}, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.stage === "copying" && progress.bytesRead === undefined) hashingComplete = true;
    },
    deleteTemporaryDatabase: async (name) => { deleted.push(name); },
  }), { name: "AbortError" });

  assert.equal(copyPageReads, 1, "no SQLite page is read after cancellation");
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^mac-analyzer-[0-9a-f-]{36}\.db$/i);
});

test("legacy SQLite vendor history maps 1,001,099 observations in fixed batches", async () => {
  const rowCount = 1_001_099;
  const runtime = fakeRuntime({ tables: ["vendor_model_history"], rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    const baseRun = sqlite.run;
    sqlite.run = async (sql) => {
      if (sql.includes('table_info("vendor_model_history")')) return [{ name: "mac" }, { name: "observed_at" }];
      return baseRun(sql);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql !== 'SELECT * FROM "vendor_model_history"') return;
    for (let index = 0; index < rowCount; index += 1) {
      yield { id: index, mac: "02:00:00:00:00:01", vendor: "Legacy vendor", model: "Legacy model", observed_at: "2026-10-22T00:00:00Z" };
    }
  };
  const streamed = { total: 0, maxBatch: 0, batches: 0 };
  const database = {
    async importArchiveEvents(_header, events) {
      for await (const event of events) {
        if (event.type !== "records" || event.collection !== "legacyObservations") continue;
        streamed.total += event.records.length;
        streamed.maxBatch = Math.max(streamed.maxBatch, event.records.length);
        streamed.batches += 1;
      }
    },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile(), database, {
    runtime,
    wasmUrl: "data:application/wasm;base64,AA==",
  });

  assert.equal(report.imported.legacyObservations, rowCount);
  assert.deepEqual(report.skippedRows, {});
  assert.equal(streamed.total, rowCount);
  assert.equal(streamed.batches, Math.ceil(rowCount / 500));
  assert.ok(streamed.maxBatch <= 500);
});

test("100,000 legacy SQLite settings commit through bounded IndexedDB pages", async () => {
  const rowCount = 100_000;
  const databaseName = `mac-analyzer-pro-next-test-sqlite-large-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  const runtime = fakeRuntime({ rows: [] });
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql !== 'SELECT * FROM "app_settings"') return;
    for (let index = 0; index < rowCount; index += 1) {
      yield { key: `setting_${index}`, value: JSON.stringify({ index, enabled: index % 2 === 0 }) };
    }
  };
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, {
      runtime,
      wasmUrl: "data:application/wasm;base64,AA==",
    });
    assert.equal(report.imported.settings, rowCount);
    assert.deepEqual(report.skippedRows, {});
    assert.deepEqual(report.skippedTables, []);
    assert.deepEqual(await database.getSetting("legacyAppSetting:setting_0"), { index: 0, enabled: true });
    assert.deepEqual(await database.getSetting(`legacyAppSetting:setting_${rowCount - 1}`), {
      index: rowCount - 1,
      enabled: false,
    });
    const tx = database.connection.transaction("settings", "readonly");
    const count = tx.objectStore("settings").count();
    assert.equal(await new Promise((resolve, reject) => {
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
    }), rowCount + 1, "the current active-snapshot pointer is retained with all imported settings");
    assert.equal(await database.getSetting("activeSnapshotId"), "");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

test("large resolved SQLite inventory imports end to end through bounded IndexedDB pages", async () => {
  const rowCount = 2_005;
  const databaseName = `mac-analyzer-pro-next-test-sqlite-inventory-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  const columns = LEGACY_SQLITE_TABLE_REQUIREMENTS.resolved_device_inventory.map((name) => ({ name }));
  const runtime = fakeRuntime({ tables: ["resolved_device_inventory"], rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    const baseRun = sqlite.run;
    sqlite.run = async (sql) => {
      if (sql.includes('table_info("resolved_device_inventory")')) return columns;
      return baseRun(sql);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql !== 'SELECT * FROM "resolved_device_inventory"') return;
    for (let index = 0; index < rowCount; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      yield {
        internal_device_id: `asset-${String(index).padStart(5, "0")}`,
        payload_json: JSON.stringify({
          mac: `02:00:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}`,
          manufacturer: `Vendor ${index % 7}`,
          model: `Model ${index % 11}`,
        }),
      };
    }
  };
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    assert.equal(report.integrity, "ok");
    assert.equal(report.imported.inventory, rowCount);
    assert.deepEqual(report.skippedRows, {});
    assert.deepEqual(report.skippedTables, []);
    const firstPage = await database.inventoryPage({ limit: 2_000 });
    const lastPage = await database.inventoryPage({ afterId: firstPage.nextCursor, limit: 10 });
    assert.equal(firstPage.rows.length, 2_000);
    assert.equal(firstPage.hasMore, true);
    assert.equal(lastPage.rows.length, 5);
    assert.equal(lastPage.hasMore, false);
    assert.equal(firstPage.rows[0].id, "asset-00000");
    assert.equal(lastPage.rows.at(-1).id, "asset-02004");
    assert.equal(lastPage.rows.at(-1).manufacturer, "Vendor 2");
    const tx = database.connection.transaction("inventory", "readonly");
    const count = tx.objectStore("inventory").count();
    assert.equal(await new Promise((resolve, reject) => {
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
    }), rowCount);
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

test("multi-page SQLite MAC history imports end to end into IndexedDB", async () => {
  const rowCount = 501;
  const databaseName = `mac-analyzer-pro-next-test-sqlite-history-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  const columns = LEGACY_SQLITE_TABLE_REQUIREMENTS.mac_history.map((name) => ({ name }));
  const runtime = fakeRuntime({ tables: ["mac_history"], rows: [] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    const baseRun = sqlite.run;
    sqlite.run = async (sql) => {
      if (sql.includes('table_info("mac_history")')) return columns;
      return baseRun(sql);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql !== 'SELECT * FROM "mac_history"') return;
    for (let index = 0; index < rowCount; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      yield {
        id: index + 1,
        mac: `02:01:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}`,
        vendor: `Vendor ${index % 13}`,
        recorded_at: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      };
    }
  };
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    assert.equal(report.integrity, "ok");
    assert.equal(report.imported.legacyObservations, rowCount);
    assert.deepEqual(report.skippedRows, {});
    assert.deepEqual(report.skippedTables, []);
    let cursor = null;
    let observed = 0;
    let first = null;
    let last = null;
    do {
      const page = await database.legacyObservationPage({ kind: "mac_history", cursor, limit: 500 });
      if (!first && page.rows.length) first = page.rows[0];
      if (page.rows.length) last = page.rows.at(-1);
      observed += page.rows.length;
      cursor = page.nextCursor;
      assert.equal(page.rows.length <= 500, true);
      assert.equal(page.hasMore, Boolean(cursor));
    } while (cursor);
    assert.equal(observed, rowCount);
    assert.equal(first.payload.id, rowCount);
    assert.equal(last.payload.id, 1);
    assert.equal(last.payload.vendor, "Vendor 0");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
});

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
      assert.deepEqual(Object.keys(options).sort(), ["allowDuplicateInventoryIds", "onProgress", "preserveActiveSnapshot"]);
      assert.equal(typeof options.onProgress, "function");
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
    const source = new Uint8Array(await seed.dump());
    source[18] = source[19] = 2;
    const file = new globalThis.File([source], "real-small.sqlite");
    const walFile = new globalThis.File([], "real-small.sqlite-wal");
    const sourceNamespace = (await sha256File(file)).slice(0, 24);
    let requestedBytes = 0;
    const trackedFile = {
      name: file.name,
      size: file.size,
      slice(start, end) {
        requestedBytes += end - start;
        return file.slice(start, end);
      },
    };
    const runtime = {
      initSQLite,
      iterator,
      withExistDB,
      useIdbStorage: async (_name, options) => ({ ...await useMemoryStorage(options), path: "legacy.sqlite" }),
    };
    const report = await importLegacySQLiteFile(trackedFile, database, { runtime, wasmUrl, walFile });
    assert.equal(report.integrity, "ok");
    assert.equal(report.sourceNamespace, sourceNamespace);
    assert.equal(requestedBytes, file.size + 50, "reads the database pages once, plus the 16-byte signature, 2-byte journal mode, and 32-byte parser header");
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

test("optional-host SQLite schema exports import supported settings, devices, and snapshots into Next", async () => {
  const wasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite.wasm", import.meta.url));
  const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
  const optionalStoreSource = await readFile(new globalThis.URL("../backend/services/system/sqlite_store.py", import.meta.url), "utf8");
  const tableBlock = optionalStoreSource.match(/^TABLES\s*=\s*\(([\s\S]*?)^\)/m)?.[1];
  assert.ok(tableBlock, "optional host table declarations should be discoverable");
  const statements = Array.from(tableBlock.matchAll(/\"\"\"([\s\S]*?)\"\"\"/g), ([, sql]) => sql);
  assert.equal(statements.length, 23);

  const sourceStorage = await useMemoryStorage({ url: wasmUrl });
  const seed = await initSQLite({ ...sourceStorage, path: "optional-host-export.sqlite" });
  const databaseName = `optional-host-sqlite-import-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  let repeatedReport;
  const removedTemporaryDatabases = [];
  try {
    for (const statement of statements) await seed.run(statement);
    await seed.run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", ["theme", '"dark"', "2026-10-21T10:00:00Z"]);
    await seed.run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", ["enabled", "true", "2026-10-21T10:00:00Z"]);
    await seed.run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", ["limits", '{"batchSize":500}', "2026-10-21T10:00:00Z"]);
    await seed.run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", ["legacyLabel", "plain text", "2026-10-21T10:00:00Z"]);
    await seed.run(
      "INSERT INTO device_inventory (mac, mac_formatted, vendor, model, room, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["001122334455", "00:11:22:33:44:55", "Acme", "Conference unit", "101", "2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z"],
    );
    await seed.run(
      "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["snapshot-1", "portable final", "main.csv", 1, '[{"mac":"001122334455","room":"101"}]', "2026-10-21T10:00:00Z", "snapshot-signature"],
    );
    const file = new globalThis.File([await seed.dump()], "optional-host-export.db");
    const runtime = {
      initSQLite,
      iterator,
      withExistDB,
      useIdbStorage: async (_name, options) => ({ ...await useMemoryStorage(options), path: "optional-host-import.sqlite" }),
    };

    await database.setSetting("userPreference", { keep: true });
    await database.saveFinal({ id: "user-final", devices: [{ id: "user-device", mac: "AA:BB:CC:DD:EE:FF" }] });
    report = await importLegacySQLiteFile(file, database, {
      runtime, wasmUrl, deleteTemporaryDatabase: async (name) => { removedTemporaryDatabases.push(name); },
    });

    assert.equal(report.integrity, "ok");
    assert.ok(!report.tables.includes("resolved_device_identity_aliases"), "derived SQLite aliases are rebuilt from resolved Inventory, not imported as user data");
    assert.ok(!report.skippedTables.some(({ table }) => table === "resolved_device_identity_aliases"));
    assert.deepEqual(report.skippedTables.map(({ table }) => table), ["engineering_sessions", "notification_settings"]);
    assert.equal(await database.getSetting("legacyAppSetting:theme"), "dark");
    assert.equal(await database.getSetting("legacyAppSetting:enabled"), true);
    assert.deepEqual(await database.getSetting("legacyAppSetting:limits"), { batchSize: 500 });
    assert.equal(await database.getSetting("legacyAppSetting:legacyLabel"), "plain text");
    assert.deepEqual(await database.getSetting("userPreference"), { keep: true });
    const snapshots = await database.listSnapshots();
    const importedSnapshots = snapshots.filter(({ sourceKey }) => sourceKey === `sqlite:${report.sourceNamespace}:snapshot-1`);
    assert.equal(importedSnapshots.length, 1);
    assert.equal(importedSnapshots[0].name, "portable final");
    assert.equal(importedSnapshots[0].deviceCount, 1);
    const importedSnapshot = await database.loadSnapshot(importedSnapshots[0].id);
    assert.equal(importedSnapshot.devices[0].room, "101");
    assert.equal(await database.getSetting("activeSnapshotId"), "user-final");
    const beforeRepeatedImport = await database.inventoryPage({ limit: 100 });
    assert.ok(beforeRepeatedImport.rows.some(({ mac, manufacturer }) => mac === "00:11:22:33:44:55" && manufacturer === "Acme"));

    repeatedReport = await importLegacySQLiteFile(file, database, {
      runtime, wasmUrl, deleteTemporaryDatabase: async (name) => { removedTemporaryDatabases.push(name); },
    });

    assert.equal(report.sourceIdbName, "", "the source SQLite database is not retained when imported rows do not need it for queue-file recovery");
    assert.equal(removedTemporaryDatabases.length, 2, "each completed import removes its temporary SQLite copy");
    assert.equal(new Set(removedTemporaryDatabases).size, 2, "each import uses and removes a distinct temporary copy");
    assert.equal((await database.listSnapshots()).filter(({ sourceKey }) => sourceKey === `sqlite:${report.sourceNamespace}:snapshot-1`).length, 1);
    const afterRepeatedImport = await database.inventoryPage({ limit: 100 });
    assert.equal(afterRepeatedImport.total, beforeRepeatedImport.total);
    assert.ok(afterRepeatedImport.rows.some(({ id }) => id === "user-device"));
    assert.equal(await database.getSetting("activeSnapshotId"), "user-final");
    assert.equal(repeatedReport.sourceNamespace, report.sourceNamespace);
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
    await deleteTestIndexedDatabase(repeatedReport?.sourceIdbName).catch(() => {});
    await seed.close();
  }
});

test("legacy SQLite import preserves safe app-log events and omits sensitive tables", async () => {
  const runtime = fakeRuntime({
    tables: ["app_settings", "notification_settings", "app_logs", "engineering_sessions", "future_table"],
    rows: [
      { id: 1, action: "Save final state", created_at: "2026-10-21T12:00:00Z", details: "MAC AA:BB:CC:DD:EE:FF" },
      { id: 2, action: "User supplied action", created_at: "2026-10-21T12:01:00Z", details: "secret token" },
    ],
  });
  const visitedTables = [];
  const staged = [];
  const iterator = runtime.iterator;
  runtime.iterator = async function* (sqlite, sql) {
    const table = sql.match(/FROM "([^"]+)"/)?.[1] || "";
    visitedTables.push(table);
    assert.doesNotMatch(sql, /details/i, "the importer must not select legacy log details");
    yield* iterator(sqlite, sql);
  };
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.deepEqual(report.tables, ["app_logs", "app_settings"]);
  assert.deepEqual(report.skippedTables.map(({ table }) => table), ["engineering_sessions", "future_table", "notification_settings"]);
  assert.match(report.skippedTables.find(({ table }) => table === "notification_settings").reason, /секреты уведомлений/);
  assert.match(report.skippedTables.find(({ table }) => table === "engineering_sessions").reason, /сессии не переносятся/);
  assert.match(report.skippedTables.find(({ table }) => table === "future_table").reason, /содержимое не импортировано/);
  assert.deepEqual(visitedTables, ["app_logs", "app_settings"]);
  const imported = staged.filter((event) => event.type === "records" && event.collection === "legacyObservations").flatMap((event) => event.records);
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map(({ kind, sourceTable, observedAt, payload }) => ({ kind, sourceTable, observedAt, payload })), [
    { kind: "app_logs", sourceTable: "app_logs", observedAt: "2026-10-21T12:00:00.000Z", payload: { action: "Save final state" } },
    { kind: "app_logs", sourceTable: "app_logs", observedAt: "2026-10-21T12:01:00.000Z", payload: { action: "Другое действие" } },
  ]);
  assert.equal(JSON.stringify(imported).includes("MAC AA:BB:CC:DD:EE:FF"), false);
  assert.equal(JSON.stringify(imported).includes("secret token"), false);
});

test("legacy SQLite import reports invalid rows per source table instead of dropping them silently", async () => {
  const runtime = fakeRuntime({
    rows: [
      { key: "theme", value: "dark" },
      { key: "", value: "unmapped setting" },
      { key: null, value: "another unmapped setting" },
    ],
  });
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });

  assert.equal(report.imported.settings, 1);
  assert.deepEqual(report.skippedRows, { app_settings: 2 });
  const settings = staged.filter((event) => event.type === "records" && event.collection === "settings")
    .flatMap((event) => event.records);
  assert.deepEqual(settings.map(({ key, value }) => ({ key, value })), [{ key: "legacyAppSetting:theme", value: "dark" }]);
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

test("legacy SQLite import opens a bounded temporary IndexedDB VFS path", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (_name, _options, callback) => callback({ name: "test-lock" }) } },
  });
  const restoreTransaction = shimFakeIndexedDbTransactionNames();
  const sourceWasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite.wasm", import.meta.url));
  const sourceStorage = await useMemoryStorage({ url: `data:application/wasm;base64,${sourceWasm.toString("base64")}` });
  const seed = await initSQLite({ ...sourceStorage, path: "legacy-idb-import-source.sqlite" });
  const destinationName = `legacy-idb-import-test-${crypto.randomUUID()}`;
  const database = new Database(destinationName);
  let report;
  try {
    await seed.run("CREATE TABLE app_settings (key TEXT, value TEXT)");
    await seed.run("INSERT INTO app_settings VALUES (?, ?)", ["theme", "dark"]);
    const databaseBytes = new Uint8Array(await seed.dump());
    databaseBytes[18] = databaseBytes[19] = 2;
    const file = new globalThis.File([databaseBytes], "legacy-idb-import.sqlite");
    const walFile = new globalThis.File([], "legacy-idb-import.sqlite-wal");
    const asyncWasm = await readFile(new globalThis.URL("../node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm", import.meta.url));
    const vfsNames = [];
    const runtime = {
      initSQLite,
      iterator,
      withExistDB,
      useIdbStorage: async (name, options) => {
        vfsNames.push(name);
        return useIdbStorage(name, options);
      },
    };

    report = await importLegacySQLiteFile(file, database, {
      runtime,
      wasmUrl: `data:application/wasm;base64,${asyncWasm.toString("base64")}`,
      walFile,
    });

    assert.equal(report.integrity, "ok");
    assert.equal(report.imported.settings, 1);
    assert.equal(report.sourceNamespace, (await sha256File(file)).slice(0, 24));
    assert.match(report.importId, /^[0-9a-f-]{36}$/i);
    assert.equal(vfsNames.length, 1);
    assert.ok(vfsNames[0].length <= 56, "leave room for SQLite journal suffixes within the VFS path limit");
  } finally {
    await seed.close();
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(destinationName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
    restoreTransaction();
  }
});

test("legacy SQLite importer validates, streams compatible records, and preserves the active Final", async () => {
  const runtime = fakeRuntime();
  const staged = [];
  let sourceRecord;
  const removedDatabases = [];
  const removedSourceNamespaces = [];
  const database = {
    async importArchiveEvents(header, events, options) {
      assert.deepEqual(header, { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 });
      assert.deepEqual(Object.keys(options).sort(), ["allowDuplicateInventoryIds", "onProgress", "preserveActiveSnapshot"]);
      assert.equal(typeof options.onProgress, "function");
      for await (const event of events) staged.push(event);
    },
    async recordLegacySqliteImportSource(record) { sourceRecord = record; },
    async removeLegacySqliteImportSource(namespace) { removedSourceNamespaces.push(namespace); return ""; },
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, {
    runtime, wasmUrl: "data:application/wasm;base64,AA==",
    deleteTemporaryDatabase: async (name) => { removedDatabases.push(name); },
  });
  assert.equal(report.integrity, "ok");
  assert.equal(report.imported.settings, 1);
  assert.match(report.sourceNamespace, /^[0-9a-f]{24}$/);
  assert.equal(staged[0].records[0].key, "legacyAppSetting:theme");
  assert.equal(sourceRecord, undefined, "settings-only imports must not retain or register the source SQLite file");
  assert.equal(report.sourceIdbName, "");
  assert.equal(removedDatabases.length, 1);
  assert.deepEqual(removedSourceNamespaces, [report.sourceNamespace]);
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

  const emptyDatabase = new Database(`sqlite-broken-autosave-empty-${crypto.randomUUID()}`);
  await importLegacySQLiteFile(sqliteFile("broken-autosave.sqlite"), emptyDatabase, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.equal(await emptyDatabase.activeSnapshot(), null);
  assert.deepEqual(await emptyDatabase.recoverActiveSnapshot(), { snapshotId: "", recovered: false, unavailable: false });
  assert.deepEqual(await emptyDatabase.listSnapshots(), []);
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
      if (sql.includes('table_info("oui_vendor_history")')) return ["oui_3byte", "vendor", "occurrences", "first_seen", "last_seen"].map((name) => ({ name }));
      if (sql.includes('table_info("mac5_model_history")')) return ["mac_5byte", "model", "occurrences", "first_seen", "last_seen"].map((name) => ({ name }));
      throw new Error(`Unexpected SQL in vendor/model history import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "oui_vendor_history"') yield { oui_3byte: "AA:BB:CC", vendor: "Legacy Vendor", occurrences: 17, first_seen: "2025-02-03T00:00:00Z", last_seen: "2026-02-03T00:00:00Z" };
    if (sql === 'SELECT * FROM "mac5_model_history"') yield { mac_5byte: "AA:BB:CC:DD:01", model: "Legacy Model", occurrences: 23, first_seen: "2025-03-04T00:00:00Z", last_seen: "2026-02-04T00:00:00Z" };
  };
  const database = new Database(`mac-analyzer-pro-next-test-sqlite-oui-mac5-${crypto.randomUUID()}`);

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const mac = "AA:BB:CC:DD:01:99";
  assert.deepEqual([...await database.ouiIndexForMacs([mac])], [["AABBCC", "Legacy Vendor"]]);
  assert.deepEqual([...await database.mac5ModelsForMacs([mac])], [["AABBCCDD01", "Legacy Model"]]);
  const importedOui = (await database.ouiPage({ query: "Legacy Vendor" })).rows[0];
  assert.deepEqual([importedOui.occurrences, importedOui.firstSeen, importedOui.lastSeen], [17, "2025-02-03T00:00:00.000Z", "2026-02-03T00:00:00.000Z"]);
  const importedModel = (await database.mac5ModelPage({ query: "Legacy Model" })).rows[0];
  assert.deepEqual([importedModel.occurrences, importedModel.firstSeen, importedModel.lastSeen], [23, "2025-03-04T00:00:00.000Z", "2026-02-04T00:00:00.000Z"]);
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

  const archive = await new globalThis.Response(database.exportArchiveStream()).json();
  const restoredName = `mac-analyzer-pro-next-test-sqlite-oui-mac5-restore-${crypto.randomUUID()}`;
  const restored = new Database(restoredName);
  try {
    await restored.importArchive(archive);
    const restoredOui = (await restored.ouiPage({ query: "Legacy Vendor" })).rows[0];
    const restoredModel = (await restored.mac5ModelPage({ query: "Legacy Model" })).rows[0];
    assert.deepEqual([restoredOui.occurrences, restoredOui.firstSeen, restoredOui.lastSeen], [17, "2025-02-03T00:00:00.000Z", "2026-02-03T00:00:00.000Z"]);
    assert.deepEqual([restoredModel.occurrences, restoredModel.firstSeen, restoredModel.lastSeen], [23, "2025-03-04T00:00:00.000Z", "2026-02-04T00:00:00.000Z"]);
  } finally {
    restored.connection?.close();
    restored.connection = null;
    await deleteTestIndexedDatabase(restoredName);
  }
});

test("legacy SQLite importer preserves column preferences for every safe view name", async () => {
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
  let preferenceQuery = "";
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql.includes('FROM "column_preferences"')) {
      preferenceQuery = sql;
      yield* [
        { view_name: "Inventory", columns_json: '{"columns":["vendor"]}' },
        { view_name: " Inventory ", columns_json: '{"columns":["macFormatted"]}' },
        { view_name: "Results", columns_json: '{"columns":["vendor"]}' },
        { view_name: "results", columns_json: '{"columns":["hostname"]}' },
        { view_name: "history", columns_json: '{"columns":["event"]}' },
        ...Array.from({ length: 22 }, (_, index) => ({ view_name: `view-${String(index).padStart(2, "0")}`, columns_json: "{}" })),
        { view_name: "x".repeat(161), columns_json: "{}" },
        { view_name: "large", columns_json: "x".repeat(256 * 1024 + 1) },
        { view_name: "binary", columns_json: new Uint8Array([123, 125]) },
      ];
    }
  };
  const staged = [];
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource() {},
  };

  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  assert.match(preferenceQuery, /length\(CAST\("view_name" AS BLOB\)\) <= 640/);
  assert.match(preferenceQuery, /length\(CAST\("columns_json" AS BLOB\)\) <= 1048576/);
  const settings = staged.filter((event) => event.type === "records" && event.collection === "settings").flatMap((event) => event.records);
  assert.equal(settings.length, 28);
  assert.ok(settings.some(({ key, value }) => key === "legacyColumnPreferences:results" && value === '{"columns":["hostname"]}'));
  assert.ok(settings.some(({ key, value }) => key === "legacyColumnPreferences:inventory" && value === '{"columns":["macFormatted"]}'));
  assert.ok(settings.some(({ key, value }) => key === "legacyColumnPreferences:source:0052006500730075006c00740073" && value.viewName === "Results" && value.columnsJson === '{"columns":["vendor"]}'));
  assert.ok(settings.some(({ key, value }) => key === "legacyColumnPreferences:source:0049006e00760065006e0074006f00720079" && value.viewName === "Inventory" && value.columnsJson === '{"columns":["vendor"]}'));
  assert.ok(settings.some(({ key, value }) => key === "legacyColumnPreferences:source:00200049006e00760065006e0074006f007200790020" && value.viewName === " Inventory "));
  assert.ok(settings.some(({ key }) => key === "legacyColumnPreferences:history"));
  assert.ok(settings.some(({ key }) => key === "legacyColumnPreferences:view-21"));
  assert.deepEqual(report.skippedTables, []);
  assert.equal(report.skippedRows.column_preferences, 3);
});

test("legacy SQLite column preferences persist in IndexedDB for round-trip restoration", async () => {
  const runtime = fakeRuntime({ tables: ["column_preferences"], rows: [] });
  const baseRun = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseRun(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "column_preferences" }];
      if (sql.includes('table_info("column_preferences")')) return [{ name: "view_name" }, { name: "columns_json" }];
      throw new Error(`Unexpected SQL in column preferences persistence test: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql.includes('FROM "column_preferences"')) yield* [
      { view_name: "history", columns_json: '{"columns":["event","source"]}' },
      { view_name: "Inventory", columns_json: '{"order":["macFormatted","vendor"],"visible":["macFormatted","vendor"],"widths":{"macFormatted":220,"vendor":260}}' },
      { view_name: "Results", columns_json: '{"columns":["vendor"]}' },
      { view_name: "results", columns_json: '{"columns":["hostname"]}' },
    ];
  };

  const databaseName = `sqlite-column-preferences-${crypto.randomUUID()}`;
  const database = new Database(databaseName);
  let report;
  try {
    report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    assert.equal(await database.getSetting("legacyColumnPreferences:history"), '{"columns":["event","source"]}');
    assert.equal(await database.getSetting("legacyColumnPreferences:results"), '{"columns":["hostname"]}');
    assert.deepEqual(await database.getSetting("legacyColumnPreferences:source:0052006500730075006c00740073"), {
      viewName: "Results",
      columnsJson: '{"columns":["vendor"]}',
    });
    const legacyInventory = await database.getSetting("legacyColumnPreferences:inventory");
    const inventoryConfig = inventoryColumnConfigFromLegacyPreferences(legacyInventory);
    assert.deepEqual(visibleInventoryColumns(inventoryConfig).map(({ key }) => key), ["rowNumber", "macFormatted", "manufacturer"]);
    assert.equal(inventoryConfig.columns.find(({ key }) => key === "macFormatted").width, 220);
    assert.equal(inventoryConfig.columns.find(({ key }) => key === "manufacturer").width, 260);
    assert.equal(report.imported.settings, 5);
    assert.deepEqual(report.skippedTables, []);
    const archive = await new globalThis.Response(database.exportArchiveStream()).json();
    assert.ok(archive.settings.some(({ key }) => key === "legacyColumnPreferences:history"));
    const restoredName = `sqlite-column-preferences-restored-${crypto.randomUUID()}`;
    const restored = new Database(restoredName);
    try {
      await restored.importArchive(archive);
      assert.equal(await restored.getSetting("legacyColumnPreferences:history"), '{"columns":["event","source"]}');
      assert.equal(await restored.getSetting("legacyColumnPreferences:results"), '{"columns":["hostname"]}');
      assert.deepEqual(await restored.getSetting("legacyColumnPreferences:source:0052006500730075006c00740073"), {
        viewName: "Results",
        columnsJson: '{"columns":["vendor"]}',
      });
      const restoredInventoryConfig = inventoryColumnConfigFromLegacyPreferences(await restored.getSetting("legacyColumnPreferences:inventory"));
      assert.deepEqual(visibleInventoryColumns(restoredInventoryConfig).map(({ key }) => key), ["rowNumber", "macFormatted", "manufacturer"]);
      assert.equal(restoredInventoryConfig.columns.find(({ key }) => key === "macFormatted").width, 220);
    } finally {
      restored.connection?.close();
      restored.connection = null;
      await deleteTestIndexedDatabase(restoredName);
    }
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(databaseName);
    await deleteTestIndexedDatabase(report?.sourceIdbName).catch(() => {});
  }
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

test("current PyQt mac_movements timestamp and source_file fields are preserved", () => {
  const event = legacyMovement({
    id: 23,
    mac: "00:11:22:33:44:55",
    field_name: "switch_port",
    from_value: "Gi1/0/1",
    to_value: "Gi1/0/2",
    timestamp: "2026-10-15T12:34:56Z",
    source_file: "Main-2026-10-15.xlsx",
  });
  assert.equal(event.timestamp, "2026-10-15T12:34:56.000Z");
  assert.equal(event.source, "Main-2026-10-15.xlsx");
  assert.equal(event.field, "switchPort");
});

test("current PyQt mac_movements row survives SQLite-to-IndexedDB import with source metadata", async () => {
  const row = {
    id: 23, mac: "00:11:22:33:44:55", field_name: "switch_port", from_value: "Gi1/0/1",
    to_value: "Gi1/0/2", timestamp: "2026-10-15T12:34:56Z", source_file: "Main-2026-10-15.xlsx",
  };
  const runtime = fakeRuntime({ tables: ["mac_movements"] });
  const baseInit = runtime.initSQLite;
  runtime.initSQLite = async (...args) => {
    const sqlite = await baseInit(...args);
    sqlite.run = async (sql) => {
      if (sql === "PRAGMA integrity_check") return [{ integrity_check: "ok" }];
      if (sql.includes("sqlite_master")) return [{ name: "mac_movements" }];
      if (sql.includes('table_info("mac_movements")')) return Object.keys(row).map((name) => ({ name }));
      throw new Error(`Unexpected SQL in current movement import: ${sql}`);
    };
    return sqlite;
  };
  runtime.iterator = async function* (_sqlite, sql) {
    if (sql === 'SELECT * FROM "mac_movements"') yield row;
  };
  const name = `mac-analyzer-pro-next-current-movement-${crypto.randomUUID()}`;
  const database = new Database(name);
  try {
    await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
    const archive = await new globalThis.Response(database.exportArchiveStream()).json();
    assert.equal(archive.history.length, 1);
    assert.equal(archive.history[0].timestamp, "2026-10-15T12:34:56.000Z");
    assert.equal(archive.history[0].source, "Main-2026-10-15.xlsx");
    assert.equal(archive.history[0].field, "switchPort");
  } finally {
    database.connection?.close();
    database.connection = null;
    await deleteTestIndexedDatabase(name);
  }
});

test("legacy observations retain each source schema and normalize identity without becoming change events", () => {
  const currentPyQtMacHistoryRow = {
    id: 3,
    mac: "00-11-22-33-44-55",
    mac_formatted: "00:11:22:33:44:55",
    oui_3byte: "001122",
    mac_5byte: "0011223344",
    timestamp: "2026-10-15T09:00:00Z",
    source_file: "Main-2026-10-15.xlsx",
    vendor: "Vendor",
    vendor_confidence: 0.97,
    vendor_source: "OUI",
    model: "Model",
    model_confidence: 0.91,
    model_source: "MAC5",
    ip: "192.0.2.8",
    address: "Floor 1",
    room: "Room 101",
    switch_ip: "192.0.2.1",
    switch_port: "Gi1/0/1",
    match_details: "exact MAC",
  };
  const macHistory = legacyObservation("mac_history", currentPyQtMacHistoryRow);
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
  assert.equal(macHistory.observedAt, "2026-10-15T09:00:00.000Z");
  assert.equal(macHistory.source, "Main-2026-10-15.xlsx");
  assert.deepEqual(macHistory.payload, currentPyQtMacHistoryRow, "all 19 columns in the current PyQt mac_history schema remain available in the imported observation");
  assert.equal(macHistory.payload.switch_ip, "192.0.2.1");
  const currentMacHistory = legacyObservation("mac_history", {
    id: 6, mac: "00:11:22:33:44:88", vendor: "Vendor", timestamp: "2026-10-15T12:00:00Z",
    source_file: "Main-current.xlsx",
  });
  assert.equal(currentMacHistory.observedAt, "2026-10-15T12:00:00.000Z");
  assert.equal(currentMacHistory.source, "Main-current.xlsx");
  assert.equal(resolved.internalDeviceId, "asset-a");
  assert.equal(resolved.payload.observation_key, "obs-a");
  assert.equal(resolved.payload.payload_json, undefined, "valid JSON is kept as the decoded object without a duplicate string copy");
  assert.deepEqual(resolved.payload.decodedPayload, { mac: "00:11:22:33:44:66", serial: "S-1" });
  const malformedResolved = legacyObservation("resolved_device_history", {
    id: 7, observation_key: "obs-bad", payload_json: "{malformed", recorded_at: "2026-10-15T10:30:00Z",
  });
  assert.equal(malformedResolved.payload.payload_json, "{malformed", "malformed source JSON stays available for review");
  assert.deepEqual(malformedResolved.payload.decodedPayload, {});
  assert.equal(vendor.kind, "vendor_model_history");
  assert.equal(vendor.payload.model, "Model");
  assert.equal(macHistory.id, legacyObservation("mac_history", currentPyQtMacHistoryRow).id);
});

test("imported legacy MAC and resolved-device rows flow into vendor-model history with their source filenames", () => {
  const observations = [
    legacyObservation("mac_history", {
      id: 31, mac: "00:11:22:33:44:55", vendor: "Room Vendor", model: "Room Model",
      source_file: "room-scan.csv", recorded_at: "2026-10-15T09:00:00Z",
    }),
    legacyObservation("resolved_device_history", {
      id: 32, observation_key: "resolve-32", source: "SmartRoom", recorded_at: "2026-10-15T10:00:00Z",
      payload_json: JSON.stringify({ mac: "00:11:22:33:44:66", manufacturer: "Resolved Vendor", device_model: "Resolved Model", source_file: "resolved.xlsx" }),
    }),
  ];
  const history = new VendorModelHistoryAccumulator();
  observations.forEach((observation) => assert.equal(history.addObservation(observation), true));
  const result = history.result();
  assert.equal(result.statistics.totalSnapshots, 0);
  assert.equal(result.statistics.importedObservations, 2);
  assert.ok(result.vendors.some(({ vendor, sources, firstSeen }) => vendor === "Room Vendor" && sources.includes("room-scan.csv") && firstSeen === "2026-10-15T09:00:00.000Z"));
  assert.ok(result.models.some(({ model, sources, firstSeen }) => model === "Resolved Model" && sources.includes("resolved.xlsx") && firstSeen === "2026-10-15T10:00:00.000Z"));
});

test("legacy row IDs remain byte-compatible with the existing 64-bit FNV hash", () => {
  const fixtures = [
    ["mac_history", { id: 3, mac: "00-11-22-33-44-55", timestamp: "2026-10-15T09:00:00Z" }],
    ["vendor_model_history", { id: 5, mac: "00:11:22:33:44:77", model: "Модель 🔌", observed_at: "2026-10-15T11:00:00Z" }],
    ["mac_movements", { id: 17, mac: "AA:BB:CC:DD:EE:FF", field_name: "switch_port", to_value: "Gi1/0/7" }],
  ];

  for (const [table, row] of fixtures) {
    let hash = 14695981039346656037n;
    for (const character of `${table}:${JSON.stringify(row)}`) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 1099511628211n);
    }
    const expected = `legacy-${table}-${hash.toString(16).padStart(16, "0")}`;
    assert.equal(table === "mac_movements" ? legacyMovement(row).id : legacyObservation(table, row).id, expected);
  }
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
  assert.equal(queued.payload.contentRetainedInSourceDatabase, false);
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
  const metricObservation = (await database.legacyObservationSearchPage({ kind: "performance_metrics" })).rows[0];
  assert.equal(metricObservation.payload.details, "legacy-test-metric", "full details stay searchable in the legacy performance observation");
  assert.deepEqual(await database.getSetting(`legacyPerformanceMetric:${metricObservation.id}`, null), {
    operation: "legacy_export", durationMs: 2_500, timestamp: "2026-01-05T10:00:00.000Z",
  }, "the aggregation setting stores only the fields consumed by performance statistics");
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
  let retainedSourceRecord;
  const database = {
    async importArchiveEvents(_header, events) { for await (const event of events) staged.push(event); },
    async recordLegacySqliteImportSource(record) { retainedSourceRecord = record; },
  };
  const report = await importLegacySQLiteFile(sqliteFile(), database, { runtime, wasmUrl: "data:application/wasm;base64,AA==" });
  const observations = staged.filter((event) => event.type === "records" && event.collection === "legacyObservations").flatMap((event) => event.records);
  assert.equal(report.imported.legacyObservations, 3);
  assert.deepEqual(report.skippedTables, []);
  assert.deepEqual(observations.map((item) => item.kind).sort(), ["scheduled_tasks", "task_file_queue", "task_file_queue"]);
  assert.equal(observations.find((item) => item.kind === "task_file_queue" && item.payload.filename === "main.xlsx").payload.contentRetainedInSourceDatabase, false);
  assert.equal(observations.find((item) => item.kind === "task_file_queue").payload.contentBase64, "Ynl0ZXM=");
  assert.equal(observations.find((item) => item.kind === "task_file_queue").payload.taskId, observations.find((item) => item.kind === "scheduled_tasks").payload.id);
  assert.match(observations.find((item) => item.kind === "scheduled_tasks").payload.id, /^legacy-task-[0-9a-f]{24}-[0-9a-f]{16}$/);
  const largeQueue = observations.find((item) => item.kind === "task_file_queue" && item.payload.filename === "large.xlsx");
  assert.equal(largeQueue.payload.contentAvailable, false);
  assert.equal(largeQueue.payload.contentRetainedInSourceDatabase, true);
  assert.equal(largeQueue.payload.contentBase64Chars, 40 * 1024 * 1024 + 4);
  assert.equal(Object.hasOwn(largeQueue.payload, "contentBase64"), false);
  assert.match(report.sourceIdbName, /^mac-analyzer-/);
  assert.equal(retainedSourceRecord.sourceIdbName, report.sourceIdbName);
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
  assert.equal(restored.blob.type, "application/octet-stream");
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
