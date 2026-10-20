import { conflictingStrongFields, createPositionedIdentityIndex, findIdentityMatch, normalizeAlternateMacValues, stableId } from "../core/identity.js";
import { firstMac, keyText, MAX_DEVICE_ALTERNATIVES, MAX_DEVICE_CONFLICTS, normalizeDate, normalizeMac, normalizeIp, text } from "../core/normalize.js";
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
  "history_loads", "analysis_history", "performance_metrics", "oui_vendor_history", "mac5_model_history", "mac_vendor_history", "mac_model_history", "daily_stats", "exports",
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
const MAX_LEGACY_COLUMN_PREFERENCES_CHARS = 256 * 1024;
export const LEGACY_SQLITE_TABLE_REQUIREMENTS = Object.freeze({
  resolved_device_history: ["observation_key", "internal_device_id", "payload_json", "recorded_at"],
  mac_history: ["mac"],
  mac_movements: ["mac", "field_name"],
  mac_vendor_history: ["mac", "vendor"],
  mac_model_history: ["mac", "model"],
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
  exports: ["id", "filename", "export_date"],
  data_quality_reports: ["id", "source", "score", "grade", "report_json", "created_at"],
  api_cache: ["cache_key", "value", "cached_at"],
  scheduled_tasks: ["id", "name", "interval_minutes", "payload_json", "created_at"],
  task_file_queue: ["id", "task_id", "filename", "content_base64", "status", "created_at"],
});
export const LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES = Object.freeze({
  mac_movements: Object.freeze([Object.freeze(["timestamp", "changed_at"])]),
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

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function legacyConfidence(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const confidence = Number(value);
    if (Number.isFinite(confidence)) return Math.max(0, Math.min(1, confidence));
  }
  return undefined;
}

function legacyCustomKey(rawLabel) {
  const label = String(rawLabel).trim().replace(/^\[Пользовательская\]\s*/u, "").slice(0, 60);
  if (!label) return "";
  return /^custom_[0-9a-f-]{36}$/i.test(label) ? label : customInventoryColumnKey(label);
}

function legacyCustomFields(value) {
  const source = parseObject(value);
  const customFields = {};
  for (const [rawLabel, rawValue] of Object.entries(source)) {
    if (!["string", "number", "boolean"].includes(typeof rawValue)) continue;
    const key = legacyCustomKey(rawLabel);
    if (!key) continue;
    customFields[key] = String(rawValue);
  }
  return customFields;
}

function legacyCustomFieldSources(value, customFields) {
  const source = parseObject(value);
  const customFieldSources = {};
  for (const [rawLabel, rawSource] of Object.entries(source)) {
    const key = legacyCustomKey(rawLabel);
    const normalizedSource = text(rawSource).slice(0, 500);
    if (key && Object.hasOwn(customFields, key) && normalizedSource) customFieldSources[key] = normalizedSource;
  }
  return customFieldSources;
}

function legacyDevice(row = {}, canonicalId = "") {
  const payload = parseObject(row.payload_json);
  const value = { ...payload, ...row };
  const fieldSources = parseObject(value.field_sources_json || value.fieldSources);
  const vendorConfidence = legacyConfidence(value.vendorConfidence, value.vendor_confidence);
  const modelConfidence = legacyConfidence(value.modelConfidence, value.model_confidence);
  const vendorSource = text(value.vendorSource || value.vendor_source);
  const modelSource = text(value.modelSource || value.model_source);
  const rawConflicts = value.conflicts_json ?? value.conflicts;
  const parsedConflicts = parseArray(rawConflicts);
  const conflictsAreArray = Array.isArray(rawConflicts) || typeof rawConflicts === "string" && rawConflicts.trim().startsWith("[");
  const conflicts = conflictsAreArray
    ? parsedConflicts.slice(0, MAX_DEVICE_CONFLICTS)
    : parseObject(rawConflicts);
  const conflictsTruncated = Boolean(value.conflictsTruncated || parsedConflicts.length > MAX_DEVICE_CONFLICTS);
  const sources = [...new Set(parseArray(value.sources).slice(0, MAX_DEVICE_ALTERNATIVES).map(text).filter(Boolean))];
  const customFields = legacyCustomFields(value.custom_fields || value.customFields);
  const customFieldSources = legacyCustomFieldSources(value.custom_field_sources || value.customFieldSources, customFields);
  const primaryMac = firstMac(value.mac, value.mac_formatted, value.CallingStationID);
  const storedAlternates = Array.isArray(value.alternateMacs)
    ? value.alternateMacs
    : typeof value.alternateMacs === "string" ? value.alternateMacs.split(",") : [];
  const alternateMacInput = [
    ...storedAlternates.slice(0, MAX_DEVICE_ALTERNATIVES),
    value.secondaryMac, value.secondary_mac, value.mac2, value.additionalMac, value.additional_mac,
  ];
  const normalizedAliasMacs = normalizeAlternateMacValues(alternateMacInput);
  const mac = primaryMac || normalizedAliasMacs[0] || "";
  const normalizedAlternateMacs = normalizedAliasMacs.filter((alternate) => alternate !== mac);
  const alternateMacs = normalizedAlternateMacs.slice(0, MAX_DEVICE_ALTERNATIVES);
  const alternateMacsTruncated = Boolean(value.alternateMacsTruncated || storedAlternates.length > MAX_DEVICE_ALTERNATIVES || normalizedAlternateMacs.length > MAX_DEVICE_ALTERNATIVES);
  const storedPossibleIps = Array.isArray(value.possibleIps)
    ? value.possibleIps
    : typeof value.possibleIps === "string" ? value.possibleIps.split(",") : [];
  const possibleIps = [...new Set(storedPossibleIps.slice(0, MAX_DEVICE_ALTERNATIVES).map(normalizeIp).filter(Boolean))];
  const possibleIpsTruncated = Boolean(value.possibleIpsTruncated || storedPossibleIps.length > MAX_DEVICE_ALTERNATIVES);
  const device = {
    id: canonicalId || stableId({
      internalDeviceId: value.internal_device_id || value.internalDeviceId,
      deviceId: value.device_id || value.deviceId,
      serial: value.serial_number || value.serialNumber,
      mac,
    }),
    mac,
    alternateMacs,
    ...(alternateMacsTruncated ? { alternateMacsTruncated: true } : {}),
    ip: normalizeIp(value.ip || value.device_ip || value.deviceIp),
    switchIp: normalizeIp(value.switch_ip || value.switchIp),
    switchPort: text(value.switch_port || value.switchPort),
    manufacturer: text(value.manufacturer || value.vendor),
    ...(vendorConfidence === undefined ? {} : { vendorConfidence }),
    ...(vendorSource ? { vendorSource } : {}),
    model: text(value.model),
    ...(modelConfidence === undefined ? {} : { modelConfidence }),
    ...(modelSource ? { modelSource } : {}),
    deviceType: text(value.device_type || value.deviceType),
    hostname: text(value.hostname),
    serial: text(value.serial_number || value.serialNumber || value.serial),
    deviceId: text(value.device_id || value.deviceId),
    smartroomId: text(value.smartroom_id || value.smartroomId),
    room: text(value.room),
    address: text(value.address),
    physicalAddress: text(value.physical_address || value.physicalAddress),
    businessUnit: text(value.business_unit || value.businessUnit),
    city: text(value.city),
    site: text(value.site),
    floor: text(value.floor),
    deviceName: text(value.device_name || value.deviceName || value.name),
    authenticationTime: text(value.authentication_time || value.authenticationTime || value.recorded_at),
    possibleIps,
    ...(possibleIpsTruncated ? { possibleIpsTruncated: true } : {}),
    fieldSources,
    conflicts,
    ...(conflictsTruncated ? { conflictsTruncated: true } : {}),
    sources,
    ...(Object.keys(customFields).length ? { customFields } : {}),
    ...(Object.keys(customFieldSources).length ? { customFieldSources } : {}),
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

export function normalizeLegacyTimestamp(value, fallback) {
  const asDateValue = (candidate) => typeof candidate === "number" ? new Date(candidate) : candidate;
  return normalizeDate(asDateValue(value)) || normalizeDate(asDateValue(fallback)) || new Date().toISOString();
}

const normalizedTimestamp = normalizeLegacyTimestamp;

function importedOccurrences(value) {
  if (value === undefined || value === null || text(value) === "") return 1;
  return Math.max(0, Number(value) || 0);
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

function countSkippedRow(report, table) {
  report.skippedRows[table] = (report.skippedRows[table] || 0) + 1;
}

function legacyMovement(row = {}) {
  const mac = normalizeMac(row.mac);
  const field = text(row.field_name);
  const normalizedFields = {
    ip: "ip", device_ip: "ip", switch_ip: "switchIp", switch_port: "switchPort",
    physical_address: "address", room: "room", vendor: "manufacturer", serial_number: "serial",
    hostname: "hostname", device_id: "deviceId", model: "model",
  };
  const timestamp = normalizedTimestamp(row.timestamp || row.changed_at, new Date().toISOString());
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
    source: text(row.source_file || row.source) || "Импорт SQLite",
    timestamp,
  };
}

function legacyObservation(table, row = {}) {
  const payload = table === "resolved_device_history" ? { ...row, decodedPayload: parseObject(row.payload_json) } : { ...row };
  const observedAt = normalizedTimestamp(row.timestamp || row.recorded_at || row.observed_at || row.last_seen, new Date().toISOString());
  const mac = firstMac(row.mac, payload.mac, payload.mac_formatted);
  return {
    id: legacyRowId(table, row),
    kind: table,
    sourceTable: table,
    source: text(row.source_file || row.source) || "Импорт SQLite",
    observedAt,
    mac,
    internalDeviceId: text(row.internal_device_id || payload.internal_device_id || payload.internalDeviceId),
    payload,
  };
}

function legacyMacVendorModelObservation(table, row = {}) {
  const mac = firstMac(row.mac);
  const isVendor = table === "mac_vendor_history";
  const value = text(isVendor ? row.vendor : row.model);
  if (!mac || !value) return null;
  const observedAt = normalizedTimestamp(row.last_seen || row.source_date || row.first_seen, new Date().toISOString());
  const sourceFile = text(row.source_file);
  const confidenceValue = Number(isVendor ? row.vendor_confidence : row.model_confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.93;
  const timesSeen = importedOccurrences(row.times_seen);
  return {
    id: legacyRowId(table, row),
    kind: "vendor_model_history",
    sourceTable: "vendor_model_history",
    source: sourceFile || "Импорт SQLite",
    observedAt,
    mac,
    internalDeviceId: "",
    payload: {
      id: text(row.id),
      legacySourceTable: table,
      mac,
      vendor: isVendor ? value : "",
      model: isVendor ? "" : value,
      vendorConfidence: isVendor ? confidence : 0,
      modelConfidence: isVendor ? 0 : confidence,
      source_file: sourceFile,
      source_date: text(row.source_date),
      first_seen: text(row.first_seen),
      last_seen: text(row.last_seen),
      times_seen: timesSeen,
    },
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
    table === "history_loads" ? row.load_date : table === "exports" ? row.export_date : row.timestamp || row.date || row.created_at,
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
  } else if (table === "exports") {
    const filename = text(row.filename).split(/[\\/]/).filter(Boolean).at(-1) || "";
    payload = {
      id: text(row.id),
      filename: filename.slice(0, 1024),
      exportDate: text(row.export_date),
      devicesCount: Math.max(0, Number(row.devices_count) || 0),
      formatType: text(row.format_type).slice(0, 100),
      user: text(row.user).slice(0, 200),
      notes: text(row.notes).slice(0, 2000),
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
  if (tables.has("snapshots") && tables.has("app_autosaves")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT "slot", "state_json" FROM "app_autosaves"');
    for await (const row of sourceRows) {
      const reference = legacyAutosaveReferenceId(row.state_json);
      if (reference) legacySnapshotReferences.add(reference);
    }
  }
  const emitRows = async function* (collection, sourceRows, mapRow, sourceTable = collection) {
    let batch = [];
    let recordsRead = 0;
    for await (const row of sourceRows) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      recordsRead += 1;
      const mapped = mapRow(row);
      if (!mapped) {
        countSkippedRow(report, sourceTable);
        continue;
      }
      batch.push(mapped);
      recordCount += 1;
      report.imported[collection] = (report.imported[collection] || 0) + 1;
      if (batch.length >= SQLITE_PAGE_SIZE) {
        onProgress({ collection, recordsRead, table: sourceTable });
        yield { type: "records", collection, records: batch };
        batch = [];
      }
    }
    if (batch.length) {
      onProgress({ collection, recordsRead, table: sourceTable });
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
        if (!device) {
          countSkippedRow(report, "snapshots.devices");
          continue;
        }
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
  let resolvedInventoryIdentityIndex = null;
  if (tables.has("device_inventory") && tables.has("resolved_device_inventory")) {
    const countRows = await sqlite.run('SELECT COUNT(*) AS count FROM "resolved_device_inventory"');
    const candidateCount = Number(countRows[0]?.count);
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) throw new Error("Не удалось определить число resolved Inventory-строк для identity-сопоставления");
    resolvedInventoryIdentityIndex = createPositionedIdentityIndex(candidateCount);
    let position = 0;
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "resolved_device_inventory"');
    for await (const row of sourceRows) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      const device = legacyDevice(row);
      if (device) {
        const payload = parseObject(row.payload_json);
        resolvedInventoryIdentityIndex.addCandidate(position, {
          internalDeviceId: text(row.internal_device_id || payload.internal_device_id || payload.internalDeviceId),
          deviceId: device.deviceId,
          serial: device.serial,
          mac: device.mac,
          alternateMacs: device.alternateMacs,
          canonicalId: device.id,
        });
      }
      position += 1;
    }
    if (position !== candidateCount) throw new Error("Число resolved Inventory-строк изменилось во время SQLite-импорта");
    report.identityReconciliation = { linked: 0, ambiguous: 0, conflicts: 0 };
  }

  const inventoryTables = ["device_inventory", "resolved_device_inventory"].filter((table) => tables.has(table));
  for (const table of inventoryTables) {
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("inventory", sourceRows, (row) => {
      let device = legacyDevice(row);
      if (!device) return null;
      if (table === "device_inventory" && resolvedInventoryIdentityIndex) {
        const candidate = { deviceId: device.deviceId, serial: device.serial, mac: device.mac, alternateMacs: device.alternateMacs };
        const match = findIdentityMatch(candidate, resolvedInventoryIdentityIndex);
        if (match.status === "ambiguous") report.identityReconciliation.ambiguous += 1;
        else if (match.status === "matched") {
          const conflicts = conflictingStrongFields(candidate, match.match);
          if (conflicts.length || match.identityConflicts?.length) report.identityReconciliation.conflicts += 1;
          else if (match.match.canonicalId) {
            device = { ...device, id: match.match.canonicalId };
            report.identityReconciliation.linked += 1;
          }
        }
      }
      return inventoryRecord(device, row, timestamp);
    }, table);
  }

  if (tables.has("vendor_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "vendor_mappings"');
    yield* emitRows("oui", sourceRows, (row) => {
      const prefix = normalizeOuiPrefix(row.oui);
      const vendor = text(row.vendor);
      return prefix && vendor ? { prefix, vendor, source: text(row.source) || "Импорт SQLite", updatedAt: text(row.updated_at) || timestamp } : null;
    }, "vendor_mappings");
  }
  if (tables.has("oui_vendor_history")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "oui_vendor_history"');
    yield* emitRows("oui", sourceRows, (row) => {
      const prefix = normalizeOuiPrefix(row.oui_3byte);
      const vendor = text(row.vendor);
      const updatedAt = normalizedTimestamp(row.last_seen || row.updated_at, timestamp);
      return prefix && vendor ? {
        prefix, vendor, source: "Импорт SQLite: OUI history", updatedAt,
        occurrences: importedOccurrences(row.occurrences),
        firstSeen: row.first_seen ? normalizedTimestamp(row.first_seen, updatedAt) : "",
        lastSeen: updatedAt,
      } : null;
    }, "oui_vendor_history");
  }
  if (tables.has("model_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "model_mappings"');
    yield* emitRows("mac5Models", sourceRows, (row) => {
      const prefix = normalizeMacPrefix(row.prefix);
      const model = text(row.model);
      return prefix && model ? { prefix, model, source: text(row.source) || "Импорт SQLite", updatedAt: text(row.updated_at) || timestamp } : null;
    }, "model_mappings");
  }
  if (tables.has("mac5_model_history")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "mac5_model_history"');
    yield* emitRows("mac5Models", sourceRows, (row) => {
      const prefix = normalizeMacPrefix(row.mac_5byte);
      const model = text(row.model);
      const updatedAt = normalizedTimestamp(row.last_seen || row.updated_at, timestamp);
      return prefix && model ? {
        prefix, model, source: "Импорт SQLite: MAC5 history", updatedAt,
        occurrences: importedOccurrences(row.occurrences),
        firstSeen: row.first_seen ? normalizedTimestamp(row.first_seen, updatedAt) : "",
        lastSeen: updatedAt,
      } : null;
    }, "mac5_model_history");
  }
  if (tables.has("ip_address_mappings")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "ip_address_mappings"');
    const mappings = createIpMappingAccumulator();
    for await (const row of sourceRows) {
      if (!mappings.accept({ switchIp: row.switch_ip, address: row.physical_address, source: text(row.source) || "Импорт SQLite" })) countSkippedRow(report, "ip_address_mappings");
    }
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
    yield* emitRows("history", sourceRows, legacyMovement, "mac_movements");
  }

  for (const table of ["mac_history", "resolved_device_history", "vendor_model_history"]) {
    if (!tables.has(table)) continue;
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyObservation(table, row), table);
  }

  for (const table of ["mac_vendor_history", "mac_model_history"]) {
    if (!tables.has(table)) continue;
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMacVendorModelObservation(table, row), table);
  }

  if (tables.has("api_cache")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "api_cache"');
    yield* emitRows("legacyObservations", sourceRows, legacyApiCacheVendorObservation, "api_cache");
  }

  for (const table of ["history_loads", "analysis_history", "performance_metrics", "exports"]) {
    if (!tables.has(table)) continue;
    if (table === "performance_metrics") {
      recordCount += yield* legacyPerformanceMetricEvents(runtime, sqlite, onProgress, signal, report);
      continue;
    }
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMigrationObservation(table, row), table);
  }

  if (tables.has("daily_stats")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT * FROM "daily_stats"');
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMigrationObservation("daily_stats", row), "daily_stats");
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
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyTaskObservation(table, row, sourceNamespace), table);
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
    }, "data_quality_reports");
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
    }, "smartroom_room_mappings");
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
        if (!viewName || viewName.length > 160 || typeof row.columns_json !== "string"
          || row.columns_json.length > MAX_LEGACY_COLUMN_PREFERENCES_CHARS) return null;
        return { key: `legacyColumnPreferences:${viewName}`, value: row.columns_json };
      }
      return null;
    }, table);
  }

  report.records = recordCount;
  const unsupported = LEGACY_SQLITE_TABLES.filter((table) => tables.has(table) && ![
    "snapshots", "device_inventory", "resolved_device_inventory", "vendor_mappings", "model_mappings",
    "oui_vendor_history", "mac5_model_history", "mac_vendor_history", "mac_model_history", "daily_stats", "exports",
    "ip_address_mappings", "mac_movements", "mac_history", "resolved_device_history", "vendor_model_history", "api_cache", "scheduled_tasks", "task_file_queue", "data_quality_reports", "smartroom_room_mappings", "app_settings", "app_autosaves", "column_preferences", "history_loads", "analysis_history", "performance_metrics",
  ].includes(table));
  for (const table of unsupported) {
    const reason = "Next пока не имеет эквивалентной модели данных для этой таблицы";
    if (!report.skippedTables.some((item) => item.table === table)) report.skippedTables.push({ table, reason });
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
  const report = { importId, fileName: String(file.name || "database.sqlite"), sourceBytes: file.size, integrity: "", tables: [], imported: {}, skippedTables: [], skippedRows: {} };
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
      const required = LEGACY_SQLITE_TABLE_REQUIREMENTS[table];
      if (!required) {
        validTables.add(table);
        continue;
      }
      const columns = new Set((await sqlite.run(`PRAGMA table_info(${quoteIdentifier(table)})`)).map((column) => String(column.name)));
      const missing = required.filter((column) => !columns.has(column));
      const missingAlternatives = (LEGACY_SQLITE_TABLE_COLUMN_ALTERNATIVES[table] || [])
        .filter((alternatives) => !alternatives.some((column) => columns.has(column)))
        .map((alternatives) => alternatives.join(" или "));
      missing.push(...missingAlternatives);
      if (missing.length) report.skippedTables.push({ table, reason: `В таблице отсутствуют поля: ${missing.join(", ")}` });
      else validTables.add(table);
    }
    if (!validTables.size) throw new Error("В SQLite не найдены таблицы MAC Analyzer с совместимой схемой");
    const generator = legacyEvents(runtime, sqlite, importId, sourceNamespace, validTables, onProgress, signal, report);
    await database.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, generator, {
      preserveActiveSnapshot: true,
      allowDuplicateInventoryIds: true,
    });
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
    const canStreamBlob = typeof globalThis.TransformStream === "function" && typeof globalThis.Response === "function";
    let blobWriter = null;
    let blobPromise = null;
    if (canStreamBlob) {
      const stream = new globalThis.TransformStream();
      blobWriter = stream.writable.getWriter();
      blobPromise = new globalThis.Response(stream.readable, { headers: { "Content-Type": "application/octet-stream" } }).blob();
    }
    const chunkChars = 64 * 1024;
    try {
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
        if (blobWriter) await blobWriter.write(bytes);
        else parts.push(bytes);
        onProgress({ readChars: offset + take, totalChars });
      }
      let blob;
      if (blobWriter) {
        await blobWriter.close();
        blob = await blobPromise;
      } else blob = new Blob(parts, { type: "application/octet-stream" });
      return { filename: String(meta.filename || payload.filename || "queued-file"), blob, contentBase64Chars: totalChars };
    } catch (error) {
      await blobWriter?.abort(error).catch(() => {});
      await blobPromise?.catch(() => {});
      throw error;
    }
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
