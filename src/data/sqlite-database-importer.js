import { stableId } from "../core/identity.js";
import { keyText, normalizeMac, normalizeIp, text } from "../core/normalize.js";
import { normalizeMacPrefix } from "../core/model-knowledge.js";
import { normalizeOuiPrefix } from "../core/ieee-registry.js";
import { createIpMappingAccumulator } from "../core/ip-mapping.js";
import { sha256File } from "../core/incremental-sha256.js";
import { normalizePerformanceMetric } from "../core/performance-statistics.js";
import { customInventoryColumnKey } from "../core/inventory-columns.js";

export const LEGACY_SQLITE_TABLES = Object.freeze([
  "resolved_device_inventory", "resolved_device_history", "device_inventory", "mac_history",
  "mac_movements", "vendor_model_history", "snapshots", "vendor_mappings", "model_mappings",
  "ip_address_mappings", "smartroom_room_mappings", "column_preferences", "api_cache",
  "data_quality_reports", "scheduled_tasks", "task_file_queue", "app_settings", "app_autosaves",
  "history_loads", "analysis_history", "performance_metrics", "oui_vendor_history", "mac5_model_history", "daily_stats",
]);

const OMITTED_SQLITE_TABLE_REASONS = Object.freeze({
  notification_settings: "Настройки внешних каналов и секреты уведомлений не переносятся в локальный browser-only режим.",
  app_logs: "Содержимое журналов не импортируется, поскольку оно может включать чувствительные сообщения и данные.",
  engineering_sessions: "Учетные данные и активные инженерные сессии не переносятся между приложениями.",
});

const SQLITE_HEADER = "SQLite format 3\0";
const SQLITE_STREAM_HEADER_BYTES = 32;
const SQLITE_IMPORT_LIMIT = 1024 * 1024 * 1024;
const SQLITE_PAGE_SIZE = 128;
const DEVICE_BATCH_SIZE = 500;
const MAX_LEGACY_TASK_FILE_BASE64_CHARS = 40 * 1024 * 1024;
const MAX_LEGACY_AUTOSAVE_REFERENCE_BYTES = 1024 * 1024;
const TABLE_REQUIREMENTS = Object.freeze({
  resolved_device_history: ["observation_key", "internal_device_id", "payload_json", "recorded_at"],
  mac_history: ["mac"],
  vendor_model_history: ["mac", "observed_at"],
  resolved_device_inventory: ["internal_device_id", "payload_json"],
  device_inventory: ["mac"],
  snapshots: ["id", "devices_json"],
  vendor_mappings: ["oui", "vendor"],
  model_mappings: ["prefix", "model"],
  ip_address_mappings: ["switch_ip", "physical_address"],
  smartroom_room_mappings: ["smartroom_id", "room"],
  column_preferences: ["view_name", "columns_json"],
  app_settings: ["key", "value"],
  app_autosaves: ["slot", "state_json"],
  history_loads: ["filename"],
  analysis_history: ["filename"],
  performance_metrics: ["operation"],
  oui_vendor_history: ["oui_3byte", "vendor"],
  mac5_model_history: ["mac_5byte", "model"],
  daily_stats: ["date", "total_devices"],
  data_quality_reports: ["id", "source", "score", "grade", "report_json", "created_at"],
  api_cache: ["cache_key", "value", "cached_at"],
  scheduled_tasks: ["id", "name", "interval_minutes", "payload_json", "created_at"],
  task_file_queue: ["id", "task_id", "filename", "content_base64", "status", "created_at"],
});

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function legacyCustomFields(value) {
  const source = parseObject(value);
  const customFields = {};
  for (const [rawLabel, rawValue] of Object.entries(source)) {
    if (!["string", "number", "boolean"].includes(typeof rawValue)) continue;
    const label = String(rawLabel).trim().replace(/^\[Пользовательская\]\s*/u, "").slice(0, 60);
    if (!label) continue;
    customFields[customInventoryColumnKey(label)] = String(rawValue);
  }
  return customFields;
}

