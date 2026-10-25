import { conflictingStrongFields, createPositionedIdentityIndex, findIdentityMatch, stableId, visitDeviceAlternateMacs } from "../core/identity.js";
import { firstMac, keyText, MAX_DEVICE_ALTERNATIVES, MAX_DEVICE_CONFLICTS, normalizeDate, normalizeMac, normalizeIp, text } from "../core/normalize.js";
import { normalizeMacPrefix } from "../core/model-knowledge.js";
import { normalizeOuiPrefix } from "../core/ieee-registry.js";
import { createIpMappingAccumulator } from "../core/ip-mapping.js";
import { DEFAULT_SHA256_CHUNK_BYTES, IncrementalSha256, sha256File } from "../core/incremental-sha256.js";
import { normalizePerformanceMetric } from "../core/performance-statistics.js";
import { customInventoryColumnKey } from "../core/inventory-columns.js";
import { historyConfidenceFromOccurrences } from "../core/history-confidence.js";
import { mergeInventoryObservations } from "../core/inventory-merge.js";
import { assertBrowserHeapCapacity, assertSourceFileCapacity, IMPORT_LIMITS } from "../core/import-limits.js";

export const LEGACY_SQLITE_TABLES = Object.freeze([
  "resolved_device_inventory", "resolved_device_history", "device_inventory", "mac_history", "app_logs",
  "mac_movements", "vendor_model_history", "snapshots", "vendor_mappings", "model_mappings",
  "ip_address_mappings", "smartroom_room_mappings", "column_preferences", "api_cache",
  "data_quality_reports", "scheduled_tasks", "task_file_queue", "app_settings", "app_autosaves",
  "history_loads", "analysis_history", "performance_metrics", "oui_vendor_history", "mac5_model_history", "mac_vendor_history", "mac_model_history", "daily_stats", "exports",
]);

const DERIVED_SQLITE_TABLES = Object.freeze(["resolved_device_identity_aliases"]);

const OMITTED_SQLITE_TABLE_REASONS = Object.freeze({
  notification_settings: "Настройки внешних каналов и секреты уведомлений не переносятся в локальный browser-only режим.",
  engineering_sessions: "Учетные данные и активные инженерные сессии не переносятся между приложениями.",
});

const SQLITE_HEADER = "SQLite format 3\0";
const SQLITE_STREAM_HEADER_BYTES = 32;
const SQLITE_IMPORT_LIMIT = 1024 * 1024 * 1024;
const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_WAL_FRAME_HEADER_BYTES = 24;
const SQLITE_PAGE_SIZE = 500;
const SQLITE_HIGH_VOLUME_OBSERVATION_BATCH_SIZE = 5_000;
const DEVICE_BATCH_SIZE = 500;
const MAX_LEGACY_TASK_FILE_BASE64_CHARS = 40 * 1024 * 1024;
const MAX_LEGACY_AUTOSAVE_REFERENCE_BYTES = 1024 * 1024;
const MAX_LEGACY_COLUMN_PREFERENCES_CHARS = 256 * 1024;
const MAX_LEGACY_COLUMN_PREFERENCES_BYTES = 1024 * 1024;
const LEGACY_ID_JSON_SHORT_ESCAPES = Object.freeze({ 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" });
export const LEGACY_SQLITE_TABLE_REQUIREMENTS = Object.freeze({
  resolved_device_history: ["observation_key", "internal_device_id", "payload_json", "recorded_at"],
  mac_history: ["mac"],
  app_logs: ["id", "action", "created_at"],
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

function parseObjectWithStatus(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { value, parsed: true };
  if (typeof value !== "string" || !value.trim()) return { value: {}, parsed: false };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { value: parsed, parsed: true }
      : { value: {}, parsed: false };
  } catch {
    return { value: {}, parsed: false };
  }
}

function parseObject(value) {
  return parseObjectWithStatus(value).value;
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

function legacySettingValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
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

function legacyIdentity(value = {}, canonicalId = "", target = {}) {
  const primaryMac = firstMac(value.mac, value.mac_formatted, value.CallingStationID);
  const normalizedAliasMacs = [];
  let aliasesOverflow = false;
  visitDeviceAlternateMacs(value, (alternate) => {
    if (normalizedAliasMacs.length > MAX_DEVICE_ALTERNATIVES) {
      aliasesOverflow = true;
      return false;
    }
    normalizedAliasMacs.push(alternate);
    return true;
  });
  const mac = primaryMac || normalizedAliasMacs[0] || "";
  const normalizedAlternateMacs = normalizedAliasMacs.filter((alternate) => alternate !== mac);
  const alternateMacs = normalizedAlternateMacs.slice(0, MAX_DEVICE_ALTERNATIVES);
  const alternateMacsTruncated = Boolean(value.alternateMacsTruncated || aliasesOverflow || normalizedAlternateMacs.length > MAX_DEVICE_ALTERNATIVES);
  const deviceId = text(value.device_id || value.deviceId);
  const serial = text(value.serial_number || value.serialNumber || value.serial);
  const internalDeviceId = text(value.internal_device_id || value.internalDeviceId);
  const id = canonicalId || stableId({
    internalDeviceId: value.internal_device_id || value.internalDeviceId,
    deviceId: value.device_id || value.deviceId,
    serial: value.serial_number || value.serialNumber,
    mac,
  });
  if (!id || !mac && !serial && !deviceId) return null;
  target.id = id;
  target.internalDeviceId = internalDeviceId;
  target.deviceId = deviceId;
  target.serial = serial;
  target.mac = mac;
  target.alternateMacs = alternateMacs;
  if (alternateMacsTruncated) target.alternateMacsTruncated = true;
  else if (Object.hasOwn(target, "alternateMacsTruncated")) delete target.alternateMacsTruncated;
  return target;
}

function legacyDevice(row = {}, canonicalId = "", { identityOnly = false } = {}) {
  const payload = parseObject(row.payload_json);
  const value = { ...payload, ...row };
  if (identityOnly) return legacyIdentity(value, canonicalId);
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
  const storedPossibleIps = Array.isArray(value.possibleIps)
    ? value.possibleIps
    : typeof value.possibleIps === "string" ? value.possibleIps.split(",") : [];
  const possibleIps = [...new Set(storedPossibleIps.slice(0, MAX_DEVICE_ALTERNATIVES).map(normalizeIp).filter(Boolean))];
  const possibleIpsTruncated = Boolean(value.possibleIpsTruncated || storedPossibleIps.length > MAX_DEVICE_ALTERNATIVES);
  const device = {
    id: "",
    mac: "",
    alternateMacs: [],
    alternateMacsTruncated: false,
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
    serial: "",
    deviceId: "",
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
  if (!legacyIdentity(value, canonicalId, device)) return null;
  delete device.internalDeviceId;
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
        const row = Object.create(null);
        for (let index = 0; index < columns.length; index += 1) row[columns[index]] = values[index];
        yield row;
      }
    }
    return;
  }
  yield* runtime.iterator(sqlite, sql, parameters, SQLITE_PAGE_SIZE);
}

function makeSnapshotId(sourceNamespace, sourceId) {
  return `legacy-sqlite-${sourceNamespace}-${String(sourceId).slice(0, 160)}`;
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

function hashLegacyIdText(state, value, start = 0, end = value.length) {
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    // Match the historical code-point loop, which hashes only the leading
    // UTF-16 code unit for a valid surrogate pair.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff && index + 1 < end) index += 1;
    }
    state.low = (state.low ^ code) >>> 0;
    const product = state.low * 0x1b3;
    const carry = Math.floor(product / 0x100000000);
    state.high = (Math.imul(state.high, 0x1b3) + Math.imul(state.low, 0x100) + carry) >>> 0;
    state.low = product >>> 0;
  }
}

function hashLegacyIdJsonString(state, value) {
  hashLegacyIdText(state, '"');
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index += 1; continue; }
    } else if (code < 0x20 || code === 34 || code === 92 || (code >= 0xdc00 && code <= 0xdfff)) {
      // JSON.stringify escapes control characters and unpaired surrogates.
    } else {
      continue;
    }
    hashLegacyIdText(state, value, segmentStart, index);
    hashLegacyIdText(state, LEGACY_ID_JSON_SHORT_ESCAPES[code] || `\\u${code.toString(16).padStart(4, "0")}`);
    segmentStart = index + 1;
  }
  hashLegacyIdText(state, value, segmentStart);
  hashLegacyIdText(state, '"');
}