function legacyDevice(row = {}) {
  const payload = parseObject(row.payload_json);
  const sources = parseObject(row.field_sources_json || row.fieldSources);
  const conflicts = parseObject(row.conflicts_json || row.conflicts);
  const value = { ...payload, ...row };
  const customFields = legacyCustomFields(value.custom_fields || value.customFields);
  const mac = normalizeMac(value.mac || value.mac_formatted || value.CallingStationID);
  const device = {
    id: stableId({
      internalDeviceId: value.internal_device_id || value.internalDeviceId,
      deviceId: value.device_id || value.deviceId,
      serial: value.serial_number || value.serialNumber,
      mac,
    }),
    mac,
    ip: normalizeIp(value.ip || value.device_ip || value.deviceIp),
    switchIp: normalizeIp(value.switch_ip || value.switchIp),
    switchPort: text(value.switch_port || value.switchPort),
    manufacturer: text(value.manufacturer || value.vendor),
    model: text(value.model),
    deviceType: text(value.device_type || value.deviceType),
    hostname: text(value.hostname),
    serial: text(value.serial_number || value.serialNumber || value.serial),
    deviceId: text(value.device_id || value.deviceId),
    smartroomId: text(value.smartroom_id || value.smartroomId),
    room: text(value.room),
    address: text(value.address),
    authenticationTime: text(value.authentication_time || value.authenticationTime || value.recorded_at),
    fieldSources: sources,
    conflicts,
    ...(Object.keys(customFields).length ? { customFields } : {}),
  };
  if (!device.id || !device.mac && !device.serial && !device.deviceId) return null;
  return device;
}

function inventoryRecord(device, row = {}, timestamp) {
  const seenAt = text(row.updated_at || row.last_seen || row.recorded_at || timestamp);
  return {
    ...device,
    firstSeen: text(row.first_seen || row.firstSeen) || seenAt,
    lastSeen: seenAt,
    present: true,
    snapshotId: "",
    observationCount: Math.max(1, Number(row.seen_count || row.seenCount) || 1),
    source: text(row.source) || "Импорт SQLite",
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedTimestamp(value, fallback) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

async function* sqliteRows(runtime, sqlite, sql, parameters = []) {
  const engine = sqlite?.sqlite;
  if (engine?.statements && Number.isInteger(sqlite?.pointer)) {
    for await (const statement of engine.statements(sqlite.pointer, sql)) {
      if (parameters.length) engine.bind_collection(statement, parameters);
      const columns = engine.column_names(statement);
      while (await engine.step(statement) === 100) {
        const values = engine.row(statement);
        yield Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      }
    }
    return;
  }
  yield* runtime.iterator(sqlite, sql, parameters, SQLITE_PAGE_SIZE);
}

function makeSnapshotId(importId, sourceId) {
  return `legacy-sqlite-${importId}-${String(sourceId).slice(0, 160)}`;
}

export function legacyAutosaveReferenceId(stateJson) {
  if (typeof stateJson === "string" && stateJson.length > MAX_LEGACY_AUTOSAVE_REFERENCE_BYTES) return "";
  const state = parseObject(stateJson);
  const reference = state.resultSnapshotId || state.resultBrowserSnapshotId || state.activeSnapshotId || state.finalSnapshotId;
  return reference ? String(reference).slice(0, 200) : "";
}

export function legacyAutosaveSnapshotId(stateJson, snapshotIds) {
  const reference = legacyAutosaveReferenceId(stateJson);
  return reference ? snapshotIds.get(reference) || "" : "";
}

function legacyRowId(table, row) {
  let hash = 14695981039346656037n;
  for (const character of `${table}:${JSON.stringify(row)}`) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 1099511628211n);
  }
  return `legacy-${table}-${hash.toString(16).padStart(16, "0")}`;
}

function legacyMovement(row = {}) {
  const mac = normalizeMac(row.mac);
  const field = text(row.field_name);
  const normalizedFields = {
    ip: "ip", device_ip: "ip", switch_ip: "switchIp", switch_port: "switchPort",
    physical_address: "address", room: "room", vendor: "manufacturer", serial_number: "serial",
    hostname: "hostname", device_id: "deviceId", model: "model",
  };
  const timestamp = normalizedTimestamp(row.changed_at, new Date().toISOString());
  if (!mac || !field) return null;
  return {
    id: legacyRowId("mac_movements", row),
    type: "modified",
    mac,
    deviceId: "",
    field: normalizedFields[field.toLowerCase()] || field,
    oldValue: text(row.from_value),
    newValue: text(row.to_value),
    ddioCandidateIp: normalizeIp(row.ddio_candidate_ip),
    ddioMatch: text(row.ddio_match),
    source: text(row.source) || "Импорт SQLite",
    timestamp,
  };
}

function legacyObservation(table, row = {}) {
  const payload = table === "resolved_device_history" ? { ...row, decodedPayload: parseObject(row.payload_json) } : { ...row };
  const observedAt = normalizedTimestamp(row.recorded_at || row.observed_at, new Date().toISOString());
  const mac = normalizeMac(row.mac || payload.mac || payload.mac_formatted);
  return {
    id: legacyRowId(table, row),
    kind: table,
    sourceTable: table,
    source: text(row.source) || "Импорт SQLite",
    observedAt,
    mac,
    internalDeviceId: text(row.internal_device_id || payload.internal_device_id || payload.internalDeviceId),
    payload,
  };
}

function legacyApiCacheVendorObservation(row = {}) {
  const cacheKey = text(row.cache_key);
  const suffix = cacheKey.match(/^vendor:(.+)$/i)?.[1]
    || cacheKey.match(/^external_vendor:[^:]+:(.+)$/i)?.[1]
    || "";
  const mac = normalizeMac(suffix);
  const vendor = text(row.value);
  if (!mac || !vendor) return null;
  const observedAt = normalizedTimestamp(row.cached_at, new Date().toISOString());
  return {
    id: legacyRowId("api_cache", row),
    kind: "vendor_model_history",
    sourceTable: "vendor_model_history",
    source: "SQLite API cache",
    observedAt,
    mac,
    internalDeviceId: "",
    payload: { mac, vendor, model: "", source: "SQLite API cache", cached_at: observedAt },
  };
}

function legacyMigrationObservation(table, row = {}) {
  const observedAt = normalizedTimestamp(
    table === "history_loads" ? row.load_date : row.timestamp || row.date || row.created_at,
    new Date().toISOString(),
  );
  let payload;
  if (table === "history_loads") {
    payload = {
      id: text(row.id),
      filename: text(row.filename),
      loadDate: text(row.load_date),
      devicesCount: Math.max(0, Number(row.devices_count) || 0),
      newVendorsAdded: Math.max(0, Number(row.new_vendors_added) || 0),
      newModelsAdded: Math.max(0, Number(row.new_models_added) || 0),
      enrichedFromHistory: Math.max(0, Number(row.enriched_from_history) || 0),
    };
  } else if (table === "analysis_history") {
    payload = {
      id: text(row.id),
      filename: text(row.filename),
      devicesCount: Math.max(0, Number(row.devices_count ?? row.total_devices) || 0),
      strategy: text(row.strategy),
      processingTime: Math.max(0, Number(row.processing_time ?? row.duration_seconds) || 0),
    };
  } else if (table === "daily_stats") {
    const count = (value) => Math.max(0, Number(value) || 0);
    payload = {
      date: text(row.date),
      totalDevices: count(row.total_devices),
      newDevices: count(row.new_devices),
      vendorsCount: count(row.vendors_count),
      roomsCount: count(row.rooms_count),
      devicesWithAddress: count(row.devices_with_address),
      devicesWithRoom: count(row.devices_with_room),
    };
  } else {
    const durationMs = Number.isFinite(Number(row.duration_ms))
      ? Math.max(0, Number(row.duration_ms))
      : Math.max(0, Number(row.duration_seconds) || 0) * 1000;
    payload = {
      id: text(row.id),
      operation: text(row.operation),
      durationMs,
      details: text(row.details),
    };
  }
  return {
    id: legacyRowId(table, row),
    kind: table,
    sourceTable: table,
    source: "Импорт SQLite",
    observedAt,
    mac: "",
    internalDeviceId: "",
    payload,
  };
}

async function* legacyPerformanceMetricEvents(runtime, sqlite, onProgress, signal, report) {
  const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "performance_metrics"');
  let observations = [];
  let metrics = [];
  let recordsRead = 0;
  let importedCount = 0;
  const flush = () => {
    const events = [];
    if (observations.length) events.push({ type: "records", collection: "legacyObservations", records: observations });
    if (metrics.length) events.push({ type: "records", collection: "settings", records: metrics });
    report.imported.legacyObservations = (report.imported.legacyObservations || 0) + observations.length;
    report.imported.settings = (report.imported.settings || 0) + metrics.length;
    onProgress({ collection: "performance_metrics", recordsRead, table: "performance_metrics" });
    observations = [];
    metrics = [];
    return events;
  };
  for await (const row of sourceRows) {
    if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
    const observation = legacyMigrationObservation("performance_metrics", row);
    observations.push(observation);
    const metric = normalizePerformanceMetric({
      operation: observation.payload.operation,
      durationMs: observation.payload.durationMs,
      timestamp: observation.observedAt,
    });
    if (metric) metrics.push({
      key: `legacyPerformanceMetric:${observation.id}`,
      value: { ...metric, details: observation.payload.details },
    });
    importedCount += 1 + Number(Boolean(metric));
    recordsRead += 1;
    if (observations.length >= SQLITE_PAGE_SIZE) yield* flush();
  }
  if (observations.length) yield* flush();
  return importedCount;
}