function legacyRowId(table, row) {
  const state = { high: 0xcbf29ce4, low: 0x84222325 };
  hashLegacyIdText(state, `${table}:`);
  let flatSqliteRow = row && typeof row === "object" && Object.getPrototypeOf(row) === null;
  const keys = flatSqliteRow ? Object.keys(row) : [];
  for (const key of keys) {
    if (!flatSqliteRow) break;
    const value = row[key];
    if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      flatSqliteRow = false;
    }
  }
  if (!flatSqliteRow) {
    // Non-SQLite callers keep native JSON.stringify semantics.
    hashLegacyIdText(state, String(JSON.stringify(row)));
  } else {
    hashLegacyIdText(state, "{");
    let first = true;
    for (const key of keys) {
      const value = row[key];
      if (value === undefined) continue;
      if (!first) hashLegacyIdText(state, ",");
      first = false;
      hashLegacyIdJsonString(state, key);
      hashLegacyIdText(state, ":");
      if (typeof value === "string") hashLegacyIdJsonString(state, value);
      else hashLegacyIdText(state, JSON.stringify(value));
    }
    hashLegacyIdText(state, "}");
  }
  const hash = `${state.high.toString(16).padStart(8, "0")}${state.low.toString(16).padStart(8, "0")}`;
  return `legacy-${table}-${hash}`;
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
  const payload = { ...row };
  if (table === "resolved_device_history") {
    const decoded = parseObjectWithStatus(row.payload_json);
    payload.decodedPayload = decoded.value;
    if (decoded.parsed) delete payload.payload_json;
  }
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

const SAFE_LEGACY_LOG_ACTIONS = new Set([
  "Анализ завершён", "Вход в инженерный режим", "API cache cleared", "API request failed",
  "Autosave deleted", "Autosave", "Backend shutdown signal", "Column moved", "Column preferences reset",
  "Data quality report", "Database maintenance", "Delete database history", "Delete filtered movements",
  "Delete snapshots", "Engineering login", "Enrichment cancelled", "History enrichment settings updated",
  "Legacy MAC history synchronization failed", "OUI settings updated", "Save final state",
  "Save statistics snapshot", "Scheduled task run", "Scheduler task failed", "Settings deleted",
  "Settings updated", "Single file analysis", "Theme changed", "Vendor detector settings updated",
  "OUI reference synchronization failed", "OUI reference synchronized",
]);

function legacyApplicationLog(row = {}) {
  const action = text(row.action);
  const observedAt = normalizedTimestamp(row.created_at, new Date().toISOString());
  return {
    id: legacyRowId("app_logs", { id: row.id, action, created_at: row.created_at }),
    kind: "app_logs",
    sourceTable: "app_logs",
    source: "Импорт SQLite",
    observedAt,
    mac: "",
    internalDeviceId: "",
    payload: { action: SAFE_LEGACY_LOG_ACTIONS.has(action) ? action : "Другое действие" },
  };
}

function legacyMacVendorModelObservation(table, row = {}) {
  const mac = firstMac(row.mac);
  const isVendor = table === "mac_vendor_history";
  const value = text(isVendor ? row.vendor : row.model);
  if (!mac || !value) return null;
  const observedAt = normalizedTimestamp(row.last_seen || row.source_date || row.first_seen, new Date().toISOString());
  const sourceFile = text(row.source_file);
  const timesSeen = importedOccurrences(row.times_seen);
  const confidence = legacyConfidence(isVendor ? row.vendor_confidence : row.model_confidence)
    ?? historyConfidenceFromOccurrences(timesSeen);
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
      value: metric,
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
    contentRetainedInSourceDatabase: contentBase64Chars > 0 && !validContent,
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

async function* legacyEvents(runtime, sqlite, sourceNamespace, tables, onProgress, signal, report) {
  let ordinal = 0;
  let recordCount = 0;
  const legacySnapshotReferences = new Set();
  const legacySnapshotIds = new Map();
  const sourceRowCounts = new Map();
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
  };
  const countSourceRows = async (sourceTable) => {
    throwIfAborted();
    let total = 0;
    for (const table of sourceTable.split("+").map((value) => value.trim()).filter(Boolean)) {
      throwIfAborted();
      let count = sourceRowCounts.get(table);
      if (count === undefined) {
        onProgress({ stage: "mapping", table: sourceTable, recordsProcessed: 0, totalRecords: null, counting: true });
        try {
          const rows = await sqlite.run(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
          throwIfAborted();
          const candidate = Number(rows[0]?.count);
          count = Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
        } catch {
          throwIfAborted();
          count = null;
        }
        sourceRowCounts.set(table, count);
      }
      if (!Number.isSafeInteger(count) || count < 0) return null;
      total += count;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  if (tables.has("snapshots") && tables.has("app_autosaves")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT "slot", "state_json" FROM "app_autosaves"');
    for await (const row of sourceRows) {
      const reference = legacyAutosaveReferenceId(row.state_json);
      if (reference) legacySnapshotReferences.add(reference);
    }
  }
  const emitRows = async function* (collection, sourceRows, mapRow, sourceTable = collection, batchSize = SQLITE_PAGE_SIZE) {
    let batch = [];
    let recordsRead = 0;
    let lastProgressRead = -1;
    const totalRecords = await countSourceRows(sourceTable);
    throwIfAborted();
    const reportMappingProgress = () => {
      onProgress({ stage: "mapping", collection, table: sourceTable, recordsProcessed: recordsRead, totalRecords });
      lastProgressRead = recordsRead;
    };
    reportMappingProgress();
    for await (const row of sourceRows) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      recordsRead += Math.max(1, Number(row?.inventorySourceRowsRead) || 1);
      if (recordsRead - lastProgressRead >= batchSize) reportMappingProgress();
      const mapped = mapRow(row);
      const mappedRows = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
      if (!mappedRows.length) {
        if (sourceTable !== "device_inventory + resolved_device_inventory") countSkippedRow(report, sourceTable);
        continue;
      }
      for (const mappedRow of mappedRows) {
        batch.push(mappedRow);
        recordCount += 1;
        report.imported[collection] = (report.imported[collection] || 0) + 1;
        if (batch.length >= batchSize) {
          yield { type: "records", collection, records: batch };
          batch = [];
        }
      }
    }
    if (recordsRead !== lastProgressRead) reportMappingProgress();
    if (batch.length) {
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
      const snapshotId = makeSnapshotId(sourceNamespace, row.id);
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
          sourceKey: `sqlite:${sourceNamespace}:${row.id}`,
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
      const device = legacyDevice(row, "", { identityOnly: true });
      if (device) {
        resolvedInventoryIdentityIndex.addCandidate(position, {
          internalDeviceId: text(row.internal_device_id || device.internalDeviceId),
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
  let mergeAlignedInventoryTables = inventoryTables.length === 2 && Boolean(resolvedInventoryIdentityIndex);
  if (mergeAlignedInventoryTables) {
    try {
      await sqlite.run('SELECT d.rowid, r.rowid FROM "device_inventory" AS d LEFT JOIN "resolved_device_inventory" AS r ON r.rowid = d.rowid LIMIT 0');
    } catch {
      mergeAlignedInventoryTables = false;
    }
  }
  if (mergeAlignedInventoryTables) {
    const deviceColumns = (await sqlite.run('PRAGMA table_info("device_inventory")')).map(({ name }) => String(name));
    const resolvedColumns = (await sqlite.run('PRAGMA table_info("resolved_device_inventory")')).map(({ name }) => String(name));
    const selectColumns = [
      'd.rowid AS "__device_rowid"',
      'r.rowid AS "__resolved_rowid"',
      ...deviceColumns.map((name) => `d.${quoteIdentifier(name)} AS ${quoteIdentifier(`__device_${name}`)}`),
      ...resolvedColumns.map((name) => `r.${quoteIdentifier(name)} AS ${quoteIdentifier(`__resolved_${name}`)}`),
    ];
    const pairQuery = `SELECT ${selectColumns.join(", ")} FROM "device_inventory" AS d LEFT JOIN "resolved_device_inventory" AS r ON r.rowid = d.rowid ORDER BY d.rowid`;
    const pairedRows = async function* () {
      for await (const pair of sqliteRows(runtime, sqlite, pairQuery)) {
        const deviceRow = Object.fromEntries(deviceColumns.map((name) => [name, pair[`__device_${name}`]]));
        const resolvedRow = pair.__resolved_rowid === null || pair.__resolved_rowid === undefined
          ? null
          : Object.fromEntries(resolvedColumns.map((name) => [name, pair[`__resolved_${name}`]]));
        yield { deviceRow, resolvedRow, inventorySourceRowsRead: 1 + Number(Boolean(resolvedRow)) };
      }
      const resolvedOnlyColumns = [
        'r.rowid AS "__resolved_rowid"',
        ...resolvedColumns.map((name) => `r.${quoteIdentifier(name)} AS ${quoteIdentifier(`__resolved_${name}`)}`),
      ];
      const resolvedOnlyQuery = `SELECT ${resolvedOnlyColumns.join(", ")} FROM "resolved_device_inventory" AS r WHERE NOT EXISTS (SELECT 1 FROM "device_inventory" AS d WHERE d.rowid = r.rowid) ORDER BY r.rowid`;
      for await (const row of sqliteRows(runtime, sqlite, resolvedOnlyQuery)) {
        const resolvedRow = Object.fromEntries(resolvedColumns.map((name) => [name, row[`__resolved_${name}`]]));
        yield { deviceRow: null, resolvedRow, inventorySourceRowsRead: 1 };
      }
    };
    const pairedRecord = (row, countIdentity, sourceTable) => {
      if (!row) return null;
      const device = legacyDevice(row);
      if (!device) {
        countSkippedRow(report, sourceTable);
        return null;
      }
      let linkedCanonicalId = "";
      if (countIdentity) {
        const candidate = { deviceId: device.deviceId, serial: device.serial, mac: device.mac, alternateMacs: device.alternateMacs };
        const match = findIdentityMatch(candidate, resolvedInventoryIdentityIndex);
        if (match.status === "ambiguous") report.identityReconciliation.ambiguous += 1;
        else if (match.status === "matched") {
          const conflicts = conflictingStrongFields(candidate, match.match);
          if (conflicts.length || match.identityConflicts?.length) report.identityReconciliation.conflicts += 1;
          else if (match.match.canonicalId) {
            linkedCanonicalId = match.match.canonicalId;
            device.id = linkedCanonicalId;
            report.identityReconciliation.linked += 1;
          }
        }
      }
      return { record: inventoryRecord(device, row, timestamp), linkedCanonicalId };
    };
    yield* emitRows("inventory", pairedRows(), (pair) => {
      const deviceRecord = pairedRecord(pair.deviceRow, true, "device_inventory");
      const resolvedRecord = pairedRecord(pair.resolvedRow, false, "resolved_device_inventory");
      if (deviceRecord?.linkedCanonicalId && resolvedRecord?.record.id === deviceRecord.linkedCanonicalId) {
        return mergeInventoryObservations(deviceRecord.record, resolvedRecord.record);
      }
      return [deviceRecord?.record, resolvedRecord?.record].filter(Boolean);
    }, "device_inventory + resolved_device_inventory");
  } else {
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
  }
  resolvedInventoryIdentityIndex?.clearCandidates();
  resolvedInventoryIdentityIndex = null;

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
    const batchSize = table === "mac_history" || table === "vendor_model_history"
      ? SQLITE_HIGH_VOLUME_OBSERVATION_BATCH_SIZE
      : SQLITE_PAGE_SIZE;
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyObservation(table, row), table, batchSize);
  }

  for (const table of ["mac_vendor_history", "mac_model_history"]) {
    if (!tables.has(table)) continue;
    const sourceRows = sqliteRows(runtime, sqlite, `SELECT * FROM ${quoteIdentifier(table)}`);
    yield* emitRows("legacyObservations", sourceRows, (row) => legacyMacVendorModelObservation(table, row), table, SQLITE_HIGH_VOLUME_OBSERVATION_BATCH_SIZE);
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

  if (tables.has("app_logs")) {
    const sourceRows = sqliteRows(runtime, sqlite, 'SELECT "id", "action", "created_at" FROM "app_logs"');
    yield* emitRows("legacyObservations", sourceRows, legacyApplicationLog, "app_logs");
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
    yield* emitRows("legacyObservations", sourceRows, (row) => {
      const observation = legacyTaskObservation(table, row, sourceNamespace);
      if (table === "task_file_queue" && observation.payload.contentRetainedInSourceDatabase) report.requiresSourceDatabaseRetention = true;
      return observation;
    }, table);
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
  const uiColumnPreferenceAliases = new Map();
  for (const table of settingTables) {
    if (!tables.has(table)) continue;
    const query = table === "column_preferences"
      ? `SELECT CASE WHEN length(CAST("view_name" AS BLOB)) <= 640 THEN "view_name" ELSE NULL END AS "view_name", CASE WHEN length(CAST("columns_json" AS BLOB)) <= ${MAX_LEGACY_COLUMN_PREFERENCES_BYTES} THEN "columns_json" ELSE NULL END AS "columns_json" FROM "column_preferences"`
      : `SELECT * FROM ${quoteIdentifier(table)}`;
    const sourceRows = sqliteRows(runtime, sqlite, query);
    yield* emitRows("settings", sourceRows, (row) => {
      if (table === "app_settings") return row.key ? {
        key: `legacyAppSetting:${String(row.key).slice(0, 240)}`,
        value: legacySettingValue(row.value),
      } : null;
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
        const sourceViewName = String(row.view_name || "");
        const viewName = sourceViewName.trim().toLowerCase();
        if (!viewName || viewName.length > 160 || typeof row.columns_json !== "string"
          || row.columns_json.length > MAX_LEGACY_COLUMN_PREFERENCES_CHARS) return null;
        const exactLowercaseName = sourceViewName === sourceViewName.trim() && sourceViewName === viewName;
        if (["inventory", "results"].includes(viewName)) {
          const current = uiColumnPreferenceAliases.get(viewName);
          if (!current || exactLowercaseName || !current.exact && sourceViewName < current.sourceViewName) {
            uiColumnPreferenceAliases.set(viewName, { exact: exactLowercaseName, sourceViewName, value: row.columns_json });
          }
        }
        // SQLite's TEXT primary key is case-sensitive. Preserve every original
        // spelling as well as the normalized alias used by Next's own views.
        const sourceKey = sourceViewName.split("")
          .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
          .join("");
        // Only exact lowercase names can safely populate Next's normalized
        // alias: SQLite permits case-distinct variants of the same alias.
        if (exactLowercaseName) {
          return { key: `legacyColumnPreferences:${viewName}`, value: row.columns_json };
        }
        return {
          key: `legacyColumnPreferences:source:${sourceKey}`,
          value: { viewName: sourceViewName, columnsJson: row.columns_json },
        };
      }
      return null;
    }, table);
    if (table === "column_preferences") {
      const aliases = [...uiColumnPreferenceAliases]
        .filter(([, preference]) => !preference.exact)
        .map(([viewName, preference]) => ({ key: `legacyColumnPreferences:${viewName}`, value: preference.value }));
      if (aliases.length) {
        yield { type: "records", collection: "settings", records: aliases };
        recordCount += aliases.length;
        report.imported.settings = (report.imported.settings || 0) + aliases.length;
      }
    }
  }

  report.records = recordCount;
  const unsupported = LEGACY_SQLITE_TABLES.filter((table) => tables.has(table) && ![
    "snapshots", "device_inventory", "resolved_device_inventory", "vendor_mappings", "model_mappings", "app_logs",
    "oui_vendor_history", "mac5_model_history", "mac_vendor_history", "mac_model_history", "daily_stats", "exports",
    "ip_address_mappings", "mac_movements", "mac_history", "resolved_device_history", "vendor_model_history", "api_cache", "scheduled_tasks", "task_file_queue", "data_quality_reports", "smartroom_room_mappings", "app_settings", "app_autosaves", "column_preferences", "history_loads", "analysis_history", "performance_metrics",
  ].includes(table));
  for (const table of unsupported) {
    const reason = "Next пока не имеет эквивалентной модели данных для этой таблицы";
    if (!report.skippedTables.some((item) => item.table === table)) report.skippedTables.push({ table, reason });
  }
}

export async function importLegacySQLiteFile(file, database, {
  walFile = null,
  signal,
  onProgress = () => {},
  runtime = globalThis.__MAC_ANALYZER_SQLITE_RUNTIME__,
  wasmUrl = globalThis.__MAC_ANALYZER_SQLITE_WASM_URL__,
  deleteTemporaryDatabase = deleteSqliteIdb,
} = {}) {
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size < 100) throw new Error("Выбранный SQLite-файл отсутствует или слишком мал");
  if (file.size > SQLITE_IMPORT_LIMIT) throw new Error("SQLite-файл превышает поддерживаемый размер 1 ГиБ");
  const header = new TextDecoder().decode(await file.slice(0, SQLITE_HEADER.length).arrayBuffer());
  if (header !== SQLITE_HEADER) throw new Error("Выбранный файл не является базой SQLite");
  const journalHeader = new Uint8Array(await file.slice(18, 20).arrayBuffer());
  if (journalHeader.length !== 2 || !([1, 1].includes(journalHeader[0]) && [1, 1].includes(journalHeader[1]))
    && !(journalHeader[0] === 2 && journalHeader[1] === 2)) {
    throw new Error("Заголовок SQLite содержит неподдерживаемый режим журнала");
  }
  const walMode = journalHeader[0] === 2;
  if (walMode && (!walFile || walFile.name !== `${file.name}-wal`)) {
    throw new Error(`Для WAL-базы выберите вместе с ней файл ${file.name}-wal`);
  }
  if (!walMode && walFile) throw new Error("WAL-файл выбран для базы, которая не помечена как WAL");
  if (walFile?.size > SQLITE_IMPORT_LIMIT - file.size) throw new Error("Суммарный размер SQLite-файла и WAL превышает 1 ГиБ");
  if (!runtime?.initSQLite || !runtime?.useIdbStorage || !runtime?.withExistDB || !runtime?.iterator || !wasmUrl) {
    throw new Error("SQLite-WASM runtime не встроен в приложение");
  }
  const importId = crypto.randomUUID();
  // SQLite reserves room for journal suffixes within the VFS's 64-character
  // pathname limit, so keep the base path at or below 56 characters.
  const idbName = `mac-analyzer-${importId}.db`;
  let sqlite;
  let sqliteVfs;
  let successful = false;
  let retainSourceDatabase = false;
  let sourceDatabaseDeleted = false;
  let replacedSourceIdbName = "";
  const report = { importId, fileName: String(file.name || "database.sqlite"), sourceBytes: file.size, walBytes: Number(walFile?.size) || 0, integrity: "", tables: [], imported: {}, skippedTables: [], skippedRows: {} };
  try {
    onProgress({ stage: "copying", fileName: report.fileName, sourceBytes: file.size });
    let sourceDigest = "";
    let walDigest = "";
    let sourcePageSize = 0;
    const stream = createSQLitePageImportStream(file, {
      normalizeEmptyWal: walMode && walFile.size === 0,
      signal,
      onPageSize: (size) => { sourcePageSize = size; },
      onSourceDigest: (digest) => { sourceDigest = digest; },
      onProgress: ({ bytesRead, totalBytes }) => onProgress({ stage: "copying", fileName: report.fileName, bytesRead, totalBytes }),
    });
    const baseOptions = runtime.withExistDB(stream, { url: wasmUrl, readonly: true });
    const options = walFile?.size > 0 ? {
      ...baseOptions,
      beforeOpen: async (vfs, path) => {
        await baseOptions.beforeOpen?.(vfs, path);
        const wal = await inspectSQLiteWal(walFile, sourcePageSize, {
          signal,
          onProgress: ({ bytesRead, totalBytes }) => onProgress({ stage: "checkpointing", fileName: walFile.name, bytesRead, totalBytes }),
        });
        walDigest = wal.digest;
        await checkpointSQLiteWalIntoVfs(vfs, path, walFile, {
          pageSize: sourcePageSize,
          lastCommitFrame: wal.lastCommitFrame,
          finalDatabaseSize: wal.finalDatabaseSize,
          signal,
        });
      },
    } : baseOptions;
    const storage = await runtime.useIdbStorage(idbName, { ...options, url: wasmUrl, readonly: true });
    const createVfs = storage.vfsFn;
    storage.vfsFn = async (...args) => {
      sqliteVfs = await createVfs(...args);
      return sqliteVfs;
    };
    sqlite = await runtime.initSQLite(storage);
    if (!sourceDigest) {
      sourceDigest = await sha256File(file, {
        signal,
        onProgress: ({ bytesRead, totalBytes }) => onProgress({ stage: "hashing", fileName: report.fileName, bytesRead, totalBytes }),
      });
    }
    if (walFile?.size > 0) {
      const combinedSourceHash = new IncrementalSha256();
      combinedSourceHash.update(new globalThis.TextEncoder().encode(`mac-analyzer-sqlite-wal-v1\n${sourceDigest}\n${walDigest}`));
      sourceDigest = combinedSourceHash.digestHex();
    }
    const sourceNamespace = sourceDigest.slice(0, 24);
    report.sourceNamespace = sourceNamespace;
    const integrityRows = await sqlite.run("PRAGMA integrity_check");
    if (integrityRows.length !== 1 || String(integrityRows[0]?.integrity_check || "").toLowerCase() !== "ok") {
      throw new Error(`Проверка целостности SQLite не пройдена: ${String(integrityRows[0]?.integrity_check || "неизвестная ошибка")}`);
    }
    report.integrity = "ok";
    const tableRows = await sqlite.run("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const available = new Set(tableRows.map((row) => String(row.name)));
    report.tables = LEGACY_SQLITE_TABLES.filter((table) => available.has(table));
    const knownTables = new Set([...LEGACY_SQLITE_TABLES, ...DERIVED_SQLITE_TABLES]);
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
    const generator = legacyEvents(runtime, sqlite, sourceNamespace, validTables, onProgress, signal, report);
    const sourceReleasedEvents = (async function* () {
      try {
        yield* generator;
      } finally {
        // The read-only SQLite copy is no longer needed after its event stream
        // has been staged. Release its WASM connection and VFS before archive
        // validation/restoration allocates the destination records.
        const connection = sqlite;
        const vfs = connection?.vfs || sqliteVfs;
        sqlite = null;
        sqliteVfs = null;
        try {
          await connection?.close?.();
        } finally {
          await vfs?.close?.();
        }
        if (!report.requiresSourceDatabaseRetention) {
          await deleteTemporaryDatabase(idbName);
          sourceDatabaseDeleted = true;
        }
      }
    }());
    await database.importArchiveEvents({ format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1 }, sourceReleasedEvents, {
      preserveActiveSnapshot: true,
      allowDuplicateInventoryIds: true,
      onProgress,
      ...(signal ? { signal } : {}),
    });
    report.importedAt = new Date().toISOString();
    retainSourceDatabase = Boolean(report.requiresSourceDatabaseRetention);
    delete report.requiresSourceDatabaseRetention;
    report.sourceIdbName = retainSourceDatabase ? idbName : "";
    if (retainSourceDatabase) replacedSourceIdbName = await database.recordLegacySqliteImportSource(report) || "";
    else replacedSourceIdbName = await database.removeLegacySqliteImportSource?.(sourceNamespace) || "";
    successful = true;
    return report;
  } finally {
    await sqlite?.close().catch(() => {});
    await (sqlite?.vfs || sqliteVfs)?.close?.();
    if ((!successful || !retainSourceDatabase) && !sourceDatabaseDeleted) await deleteTemporaryDatabase(idbName);
    if (/^mac-analyzer-[0-9a-f-]{36}\.db$/i.test(replacedSourceIdbName)) {
      await deleteTemporaryDatabase(replacedSourceIdbName).catch(() => {});
    }
  }
}

export function resolveLegacySQLiteFileSelection(fileList) {
  const files = Array.from(fileList || []);
  const databases = files.filter((file) => /\.(?:sqlite|sqlite3|db)$/i.test(String(file?.name || "")));
  if (databases.length !== 1) throw new Error("Выберите один основной файл SQLite (.sqlite, .sqlite3 или .db)");
  const file = databases[0];
  const extras = files.filter((candidate) => candidate !== file);
  const walFile = extras.find((candidate) => candidate.name === `${file.name}-wal`);
  if (extras.length !== (walFile ? 1 : 0)) throw new Error(`Выберите только ${file.name} и, если он существует, ${file.name}-wal`);
  return { file, walFile: walFile || null };
}

export function createSQLitePageImportStream(file, { signal, normalizeEmptyWal = false, onPageSize = () => {}, onSourceDigest = () => {}, onProgress = () => {} } = {}) {
  let offset = 0;
  let pageSize = 0;
  let headerSent = false;
  let settled = false;
  let abortListener;
  let lastProgressBytes = 0;
  const sourceHash = new IncrementalSha256();
  const abortError = () => new DOMException("Импорт SQLite отменён", "AbortError");
  return new globalThis.ReadableStream({
    start(controller) {
      abortListener = () => {
        if (settled) return;
        settled = true;
        controller.error(abortError());
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();
    },
    async pull(controller) {
      try {
        if (signal?.aborted) throw abortError();
        if (!headerSent) {
          const header = new Uint8Array(await file.slice(0, SQLITE_STREAM_HEADER_BYTES).arrayBuffer());
          if (signal?.aborted) throw abortError();
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
          onPageSize(pageSize);
          if (pageCount === 0) view.setUint32(28, physicalPageCount, false);
          if (normalizeEmptyWal) header[18] = header[19] = 1;
          controller.enqueue(header);
          headerSent = true;
          return;
        }
        if (offset >= file.size) {
          settled = true;
          signal?.removeEventListener("abort", abortListener);
          controller.close();
          return;
        }
        const page = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + pageSize)).arrayBuffer());
        if (signal?.aborted) throw abortError();
        if (page.byteLength !== pageSize) throw new Error("Последняя страница SQLite неполная");
        offset += page.byteLength;
        sourceHash.update(page);
        if (normalizeEmptyWal && offset === pageSize) page[18] = page[19] = 1;
        if (offset === file.size || offset - lastProgressBytes >= DEFAULT_SHA256_CHUNK_BYTES) {
          lastProgressBytes = offset;
          onProgress({ bytesRead: offset, totalBytes: file.size });
        }
        controller.enqueue(page);
        if (offset === file.size) onSourceDigest(sourceHash.digestHex());
      } catch (error) {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", abortListener);
          controller.error(error);
        }
      }
    },
    cancel() {
      settled = true;
      signal?.removeEventListener("abort", abortListener);
    },
  });
}

function sqliteWalChecksum(bytes, seed, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first = seed[0] >>> 0;
  let second = seed[1] >>> 0;
  if (bytes.byteLength % 8 !== 0) throw new Error("WAL содержит неполный блок контрольной суммы");
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    first = (first + view.getUint32(offset, littleEndian) + second) >>> 0;
    second = (second + view.getUint32(offset + 4, littleEndian) + first) >>> 0;
  }
  return [first, second];
}

function assertSQLiteWalChecksum(bytes, offset, checksum) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(offset, false) !== checksum[0] || view.getUint32(offset + 4, false) !== checksum[1]) {
    throw new Error("Контрольная сумма WAL не совпадает; импорт остановлен без изменения основной базы");
  }
}