function legacyTaskObservation(table, row = {}, sourceNamespace = "legacy-sqlite") {
  const queue = table === "task_file_queue";
  const legacyTaskId = (id) => `legacy-task-${sourceNamespace}-${legacyRowId("scheduled_tasks", { id: text(id).slice(0, 240) }).slice(-16)}`;
  const contentBase64 = typeof row.content_base64 === "string" ? row.content_base64 : "";
  const contentBase64Chars = Math.max(0, Number(row.content_base64_chars) || contentBase64.length);
  const validContent = contentBase64Chars > 0 && contentBase64Chars <= MAX_LEGACY_TASK_FILE_BASE64_CHARS && contentBase64.length === contentBase64Chars
    && contentBase64.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64);
  const resultJson = typeof row.result_json === "string" ? row.result_json : "";
  const taskPayloadJson = typeof row.payload_json === "string" ? row.payload_json : "";
  const observedAt = normalizedTimestamp(row.created_at || row.last_run_at || row.finished_at, new Date().toISOString());
  const payload = queue ? {
    id: text(row.id).slice(0, 240),
    taskId: legacyTaskId(row.task_id),
    sourceTaskId: text(row.task_id).slice(0, 240),
    filename: text(row.filename).slice(0, 1024),
    status: text(row.status).slice(0, 80) || "pending",
    result: resultJson.length <= 1024 * 1024 ? parseObject(resultJson) : {},
    resultOmitted: resultJson.length > 1024 * 1024,
    error: text(row.error).slice(0, 2000),
    createdAt: text(row.created_at),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    contentBase64Chars,
    contentAvailable: validContent,
    ...(validContent ? { contentBase64 } : {}),
    contentRetainedInSourceDatabase: contentBase64Chars > 0,
  } : {
    id: legacyTaskId(row.id),
    name: text(row.name).slice(0, 512),
    intervalMinutes: Math.max(1, Number(row.interval_minutes) || 1),
    enabled: Boolean(Number(row.enabled)),
    payload: taskPayloadJson.length <= 1024 * 1024 ? parseObject(taskPayloadJson) : {},
    payloadOmitted: taskPayloadJson.length > 1024 * 1024,
    lastRunAt: text(row.last_run_at),
    nextRunAt: text(row.next_run_at),
    createdAt: text(row.created_at),
  };
  return {
    id: legacyRowId(table, { sourceNamespace, row }),
    kind: table,
    sourceTable: table,
    source: "Импорт SQLite",
    observedAt,
    mac: "",
    internalDeviceId: "",
    payload,
  };
}