async function inspectSQLiteWal(file, pageSize, { signal, onProgress = () => {} } = {}) {
  const header = new Uint8Array(await file.slice(0, SQLITE_WAL_HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== SQLITE_WAL_HEADER_BYTES) throw new Error("Заголовок WAL неполный");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, false);
  const checksumLittleEndian = magic === 0x377f0682;
  const encodedPageSize = view.getUint32(8, false);
  const walPageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  const frameBytes = SQLITE_WAL_FRAME_HEADER_BYTES + pageSize;
  if (![0x377f0682, 0x377f0683].includes(magic)
    || view.getUint32(4, false) !== 3007000 || !pageSize || walPageSize !== pageSize
    || file.size <= SQLITE_WAL_HEADER_BYTES || (file.size - SQLITE_WAL_HEADER_BYTES) % frameBytes !== 0) {
    throw new Error("Заголовок или длина WAL не соответствует основной SQLite-базе");
  }
  let checksum = sqliteWalChecksum(header.subarray(0, 24), [0, 0], checksumLittleEndian);
  assertSQLiteWalChecksum(header, 24, checksum);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const hash = new IncrementalSha256();
  hash.update(header);
  const frameCount = (file.size - SQLITE_WAL_HEADER_BYTES) / frameBytes;
  let lastCommitFrame = 0;
  let finalDatabaseSize = 0;
  let offset = SQLITE_WAL_HEADER_BYTES;
  for (let frameNumber = 1; frameNumber <= frameCount; frameNumber += 1) {
    if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
    const frameHeader = new Uint8Array(await file.slice(offset, offset + SQLITE_WAL_FRAME_HEADER_BYTES).arrayBuffer());
    const page = new Uint8Array(await file.slice(offset + SQLITE_WAL_FRAME_HEADER_BYTES, offset + frameBytes).arrayBuffer());
    if (frameHeader.byteLength !== SQLITE_WAL_FRAME_HEADER_BYTES || page.byteLength !== pageSize) throw new Error("Кадр WAL неполный");
    const frameView = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength);
    if (frameView.getUint32(0, false) === 0
      || frameView.getUint32(8, false) !== headerView.getUint32(16, false)
      || frameView.getUint32(12, false) !== headerView.getUint32(20, false)) {
      throw new Error("WAL содержит кадр с неверным номером страницы или солью");
    }
    checksum = sqliteWalChecksum(frameHeader.subarray(0, 8), checksum, checksumLittleEndian);
    checksum = sqliteWalChecksum(page, checksum, checksumLittleEndian);
    assertSQLiteWalChecksum(frameHeader, 16, checksum);
    hash.update(frameHeader);
    hash.update(page);
    const commitSize = frameView.getUint32(4, false);
    if (commitSize > 0) {
      lastCommitFrame = frameNumber;
      finalDatabaseSize = commitSize;
    }
    offset += frameBytes;
    if (offset === file.size || offset % DEFAULT_SHA256_CHUNK_BYTES < frameBytes) onProgress({ bytesRead: offset, totalBytes: file.size });
  }
  if (!lastCommitFrame || !finalDatabaseSize) throw new Error("WAL не содержит завершённой транзакции для импорта");
  return { digest: hash.digestHex(), lastCommitFrame, finalDatabaseSize };
}