async function* legacyEvents(runtime, sqlite, importId, sourceNamespace, tables, onProgress, signal, report) {
  let ordinal = 0;
  let recordCount = 0;
  const legacySnapshotReferences = new Set();
  const legacySnapshotIds = new Map();
  const unsupportedColumnPreferenceViews = new Set();
  let unsupportedColumnPreferenceViewOverflow = 0;
  if (tables.has("snapshots") && tables.has("app_autosaves")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT "slot", "state_json" FROM "app_autosaves"');
    for await (const row of sourceRows) {
      const reference = legacyAutosaveReferenceId(row.state_json);
      if (reference) legacySnapshotReferences.add(reference);
    }
  }
  const emitRows = async function* (collection, sourceRows, mapRow) {
    let batch = [];
    let recordsRead = 0;
    for await (const row of sourceRows) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      const mapped = mapRow(row);
      if (!mapped) continue;
      batch.push(mapped);
      recordsRead += 1;
      recordCount += 1;
      report.imported[collection] = (report.imported[collection] || 0) + 1;
      if (batch.length >= SQLITE_PAGE_SIZE) {
        onProgress({ collection, recordsRead, table: collection });
        yield { type: "records", collection, records: batch };
        batch = [];
      }
    }
    if (batch.length) {
      onProgress({ collection, recordsRead, table: collection });
      yield { type: "records", collection, records: batch };
    }
  };

  if (tables.has("snapshots")) {
    const snapshotColumns = new Set((await sqlite.run('PRAGMA table_info("snapshots")')).map((column) => String(column.name)));
    const project = (name) => snapshotColumns.has(name) ? quoteIdentifier(name) : `NULL AS ${quoteIdentifier(name)}`;
    const snapshots = sqliteRows(runtime, sqlite,
      `SELECT ${["id", "name", "source", "device_count", "created_at", "signature"].map(project).join(", ")} FROM "snapshots" ORDER BY ${snapshotColumns.has("created_at") ? '"created_at"' : '"id"'}, "id"`);
    for await (const row of snapshots) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      const snapshotId = makeSnapshotId(importId, row.id);
      if (legacySnapshotReferences.has(String(row.id).slice(0, 200))) legacySnapshotIds.set(String(row.id).slice(0, 200), snapshotId);
      let devices = [];
      let index = 0;
      let deviceCount = 0;
      const query = 'SELECT CAST(json_each.value AS TEXT) AS device_json FROM "snapshots", json_each("snapshots"."devices_json") WHERE "snapshots"."id" = ? ORDER BY CAST(json_each.key AS INTEGER)';
      for await (const item of sqliteRows(runtime, sqlite, query, [row.id])) {
        const raw = JSON.parse(item.device_json);
        const device = legacyDevice(raw);
        if (!device) continue;
        devices.push(device);
        deviceCount += 1;
        if (devices.length >= DEVICE_BATCH_SIZE) {
          yield { type: "snapshotChunk", ordinal, index: index++, devices };
          onProgress({ collection: "snapshots", recordsRead: deviceCount, batchSize: devices.length });
          devices = [];
        }
      }
      if (devices.length) {
        onProgress({ collection: "snapshots", recordsRead: deviceCount, batchSize: devices.length });
        yield { type: "snapshotChunk", ordinal, index: index++, devices };
      }
      const createdAt = normalizedTimestamp(row.created_at, new Date().toISOString());
      yield {
        type: "snapshot", ordinal,
        value: {
          id: snapshotId,
          name: text(row.name) || `Импорт SQLite ${row.id}`,
          createdAt,
          sourceKey: `sqlite:${importId}:${row.id}`,
          processingTimeMs: 0,
          deviceCount,
          chunkCount: index,
          schemaVersion: 1,
          diagnostics: { importedFromSQLite: true },
          sourceFiles: [],
        },
      };
      ordinal += 1;
      recordCount += deviceCount + 1;
    }
    report.snapshots = ordinal;
    report.imported.snapshots = ordinal;
  }

  const timestamp = new Date().toISOString();
  const inventoryTables = ["device_inventory", "resolved_device_inventory"].filter((table) => tables.has(table));
  for (const table of inventoryTables) {
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("inventory", sourceRows, (row) => {
      const device = legacyDevice(row);
      return device ? inventoryRecord(device, row, timestamp) : null;
    });
  }

  if (tables.has("vendor_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "vendor_mappings"');
    yield* emitRows("oui", sourceRows, (row) => {
      const prefix = normalizeOuiPrefix(row.oui);
      const vendor = text(row.vendor);
      return prefix && vendor ? { prefix, vendor, source: text(row.source) || "Импорт SQLite", updatedAt: text(row.updated_at) || timestamp } : null;
    });
  }
  if (tables.has("oui_vendor_history")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "oui_vendor_history"');
    yield* emitRows("oui", sourceRows, (row) => {
      const prefix = normalizeOuiPrefix(row.oui_3byte);
      const vendor = text(row.vendor);
      return prefix && vendor ? { prefix, vendor, source: "Импорт SQLite: OUI history", updatedAt: normalizedTimestamp(row.last_seen || row.updated_at, timestamp) } : null;
    });
  }
  if (tables.has("model_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "model_mappings"');
    yield* emitRows("mac5Models", sourceRows, (row) => {
      const prefix = normalizeMacPrefix(row.prefix);
      const model = text(row.model);
      return prefix && model ? { prefix, model, source: text(row.source) || "Импорт SQLite", updatedAt: text(row.updated_at) || timestamp } : null;
    });
  }
  if (tables.has("mac5_model_history")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "mac5_model_history"');
    yield* emitRows("mac5Models", sourceRows, (row) => {
      const prefix = normalizeMacPrefix(row.mac_5byte);
      const model = text(row.model);
      return prefix && model ? { prefix, model, source: "Импорт SQLite: MAC5 history", updatedAt: normalizedTimestamp(row.last_seen || row.updated_at, timestamp) } : null;
    });
  }
  if (tables.has("ip_address_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "ip_address_mappings"');
    const mappings = createIpMappingAccumulator();
    for await (const row of sourceRows) mappings.accept({ switchIp: row.switch_ip, address: row.physical_address, source: text(row.source) || "Импорт SQLite" });
    const normalized = mappings.finish();
    if (normalized.length) {
      report.ipMappings = normalized.length;
      report.imported.ipAddressMappings = normalized.length;
      recordCount += normalized.length;
      yield { type: "records", collection: "settings", records: [{ key: "ipAddressMappings", value: normalized }] };
    }
  }

  if (tables.has("mac_movements")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "mac_movements"');
    yield* emitRows("history", sourceRows, legacyMovement);
  }

  for (const table of ["mac_history", "resolved_device_history", "vendor_model_history"]) {
    if (!tables.has(table)) continue;
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyObservation(table, row));
  }

  if (tables.has("api_cache")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "api_cache"');
    yield* emitRows("legacyObservations", sourceRows, legacyApiCacheVendorObservation);
  }

  for (const table of ["history_loads", "analysis_history", "performance_metrics"]) {
    if (!tables.has(table)) continue;
    if (table === "performance_metrics") {
      recordCount += yield* legacyPerformanceMetricEvents(runtime, sqlite, onProgress, signal, report);
      continue;
    }
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMigrationObservation(table, row));
  }

  if (tables.has("daily_stats")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "daily_stats"');
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMigrationObservation("daily_stats", row));
  }

  for (const table of ["scheduled_tasks", "task_file_queue"]) {
    if (!tables.has(table)) continue;
    let query = `SELECT * FROM ${quoteIdentifier(table)}`;
    if (table === "task_file_queue") {
      const columns = new Set((await sqlite.run(`PRAGMA table_info(${quoteIdentifier(table)})`)).map((column) => String(column.name)));
      const selected = ["id", "task_id", "filename", "status", "result_json", "error", "created_at", "started_at", "finished_at"]
        .filter((name) => columns.has(name)).map(quoteIdentifier);
      selected.push(`CASE WHEN length("content_base64") <= ${MAX_LEGACY_TASK_FILE_BASE64_CHARS} THEN "content_base64" ELSE '' END AS "content_base64"`);
      selected.push('length("content_base64") AS "content_base64_chars"');
      query = `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table)}`;
    }
    const sourceRows = sqliteRows(runtime, sqlite, query);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyTaskObservation(table, row, sourceNamespace));
  }

  if (tables.has("data_quality_reports")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "data_quality_reports" ORDER BY "created_at", "id"');
    yield* emitRows("dataQualityReports", sourceRows, (row) => {
      const score = Number(row.score);
      const grade = String(row.grade || "").toUpperCase();
      if (!row.id || !Number.isFinite(score) || score < 0 || score > 100 || !["A", "B", "C", "D"].includes(grade)) return null;
      const source = text(row.source) || `Legacy report ${row.id}`;
      return {
        id: legacyRowId("data_quality_reports", row),
        snapshotId: `legacy-quality:${String(row.id).slice(0, 160)}`,
        snapshotName: source,
        createdAt: normalizedTimestamp(row.created_at, timestamp),
        score, grade, report: parseObject(row.report_json),
        importedFrom: "data_quality_reports",
      };
    });
  }

  if (tables.has("smartroom_room_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "smartroom_room_mappings"');
    yield* emitRows("legacySmartroomRoomMappings", sourceRows, (row) => {
      const smartroomId = text(row.smartroom_id);
      const room = text(row.room);
      const smartroomIdKey = keyText(smartroomId);
      if (!smartroomIdKey || !room) return null;
      return {
        id: `${smartroomIdKey}\u0000${smartroomId}`,
        smartroomIdKey,
        smartroomId,
        room,
        source: text(row.source) || "Импорт SQLite",
        updatedAt: normalizedTimestamp(row.updated_at, timestamp),
      };
    });
  }

  const settingTables = ["app_settings", "app_autosaves", "column_preferences"];
  for (const table of settingTables) {
    if (!tables.has(table)) continue;
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("settings", sourceRows, (row) => {
      if (table === "app_settings") return row.key ? { key: `legacyAppSetting:${String(row.key).slice(0, 240)}`, value: row.value } : null;
      if (table === "app_autosaves") {
        if (!row.slot) return null;
        const snapshotId = legacyAutosaveSnapshotId(row.state_json, legacySnapshotIds);
        return {
          key: `legacyAutosave:${String(row.slot).slice(0, 160)}`,
          value: {
            state: row.state_json,
            reason: row.reason || "",
            updatedAt: row.updated_at || "",
            ...(snapshotId ? { snapshotId } : {}),
          },
        };
      }
      if (table === "column_preferences") {
        const viewName = String(row.view_name || "").trim().toLowerCase();
        if (!["inventory", "results"].includes(viewName)) {
          const unsupportedViewName = viewName || "(без имени)";
          if (unsupportedColumnPreferenceViews.has(unsupportedViewName)) return null;
          if (unsupportedColumnPreferenceViews.size < 20) unsupportedColumnPreferenceViews.add(unsupportedViewName);
          else unsupportedColumnPreferenceViewOverflow += 1;
          return null;
        }
        return { key: `legacyColumnPreferences:${viewName}`, value: row.columns_json };
      }
      return null;
    });
  }

  report.records = recordCount;
  const unsupported = LEGACY_SQLITE_TABLES.filter((table) => tables.has(table) && ![
    "snapshots", "device_inventory", "resolved_device_inventory", "vendor_mappings", "model_mappings",
    "oui_vendor_history", "mac5_model_history", "daily_stats",
    "ip_address_mappings", "mac_movements", "mac_history", "resolved_device_history", "vendor_model_history", "api_cache", "scheduled_tasks", "task_file_queue", "data_quality_reports", "smartroom_room_mappings", "app_settings", "app_autosaves", "column_preferences", "history_loads", "analysis_history", "performance_metrics",
  ].includes(table));
  for (const table of unsupported) {
    const reason = "Next пока не имеет эквивалентной модели данных для этой таблицы";
    if (!report.skippedTables.some((item) => item.table === table)) report.skippedTables.push({ table, reason });
  }
  if (unsupportedColumnPreferenceViews.size) {
    report.skippedTables.push({
      table: "column_preferences",
      reason: `Next не поддерживает представления: ${[...unsupportedColumnPreferenceViews].sort().join(", ")}${unsupportedColumnPreferenceViewOverflow ? `; дополнительных строк с неподдержанными представлениями: ${unsupportedColumnPreferenceViewOverflow}` : ""}`,
    });
  }
}

export async function importLegacySQLiteFile(file, database, {
  signal,
  onProgress = () => {},
  runtime = globalThis.__MAC_ANALYZER_SQLITE_RUNTIME__,
  wasmUrl = globalThis.__MAC_ANALYZER_SQLITE_WASM_URL__,
} = {}) {
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size < 100) throw new Error("Выбранный SQLite-файл отсутствует или слишком мал");
  if (file.size > SQLITE_IMPORT_LIMIT) throw new Error("SQLite-файл превышает поддерживаемый размер 1 ГиБ");
  const header = new TextDecoder().decode(await file.slice(0, SQLITE_HEADER.length).arrayBuffer());
  if (header !== SQLITE_HEADER) throw new Error("Выбранный файл не является базой SQLite");
  if (!runtime?.initSQLite || !runtime?.useIdbStorage || !runtime?.withExistDB || !runtime?.iterator || !wasmUrl) {
    throw new Error("SQLite-WASM runtime не встроен в приложение");
  }
  const importId = crypto.randomUUID();
  const idbName = `mac-analyzer-sqlite-import-${importId}.db`;
  let sqlite;
  let sqliteVfs;
  let successful = false;
  const report = { importId, fileName: String(file.name || "database.sqlite"), sourceBytes: file.size, integrity: "", tables: [], imported: {}, skippedTables: [] };
  try {
    onProgress({ stage: "hashing", fileName: report.fileName, sourceBytes: file.size });
    const sourceNamespace = (await sha256File(file, { signal, onProgress: ({ bytesRead, totalBytes }) => onProgress({ stage: "hashing", fileName: report.fileName, bytesRead, totalBytes }) })).slice(0, 24);
    report.sourceNamespace = sourceNamespace;
    onProgress({ stage: "copying", fileName: report.fileName, sourceBytes: file.size });
    const options = runtime.withExistDB(createSQLitePageImportStream(file), { url: wasmUrl, readonly: true });
    const storage = await runtime.useIdbStorage(idbName, { ...options, url: wasmUrl, readonly: true });
    const createVfs = storage.vfsFn;
    storage.vfsFn = async (...args) => {
      sqliteVfs = await createVfs(...args);
      return sqliteVfs;
    };
    sqlite = await runtime.initSQLite(storage);
    const integrityRows = await sqlite.run("PRAGMA integrity_check");
    if (integrityRows.length !== 1 || String(integrityRows[0]?.integrity_check || "").toLowerCase() !== "ok") {
      throw new Error(`Проверка целостности SQLite не пройдена: ${String(integrityRows[0]?.integrity_check || "неизвестная ошибка")}`);
    }
    report.integrity = "ok";
    const tableRows = await sqlite.run("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const available = new Set(tableRows.map((row) => String(row.name)));
    report.tables = LEGACY_SQLITE_TABLES.filter((table) => available.has(table));
    const knownTables = new Set(LEGACY_SQLITE_TABLES);
    for (const table of [...available].filter((name) => !knownTables.has(name)).sort()) {
      report.skippedTables.push({
        table,
        reason: OMITTED_SQLITE_TABLE_REASONS[table] || "Неизвестная или неподдерживаемая таблица; содержимое не импортировано.",
      });
    }
    const validTables = new Set();
    for (const table of report.tables) {
      const required = TABLE_REQUIREMENTS[table];
      if (!required) {
        validTables.add(table);
        continue;
      }
      const columns = new Set((await sqlite.run(`PRAGMA table_info(${quoteIdentifier(table)})`)).map((column) => String(column.name)));
      const missing = required.filter((column) => !columns.has(column));
      if (missing.length) report.skippedTables.push({ table, reason: `В таблице отсутствуют поля: ${missing.join(", ")}` });
      else validTables.add(table);
    }
    if (!validTables.size) throw new Error("В SQLite не найдены таблицы MAC Analyzer с совместимой схемой");
    const generator = legacyEvents(runtime, sqlite, importId, sourceNamespace, validTables, onProgress, signal, report);
    await database.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, generator, { preserveActiveSnapshot: true });
    report.importedAt = new Date().toISOString();
    report.sourceIdbName = idbName;
    successful = true;
    await database.recordLegacySqliteImportSource(report);
    return report;
  } finally {
    await sqlite?.close().catch(() => {});
    await (sqlite?.vfs || sqliteVfs)?.close?.();
    if (!successful) await deleteSqliteIdb(idbName);
  }
}