async function checkpointSQLiteWalIntoVfs(vfs, path, file, { pageSize, lastCommitFrame, finalDatabaseSize, signal }) {
  const fileId = 1234;
  const ignored = new DataView(new ArrayBuffer(8));
  const opened = await vfs.jOpen(path, fileId, 262, ignored);
  if (opened !== 0) throw new Error(`SQLite VFS не смог открыть временную копию для WAL: код ${opened}`);
  const unlock = [];
  try {
    for (const [level, unlockLevel] of [[1, 0], [2, 1]]) {
      const result = await vfs.jLock(fileId, level);
      if (result !== 0) throw new Error(`SQLite VFS не смог заблокировать временную копию: код ${result}`);
      unlock.push(unlockLevel);
    }
    const exclusive = await vfs.jLock(fileId, 4);
    if (exclusive !== 0) throw new Error(`SQLite VFS не смог заблокировать временную копию: код ${exclusive}`);
    await vfs.jFileControl(fileId, 31, ignored);
    const frameBytes = SQLITE_WAL_FRAME_HEADER_BYTES + pageSize;
    let offset = SQLITE_WAL_HEADER_BYTES;
    for (let frameNumber = 1; frameNumber <= lastCommitFrame; frameNumber += 1) {
      if (signal?.aborted) throw new DOMException("Импорт SQLite отменён", "AbortError");
      const frameHeader = new Uint8Array(await file.slice(offset, offset + SQLITE_WAL_FRAME_HEADER_BYTES).arrayBuffer());
      const pageNumber = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength).getUint32(0, false);
      const page = new Uint8Array(await file.slice(offset + SQLITE_WAL_FRAME_HEADER_BYTES, offset + frameBytes).arrayBuffer());
      if (pageNumber <= finalDatabaseSize) {
        const result = await vfs.jWrite(fileId, page, (pageNumber - 1) * pageSize);
        if (result !== 0) throw new Error(`SQLite VFS не смог применить кадр WAL: код ${result}`);
      }
      offset += frameBytes;
    }
    const databasePage = new Uint8Array(pageSize);
    const read = await vfs.jRead(fileId, databasePage, 0);
    if (read !== 0 && read !== 522) throw new Error(`SQLite VFS не смог прочитать заголовок временной копии: код ${read}`);
    databasePage[18] = databasePage[19] = 1;
    const headerView = new DataView(databasePage.buffer, databasePage.byteOffset, databasePage.byteLength);
    const changeCounter = (headerView.getUint32(24, false) + 1) >>> 0;
    headerView.setUint32(24, changeCounter, false);
    headerView.setUint32(28, finalDatabaseSize, false);
    headerView.setUint32(92, changeCounter, false);
    const headerWrite = await vfs.jWrite(fileId, databasePage, 0);
    if (headerWrite !== 0) throw new Error(`SQLite VFS не смог обновить заголовок checkpoint-копии: код ${headerWrite}`);
    const truncated = await vfs.jTruncate(fileId, finalDatabaseSize * pageSize);
    if (truncated !== 0) throw new Error(`SQLite VFS не смог завершить checkpoint-копию: код ${truncated}`);
    await vfs.jFileControl(fileId, 32, ignored);
    await vfs.jFileControl(fileId, 21, ignored);
    const synced = await vfs.jSync(fileId, 2);
    if (synced !== 0) throw new Error(`SQLite VFS не смог сохранить checkpoint-копию: код ${synced}`);
  } finally {
    while (unlock.length) await vfs.jUnlock(fileId, unlock.pop());
    await vfs.jClose(fileId);
  }
}