export function createSQLitePageImportStream(file) {
  let offset = 0;
  let pageSize = 0;
  let headerSent = false;
  return new globalThis.ReadableStream({
    async pull(controller) {
      try {
        if (!headerSent) {
          const header = new Uint8Array(await file.slice(0, SQLITE_STREAM_HEADER_BYTES).arrayBuffer());
          if (header.byteLength !== SQLITE_STREAM_HEADER_BYTES) throw new Error("Заголовок SQLite неполный");
          const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
          const encodedPageSize = view.getUint16(16, false);
          pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
          const pageCount = view.getUint32(28, false);
          const physicalPageCount = file.size / pageSize;
          if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0
            || !Number.isSafeInteger(physicalPageCount) || physicalPageCount < 1
            || pageCount && pageCount !== physicalPageCount) {
            throw new Error("Размер страницы или длина SQLite-файла не соответствует заголовку");
          }
          if (pageCount === 0) view.setUint32(28, physicalPageCount, false);
          controller.enqueue(header);
          headerSent = true;
          return;
        }
        if (offset >= file.size) {
          controller.close();
          return;
        }
        const page = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + pageSize)).arrayBuffer());
        if (page.byteLength !== pageSize) throw new Error("Последняя страница SQLite неполная");
        offset += page.byteLength;
        controller.enqueue(page);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function readLegacyTaskQueueFileFromSQLite(source, queueRecord, {
  runtime = globalThis.__MAC_ANALYZER_SQLITE_RUNTIME__,
  wasmUrl = globalThis.__MAC_ANALYZER_SQLITE_WASM_URL__,
  beforeRead = () => {},
  onProgress = () => {},
} = {}) {
  if (!source?.sourceIdbName || !/^[0-9a-f]{24}$/i.test(String(source.sourceNamespace || ""))) throw new Error("Исходная SQLite-база этого расписания недоступна");
  const payload = queueRecord?.payload || queueRecord || {};
  const fileId = String(payload.id || "");
  const taskId = String(payload.sourceTaskId || "");
  if (!fileId || !taskId) throw new Error("У файла очереди отсутствует исходный SQLite ID");
  if (!runtime?.initSQLite || !runtime?.useIdbStorage || !wasmUrl) throw new Error("SQLite-WASM runtime не встроен в приложение");
  const storage = await runtime.useIdbStorage(source.sourceIdbName, { url: wasmUrl });
  let sqlite;
  try {
    sqlite = await runtime.initSQLite(storage);
    const [meta] = await sqlite.run(
      'SELECT filename, length(content_base64) AS contentBase64Chars FROM task_file_queue WHERE id = ? AND task_id = ? LIMIT 1',
      [fileId, taskId],
    );
    const totalChars = Number(meta?.contentBase64Chars);
    if (!meta || !Number.isSafeInteger(totalChars) || totalChars < 4 || totalChars % 4 !== 0) throw new Error("В исходной SQLite базе нет корректного содержимого файла очереди");
    beforeRead(Math.ceil(totalChars * 0.75));
    const parts = [];
    const chunkChars = 64 * 1024;
    for (let offset = 0; offset < totalChars; offset += chunkChars) {
      const take = Math.min(chunkChars, totalChars - offset);
      const [row] = await sqlite.run(
        'SELECT substr(content_base64, ?, ?) AS contentChunk FROM task_file_queue WHERE id = ? AND task_id = ? LIMIT 1',
        [offset + 1, take, fileId, taskId],
      );
      const chunk = String(row?.contentChunk || "");
      if (chunk.length !== take || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)) throw new Error("Содержимое файла очереди в исходной SQLite базе повреждено");
      const binary = globalThis.atob(chunk);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      parts.push(bytes);
      onProgress({ readChars: offset + take, totalChars });
    }
    return { filename: String(meta.filename || payload.filename || "queued-file"), blob: new Blob(parts, { type: "application/octet-stream" }), contentBase64Chars: totalChars };
  } finally {
    await sqlite?.close().catch(() => {});
    await sqlite?.vfs?.close?.();
  }
}

export async function deleteSqliteIdb(name) {
  if (!name) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Не удалось очистить временный SQLite-файл"));
    request.onblocked = () => reject(new Error("Нельзя очистить временный SQLite-файл: он ещё используется"));
  });
}

export { legacyDevice, legacyMovement, legacyObservation, legacyApiCacheVendorObservation, legacyTaskObservation, inventoryRecord };