export async function readLegacyTaskQueueFileFromSQLite(source, queueRecord, {
  runtime = globalThis.__MAC_ANALYZER_SQLITE_RUNTIME__,
  wasmUrl = globalThis.__MAC_ANALYZER_SQLITE_WASM_URL__,
  beforeRead = () => {},
  onProgress = () => {},
  memoryInfo = globalThis.performance?.memory,
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
      'SELECT filename, length(content_base64) AS contentBase64Chars, substr(content_base64, -2) AS contentBase64Tail FROM task_file_queue WHERE id = ? AND task_id = ? LIMIT 1',
      [fileId, taskId],
    );
    const totalChars = Number(meta?.contentBase64Chars);
    if (!meta || !Number.isSafeInteger(totalChars) || totalChars < 4 || totalChars % 4 !== 0) throw new Error("В исходной SQLite базе нет корректного содержимого файла очереди");
    const tail = String(meta.contentBase64Tail || "");
    if (!/^(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(tail)) throw new Error("Содержимое файла очереди в исходной SQLite базе повреждено");
    const padding = tail.endsWith("==") ? 2 : tail.endsWith("=") ? 1 : 0;
    const decodedBytes = (totalChars / 4) * 3 - padding;
    assertSourceFileCapacity({ size: decodedBytes }, IMPORT_LIMITS.sourceFileBytes);
    assertBrowserHeapCapacity(decodedBytes * 3, memoryInfo);
    beforeRead(decodedBytes);
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
        const isFinalChunk = offset + take === totalChars;
        const validChunk = isFinalChunk
          ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)
          : /^[A-Za-z0-9+/]+$/.test(chunk);
        if (chunk.length !== take || !validChunk) throw new Error("Содержимое файла очереди в исходной SQLite базе повреждено");
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
