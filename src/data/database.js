import { keyText, locationKey, normalizeIp, normalizeMac, text } from "../core/normalize.js";
import { dashboardDeviceMatchesFilters, normalizeDashboardFilters } from "../core/dashboard-filter.js";
import { normalizeMacPrefix } from "../core/model-knowledge.js";
import { matchesDeviceSearch } from "../core/search.js";
import { applyIpMapping, normalizeIpMappings } from "../core/ip-mapping.js";
import { isCriticalHistoryChange, normalizeChangeType } from "../core/change-categories.js";
import { MAX_PORTABLE_ARCHIVE_BYTES } from "./data-directory.js";
import { PerformanceStatisticsAccumulator, normalizePerformanceMetric, PERFORMANCE_METRIC_LIMIT } from "../core/performance-statistics.js";
import { appendApplicationLog, normalizeApplicationLogEntry } from "../core/application-log.js";
import { normalizeOuiPrefix } from "../core/ieee-registry.js";
import { FINAL_SNAPSHOT_TYPE, isFinalSnapshot, resolveSnapshotType } from "../core/snapshot-kind.js";

const TEST_DB_NAME_PATTERN = /^mac-analyzer-pro-next-test-[a-z0-9-]{8,80}$/i;
export function databaseNameFromSearch(search = "") {
  const requestedDatabaseName = new globalThis.URLSearchParams(search).get("db") || "";
  return TEST_DB_NAME_PATTERN.test(requestedDatabaseName) ? requestedDatabaseName : "mac-analyzer-pro-next";
}
const DB_NAME = databaseNameFromSearch(globalThis.location?.search || "");
const DB_VERSION = 26;
const PERFORMANCE_METRICS_SETTING = "performanceMetrics:v1";
const PERFORMANCE_METRIC_PREFIX = "performanceMetric:";
const LEGACY_PERFORMANCE_METRIC_PREFIX = "legacyPerformanceMetric:";
const APPLICATION_LOG_SETTING = "applicationLog:v1";
const SNAPSHOT_HISTORY_CACHE_SCHEMA = 2;
function snapshotHistoryCacheKey(filters = {}) {
  const normalized = normalizeDashboardFilters(filters);
  const scope = { query: normalized.query, manufacturer: normalized.manufacturer, room: normalized.room };
  return Object.values(scope).some(Boolean) ? `snapshot-history:${JSON.stringify(scope)}` : "snapshot-history";
}
const CHUNK_SIZE = 500;
const INDEXED_DB_KEY_READ_BATCH_SIZE = 250;
const ARCHIVE_PAGE_SIZE = 128;
const SOURCE_FILE_ARCHIVE_CHUNK_BYTES = 192 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SMARTROOM_ALTERNATIVES = 100;
const MAX_ARCHIVE_RECORDS = 2_000_000;
const LEGACY_OBSERVATION_KINDS = Object.freeze([
  "mac_history", "resolved_device_history", "vendor_model_history", "scheduled_tasks", "task_file_queue",
  "history_loads", "analysis_history", "performance_metrics", "daily_stats",
]);
const ARCHIVE_STORES = Object.freeze([
  "snapshots", "snapshotChunks", "inventory", "history", "settings", "knownModels",
  "oui", "switchAddressEvidence", "mac5Models", "smartroomRoomMappings", "originalFiles",
  "singleAnalyses", "singleAnalysisChunks", "legacyObservations", "dataQualityReports", "legacySmartroomRoomMappings",
]);
const INVENTORY_SORT_FIELDS = Object.freeze([
  "mac", "ip", "switchIp", "switchPort", "manufacturer", "model", "deviceType",
  "hostname", "serial", "smartroomId", "room", "address", "authenticationTime",
]);
function snapshotMetadataSignature(rows) {
  return JSON.stringify(["snapshot-history-v2", [...rows]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)))
    .map((snapshot) => [snapshot.id, snapshot.createdAt, Number(snapshot.deviceCount || 0), Number(snapshot.chunkCount || 0), Number(snapshot.dataRevision || 0)])]);
}
function snapshotIntegrityError(message) {
  const error = new Error(message);
  error.code = "SNAPSHOT_INTEGRITY";
  return error;
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Ошибка IndexedDB"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Транзакция IndexedDB завершилась ошибкой"));
    transaction.onabort = () => reject(transaction.error || new Error("Транзакция IndexedDB отменена"));
  });
}

async function visitSettingPrefix(db, prefix, visit) {
  const tx = db.transaction("settings", "readonly");
  const done = transactionDone(tx);
  const range = globalThis.IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const request = tx.objectStore("settings").openCursor(range);
  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error || new Error("Не удалось прочитать метрики производительности"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      try {
        visit(cursor.key, cursor.value);
        cursor.continue();
      } catch (error) {
        try { tx.abort(); } catch {}
        reject(error);
      }
    };
  });
  await done;
}

async function getByKeysInBatches(db, storeName, keys) {
  const records = [];
  for (let offset = 0; offset < keys.length; offset += INDEXED_DB_KEY_READ_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + INDEXED_DB_KEY_READ_BATCH_SIZE);
    const tx = db.transaction(storeName, "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore(storeName);
    try {
      records.push(...await Promise.all(batch.map((key) => requestResult(store.get(key)))));
      await done;
    } catch (error) {
      await done.catch(() => {});
      throw error;
    }
  }
  return records;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Некорректный блок исходного файла в архиве");
  }
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sourceFileArchiveSize(base64) {
  if (typeof base64 !== "string" || base64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Некорректный блок исходного файла в архиве");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return base64.length / 4 * 3 - padding;
}

const EMBEDDED_SNAPSHOT_KEYS = new Set(["devices", "allDevices", "fullDevices", "snapshotDevices", "previousFinalDevices", "currentFinalDevices"]);
const MAX_SERIALIZED_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_SERIALIZED_RECORD_NODES = 1_500_000;

export function sanitizeForDatabase(value, {
  dropEmbeddedSnapshotRows = false,
  maxBytes = MAX_SERIALIZED_RECORD_BYTES,
  maxNodes = MAX_SERIALIZED_RECORD_NODES,
} = {}) {
  const ancestors = new WeakSet();
  let estimatedBytes = 0;
  let nodeCount = 0;
  const charge = (bytes = 8) => {
    estimatedBytes += bytes;
    nodeCount += 1;
    if (estimatedBytes > maxBytes || nodeCount > maxNodes) {
      const error = new RangeError(`Запись IndexedDB превышает предел подготовки (${maxBytes.toLocaleString("ru-RU")} байт, ${maxNodes.toLocaleString("ru-RU")} значений)`);
      error.code = "DATABASE_RECORD_LIMIT";
      error.estimatedBytes = estimatedBytes;
      error.nodeCount = nodeCount;
      throw error;
    }
  };
  const clean = (item, key = "") => {
    if (item === null || typeof item === "boolean") { charge(); return item; }
    if (typeof item === "string") { charge(item.length * 2 + 8); return item; }
    if (typeof item === "number") { charge(); return Number.isFinite(item) ? item : null; }
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") return undefined;
    if (item instanceof Date) { charge(32); return Number.isFinite(item.getTime()) ? item.toISOString() : null; }
    if (typeof item !== "object") return undefined;
    if (dropEmbeddedSnapshotRows && EMBEDDED_SNAPSHOT_KEYS.has(key) && Array.isArray(item)
      && item.length > 0 && item.every((row) => row && typeof row === "object" && (row.id || row.mac || row.deviceId || row.serial))) return undefined;
    if (ancestors.has(item)) return undefined;
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      charge(item.length * 8 + 16);
      result = item.map((entry, index) => {
        const cleaned = clean(entry, String(index));
        return cleaned === undefined ? null : cleaned;
      });
    } else {
      result = {};
      let keys = [];
      try { keys = Object.keys(item); } catch { ancestors.delete(item); return result; }
      charge(keys.length * 8 + 32);
      for (const property of keys) {
        let entry;
        try { entry = item[property]; } catch { continue; }
        charge(property.length * 2 + 8);
        const cleaned = clean(entry, property);
        if (cleaned !== undefined) result[property] = cleaned;
      }
    }
    ancestors.delete(item);
    return result;
  };
  const cleaned = clean(value);
  return cleaned === undefined ? null : cleaned;
}

function serializable(value, options) {
  return sanitizeForDatabase(value, options);
}

function finalWriteError(error) {
  const name = String(error?.name || "");
  const detail = name === "DataCloneError"
    ? `Браузер отклонил формат клонирования записи (DataCloneError): ${error.message}`
    : name === "QuotaExceededError"
      ? `Недостаточно места в IndexedDB (QuotaExceededError): ${error.message}`
      : /out of memory|allocation failed/i.test(String(error?.message || ""))
        ? `Браузеру не хватило памяти для записи Final: ${error.message}`
        : error?.message || String(error);
  return new Error(`Final не сохранён, предыдущий снимок не изменён. ${detail}`, { cause: error });
}

function hasKnownValue(value) {
  if (typeof value === "string") return Boolean(text(value));
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function mergeKnownRecord(previous = {}, incoming = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) if (hasKnownValue(value)) merged[key] = value;
  return merged;
}

const LEGACY_VENDOR_EMPTY_VALUES = new Set(["unknown", "not found", "n/a", "none", "null", "не определено", "неизвестно", "не указано"]);

function knownLegacyVendorValue(value) {
  const result = text(value);
  return result && !LEGACY_VENDOR_EMPTY_VALUES.has(result.toLocaleLowerCase("ru-RU")) ? result : "";
}

function legacyObservationIsNewer(candidate, current) {
  if (!current) return true;
  const timestampOrder = String(candidate.observedAt || "").localeCompare(String(current.observedAt || ""));
  if (timestampOrder) return timestampOrder > 0;
  const leftId = Number(candidate.sourceId);
  const rightId = Number(current.sourceId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId > rightId;
  return String(candidate.sourceId || "").localeCompare(String(current.sourceId || "")) > 0;
}

function legacyVendorPrefixRows(observation) {
  if (observation?.kind !== "vendor_model_history") return [];
  const mac = normalizeMac(observation.mac).replaceAll(":", "");
  if (!mac) return [];
  const payload = observation.payload && typeof observation.payload === "object" ? observation.payload : {};
  const rows = [];
  for (const prefixLength of [10, 8, 6]) {
    const prefix = mac.slice(0, prefixLength);
    if (prefix.length !== prefixLength) continue;
    for (const [field, value] of [["vendor", knownLegacyVendorValue(payload.vendor)], ["model", knownLegacyVendorValue(payload.model)]]) {
      if (value) rows.push({ prefixLength, prefix, field, value });
    }
  }
  return rows;
}

function legacyObservationFilterSpec(filters = {}) {
  const fromValue = String(filters.from || filters.dateFrom || "");
  const toValue = String(filters.to || filters.dateTo || "");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromValue) ? `${fromValue}T00:00:00` : fromValue;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toValue) ? `${toValue}\uffff` : toValue;
  if (from && to && from > to) throw new Error("Начальная дата позже конечной");
  return {
    kind: String(filters.kind || ""),
    mac: String(filters.mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase(),
    source: String(filters.source || "").trim().toLocaleLowerCase("ru-RU"),
    vendor: String(filters.vendor || "").trim().toLocaleLowerCase("ru-RU"),
    model: String(filters.model || "").trim().toLocaleLowerCase("ru-RU"),
    room: String(filters.room || "").trim().toLocaleLowerCase("ru-RU"),
    from,
    to,
  };
}

function legacyObservationFilterValue(observation, names) {
  const payload = observation?.payload && typeof observation.payload === "object" ? observation.payload : {};
  const sources = [payload, payload.decodedPayload, payload.device, payload.current_state].filter((value) => value && typeof value === "object");
  for (const source of sources) for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return "";
}

function matchesLegacyObservation(observation, filters) {
  const observedAt = String(observation.observedAt || "");
  return (!filters.kind || observation.kind === filters.kind)
    && (!filters.mac || String(observation.mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase().includes(filters.mac))
    && (!filters.source || `${String(observation.source || "")} ${legacyObservationFilterValue(observation, ["source", "source_file", "filename"])}`.toLocaleLowerCase("ru-RU").includes(filters.source))
    && (!filters.vendor || legacyObservationFilterValue(observation, ["vendor", "manufacturer"]).toLocaleLowerCase("ru-RU").includes(filters.vendor))
    && (!filters.model || legacyObservationFilterValue(observation, ["model", "device_model"]).toLocaleLowerCase("ru-RU").includes(filters.model))
    && (!filters.room || legacyObservationFilterValue(observation, ["room", "room_name"]).toLocaleLowerCase("ru-RU").includes(filters.room))
    && (!filters.from || observedAt >= filters.from)
    && (!filters.to || observedAt <= filters.to);
}

function legacyObservationDistinctValues(observation) {
  const mac = observation.mac === null || observation.mac === undefined ? null : String(observation.mac);
  return [
    ["mac", mac],
    ["vendor", legacyObservationFilterValue(observation, ["vendor", "manufacturer"])],
    ["model", legacyObservationFilterValue(observation, ["model", "device_model"])],
    ["room", legacyObservationFilterValue(observation, ["room", "room_name"])],
    ["source", String(legacyObservationFilterValue(observation, ["source", "source_file", "filename"]) || observation.source || "")],
  ].filter(([, value]) => value !== null && value !== "");
}

function legacyObservationPageRecord(observation) {
  if (observation?.kind !== "task_file_queue") return observation;
  const payload = { ...observation.payload };
  delete payload.contentBase64;
  delete payload.localBlobKey;
  return { ...observation, payload };
}

function legacyObservationArchiveRecord(observation) {
  if (observation?.kind !== "task_file_queue" || !observation.payload?.localBlobKey) return observation;
  const payload = { ...observation.payload };
  delete payload.localBlobKey;
  delete payload.contentRetainedLocally;
  payload.contentAvailable = false;
  return { ...observation, payload };
}

function referenceArchiveDevice(device = {}) {
  return {
    ...device,
    internalDeviceId: String(device.id || device.internalDeviceId || ""),
    vendor: String(device.manufacturer || device.vendor || ""),
    ip: String(device.ip || device.deviceIp || ""),
    mac2: String(device.alternateMacs?.[0] || device.mac2 || ""),
    alternateMacs: Array.isArray(device.alternateMacs) ? device.alternateMacs : [],
    type: String(device.deviceType || device.type || ""),
  };
}

function legacyObservationImportRecord(observation) {
  if (observation?.kind !== "task_file_queue") return observation;
  const payload = { ...observation.payload };
  delete payload.localBlobKey;
  delete payload.contentRetainedLocally;
  if (typeof payload.contentBase64 !== "string" || !payload.contentBase64) payload.contentAvailable = false;
  return { ...observation, payload };
}

function encodeBase64(bytes) {
  const chunkBytes = 48 * 1024;
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    let binary = "";
    for (let start = 0; start < chunk.length; start += 0x8000) {
      binary += String.fromCharCode(...chunk.subarray(start, Math.min(chunk.length, start + 0x8000)));
    }
    parts.push(globalThis.btoa(binary));
  }
  return parts.join("");
}

async function encodeFileBase64(file) {
  const chunkBytes = 48 * 1024;
  const parts = [];
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const end = Math.min(file.size, offset + chunkBytes);
    parts.push(encodeBase64(new Uint8Array(await file.slice(offset, end).arrayBuffer())));
  }
  return parts.join("");
}

function deleteLegacyTaskQueueRecords(store, taskIds, fileHandles, onDone) {
  const targets = new Set(taskIds);
  if (!targets.size) { onDone(0); return; }
  const index = store.index("by_kind_observed");
  const range = IDBKeyRange.bound(["task_file_queue", "", ""], ["task_file_queue", "\uffff", "\uffff"]);
  let deleted = 0;
  const request = index.openCursor(range, "next");
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) { onDone(deleted); return; }
    if (targets.has(String(cursor.value.payload?.taskId || ""))) {
      if (cursor.value.payload?.localBlobKey) fileHandles.delete(cursor.value.payload.localBlobKey);
      cursor.delete();
      deleted += 1;
    }
    cursor.continue();
  };
}

async function incrementLegacyVendorPrefixCounts(store, observation) {
  for (const row of legacyVendorPrefixRows(observation)) {
    const key = [row.prefixLength, row.prefix, row.field, row.value];
    const existing = await requestResult(store.get(key));
    store.put({ ...row, count: Number(existing?.count || 0) + 1 });
  }
}

function validateArchive(archive) {
  if (archive?.format !== "MAC_ANALYZER_NEXT_ARCHIVE" || archive.version !== 1) throw new Error("Неподдерживаемый формат архива");
  const collections = ["snapshots", "inventory", "history", "settings", "knownModels", "oui", "switchAddressEvidence", "mac5Models", "smartroomRoomMappings", "originalFiles", "singleAnalyses", "singleAnalysisChunks", "legacyObservations", "dataQualityReports", "legacySmartroomRoomMappings"];
  let records = 0;
  for (const key of collections) {
    if (archive[key] !== undefined && !Array.isArray(archive[key])) throw new Error(`Некорректная структура архива: ${key}`);
    records += archive[key]?.length || 0;
  }
  if (records > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей");
  const ids = new Set();
  let devices = 0;
  for (const snapshot of archive.snapshots || []) {
    if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id || !Array.isArray(snapshot.devices)) throw new Error("Некорректная структура Final в архиве");
    if (ids.has(snapshot.id)) throw new Error("Архив содержит повторяющийся ID Final");
    ids.add(snapshot.id);
    devices += snapshot.devices.length;
    if (devices > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей устройств");
  }
  const analyses = new Map();
  for (const analysis of archive.singleAnalyses || []) {
    if (!analysis || typeof analysis.id !== "string" || !analysis.id || typeof analysis.filename !== "string"
      || !analysis.filename || analysis.filename.length > 1024 || typeof analysis.processedAt !== "string"
      || !analysis.processedAt || !Number.isSafeInteger(analysis.deviceCount) || analysis.deviceCount < 0
      || !Number.isSafeInteger(analysis.chunkCount) || analysis.chunkCount < 0
      || !analysis.storedRecordCounts || !Number.isSafeInteger(analysis.storedRecordCounts.invalid)
      || !Number.isSafeInteger(analysis.storedRecordCounts.invalidMacs) || !Number.isSafeInteger(analysis.storedRecordCounts.ambiguous)
      || !Number.isSafeInteger(analysis.storedRecordCounts.identityConflicts)) throw new Error("Некорректные метаданные анализа одного файла в архиве");
    if (analyses.has(analysis.id)) throw new Error("Архив содержит повторный анализ одного файла");
    const expectedCount = Math.ceil(Math.max(analysis.deviceCount, ...Object.values(analysis.storedRecordCounts), 0) / CHUNK_SIZE);
    if (analysis.chunkCount !== expectedCount) throw new Error("Число блоков анализа в архиве не совпадает с метаданными");
    analyses.set(analysis.id, analysis);
  }
  const analysisChunks = new Map();
  let analysisRowCount = 0;
  for (const chunk of archive.singleAnalysisChunks || []) {
    if (!chunk || typeof chunk.analysisId !== "string" || !analyses.has(chunk.analysisId)
      || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= analyses.get(chunk.analysisId).chunkCount
      || !["devices", "invalid", "invalidMacs", "ambiguous", "identityConflicts"].every((field) => Array.isArray(chunk[field]) && chunk[field].length <= CHUNK_SIZE)) {
      throw new Error("Некорректный блок анализа одного файла в архиве");
    }
    analysisRowCount += chunk.devices.length + chunk.invalid.length + chunk.invalidMacs.length + chunk.ambiguous.length + chunk.identityConflicts.length;
    if (analysisRowCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число строк анализов");
    const key = `${chunk.analysisId}\u0000${chunk.index}`;
    if (analysisChunks.has(key)) throw new Error("Архив содержит повторный блок анализа одного файла");
    analysisChunks.set(key, chunk);
  }
  const legacyObservationIds = new Set();
  for (const observation of archive.legacyObservations || []) {
    if (!observation || typeof observation.id !== "string" || !observation.id
      || !LEGACY_OBSERVATION_KINDS.includes(observation.kind)
      || observation.sourceTable !== observation.kind || typeof observation.observedAt !== "string"
      || !observation.payload || typeof observation.payload !== "object" || Array.isArray(observation.payload)) {
      throw new Error("Некорректная запись legacy-наблюдения в архиве");
    }
    if (legacyObservationIds.has(observation.id)) throw new Error("Архив содержит повторное legacy-наблюдение");
    legacyObservationIds.add(observation.id);
  }
  const qualityReportIds = new Set();
  for (const report of archive.dataQualityReports || []) {
    if (!report || typeof report.id !== "string" || !report.id || typeof report.snapshotId !== "string" || !report.snapshotId
      || typeof report.createdAt !== "string" || !Number.isFinite(Date.parse(report.createdAt)) || !Number.isFinite(report.score) || report.score < 0 || report.score > 100
      || !["A", "B", "C", "D"].includes(report.grade) || !report.report || typeof report.report !== "object" || Array.isArray(report.report)) {
      throw new Error("Некорректный отчёт качества данных в архиве");
    }
    if (qualityReportIds.has(report.id)) throw new Error("Архив содержит повторный отчёт качества данных");
    qualityReportIds.add(report.id);
  }
  const legacySmartroomMappingIds = new Set();
  for (const mapping of archive.legacySmartroomRoomMappings || []) {
    const key = keyText(mapping?.smartroomId);
    const mappingId = `${key}\u0000${text(mapping?.smartroomId)}`;
    if (!mapping || !key || mapping.smartroomIdKey !== key || mapping.id !== mappingId || !text(mapping.room)
      || typeof mapping.source !== "string" || typeof mapping.updatedAt !== "string" || !Number.isFinite(Date.parse(mapping.updatedAt))) {
      throw new Error("Некорректная legacy Smartroom-маппинг-запись в архиве");
    }
    if (legacySmartroomMappingIds.has(mapping.id)) throw new Error("Архив содержит повторную legacy Smartroom-маппинг-запись");
    legacySmartroomMappingIds.add(mapping.id);
  }
  for (const [id, analysis] of analyses) {
    const counts = { devices: analysis.deviceCount, ...analysis.storedRecordCounts };
    for (let index = 0; index < analysis.chunkCount; index += 1) {
      const chunk = analysisChunks.get(`${id}\u0000${index}`);
      if (!chunk) throw new Error("В архиве отсутствует блок анализа одного файла");
      for (const [field, count] of Object.entries(counts)) {
        if (chunk[field].length !== Math.min(CHUNK_SIZE, Math.max(0, count - index * CHUNK_SIZE))) throw new Error("Размер блока анализа одного файла не совпадает с метаданными");
      }
    }
  }
  const originalFileKeys = new Set();
  for (const file of archive.originalFiles || []) {
    const key = `${file?.snapshotId || ""}\u0000${file?.role || ""}`;
    if (!ids.has(file?.snapshotId) || !["main", "smartroom", "ddio"].includes(file.role)
      || typeof file.name !== "string" || file.name.length > 1024
      || (file.type !== undefined && typeof file.type !== "string")
      || (file.lastModified !== undefined && (!Number.isSafeInteger(file.lastModified) || file.lastModified < 0))
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SOURCE_FILE_BYTES
      || !Array.isArray(file.chunks)) throw new Error("Некорректный оригинал исходного файла в архиве");
    if (originalFileKeys.has(key)) throw new Error("Архив содержит повторный оригинал исходного файла");
    originalFileKeys.add(key);
    let size = 0;
    for (let index = 0; index < file.chunks.length; index += 1) {
      const chunk = file.chunks[index];
      const chunkSize = sourceFileArchiveSize(chunk);
      const finalChunk = index === file.chunks.length - 1;
      if (chunkSize === 0 || chunkSize > SOURCE_FILE_ARCHIVE_CHUNK_BYTES
        || (!finalChunk && chunkSize !== SOURCE_FILE_ARCHIVE_CHUNK_BYTES)) {
        throw new Error("Некорректный размер блока исходного файла в архиве");
      }
      size += chunkSize;
    }
    if (size !== file.size) throw new Error("Размер оригинала исходного файла в архиве не совпадает");
  }
  for (const item of archive.inventory || []) if (!item || typeof item.id !== "string" || !item.id) throw new Error("Некорректная запись Inventory в архиве");
  for (const item of archive.settings || []) if (!item || typeof item.key !== "string" || !item.key) throw new Error("Некорректная настройка в архиве");
  const smartroomKeys = new Set();
  for (const item of archive.smartroomRoomMappings || []) {
    const key = keyText(item?.smartroomId);
    if (!key || item.smartroomIdKey !== key || !ids.has(item.sourceFinalId) || !item.createdAt
      || !["confirmed", "review"].includes(item.status) || !Array.isArray(item.alternatives) || !Array.isArray(item.sampleMacs)) {
      throw new Error("Некорректное свидетельство Smartroom ID → помещение в архиве");
    }
    if (smartroomKeys.has(key)) throw new Error("Архив содержит повторяющиеся Smartroom ID → помещение");
    smartroomKeys.add(key);
  }
  const mac5Prefixes = new Set();
  for (const item of archive.mac5Models || []) {
    const prefix = normalizeMacPrefix(item?.prefix);
    if (!prefix || typeof item.model !== "string" || !text(item.model)) throw new Error("Некорректное правило MAC5 в архиве");
    if (mac5Prefixes.has(prefix)) throw new Error("Архив содержит повторяющийся префикс MAC5");
    mac5Prefixes.add(prefix);
  }
}

export class Database {
  constructor(name = DB_NAME) {
    this.name = name;
    this.connection = null;
  }

  async open() {
    if (this.connection) return this.connection;
    const request = indexedDB.open(this.name, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      let legacyInventoryBackfillDone = event.oldVersion >= 4;
      let startObservationCountMigration = null;
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", { keyPath: "id" });
        store.createIndex("by_created", "createdAt");
      }
      const snapshotStore = request.transaction.objectStore("snapshots");
      if (!snapshotStore.indexNames.contains("by_source_key")) snapshotStore.createIndex("by_source_key", "sourceKey");
      if (!db.objectStoreNames.contains("snapshotChunks")) db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
      if (!db.objectStoreNames.contains("inventory")) {
        const store = db.createObjectStore("inventory", { keyPath: "id" });
        store.createIndex("by_mac", "mac", { unique: false });
        store.createIndex("by_smartroom", "smartroomId", { unique: false });
      }
      const inventoryStore = request.transaction.objectStore("inventory");
      if (!inventoryStore.indexNames.contains("by_switch")) inventoryStore.createIndex("by_switch", "switchIp", { unique: false });
      if (!inventoryStore.indexNames.contains("by_alternate_mac")) inventoryStore.createIndex("by_alternate_mac", "alternateMacs", { unique: false, multiEntry: true });
      if (!inventoryStore.indexNames.contains("by_device_id")) inventoryStore.createIndex("by_device_id", "deviceId", { unique: false });
      if (!inventoryStore.indexNames.contains("by_serial_identity")) inventoryStore.createIndex("by_serial_identity", "serial", { unique: false });
      if (!inventoryStore.indexNames.contains("by_device_id_normalized")) inventoryStore.createIndex("by_device_id_normalized", "deviceIdKey", { unique: false });
      if (!inventoryStore.indexNames.contains("by_serial_normalized")) inventoryStore.createIndex("by_serial_normalized", "serialKey", { unique: false });
      if (event.oldVersion < 26) {
        const cursorRequest = inventoryStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            if (event.oldVersion < 4) {
              legacyInventoryBackfillDone = true;
              startObservationCountMigration?.();
            }
            return;
          }
          const record = cursor.value || {};
          const updated = {
            ...record,
            deviceIdKey: keyText(record.deviceId),
            serialKey: keyText(record.serial),
          };
          if (event.oldVersion < 4) {
            for (const field of INVENTORY_SORT_FIELDS) if (updated[field] === null || updated[field] === undefined) updated[field] = "";
          }
          cursor.update(updated);
          cursor.continue();
        };
      }
      for (const field of INVENTORY_SORT_FIELDS) {
        const indexName = `by_sort_${field}`;
        if (!inventoryStore.indexNames.contains(indexName)) inventoryStore.createIndex(indexName, [field, "id"], { unique: false });
      }
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_snapshot", "snapshotId");
        store.createIndex("by_device", "deviceId");
        store.createIndex("by_timestamp", "timestamp");
      }
      const historyStore = request.transaction.objectStore("history");
      if (!historyStore.indexNames.contains("by_device_timestamp")) {
        historyStore.createIndex("by_device_timestamp", ["deviceId", "timestamp"], { unique: false });
      }
      if (!historyStore.indexNames.contains("by_mac_timestamp")) {
        historyStore.createIndex("by_mac_timestamp", ["macKey", "timestamp"], { unique: false });
      }
      if (event.oldVersion < 22) {
        const historyCursor = historyStore.openCursor();
        historyCursor.onsuccess = () => {
          const cursor = historyCursor.result;
          if (!cursor) return;
          const eventRecord = cursor.value || {};
          const macKey = normalizeMac(eventRecord.mac);
          if (eventRecord.macKey !== macKey) cursor.update({ ...eventRecord, macKey });
          cursor.continue();
        };
      }
      if (event.oldVersion < 10) {
        const snapshotStoreForHistory = request.transaction.objectStore("snapshots");
        const cursorRequest = historyStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const record = cursor.value || {};
          if (typeof record.timestamp === "string") {
            cursor.continue();
            return;
          }
          const snapshotRequest = record.snapshotId ? snapshotStoreForHistory.get(record.snapshotId) : null;
          if (!snapshotRequest) {
            cursor.update({ ...record, timestamp: String(record.createdAt || "") });
            cursor.continue();
            return;
          }
          snapshotRequest.onsuccess = () => {
            const timestamp = record.timestamp || record.createdAt || snapshotRequest.result?.createdAt || "";
            cursor.update({ ...record, timestamp: String(timestamp) });
            cursor.continue();
          };
        };
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("fileHandles")) db.createObjectStore("fileHandles", { keyPath: "key" });
      if (!db.objectStoreNames.contains("originalFiles")) db.createObjectStore("originalFiles", { keyPath: ["snapshotId", "role"] });
      if (!db.objectStoreNames.contains("knownModels")) db.createObjectStore("knownModels", { keyPath: "mac" });
      if (!db.objectStoreNames.contains("mac5Models")) db.createObjectStore("mac5Models", { keyPath: "prefix" });
      if (!db.objectStoreNames.contains("oui")) db.createObjectStore("oui", { keyPath: "prefix" });
      if (!db.objectStoreNames.contains("archives")) db.createObjectStore("archives", { keyPath: "id" });
      if (!db.objectStoreNames.contains("archiveRecords")) {
        const records = db.createObjectStore("archiveRecords", { keyPath: ["archiveId", "collection", "recordKey"] });
        records.createIndex("by_archive", "archiveId");
        records.createIndex("by_archive_collection", ["archiveId", "collection", "recordKey"]);
      }
      if (!db.objectStoreNames.contains("analyticsCache")) db.createObjectStore("analyticsCache", { keyPath: "key" });
      if (!db.objectStoreNames.contains("finalAnalytics")) {
        const finalAnalytics = db.createObjectStore("finalAnalytics", { keyPath: ["snapshotId", "generation", "index"] });
        finalAnalytics.createIndex("by_snapshot", ["snapshotId", "generation"], { unique: false });
      }
      if (!db.objectStoreNames.contains("finalAnalyticsMetadata")) db.createObjectStore("finalAnalyticsMetadata", { keyPath: "snapshotId" });
      if (!db.objectStoreNames.contains("smartroomRoomMappings")) {
        const mappings = db.createObjectStore("smartroomRoomMappings", { keyPath: "smartroomIdKey" });
        mappings.createIndex("by_snapshot", "sourceFinalId");
      }
      if (!db.objectStoreNames.contains("legacySmartroomRoomMappings")) {
        const mappings = db.createObjectStore("legacySmartroomRoomMappings", { keyPath: "id" });
        mappings.createIndex("by_updated_at", "updatedAt", { unique: false });
        mappings.createIndex("by_smartroom_id", ["smartroomIdKey", "id"], { unique: false });
      }
      if (event.oldVersion < 21) {
        const settings = request.transaction.objectStore("settings");
        const mappings = request.transaction.objectStore("legacySmartroomRoomMappings");
        const cursorRequest = settings.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const setting = cursor.value || {};
          const key = String(setting.key || "");
          if (key.startsWith("legacySmartroomRoom:")) {
            const smartroomId = text(key.slice("legacySmartroomRoom:".length));
            const smartroomIdKey = keyText(smartroomId);
            const value = setting.value && typeof setting.value === "object" ? setting.value : {};
            const room = text(value.room);
            if (smartroomIdKey && room) {
              const updatedAt = Number.isFinite(Date.parse(value.updatedAt)) ? String(value.updatedAt) : "1970-01-01T00:00:00.000Z";
              mappings.put({
                id: `${smartroomIdKey}\u0000${smartroomId}`, smartroomIdKey, smartroomId, room,
                source: text(value.source) || "Импорт SQLite",
                updatedAt,
              });
            }
          }
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains("switchAddressEvidence")) {
        const evidence = db.createObjectStore("switchAddressEvidence", { keyPath: ["switchIp", "address", "snapshotId"] });
        evidence.createIndex("by_switch", "switchIp");
        evidence.createIndex("by_snapshot", "snapshotId");
      }
      if (!db.objectStoreNames.contains("singleAnalyses")) {
        const analyses = db.createObjectStore("singleAnalyses", { keyPath: "id" });
        analyses.createIndex("by_processed_at", "processedAt");
        analyses.createIndex("by_filename", "filename");
      }
      if (!db.objectStoreNames.contains("singleAnalysisChunks")) {
        db.createObjectStore("singleAnalysisChunks", { keyPath: ["analysisId", "index"] });
      }
      if (!db.objectStoreNames.contains("legacyObservations")) {
        const observations = db.createObjectStore("legacyObservations", { keyPath: "id" });
        observations.createIndex("by_kind_observed", ["kind", "observedAt", "id"]);
        observations.createIndex("by_mac_observed", ["mac", "observedAt", "id"]);
      }
      const legacyObservations = request.transaction.objectStore("legacyObservations");
      if (!legacyObservations.indexNames.contains("by_observed_id")) legacyObservations.createIndex("by_observed_id", ["observedAt", "id"], { unique: false });
      if (!db.objectStoreNames.contains("legacyObservationQueryScratch")) {
        db.createObjectStore("legacyObservationQueryScratch", { keyPath: ["queryId", "metric", "value"] });
      }
      const legacyObservationScratch = request.transaction.objectStore("legacyObservationQueryScratch");
      if (!legacyObservationScratch.indexNames.contains("by_query_metric_count")) {
        legacyObservationScratch.createIndex("by_query_metric_count", ["queryId", "metric", "count", "value"], { unique: false });
      }
      if (!legacyObservationScratch.indexNames.contains("by_query_metric_rank")) {
        legacyObservationScratch.createIndex("by_query_metric_rank", ["queryId", "metric", "rankCount", "value"], { unique: false });
      }
      if (!db.objectStoreNames.contains("legacyVendorModelPrefixCounts")) {
        const counts = db.createObjectStore("legacyVendorModelPrefixCounts", { keyPath: ["prefixLength", "prefix", "field", "value"] });
        counts.createIndex("by_prefix", ["prefixLength", "prefix"], { unique: false });
      }
      if (!db.objectStoreNames.contains("dataQualityReports")) {
        const reports = db.createObjectStore("dataQualityReports", { keyPath: "id" });
        reports.createIndex("by_created", "createdAt", { unique: false });
        reports.createIndex("by_snapshot_created", ["snapshotId", "createdAt"], { unique: false });
      }
      if (event.oldVersion < 17) {
        const observations = request.transaction.objectStore("legacyObservations");
        const counts = request.transaction.objectStore("legacyVendorModelPrefixCounts");
        const cursorRequest = observations.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const rows = legacyVendorPrefixRows(cursor.value);
          let position = 0;
          const countNext = () => {
            if (position >= rows.length) {
              cursor.continue();
              return;
            }
            const row = rows[position++];
            const key = [row.prefixLength, row.prefix, row.field, row.value];
            const getRequest = counts.get(key);
            getRequest.onsuccess = () => {
              counts.put({ ...row, count: Number(getRequest.result?.count || 0) + 1 });
              countNext();
            };
          };
          countNext();
        };
      }
      if (event.oldVersion < 11) {
        const chunks = request.transaction.objectStore("snapshotChunks");
        const inventory = request.transaction.objectStore("inventory");
        startObservationCountMigration = () => {
          const initializeInventory = inventory.openCursor();
          initializeInventory.onsuccess = () => {
            const cursor = initializeInventory.result;
            if (!cursor) return countSnapshotChunks();
            cursor.update({ ...cursor.value, observationCount: 0 });
            cursor.continue();
          };
        };
        const countSnapshotChunks = () => {
          const chunkCursor = chunks.openCursor();
          chunkCursor.onsuccess = () => {
            const cursor = chunkCursor.result;
            if (!cursor) return;
            const devices = Array.isArray(cursor.value?.devices) ? cursor.value.devices : [];
            let position = 0;
            const countNext = () => {
              if (position >= devices.length) {
                cursor.continue();
                return;
              }
              const device = devices[position++];
              if (!device?.id) {
                countNext();
                return;
              }
              const recordRequest = inventory.get(String(device.id));
              recordRequest.onsuccess = () => {
                const record = recordRequest.result;
                if (record) {
                  record.observationCount += 1;
                  inventory.put(record);
                }
                countNext();
              };
            };
            countNext();
          };
        };
        if (legacyInventoryBackfillDone) startObservationCountMigration();
      }
    };
    this.connection = await requestResult(request);
    this.connection.onversionchange = () => {
      this.connection.close();
      this.connection = null;
    };
    return this.connection;
  }

  async listSnapshots({ includeDiagnostics = true } = {}) {
    const db = await this.open();
    const tx = db.transaction("snapshots", "readonly");
    const store = tx.objectStore("snapshots");
    const records = await new Promise((resolve, reject) => {
      const items = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        const metadata = cursor.value;
        if (!includeDiagnostics && metadata.diagnostics) {
          const { diagnostics: _diagnostics, ...summary } = metadata;
          items.push(summary);
        } else {
          items.push(metadata);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("Не удалось перечислить снимки"));
    });
    await transactionDone(tx);
    return records.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  async deleteSnapshots(ids = []) {
    const selectedIds = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
    if (!selectedIds.size) return { deleted: 0, activeSnapshotId: await this.getSetting("activeSnapshotId", "") };
    const db = await this.open();
    const storeNames = ["snapshots", "snapshotChunks", "history", "settings", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "analyticsCache", "smartroomRoomMappings", "switchAddressEvidence", "dataQualityReports", "legacyObservationQueryScratch"];
    const tx = db.transaction(storeNames, "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const snapshots = tx.objectStore("snapshots");
    const settings = tx.objectStore("settings");
    let deleted = 0;
    let activeSnapshotId = "";
    const failTransaction = (request) => {
      request.onerror = () => { try { tx.abort(); } catch {} };
    };
    const deleteByCursor = (store, range, indexName = "") => {
      const request = (indexName ? store.index(indexName) : store).openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      failTransaction(request);
    };
    const activeRequest = settings.get("activeSnapshotId");
    activeRequest.onsuccess = () => {
      const oldActiveId = String(activeRequest.result?.value || "");
      const replaceActive = selectedIds.has(oldActiveId);
      let latestRemaining = null;
      const snapshotRequest = snapshots.openCursor();
      snapshotRequest.onsuccess = () => {
        const cursor = snapshotRequest.result;
        if (!cursor) {
          activeSnapshotId = replaceActive ? (latestRemaining?.id || "") : oldActiveId;
          if (replaceActive) settings.put({ key: "activeSnapshotId", value: activeSnapshotId });
          if (deleted) tx.objectStore("analyticsCache").clear();
          return;
        }
        const record = cursor.value;
        const id = String(record.id);
        if (selectedIds.has(id)) {
          deleted += 1;
          failTransaction(cursor.delete());
          deleteByCursor(tx.objectStore("snapshotChunks"), IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
          deleteByCursor(tx.objectStore("history"), IDBKeyRange.only(id), "by_snapshot");
          deleteByCursor(tx.objectStore("originalFiles"), IDBKeyRange.bound([id, ""], [id, "\uffff"]));
          deleteByCursor(tx.objectStore("finalAnalytics"), IDBKeyRange.bound([id, ""], [id, "\uffff"]), "by_snapshot");
          deleteByCursor(tx.objectStore("finalAnalyticsMetadata"), IDBKeyRange.only(id));
          deleteByCursor(tx.objectStore("smartroomRoomMappings"), IDBKeyRange.only(id), "by_snapshot");
          deleteByCursor(tx.objectStore("switchAddressEvidence"), IDBKeyRange.only(id), "by_snapshot");
          deleteByCursor(tx.objectStore("dataQualityReports"), IDBKeyRange.bound([id, ""], [id, "\uffff"]), "by_snapshot_created");
          const maxIndexKey = String.fromCharCode(65535);
          deleteByCursor(tx.objectStore("legacyObservationQueryScratch"), IDBKeyRange.bound([`analytics-final-v2:${id}`, "", ""], [`analytics-final-v2:${id}`, maxIndexKey, maxIndexKey]));
        } else if (isFinalSnapshot(record)) {
          const candidate = { id: record.id, createdAt: String(record.createdAt || "") };
          if (!latestRemaining
            || candidate.createdAt.localeCompare(latestRemaining.createdAt) > 0
            || (candidate.createdAt === latestRemaining.createdAt && String(candidate.id).localeCompare(String(latestRemaining.id)) > 0)) {
            latestRemaining = candidate;
          }
        }
        cursor.continue();
      };
      failTransaction(snapshotRequest);
    };
    failTransaction(activeRequest);
    await done;
    return { deleted, activeSnapshotId };
  }

  async clearSnapshots() {
    const db = await this.open();
    const storeNames = ["snapshots", "snapshotChunks", "history", "settings", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "analyticsCache", "smartroomRoomMappings", "switchAddressEvidence", "legacyObservationQueryScratch"];
    const tx = db.transaction(storeNames, "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
      const count = await requestResult(tx.objectStore("snapshots").count());
      for (const name of ["snapshots", "snapshotChunks", "history", "originalFiles", "finalAnalytics", "finalAnalyticsMetadata", "analyticsCache", "smartroomRoomMappings", "switchAddressEvidence", "legacyObservationQueryScratch"]) {
        tx.objectStore(name).clear();
      }
      tx.objectStore("settings").put({ key: "activeSnapshotId", value: "" });
      await done;
      return { deleted: Number(count || 0), activeSnapshotId: "" };
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async loadSnapshotHistoryCache(signature, filters = {}) {
    return this.loadAnalyticsCache(snapshotHistoryCacheKey(filters), signature, SNAPSHOT_HISTORY_CACHE_SCHEMA);
  }

  async loadAnalyticsCache(key, signature, schemaVersion = 1) {
    const db = await this.open();
    const tx = db.transaction("analyticsCache", "readonly");
    const record = await requestResult(tx.objectStore("analyticsCache").get(key));
    await transactionDone(tx);
    return record?.schemaVersion === schemaVersion && record.signature === signature ? record.value : null;
  }

  async saveSnapshotHistoryCache(signature, value, filters = {}) {
    return this.saveAnalyticsCache(snapshotHistoryCacheKey(filters), signature, value, SNAPSHOT_HISTORY_CACHE_SCHEMA);
  }

  async saveAnalyticsCache(key, signature, value, schemaVersion = 1, { onProgress = null } = {}) {
    const db = await this.open();
    const tx = db.transaction(["snapshots", "analyticsCache"], "readwrite");
    const done = transactionDone(tx);
    const rows = [];
    let preparationError = null;
    const report = (phase, details = {}) => {
      if (typeof onProgress === "function") onProgress({ phase, ...details });
    };
    tx.addEventListener("complete", () => report("transaction-complete"));
    const cursorRequest = tx.objectStore("snapshots").openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        if (isFinalSnapshot(cursor.value)) rows.push(cursor.value);
        cursor.continue();
        return;
      }
      const currentSignature = snapshotMetadataSignature(rows);
      if (currentSignature !== signature) return;
      try {
        report("serialize-start");
        const cleanValue = serializable(value);
        report("serialize-complete");
        const put = tx.objectStore("analyticsCache").put({ key, schemaVersion, signature, value: cleanValue, updatedAt: new Date().toISOString() });
        put.addEventListener("success", () => report("put-complete"));
      } catch (error) {
        preparationError = error;
        try { tx.abort(); } catch {}
      }
    };
    report("started");
    await done.catch((error) => { throw preparationError || error; });
    report("complete");
    return snapshotMetadataSignature(rows) === signature;
  }

  async clearAnalyticsAggregateQuery(queryId, metric = "") {
    if (!queryId) throw new TypeError("Для очистки агрегатов нужен ID запроса");
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
    const done = transactionDone(tx);
    const request = tx.objectStore("legacyObservationQueryScratch").openCursor(
      IDBKeyRange.bound([queryId, metric, ""], [queryId, metric || "\uffff", "\uffff"]),
    );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await done;
  }

  async addAnalyticsDistinctBatch(queryId, metric, values = [], alsoMetric = "") {
    if (!queryId || !metric || !Array.isArray(values)) throw new TypeError("Для временного множества нужны ID запроса, тип и значения");
    const unique = [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
    const temporalQuery = String(queryId).startsWith("temporal:");
    const secondaryMetric = String(alsoMetric || "");
    if (secondaryMetric && (!temporalQuery || secondaryMetric === metric)) throw new TypeError("Дополнительный тип допустим только для двух разных временных множеств");
    if (!unique.length && !temporalQuery) return 0;
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservationQueryScratch");
    const updatedAt = Date.now();
    if (temporalQuery) store.put({ queryId, metric: "", value: "lease", count: 1, rankCount: -1, updatedAt });
    for (const value of unique) {
      // A set key is idempotent, so one bounded put is enough even when a MAC
      // appeared in a previous chunk of the same period.
      store.put({ queryId, metric, value, count: 1, rankCount: -1, updatedAt });
      if (secondaryMetric) store.put({ queryId, metric: secondaryMetric, value, count: 1, rankCount: -1, updatedAt });
    }
    await done;
    return unique.length;
  }

  async clearExpiredAnalyticsAggregateQueries(queryIdPrefix, olderThan = Date.now() - 86_400_000) {
    const prefix = String(queryIdPrefix || "");
    const cutoff = Number(olderThan);
    if (!prefix || !Number.isFinite(cutoff)) throw new TypeError("Для очистки устаревших агрегатов нужны префикс и дата");
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
    const done = transactionDone(tx);
    const range = IDBKeyRange.bound([prefix, "", ""], [`${prefix}\uffff`, "\uffff", "\uffff"]);
    const request = tx.objectStore("legacyObservationQueryScratch").openCursor(range);
    let removed = 0;
    let currentQueryId = "";
    let currentQueryIsActive = false;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      if (record.queryId !== currentQueryId) {
        currentQueryId = record.queryId;
        currentQueryIsActive = record.metric === "" && record.value === "lease" && Number(record.updatedAt || 0) >= cutoff;
      }
      if (!currentQueryIsActive) {
        cursor.delete();
        removed += 1;
      }
      cursor.continue();
    };
    await done;
    return removed;
  }

  async compareAnalyticsDistinctMetrics(queryId, previousMetric, currentMetric) {
    if (!queryId || !previousMetric || !currentMetric) throw new TypeError("Для сравнения нужны два временных множества");
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservationQueryScratch");
    const rangeFor = (metric) => IDBKeyRange.bound([queryId, metric, ""], [queryId, metric, "\uffff"]);
    const previousRequest = store.openCursor(rangeFor(previousMetric));
    const currentRequest = store.openCursor(rangeFor(currentMetric));
    const stats = { previousCount: 0, currentCount: 0, added: 0, removed: 0 };
    let previousCursor;
    let currentCursor;
    let previousWaiting = true;
    let currentWaiting = true;
    const advancePrevious = () => { previousWaiting = true; previousCursor.continue(); };
    const advanceCurrent = () => { currentWaiting = true; currentCursor.continue(); };
    const compare = () => {
      if (previousWaiting || currentWaiting) return;
      if (!previousCursor && !currentCursor) return;
      if (!previousCursor) {
        stats.currentCount += 1;
        stats.added += 1;
        advanceCurrent();
        return;
      }
      if (!currentCursor) {
        stats.previousCount += 1;
        stats.removed += 1;
        advancePrevious();
        return;
      }
      const previousValue = String(previousCursor.value.value);
      const currentValue = String(currentCursor.value.value);
      if (previousValue === currentValue) {
        stats.previousCount += 1;
        stats.currentCount += 1;
        advancePrevious();
        advanceCurrent();
      } else if (previousValue < currentValue) {
        stats.previousCount += 1;
        stats.removed += 1;
        advancePrevious();
      } else {
        stats.currentCount += 1;
        stats.added += 1;
        advanceCurrent();
      }
    };
    previousRequest.onsuccess = () => { previousCursor = previousRequest.result; previousWaiting = false; compare(); };
    currentRequest.onsuccess = () => { currentCursor = currentRequest.result; currentWaiting = false; compare(); };
    await done;
    return stats;
  }

  async mergeAnalyticsAggregateBatch(queryId, metric, rows = []) {
    if (!queryId || !metric || !Array.isArray(rows)) throw new TypeError("Для агрегата нужны ID запроса, тип и строки");
    if (!rows.length) return 0;
    const batch = new Map();
    for (const row of rows) {
      const value = String(row?.value ?? "");
      const count = Number(row?.count ?? 1);
      if (!value || !Number.isSafeInteger(count) || count < 1) continue;
      const previous = batch.get(value);
      batch.set(value, {
        value,
        count: (previous?.count || 0) + count,
        data: row.data === undefined ? previous?.data : serializable(row.data),
      });
    }
    if (!batch.size) return 0;
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservationQueryScratch");
    for (const row of batch.values()) {
      const request = store.get([queryId, metric, row.value]);
      request.onsuccess = () => {
        const previous = request.result;
        store.put({
          queryId,
          metric,
          value: row.value,
          count: Number(previous?.count || 0) + row.count,
          rankCount: -(Number(previous?.count || 0) + row.count),
          data: row.data === undefined ? previous?.data : row.data,
        });
      };
    }
    await done;
    return batch.size;
  }

  async mergeAnalyticsAggregateBatches(queryId, metrics = {}) {
    if (!queryId || !metrics || typeof metrics !== "object") throw new TypeError("Для агрегатов нужны ID запроса и метрики");
    const batches = new Map();
    for (const [metric, rows] of Object.entries(metrics)) {
      if (!Array.isArray(rows)) throw new TypeError("Строки агрегата должны быть массивом");
      const batch = new Map();
      for (const row of rows) {
        const value = String(row?.value ?? "");
        const count = Number(row?.count ?? 1);
        if (!value || !Number.isSafeInteger(count) || count < 1) continue;
        const previous = batch.get(value);
        batch.set(value, {
          value,
          count: (previous?.count || 0) + count,
          data: row.data === undefined ? previous?.data : serializable(row.data),
        });
      }
      if (batch.size) batches.set(metric, batch);
    }
    if (!batches.size) return 0;
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservationQueryScratch");
    let merged = 0;
    for (const [metric, batch] of batches) {
      for (const row of batch.values()) {
        const request = store.get([queryId, metric, row.value]);
        request.onsuccess = () => {
          const previous = request.result;
          store.put({
            queryId,
            metric,
            value: row.value,
            count: Number(previous?.count || 0) + row.count,
            rankCount: -(Number(previous?.count || 0) + row.count),
            data: row.data === undefined ? previous?.data : row.data,
          });
          merged += 1;
        };
      }
    }
    await done;
    return merged;
  }

  async analyticsAggregateCount(queryId, metric) {
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const range = IDBKeyRange.bound([queryId, metric, 0, ""], [queryId, metric, Number.MAX_SAFE_INTEGER, "\uffff"]);
    const count = await requestResult(tx.objectStore("legacyObservationQueryScratch").index("by_query_metric_count").count(range));
    await done;
    return Number(count || 0);
  }

  async analyticsAggregateTop(queryId, metric, limit = 50, locale = "ru") {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const range = IDBKeyRange.bound([queryId, metric, 0, ""], [queryId, metric, Number.MAX_SAFE_INTEGER, "\uffff"]);
    const rows = [];
    const request = tx.objectStore("legacyObservationQueryScratch").index("by_query_metric_count").openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      const candidate = { value: record.value, count: Number(record.count || 0), ...(record.data === undefined ? {} : { data: record.data }) };
      const position = rows.findIndex((item) => item.count < candidate.count
        || (item.count === candidate.count && String(item.data?.label || item.value).localeCompare(String(candidate.data?.label || candidate.value), locale) > 0));
      if (position < 0) rows.push(candidate);
      else rows.splice(position, 0, candidate);
      if (rows.length > pageSize) rows.pop();
      cursor.continue();
    };
    await done;
    return rows;
  }

  async analyticsAggregatePage(queryId, metric, { after = null, limit = 50 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const lower = [queryId, metric, 0, ""];
    const upper = [queryId, metric, Number.MAX_SAFE_INTEGER, "\uffff"];
    const range = after
      ? IDBKeyRange.bound(lower, after, false, true)
      : IDBKeyRange.bound(lower, upper);
    const rows = [];
    let nextCursor = null;
    let hasMore = false;
    const request = tx.objectStore("legacyObservationQueryScratch").index("by_query_metric_count").openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      const record = cursor.value;
      rows.push({ value: record.value, count: Number(record.count || 0), ...(record.data === undefined ? {} : { data: record.data }) });
      nextCursor = Array.from(cursor.key);
      cursor.continue();
    };
    await done;
    return { rows, total: await this.analyticsAggregateCount(queryId, metric), hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async analyticsAggregateRankedPage(queryId, metric, { after = null, before = null, limit = 20 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const lower = [queryId, metric, -Number.MAX_SAFE_INTEGER, ""];
    const upper = [queryId, metric, 0, "\uffff"];
    const backwards = Boolean(before);
    const range = backwards
      ? IDBKeyRange.bound(lower, before, false, true)
      : after ? IDBKeyRange.bound(after, upper, true, false) : IDBKeyRange.bound(lower, upper);
    const rows = [];
    let hasMore = false;
    const request = tx.objectStore("legacyObservationQueryScratch").index("by_query_metric_rank").openCursor(range, backwards ? "prev" : "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      const record = cursor.value;
      rows.push({ value: record.value, count: Number(record.count || 0), ...(record.data === undefined ? {} : { data: record.data }) });
      cursor.continue();
    };
    await done;
    if (backwards) rows.reverse();
    return {
      rows,
      total: await this.analyticsAggregateCount(queryId, metric),
      hasMore: backwards ? rows.length > 0 : hasMore,
      firstCursor: rows.length ? [queryId, metric, -rows[0].count, rows[0].value] : null,
      nextCursor: rows.length && (backwards || hasMore) ? [queryId, metric, -rows.at(-1).count, rows.at(-1).value] : null,
    };
  }

  async analyticsAggregateValuePage(queryId, metric, { after = null, before = null, limit = 50 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    const db = await this.open();
    const tx = db.transaction("legacyObservationQueryScratch", "readonly");
    const done = transactionDone(tx);
    const lower = [queryId, metric, ""];
    const upper = [queryId, metric, "\uffff"];
    const backwards = Boolean(before);
    const range = backwards
      ? IDBKeyRange.bound(lower, [queryId, metric, before], false, true)
      : after ? IDBKeyRange.bound([queryId, metric, after], upper, true, false) : IDBKeyRange.bound(lower, upper);
    const rows = [];
    let hasMore = false;
    const request = tx.objectStore("legacyObservationQueryScratch").openCursor(range, backwards ? "prev" : "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      const record = cursor.value;
      rows.push({ value: record.value, count: Number(record.count || 0), ...(record.data === undefined ? {} : { data: record.data }) });
      cursor.continue();
    };
    await done;
    if (backwards) rows.reverse();
    return {
      rows,
      total: await this.analyticsAggregateCount(queryId, metric),
      hasMore: backwards ? rows.length > 0 : hasMore,
      firstCursor: rows[0]?.value || null,
      nextCursor: rows.length && (backwards || hasMore) ? rows.at(-1).value : null,
    };
  }

  async loadFinalAnalyticsIndex(snapshotId, signature, schemaVersion = 1, projectDevice = null) {
    if (projectDevice !== null && typeof projectDevice !== "function") throw new TypeError("Проекция FinalAnalytics должна быть функцией");
    const db = await this.open();
    const metadataTx = db.transaction("finalAnalyticsMetadata", "readonly");
    const metadata = await requestResult(metadataTx.objectStore("finalAnalyticsMetadata").get(snapshotId));
    await transactionDone(metadataTx);
    if (metadata?.schemaVersion !== schemaVersion || metadata.signature !== signature) return null;
    const deviceCount = Number(metadata.deviceCount);
    const chunkCount = Number(metadata.chunkCount);
    if (!Number.isInteger(deviceCount) || deviceCount < 0 || chunkCount !== Math.ceil(deviceCount / CHUNK_SIZE)) return null;
    const devices = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const tx = db.transaction("finalAnalytics", "readonly");
      const chunk = await requestResult(tx.objectStore("finalAnalytics").get([snapshotId, metadata.generation, index]));
      await transactionDone(tx);
      const expectedLength = Math.min(CHUNK_SIZE, Math.max(0, deviceCount - index * CHUNK_SIZE));
      if (!Array.isArray(chunk?.devices) || chunk.devices.length !== expectedLength) return null;
      devices.push(...(projectDevice ? chunk.devices.map(projectDevice) : chunk.devices));
    }
    return devices.length === deviceCount ? devices : null;
  }

  async saveFinalAnalyticsIndex(snapshotId, signature, devices = [], schemaVersion = 1) {
    if (!snapshotId || !Array.isArray(devices)) throw new TypeError("Нужен снимок Final и массив компактных записей");
    const db = await this.open();
    const generation = crypto.randomUUID();
    let committed = false;
    try {
      for (let offset = 0; offset < devices.length; offset += CHUNK_SIZE) {
        const tx = db.transaction("finalAnalytics", "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("finalAnalytics").put({ snapshotId, generation, index: offset / CHUNK_SIZE, devices: devices.slice(offset, offset + CHUNK_SIZE) });
        await done;
      }
      const tx = db.transaction("finalAnalyticsMetadata", "readwrite");
      const done = transactionDone(tx);
      tx.objectStore("finalAnalyticsMetadata").put({ snapshotId, generation, signature, schemaVersion, deviceCount: devices.length, chunkCount: Math.ceil(devices.length / CHUNK_SIZE), savedAt: new Date().toISOString() });
      await done;
      committed = true;
      await this.#deleteStaleFinalAnalyticsGenerations(snapshotId, generation);
      return true;
    } catch (error) {
      if (!committed) await this.#deleteFinalAnalyticsGeneration(snapshotId, generation).catch(() => {});
      throw error;
    }
  }

  async invalidateFinalAnalyticsIndex(snapshotId) {
    const db = await this.open();
    const tx = db.transaction("finalAnalyticsMetadata", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("finalAnalyticsMetadata").delete(snapshotId);
    await done;
    await this.#deleteStaleFinalAnalyticsGenerations(snapshotId, "");
  }

  async #deleteFinalAnalyticsGeneration(snapshotId, generation) {
    const db = await this.open();
    const tx = db.transaction("finalAnalytics", "readwrite");
    const done = transactionDone(tx);
    const range = globalThis.IDBKeyRange.bound([snapshotId, generation, 0], [snapshotId, generation, Number.MAX_SAFE_INTEGER]);
    const request = tx.objectStore("finalAnalytics").openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await done;
  }

  async #deleteStaleFinalAnalyticsGenerations(snapshotId, keepGeneration) {
    const db = await this.open();
    const tx = db.transaction("finalAnalytics", "readwrite");
    const done = transactionDone(tx);
    const range = globalThis.IDBKeyRange.bound([snapshotId, "", 0], [snapshotId, "\uffff", Number.MAX_SAFE_INTEGER]);
    const request = tx.objectStore("finalAnalytics").openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.generation !== keepGeneration) cursor.delete();
      cursor.continue();
    };
    await done;
  }

  async findSnapshotBySourceKey(sourceKey, { snapshotType = FINAL_SNAPSHOT_TYPE } = {}) {
    if (!sourceKey) return null;
    const db = await this.open();
    const tx = db.transaction("snapshots", "readonly");
    const index = tx.objectStore("snapshots").index("by_source_key");
    const range = globalThis.IDBKeyRange.only(sourceKey);
    let record = null;
    await new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (resolveSnapshotType(snapshotType, cursor.value.name) === resolveSnapshotType(cursor.value.snapshotType, cursor.value.name)) {
          record = cursor.value;
          return resolve();
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("Ошибка чтения индекса снимков"));
    });
    await transactionDone(tx);
    return record || null;
  }

  async forEachSnapshotChunk(id, visit, { onProgress = null } = {}) {
    const db = await this.open();
    const metadataTx = db.transaction("snapshots", "readonly");
    const metadataDone = transactionDone(metadataTx);
    const [metadata] = await Promise.all([
      requestResult(metadataTx.objectStore("snapshots").get(id)),
      metadataDone,
    ]);
    if (!metadata) throw snapshotIntegrityError("Final-снимок не найден");
    const chunkCount = Number(metadata.chunkCount ?? Math.ceil(Number(metadata.deviceCount || 0) / CHUNK_SIZE));
    const deviceCount = Number(metadata.deviceCount || 0);
    if (!Number.isInteger(deviceCount) || deviceCount < 0 || chunkCount !== Math.ceil(deviceCount / CHUNK_SIZE)) {
      throw snapshotIntegrityError("Final-снимок повреждён: метаданные блоков некорректны");
    }
    let visitedDevices = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      if (typeof onProgress === "function") onProgress({ phase: "chunk-start", index, chunkCount, visitedDevices, deviceCount });
      const chunkTx = db.transaction("snapshotChunks", "readonly");
      const chunkDone = transactionDone(chunkTx);
      // A successful readonly get already owns a detached structured clone of the
      // chunk. Do not hold the streaming consumer behind transaction.complete:
      // some browser profiles can leave that event pending even after request success.
      void chunkDone.catch(() => {});
      const chunkRequest = chunkTx.objectStore("snapshotChunks").get([id, index]);
      if (typeof onProgress === "function") {
        chunkRequest.addEventListener("success", () => onProgress({ phase: "chunk-result", index, chunkCount, visitedDevices, deviceCount }));
      }
      const chunk = await requestResult(chunkRequest);
      const expectedLength = Math.min(CHUNK_SIZE, Math.max(0, Number(metadata.deviceCount || 0) - index * CHUNK_SIZE));
      if (!Array.isArray(chunk?.devices) || chunk.devices.length !== expectedLength) throw snapshotIntegrityError(`Final-снимок повреждён: отсутствует или неполон блок ${index + 1}`);
      visitedDevices += chunk.devices.length;
      if (typeof onProgress === "function") onProgress({ phase: "chunk-ready", index, chunkCount, visitedDevices, deviceCount });
      if (await visit(chunk.devices, index, metadata) === false) return metadata;
      if (typeof onProgress === "function") onProgress({ phase: "chunk-complete", index, chunkCount, visitedDevices, deviceCount });
    }
    if (visitedDevices !== deviceCount) throw snapshotIntegrityError("Final-снимок повреждён: число устройств не совпадает с метаданными");
    return metadata;
  }

  async *iterateSnapshotDevices(id, { start = 0, limit = Number.MAX_SAFE_INTEGER } = {}) {
    const safeStart = Math.max(0, Math.floor(Number(start) || 0));
    const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
    const db = await this.open();
    const metadataTx = db.transaction("snapshots", "readonly");
    const metadata = await requestResult(metadataTx.objectStore("snapshots").get(id));
    await transactionDone(metadataTx);
    if (!metadata) throw snapshotIntegrityError("Final-снимок не найден");
    const deviceCount = Number(metadata.deviceCount || 0);
    const chunkCount = Number(metadata.chunkCount ?? Math.ceil(deviceCount / CHUNK_SIZE));
    if (!Number.isInteger(deviceCount) || deviceCount < 0 || chunkCount !== Math.ceil(deviceCount / CHUNK_SIZE)) {
      throw snapshotIntegrityError("Final-снимок повреждён: метаданные блоков некорректны");
    }
    const end = Math.min(deviceCount, safeStart + safeLimit);
    let yielded = 0;
    for (let index = Math.floor(safeStart / CHUNK_SIZE); index < chunkCount && index * CHUNK_SIZE < end; index += 1) {
      const chunkTx = db.transaction("snapshotChunks", "readonly");
      const chunk = await requestResult(chunkTx.objectStore("snapshotChunks").get([id, index]));
      await transactionDone(chunkTx);
      const expectedLength = Math.min(CHUNK_SIZE, Math.max(0, deviceCount - index * CHUNK_SIZE));
      if (!Array.isArray(chunk?.devices) || chunk.devices.length !== expectedLength) {
        throw snapshotIntegrityError(`Final-снимок повреждён: отсутствует или неполон блок ${index + 1}`);
      }
      const offset = index === Math.floor(safeStart / CHUNK_SIZE) ? safeStart % CHUNK_SIZE : 0;
      const take = Math.min(chunk.devices.length - offset, end - (index * CHUNK_SIZE + offset));
      for (let row = 0; row < take; row += 1) {
        yield chunk.devices[offset + row];
        yielded += 1;
      }
    }
    if (yielded !== end - Math.min(safeStart, deviceCount)) throw snapshotIntegrityError("Final-снимок повреждён: число устройств в диапазоне не совпадает");
  }

  async loadSnapshotPage(id, { page = 1, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const metadataDb = await this.open();
    const metadataTx = metadataDb.transaction("snapshots", "readonly");
    const metadata = await requestResult(metadataTx.objectStore("snapshots").get(id));
    await transactionDone(metadataTx);
    if (!metadata) throw snapshotIntegrityError("Final-снимок не найден");
    const deviceCount = Number(metadata.deviceCount || 0);
    const chunkCount = Number(metadata.chunkCount ?? Math.ceil(deviceCount / CHUNK_SIZE));
    if (!Number.isInteger(deviceCount) || deviceCount < 0 || chunkCount !== Math.ceil(deviceCount / CHUNK_SIZE)) {
      throw snapshotIntegrityError("Final-снимок повреждён: метаданные блоков некорректны");
    }
    const pageCount = Math.max(1, Math.ceil(deviceCount / safeLimit));
    const selectedPage = Math.min(pageCount, Math.max(1, Math.floor(Number(page) || 1)));
    const offset = (selectedPage - 1) * safeLimit;
    const end = Math.min(deviceCount, offset + safeLimit);
    const firstChunk = Math.floor(offset / CHUNK_SIZE);
    const lastChunk = end > offset ? Math.floor((end - 1) / CHUNK_SIZE) : firstChunk - 1;
    const devices = [];
    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const chunkTx = metadataDb.transaction("snapshotChunks", "readonly");
      const chunk = await requestResult(chunkTx.objectStore("snapshotChunks").get([id, index]));
      await transactionDone(chunkTx);
      const expectedLength = Math.min(CHUNK_SIZE, Math.max(0, deviceCount - index * CHUNK_SIZE));
      if (!Array.isArray(chunk?.devices) || chunk.devices.length !== expectedLength) {
        throw snapshotIntegrityError(`Final-снимок повреждён: отсутствует или неполон блок ${index + 1}`);
      }
      const chunkStart = index * CHUNK_SIZE;
      const from = Math.max(0, offset - chunkStart);
      const to = Math.min(chunk.devices.length, end - chunkStart);
      devices.push(...chunk.devices.slice(from, to));
    }
    return { metadata, devices, total: deviceCount, page: selectedPage, pageCount, hasPrevious: selectedPage > 1, hasNext: selectedPage < pageCount };
  }

  async loadSnapshotDevicePage(id, { switchIp = "", switchPort = "", unassigned = false, page = 1, limit = 50 } = {}) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const selectedPage = Math.max(1, Math.floor(Number(page) || 1));
    const offset = (selectedPage - 1) * pageSize;
    const selected = [];
    let total = 0;
    await this.forEachSnapshotChunk(id, (chunk) => {
      for (const device of chunk) {
        const deviceSwitchIp = text(device.switchIp) || text(device.switch_ip);
        if (unassigned ? Boolean(deviceSwitchIp) : deviceSwitchIp !== switchIp) continue;
        if (!unassigned && (text(device.switchPort) || text(device.switch_port) || "Не указан") !== switchPort) continue;
        total += 1;
        if (total > offset && selected.length < pageSize) selected.push(device);
      }
    });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const boundedPage = Math.min(selectedPage, pageCount);
    if (boundedPage !== selectedPage) return this.loadSnapshotDevicePage(id, { switchIp, switchPort, unassigned, page: boundedPage, limit: pageSize });
    return {
      devices: selected,
      total,
      page: selectedPage,
      pageCount,
      hasPrevious: selectedPage > 1,
      hasNext: selectedPage < pageCount,
    };
  }

  async loadSnapshotUnassignedRoomPage(id, { page = 1, limit = 50, filters = {} } = {}) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const selectedPage = Math.max(1, Math.floor(Number(page) || 1));
    const offset = (selectedPage - 1) * pageSize;
    const devices = [];
    let total = 0;
    await this.forEachSnapshotChunk(id, (chunk) => {
      for (const device of chunk) {
        if (locationKey(device) || !dashboardDeviceMatchesFilters(device, filters)) continue;
        total += 1;
        if (total > offset && devices.length < pageSize) devices.push(device);
      }
    });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const boundedPage = Math.min(selectedPage, pageCount);
    if (boundedPage !== selectedPage) return this.loadSnapshotUnassignedRoomPage(id, { page: boundedPage, limit: pageSize, filters });
    return {
      devices,
      total,
      page: boundedPage,
      pageCount,
      hasPrevious: boundedPage > 1,
      hasNext: boundedPage < pageCount,
    };
  }

  async loadSnapshotRoomAnomalyPage(id, { roomKey = "", page = 1, limit = 100, filters = {} } = {}) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
    const selectedPage = Math.max(1, Math.floor(Number(page) || 1));
    const smartroomId = roomKey.startsWith("sr:") ? roomKey.slice(3) : "";
    const locationSmartroomIds = new Map();
    const deviceLocation = (device) => locationKey({ ...device, smartroomId: "", smartroom_id: "" });
    if (smartroomId) {
      await this.forEachSnapshotChunk(id, (chunk) => {
        for (const device of chunk) {
          if (!text(device.smartroomId || device.smartroom_id)) continue;
          const location = deviceLocation(device);
          if (!location) continue;
          const ids = locationSmartroomIds.get(location) || new Set();
          ids.add(keyText(device.smartroomId || device.smartroom_id));
          locationSmartroomIds.set(location, ids);
        }
      });
    }
    const offset = (selectedPage - 1) * pageSize;
    const devices = [];
    let total = 0;
    await this.forEachSnapshotChunk(id, (chunk) => {
      for (const device of chunk) {
        const deviceId = keyText(device.smartroomId || device.smartroom_id);
        let matches = smartroomId
          ? deviceId === smartroomId
          : locationKey(device) === roomKey;
        if (smartroomId && !deviceId) {
          const location = deviceLocation(device);
          const ids = locationSmartroomIds.get(location);
          matches = Boolean(location && ids?.size === 1 && ids.has(smartroomId));
        }
        if (!matches || !dashboardDeviceMatchesFilters(device, filters)) continue;
        total += 1;
        if (total > offset && devices.length < pageSize) devices.push(device);
      }
    });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const boundedPage = Math.min(selectedPage, pageCount);
    if (boundedPage !== selectedPage) return this.loadSnapshotRoomAnomalyPage(id, { roomKey, page: boundedPage, limit: pageSize, filters });
    return { devices, total, page: selectedPage, pageCount, hasPrevious: selectedPage > 1, hasNext: selectedPage < pageCount };
  }

  async loadSnapshot(id) {
    const devices = [];
    const metadata = await this.forEachSnapshotChunk(id, (chunk) => devices.push(...chunk));
    return { ...metadata, devices };
  }

  async saveSingleAnalysis({ id = crypto.randomUUID(), filename, sheetName = "", result, processedAt = new Date().toISOString(), finalSnapshotId = "" } = {}) {
    if (!id || !filename || !result || !Array.isArray(result.devices) || !result.diagnostics) {
      throw new Error("Для сохранения анализа нужны имя файла, устройства и диагностика");
    }
    const diagnostics = result.diagnostics;
    const arrays = {
      devices: result.devices,
      invalid: diagnostics.invalid || [],
      invalidMacs: diagnostics.invalidMacs || [],
      ambiguous: diagnostics.ambiguous || [],
      identityConflicts: diagnostics.identityConflicts || [],
    };
    const chunkCount = Math.ceil(Math.max(...Object.values(arrays).map((rows) => rows.length), 0) / CHUNK_SIZE);
    const metadata = {
      id,
      filename: String(filename).slice(0, 1024),
      sheetName: String(sheetName).slice(0, 1024),
      finalSnapshotId: String(finalSnapshotId || "").slice(0, 160),
      processedAt: String(processedAt),
      headers: Array.isArray(result.headers) ? result.headers : [],
      mapping: result.mapping && typeof result.mapping === "object" ? result.mapping : {},
      detection: result.detection && typeof result.detection === "object" ? result.detection : {},
      mappingMode: String(result.mappingMode || "auto"),
      summary: result.summary && typeof result.summary === "object" ? result.summary : {},
      diagnosticCounts: {
        invalid: Number(diagnostics.invalidTotal ?? diagnostics.invalid?.length ?? 0),
        invalidMacs: Number(diagnostics.invalidMacsTotal ?? diagnostics.invalidMacs?.length ?? 0),
        ambiguous: Number(diagnostics.ambiguousTotal ?? diagnostics.ambiguous?.length ?? 0),
        identityConflicts: Number(diagnostics.identityConflictCount || diagnostics.identityConflicts?.length || 0),
        duplicateRows: Number(diagnostics.duplicateRows || 0),
      },
      deviceCount: result.devices.length,
      storedRecordCounts: {
        invalid: arrays.invalid.length,
        invalidMacs: arrays.invalidMacs.length,
        ambiguous: arrays.ambiguous.length,
        identityConflicts: arrays.identityConflicts.length,
      },
      chunkCount,
    };
    const db = await this.open();
    const tx = db.transaction(["singleAnalyses", "singleAnalysisChunks"], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
      const analyses = tx.objectStore("singleAnalyses");
      if (await requestResult(analyses.get(id))) throw new Error("Анализ с таким ID уже сохранён");
      const chunks = tx.objectStore("singleAnalysisChunks");
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * CHUNK_SIZE;
        chunks.put({
          analysisId: id,
          index,
          devices: arrays.devices.slice(start, start + CHUNK_SIZE),
          invalid: arrays.invalid.slice(start, start + CHUNK_SIZE),
          invalidMacs: arrays.invalidMacs.slice(start, start + CHUNK_SIZE),
          ambiguous: arrays.ambiguous.slice(start, start + CHUNK_SIZE),
          identityConflicts: arrays.identityConflicts.slice(start, start + CHUNK_SIZE),
        });
      }
      analyses.add(metadata);
      await done;
      return metadata;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async listSingleAnalyses({ query = "", page = 1, limit = 25 } = {}) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
    const selectedPage = Math.max(1, Math.floor(Number(page) || 1));
    const needle = keyText(query);
    const db = await this.open();
    const tx = db.transaction("singleAnalyses", "readonly");
    const done = transactionDone(tx);
    const rows = [];
    let total = 0;
    const request = tx.objectStore("singleAnalyses").index("by_processed_at").openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value;
      if (!needle || keyText(item.filename).includes(needle)) {
        total += 1;
        const offset = (selectedPage - 1) * pageSize;
        if (total > offset && rows.length < pageSize) rows.push(item);
      }
      cursor.continue();
    };
    await done;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (selectedPage > pageCount) return this.listSingleAnalyses({ query, page: pageCount, limit: pageSize });
    return { rows, total, page: selectedPage, pageCount, hasPrevious: selectedPage > 1, hasNext: selectedPage < pageCount };
  }

  async singleAnalysisMetadataPage({ afterId = "", limit = 100 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const db = await this.open();
    const tx = db.transaction("singleAnalyses", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("singleAnalyses");
    const countPromise = requestResult(store.count());
    const rows = [];
    let hasMore = false;
    const range = afterId ? IDBKeyRange.lowerBound(String(afterId), true) : null;
    const request = store.openCursor(range, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (rows.length >= pageSize) { hasMore = true; return; }
      rows.push(cursor.value);
      cursor.continue();
    };
    await done;
    const total = Number(await countPromise || 0);
    return { rows, total, hasMore, nextCursor: hasMore ? String(rows.at(-1)?.id || "") : "" };
  }

  async forEachSingleAnalysisChunk(id, visit = () => {}) {
    const analysisId = String(id || "");
    if (!analysisId || typeof visit !== "function") throw new TypeError("Для проверки анализа нужны ID и обработчик блока");
    const db = await this.open();
    const metadataTx = db.transaction("singleAnalyses", "readonly");
    const [metadata] = await Promise.all([
      requestResult(metadataTx.objectStore("singleAnalyses").get(analysisId)),
      transactionDone(metadataTx),
    ]);
    if (!metadata) throw new Error("Сохранённый анализ не найден");
    const storedCounts = metadata.storedRecordCounts || {};
    const fields = ["devices", "invalid", "invalidMacs", "ambiguous", "identityConflicts"];
    const counts = {
      devices: Number(metadata.deviceCount),
      invalid: Number(storedCounts.invalid),
      invalidMacs: Number(storedCounts.invalidMacs),
      ambiguous: Number(storedCounts.ambiguous),
      identityConflicts: Number(storedCounts.identityConflicts),
    };
    const countValues = Object.values(counts);
    const chunkCount = Number(metadata.chunkCount);
    const expectedChunkCount = Math.ceil(Math.max(...countValues, 0) / CHUNK_SIZE);
    if (countValues.some((count) => !Number.isSafeInteger(count) || count < 0)
      || !Number.isSafeInteger(chunkCount) || chunkCount !== expectedChunkCount) {
      throw new Error("Сохранённый анализ повреждён: метаданные блоков некорректны");
    }
    for (let index = 0; index < chunkCount; index += 1) {
      const tx = db.transaction("singleAnalysisChunks", "readonly");
      const done = transactionDone(tx);
      void done.catch(() => {});
      const chunk = await requestResult(tx.objectStore("singleAnalysisChunks").get([analysisId, index]));
      if (!chunk || fields.some((field) => !Array.isArray(chunk[field]))) {
        throw new Error("Сохранённый анализ повреждён: отсутствует блок " + (index + 1));
      }
      const invalidFields = fields.filter((field) => {
        const expectedLength = Math.min(CHUNK_SIZE, Math.max(0, counts[field] - index * CHUNK_SIZE));
        return chunk[field].length !== expectedLength;
      });
      if (invalidFields.length) {
        throw new Error("Сохранённый анализ повреждён: блок " + (index + 1) + " не совпадает с метаданными (" + invalidFields.join(", ") + ")");
      }
      await visit(chunk, index, metadata);
    }
    return metadata;
  }

  async loadSingleAnalysis(id) {
    const db = await this.open();
    const metadataTx = db.transaction("singleAnalyses", "readonly");
    const metadata = await requestResult(metadataTx.objectStore("singleAnalyses").get(String(id || "")));
    await transactionDone(metadataTx);
    if (!metadata) return null;
    const result = {
      filename: metadata.filename,
      headers: metadata.headers,
      mapping: metadata.mapping,
      detection: metadata.detection,
      mappingMode: metadata.mappingMode,
      summary: metadata.summary,
      devices: [],
      diagnostics: {
        invalid: [], invalidMacs: [], ambiguous: [], identityConflicts: [],
        invalidTotal: Number(metadata.diagnosticCounts.invalid || 0),
        invalidMacsTotal: Number(metadata.diagnosticCounts.invalidMacs || 0),
        ambiguousTotal: Number(metadata.diagnosticCounts.ambiguous || 0),
        invalidTruncated: Math.max(0, Number(metadata.diagnosticCounts.invalid || 0) - Number(metadata.storedRecordCounts.invalid || 0)),
        invalidMacsTruncated: Math.max(0, Number(metadata.diagnosticCounts.invalidMacs || 0) - Number(metadata.storedRecordCounts.invalidMacs || 0)),
        ambiguousTruncated: Math.max(0, Number(metadata.diagnosticCounts.ambiguous || 0) - Number(metadata.storedRecordCounts.ambiguous || 0)),
        identityConflictCount: metadata.diagnosticCounts.identityConflicts,
        duplicateRows: metadata.diagnosticCounts.duplicateRows,
      },
    };
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const tx = db.transaction("singleAnalysisChunks", "readonly");
      const chunk = await requestResult(tx.objectStore("singleAnalysisChunks").get([metadata.id, index]));
      await transactionDone(tx);
      if (!chunk || !Array.isArray(chunk.devices) || !Array.isArray(chunk.invalid)
        || !Array.isArray(chunk.invalidMacs) || !Array.isArray(chunk.ambiguous)
        || !Array.isArray(chunk.identityConflicts)) throw snapshotIntegrityError(`Сохранённый анализ повреждён: отсутствует блок ${index + 1}`);
      result.devices.push(...chunk.devices);
      for (const field of ["invalid", "invalidMacs", "ambiguous", "identityConflicts"]) result.diagnostics[field].push(...chunk[field]);
    }
    if (result.devices.length !== metadata.deviceCount
      || result.diagnostics.invalid.length !== metadata.storedRecordCounts.invalid
      || result.diagnostics.invalidMacs.length !== metadata.storedRecordCounts.invalidMacs
      || result.diagnostics.ambiguous.length !== metadata.storedRecordCounts.ambiguous
      || result.diagnostics.identityConflicts.length !== metadata.storedRecordCounts.identityConflicts) throw snapshotIntegrityError("Сохранённый анализ повреждён: число записей не совпадает с метаданными");
    result.preview = result.devices.slice(0, 20);
    result.invalidPreview = result.diagnostics.invalid.slice(0, 20);
    result.invalidMacPreview = result.diagnostics.invalidMacs.slice(0, 20);
    result.ambiguousPreview = result.diagnostics.ambiguous.slice(0, 20);
    result.identityConflictPreview = result.diagnostics.identityConflicts.slice(0, 20);
    return { ...metadata, result };
  }

  async deleteSingleAnalysis(id) {
    const db = await this.open();
    const tx = db.transaction(["singleAnalyses", "singleAnalysisChunks"], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const analyses = tx.objectStore("singleAnalyses");
    const metadata = await requestResult(analyses.get(String(id || "")));
    if (!metadata) { await done; return false; }
    analyses.delete(metadata.id);
    const range = IDBKeyRange.bound([metadata.id, 0], [metadata.id, Number.MAX_SAFE_INTEGER]);
    const request = tx.objectStore("singleAnalysisChunks").openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await done;
    return true;
  }

  async loadSnapshots(ids = null) {
    const metadata = await this.listSnapshots();
    const selected = ids ? metadata.filter((item) => ids.includes(item.id)) : metadata;
    const result = [];
    for (const item of selected) result.push(await this.loadSnapshot(item.id));
    return result;
  }

  async activeSnapshot() {
    const id = await this.getSetting("activeSnapshotId", "");
    if (!id) return null;
    try {
      const metadata = await this.forEachSnapshotChunk(id, () => {});
      return isFinalSnapshot(metadata) ? await this.loadSnapshot(id) : null;
    } catch {
      return null;
    }
  }

  async activeSnapshotMetadata() {
    const id = await this.getSetting("activeSnapshotId", "");
    if (!id) return null;
    try {
      const metadata = await this.forEachSnapshotChunk(id, () => {});
      return isFinalSnapshot(metadata) ? metadata : null;
    } catch {
      return null;
    }
  }

  async recoverActiveSnapshot() {
    const activeId = await this.getSetting("activeSnapshotId", "");
    if (activeId) {
      try {
        const active = await this.forEachSnapshotChunk(activeId, () => {});
        if (isFinalSnapshot(active)) return { snapshotId: activeId, recovered: false };
      } catch (error) {
        if (error?.code !== "SNAPSHOT_INTEGRITY") throw error;
      }
    }
    const db = await this.open();
    const tx = db.transaction(["snapshots", "snapshotChunks"], "readonly");
    const done = transactionDone(tx);
    const snapshots = tx.objectStore("snapshots");
    const snapshotChunks = tx.objectStore("snapshotChunks");
    let hasFinal = false;
    const findNewestComplete = (source, { direction = "prev", missingDateOnly = false } = {}) => new Promise((resolve, reject) => {
      const request = source.openCursor(null, direction);
      request.onerror = () => reject(request.error || new Error("Не удалось просканировать Final для восстановления"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(null); return; }
        const metadata = cursor.value;
        if (missingDateOnly && String(metadata?.createdAt || "")) { cursor.continue(); return; }
        if (!isFinalSnapshot(metadata)) { cursor.continue(); return; }
        hasFinal = true;
        const deviceCount = Number(metadata.deviceCount || 0);
        const chunkCount = Number(metadata.chunkCount ?? Math.ceil(deviceCount / CHUNK_SIZE));
        if (!metadata.id || !Number.isSafeInteger(deviceCount) || deviceCount < 0
          || !Number.isSafeInteger(chunkCount) || chunkCount !== Math.ceil(deviceCount / CHUNK_SIZE)) {
          cursor.continue();
          return;
        }
        if (chunkCount === 0) { resolve(metadata); return; }
        const range = IDBKeyRange.bound([metadata.id, 0], [metadata.id, chunkCount - 1]);
        const chunkRequest = snapshotChunks.openCursor(range, "next");
        let expectedIndex = 0;
        let visitedDevices = 0;
        let invalidChunk = false;
        chunkRequest.onerror = () => reject(chunkRequest.error || new Error(`Не удалось проверить чанки Final ${metadata.id}`));
        chunkRequest.onsuccess = () => {
          const chunkCursor = chunkRequest.result;
          if (!chunkCursor) {
            if (!invalidChunk && expectedIndex === chunkCount && visitedDevices === deviceCount) resolve(metadata);
            else cursor.continue();
            return;
          }
          const key = chunkCursor.primaryKey;
          const devices = chunkCursor.value?.devices;
          const expectedLength = Math.min(CHUNK_SIZE, deviceCount - expectedIndex * CHUNK_SIZE);
          if (!Array.isArray(devices) || key?.[0] !== metadata.id || key?.[1] !== expectedIndex || devices.length !== expectedLength) {
            invalidChunk = true;
            chunkCursor.continue();
            return;
          }
          expectedIndex += 1;
          visitedDevices += devices.length;
          chunkCursor.continue();
        };
      };
    });
    let recovered = null;
    try {
      recovered = await findNewestComplete(snapshots.index("by_created"));
      // Legacy metadata can omit createdAt and therefore has no by_created index entry.
      // The ordinary snapshot cursor checks those only after all dated Final candidates.
      if (!recovered) recovered = await findNewestComplete(snapshots, { direction: "next", missingDateOnly: true });
      await done;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
    if (recovered) {
      await this.setSetting("activeSnapshotId", recovered.id);
      return { snapshotId: recovered.id, recovered: true };
    }
    return { snapshotId: "", recovered: false, unavailable: Boolean(activeId || hasFinal) };
  }

  async saveFinal({ id = crypto.randomUUID(), name, snapshotType, sourceKey = "", createdAt = new Date().toISOString(), processingTimeMs = 0, devices, diagnostics = {}, comparison = null, sourceFiles = [], originalFiles = [], activate = true, updateInventory = true }) {
    const resolvedSnapshotType = resolveSnapshotType(snapshotType, name);
    if (activate && resolvedSnapshotType !== FINAL_SNAPSHOT_TYPE) throw new Error("Одиночный анализ не может стать активным Final");
    if (sourceKey) {
      const existing = await this.findSnapshotBySourceKey(sourceKey, { snapshotType: resolvedSnapshotType });
      if (existing) {
        if (originalFiles.length) await this.saveOriginalFiles(existing.id, originalFiles);
        return { ...existing, reused: true };
      }
    }
    if (!Array.isArray(devices)) throw new Error("Final должен содержать массив устройств");
    const db = await this.open();
    const stores = ["snapshots", "snapshotChunks", "inventory", "history", "settings", "knownModels", "switchAddressEvidence", "analyticsCache", "smartroomRoomMappings", "finalAnalyticsMetadata", "originalFiles"];
    const tx = db.transaction(stores, "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
    const metadata = {
      id,
      snapshotType: resolvedSnapshotType,
      name: name || `Final ${new Date(createdAt).toLocaleString("ru-RU")}`,
      createdAt,
      processingTimeMs: Math.max(0, Number(processingTimeMs || 0)),
      sourceKey,
      deviceCount: devices.length,
      chunkCount: Math.ceil(devices.length / CHUNK_SIZE),
      dataRevision: 0,
      diagnostics: serializable(diagnostics),
      sourceFiles: serializable(sourceFiles),
      originalFileRoles: [...new Set(originalFiles.map(({ role }) => String(role)))].sort(),
      schemaVersion: 1,
    };
    tx.objectStore("snapshots").put(metadata);
    this.#putOriginalFiles(tx.objectStore("originalFiles"), id, originalFiles);
    tx.objectStore("analyticsCache").clear();
    tx.objectStore("finalAnalyticsMetadata").delete(id);
    const addressEvidence = new Map();
    for (const device of devices) {
      const switchIp = String(device.switchIp || "").trim();
      const address = String(device.address || "").trim();
      if (!switchIp || !address) continue;
      const key = `${switchIp}\u0000${address}`;
      if (!addressEvidence.has(key)) addressEvidence.set(key, { switchIp, address, deviceCount: 0, sampleMacs: [] });
      const evidence = addressEvidence.get(key);
      evidence.deviceCount += 1;
      if (device.mac && evidence.sampleMacs.length < 5 && !evidence.sampleMacs.includes(device.mac)) evidence.sampleMacs.push(device.mac);
    }
    const evidenceStore = tx.objectStore("switchAddressEvidence");
    for (const evidence of addressEvidence.values()) evidenceStore.put({ ...evidence, snapshotId: id, snapshotName: metadata.name, createdAt });
    const roomObservations = new Map();
    for (const device of devices) {
      const smartroomId = text(device.smartroomId);
      const room = text(device.room);
      if (!smartroomId || !room) continue;
      const smartroomIdKey = keyText(smartroomId);
      if (!smartroomIdKey) continue;
      if (!roomObservations.has(smartroomIdKey)) roomObservations.set(smartroomIdKey, { smartroomId, byRoom: new Map(), alternativesTruncated: false, omittedDeviceCount: 0 });
      const roomEntry = roomObservations.get(smartroomIdKey);
      const byRoom = roomEntry.byRoom;
      if (!byRoom.has(room)) {
        if (byRoom.size >= MAX_SMARTROOM_ALTERNATIVES) { roomEntry.alternativesTruncated = true; roomEntry.omittedDeviceCount += 1; continue; }
        byRoom.set(room, { deviceCount: 0, sampleMacs: [] });
      }
      const observation = byRoom.get(room);
      observation.deviceCount += 1;
      const mac = normalizeMac(device.mac);
      if (mac && observation.sampleMacs.length < 5 && !observation.sampleMacs.includes(mac)) observation.sampleMacs.push(mac);
    }
    const roomMappingStore = tx.objectStore("smartroomRoomMappings");
    for (const [smartroomIdKey, { smartroomId, byRoom, alternativesTruncated, omittedDeviceCount }] of roomObservations) {
      const alternatives = [...byRoom.entries()]
        .sort((left, right) => right[1].deviceCount - left[1].deviceCount || left[0].localeCompare(right[0], "ru"))
        .map(([room, observation]) => ({ room, deviceCount: observation.deviceCount }));
      const confirmed = alternatives.length === 1 && !alternativesTruncated;
      const sampleMacs = [...new Set([...byRoom.values()].flatMap((observation) => observation.sampleMacs))].slice(0, 5);
      roomMappingStore.put({
        smartroomIdKey,
        smartroomId,
        room: confirmed ? alternatives[0].room : "",
        status: confirmed ? "confirmed" : "review",
        alternatives,
        alternativesTruncated,
        sourceFinalId: id,
        snapshotName: metadata.name,
        createdAt,
        deviceCount: alternatives.reduce((sum, item) => sum + item.deviceCount, 0) + omittedDeviceCount,
        sampleMacs,
      });
    }
    const chunkStore = tx.objectStore("snapshotChunks");
    const inventory = tx.objectStore("inventory");
    const models = tx.objectStore("knownModels");
    for (let start = 0; start < devices.length; start += CHUNK_SIZE) {
      const cleanChunk = serializable(devices.slice(start, start + CHUNK_SIZE), { dropEmbeddedSnapshotRows: true });
      chunkStore.put({ snapshotId: id, index: start / CHUNK_SIZE, devices: cleanChunk });
      if (updateInventory) for (const device of cleanChunk) {
        const previous = await requestResult(inventory.get(device.id));
        const inventoryRecord = {
          ...mergeKnownRecord(previous, device),
          firstSeen: previous?.firstSeen || createdAt,
          lastSeen: createdAt,
          present: true,
          snapshotId: id,
          observationCount: Math.max(0, Number(previous?.observationCount) || 0) + 1,
        };
        inventoryRecord.deviceIdKey = keyText(inventoryRecord.deviceId);
        inventoryRecord.serialKey = keyText(inventoryRecord.serial);
        for (const field of INVENTORY_SORT_FIELDS) if (inventoryRecord[field] === null || inventoryRecord[field] === undefined) inventoryRecord[field] = "";
        inventory.put(inventoryRecord);
        const learnedMac = normalizeMac(device.mac);
        const learnedModel = text(device.model);
        if (learnedMac && learnedModel) models.put({ mac: learnedMac, model: learnedModel, updatedAt: createdAt });
      }
    }
    if (comparison) {
      const history = tx.objectStore("history");
      for (const row of comparison.modified || []) {
        for (const change of row.changes || []) {
          const ddioEvidence = change.field === "switchIp"
            ? { possibleIps: Array.isArray(row.after.possibleIps) ? row.after.possibleIps : [], possibleIpsTruncated: Boolean(row.after.possibleIpsTruncated) }
            : {};
          history.add({ ...change, ...ddioEvidence, snapshotId: id, deviceId: row.after.id, mac: row.after.mac, macKey: normalizeMac(row.after.mac), type: "modified", timestamp: String(change.timestamp || change.createdAt || createdAt) });
        }
      }
      for (const device of comparison.added || []) history.add({ snapshotId: id, deviceId: device.id, mac: device.mac, macKey: normalizeMac(device.mac), type: "added", timestamp: createdAt });
      for (const device of comparison.absent || []) {
        history.add({ snapshotId: id, deviceId: device.id, mac: device.mac, macKey: normalizeMac(device.mac), type: "absent", timestamp: createdAt });
        if (updateInventory) {
          const previous = await requestResult(inventory.get(device.id));
          if (previous) inventory.put({ ...previous, present: false, lastMissing: createdAt });
        }
      }
    }
    if (activate) tx.objectStore("settings").put({ key: "activeSnapshotId", value: id });
    tx.objectStore("settings").put({ key: "analyticsRevision", value: Date.now() });
      await done;
      await this.#deleteStaleFinalAnalyticsGenerations(id, "").catch(() => {});
      return metadata;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw finalWriteError(error);
    }
  }

  #putOriginalFiles(store, snapshotId, files = []) {
    const roles = new Set();
    for (const item of files) {
      const role = String(item?.role || "");
      const file = item?.file;
      if (!["main", "smartroom", "ddio"].includes(role) || roles.has(role)) throw new Error(`Некорректный оригинал исходного файла: ${role || "неизвестная роль"}`);
      if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0) {
        throw new Error(`Исходный файл ${role} нельзя сохранить в IndexedDB`);
      }
      if (Number(file.size) > MAX_SOURCE_FILE_BYTES) throw new Error(`Исходный файл ${file.name || role} превышает лимит 64 МиБ`);
      roles.add(role);
      store.put({
        snapshotId,
        role,
        name: String(file.name || item.name || `${role}-source`),
        type: String(file.type || "application/octet-stream"),
        size: Number(file.size),
        lastModified: Math.max(0, Number(file.lastModified || item.lastModified || 0)),
        blob: file.slice(0, file.size, file.type || "application/octet-stream"),
      });
    }
  }

  async saveOriginalFiles(snapshotId, files = []) {
    if (!snapshotId || !Array.isArray(files) || !files.length) return 0;
    const db = await this.open();
    const tx = db.transaction(["snapshots", "originalFiles"], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
      const snapshots = tx.objectStore("snapshots");
      const metadata = await requestResult(snapshots.get(snapshotId));
      if (!metadata) throw new Error("Final для исходных файлов не найден");
      const originals = tx.objectStore("originalFiles");
      const missingFiles = [];
      for (const item of files) {
        if (!await requestResult(originals.get([snapshotId, String(item?.role || "")]))) missingFiles.push(item);
      }
      this.#putOriginalFiles(originals, snapshotId, missingFiles);
      const roles = [...new Set([...(metadata.originalFileRoles || []), ...missingFiles.map(({ role }) => String(role))])].sort();
      if (missingFiles.length) snapshots.put({ ...metadata, originalFileRoles: roles });
      await done;
      return missingFiles.length;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw finalWriteError(error);
    }
  }

  async listOriginalFiles(snapshotId) {
    const db = await this.open();
    const tx = db.transaction("originalFiles", "readonly");
    const range = IDBKeyRange.bound([snapshotId, ""], [snapshotId, "\uffff"]);
    const files = await requestResult(tx.objectStore("originalFiles").getAll(range));
    await transactionDone(tx);
    return files.map(({ snapshotId: _snapshotId, blob: _blob, ...metadata }) => metadata);
  }

  async getOriginalFile(snapshotId, role) {
    if (!["main", "smartroom", "ddio"].includes(role)) throw new Error("Неизвестная роль исходного файла");
    const db = await this.open();
    const tx = db.transaction("originalFiles", "readonly");
    const file = await requestResult(tx.objectStore("originalFiles").get([snapshotId, role]));
    await transactionDone(tx);
    if (!file) return null;
    return { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, blob: file.blob };
  }

  async inventoryCount() {
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const count = await requestResult(tx.objectStore("inventory").count());
    await transactionDone(tx);
    return count;
  }

  async inventoryCandidatesForDevices(devices = []) {
    if (!devices.some((device) => device?.id)) return new Map();
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("inventory");
    const byDeviceId = store.index("by_device_id_normalized");
    const bySerial = store.index("by_serial_normalized");
    const byMac = store.index("by_mac");
    const byAlternateMac = store.index("by_alternate_mac");
    const candidates = new Map();
    for (const device of devices) {
      if (!device?.id) continue;
      const id = String(device.id);
      const exact = await requestResult(store.get(id));
      if (exact) {
        candidates.set(id, { exactId: true, records: [exact] });
        continue;
      }
      const records = new Map();
      const collect = async (index, value) => {
        const normalized = text(value);
        if (!normalized) return;
        for (const record of await requestResult(index.getAll(normalized, 2))) records.set(record.id, record);
      };
      await collect(byDeviceId, keyText(device.deviceId));
      await collect(bySerial, keyText(device.serial));
      const alternateMacs = Array.isArray(device.alternateMacs) ? device.alternateMacs : [];
      const macs = [...new Set([device.mac, ...alternateMacs].map(normalizeMac).filter(Boolean))];
      for (const mac of macs) {
        for (const record of await requestResult(byMac.getAll(mac, 2))) records.set(record.id, record);
        for (const record of await requestResult(byAlternateMac.getAll(mac, 2))) records.set(record.id, record);
        if (records.size >= 10) break;
      }
      if (records.size) candidates.set(id, { exactId: false, records: [...records.values()].slice(0, 10) });
    }
    await done;
    return candidates;
  }

  async searchInventory({ query = "", field = "mac", direction = 1, page = 1, pageSize = 50, signal } = {}) {
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("inventory");
    const sortField = INVENTORY_SORT_FIELDS.includes(field) ? field : "mac";
    const request = store.index(`by_sort_${sortField}`).openCursor(null, direction < 0 ? "prev" : "next");
    const abort = () => { try { tx.abort(); } catch {} };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const size = Math.max(1, Number(pageSize) || 50);
    const currentPage = Math.max(1, Number(page) || 1);
    const start = (currentPage - 1) * size;
    const end = start + size;
    let total = 0;
    const selected = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const device = cursor.value;
      if (matchesDeviceSearch(device, query)) {
        total += 1;
        if (total > start && total <= end) selected.push(device);
      }
      cursor.continue();
    };
    try {
      await done;
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new Error("Поиск отменён");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const pages = Math.max(1, Math.ceil(total / size));
    const resolvedPage = Math.min(currentPage, pages);
    if (currentPage > pages) return this.searchInventory({ query, field: sortField, direction, page: resolvedPage, pageSize: size, signal });
    return { items: selected, total, page: resolvedPage, pages };
  }

  async inventoryMacs(limit = 20_000) {
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const done = transactionDone(tx);
    const request = tx.objectStore("inventory").openCursor();
    const macs = new Set();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      for (const mac of [cursor.value.mac, ...(cursor.value.alternateMacs || [])]) {
        const normalized = normalizeMac(mac);
        if (normalized && macs.size < limit) macs.add(normalized);
      }
      cursor.continue();
    };
    await done;
    return [...macs].sort();
  }

  async forEachInventory(visit) {
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const done = transactionDone(tx);
    const request = tx.objectStore("inventory").openCursor();
    let callbackError = null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        visit(cursor.value);
        cursor.continue();
      } catch (error) {
        callbackError = error;
        try { tx.abort(); } catch {}
      }
    };
    try { await done; } catch (error) { throw callbackError || error; }
  }

  async updateInventoryCustomField(deviceId, fieldKey, value) {
    const id = String(deviceId || "");
    const key = String(fieldKey || "");
    if (!id) throw new Error("Для пользовательского поля требуется ID устройства");
    if (!/^custom_[0-9a-f-]{36}$/i.test(key)) throw new Error("Некорректный ключ пользовательского поля");
    const cleanValue = String(value ?? "").slice(0, 4_000);
    const db = await this.open();
    const tx = db.transaction("inventory", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("inventory");
    const record = await requestResult(store.get(id));
    if (!record) {
      tx.abort();
      await done.catch(() => {});
      throw new Error("Устройство Inventory больше не найдено");
    }
    record.customFields = { ...(record.customFields || {}) };
    record.customFieldSources = { ...(record.customFieldSources || {}) };
    if (cleanValue) {
      record.customFields[key] = cleanValue;
      record.customFieldSources[key] = "Manual";
    } else {
      delete record.customFields[key];
      delete record.customFieldSources[key];
    }
    store.put(record);
    await done;
    return record;
  }

  async inventoryPage({ afterId = null, limit = 500 } = {}) {
    const pageSize = Math.max(1, Math.min(2_000, Math.floor(Number(limit) || 500)));
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("inventory");
    const range = afterId === null || afterId === undefined ? null : IDBKeyRange.lowerBound(afterId, true);
    const request = store.openCursor(range, "next");
    const rows = [];
    let nextId = null;
    let hasMore = false;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      rows.push(cursor.value);
      nextId = cursor.primaryKey;
      cursor.continue();
    };
    await done;
    return { rows, nextCursor: hasMore ? nextId : null, hasMore };
  }

  async historyPage(deviceId, { cursor: after = null, limit = 100 } = {}) {
    if (deviceId === undefined || deviceId === null || String(deviceId) === "") throw new Error("Для постраничной истории требуется ID устройства");
    const key = String(deviceId);
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const db = await this.open();
    const tx = db.transaction(["history", "inventory"], "readonly");
    const store = tx.objectStore("history");
    const inventory = tx.objectStore("inventory");
    const index = store.index("by_device_timestamp");
    const range = IDBKeyRange.bound([key, ""], [key, "\uffff"]);
    const rows = [];
    let hasMore = false;
    let nextCursor = null;
    const done = transactionDone(tx);
    const totalRequest = requestResult(index.count(range));
    const deviceRequest = requestResult(inventory.get(key));
    const cursorRequest = index.openCursor(range, "next");
    cursorRequest.onsuccess = () => {
      const current = cursorRequest.result;
      if (!current) return;
      if (after) {
        const cursorKey = [key, String(after.timestamp || "")];
        const indexOrder = indexedDB.cmp(current.key, cursorKey);
        if (indexOrder < 0 || (indexOrder === 0 && indexedDB.cmp(current.primaryKey, after.id) < 0)) {
          current.continuePrimaryKey(cursorKey, after.id);
          return;
        }
        if (indexOrder === 0 && indexedDB.cmp(current.primaryKey, after.id) === 0) {
          current.continue();
          return;
        }
      }
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      rows.push(current.value);
      nextCursor = { timestamp: String(current.value.timestamp || ""), id: current.primaryKey };
      current.continue();
    };
    await done;
    const [total, device] = await Promise.all([totalRequest, deviceRequest]);
    return { rows: rows.map((row) => ({ ...row, device: device || null })), total, hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async legacyObservationPage({ kind = "", mac = "", cursor: after = null, limit = 100 } = {}) {
    const normalizedKind = String(kind || "");
    const normalizedMac = normalizeMac(mac);
    if (!normalizedKind && !normalizedMac) throw new Error("Для поиска legacy-наблюдений укажите таблицу или MAC");
    if (normalizedKind && !LEGACY_OBSERVATION_KINDS.includes(normalizedKind)) {
      throw new Error("Неизвестный тип legacy-наблюдения");
    }
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readonly");
    const store = tx.objectStore("legacyObservations");
    const index = normalizedMac ? store.index("by_mac_observed") : store.index("by_kind_observed");
    const prefix = normalizedMac || normalizedKind;
    const range = IDBKeyRange.bound([prefix, "", ""], [prefix, "\uffff", "\uffff"]);
    const rows = [];
    let hasMore = false;
    let nextCursor = null;
    const done = transactionDone(tx);
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const current = request.result;
      if (!current) return;
      const item = current.value;
      if (normalizedKind && normalizedMac && item.kind !== normalizedKind) {
        current.continue();
        return;
      }
      if (after) {
        const order = indexedDB.cmp(current.key, after.key);
        if (order > 0 || (order === 0 && indexedDB.cmp(current.primaryKey, after.id) >= 0)) {
          current.continue();
          return;
        }
      }
      if (rows.length >= pageSize) {
        hasMore = true;
        return;
      }
      rows.push(legacyObservationPageRecord(item));
      nextCursor = { key: current.key, id: current.primaryKey };
      current.continue();
    };
    await done;
    return { rows, hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async legacyTaskQueueFileContent(id) {
    if (typeof id !== "string" || !id) throw new TypeError("Для скачивания очереди нужен ID записи");
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readonly");
    const record = await requestResult(tx.objectStore("legacyObservations").get(id));
    await transactionDone(tx);
    if (record?.kind !== "task_file_queue") return null;
    return {
      id: record.id,
      filename: String(record.payload.filename || "queued-file"),
      contentBase64: typeof record.payload.contentBase64 === "string" ? record.payload.contentBase64 : "",
      contentBase64Chars: Number(record.payload.contentBase64Chars) || record.payload.contentBase64?.length || 0,
      contentAvailable: Boolean(record.payload.contentAvailable && typeof record.payload.contentBase64 === "string"),
      taskId: String(record.payload.taskId || ""),
      sourceTaskId: String(record.payload.sourceTaskId || ""),
      contentRetainedLocally: Boolean(record.payload.contentRetainedLocally),
      status: String(record.payload.status || "pending"),
    };
  }

  async legacyScheduledTask(id) {
    if (typeof id !== "string" || !id) throw new TypeError("Для запуска расписания нужен ID записи");
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readonly");
    const record = await requestResult(tx.objectStore("legacyObservations").get(id));
    await transactionDone(tx);
    return record?.kind === "scheduled_tasks" ? legacyObservationPageRecord(record) : null;
  }

  async createLegacyScheduledTask({ name, intervalMinutes, enabled = true } = {}) {
    const taskName = String(name || "").trim();
    const interval = Number(intervalMinutes);
    if (!taskName || taskName.length > 512 || !Number.isSafeInteger(interval) || interval < 1 || typeof enabled !== "boolean") {
      throw new TypeError("Некорректные параметры расписания");
    }
    const taskId = `legacy-task-local-${crypto.randomUUID()}`;
    const id = `legacy-scheduled-local-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + interval * 60_000).toISOString();
    const record = {
      id, kind: "scheduled_tasks", sourceTable: "scheduled_tasks", source: "Локальная очередь Next",
      observedAt: now, mac: "", internalDeviceId: "",
      payload: { id: taskId, name: taskName, intervalMinutes: interval, enabled, payload: {}, lastRunAt: "", nextRunAt, createdAt: now },
    };
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readwrite", { durability: "strict" });
    tx.objectStore("legacyObservations").add(record);
    await transactionDone(tx);
    return legacyObservationPageRecord(record);
  }

  async appendLegacyTaskQueueFiles(taskRecordId, files = []) {
    if (typeof taskRecordId !== "string" || !taskRecordId || !Array.isArray(files)) throw new TypeError("Некорректная очередь файлов");
    if (files.length > 500) throw new RangeError("За один раз можно поставить в очередь не более 500 файлов");
    const task = await this.legacyScheduledTask(taskRecordId);
    if (!task) throw new Error("Расписание не найдено");
    let queued = 0;
    const invalid = [];
    for (const file of files) {
      const filename = String(file?.name || "").trim().slice(0, 1024);
      const size = Number(file?.size);
      if (!filename || !Number.isSafeInteger(size) || size < 1 || typeof file?.slice !== "function") {
        invalid.push(String(file?.name || "Без имени"));
        continue;
      }
      const id = `legacy-queue-local-${crypto.randomUUID()}`;
      const localBlobKey = size > 30 * 1024 * 1024 ? `legacyQueueFile:${id}` : "";
      const contentBase64 = localBlobKey ? "" : await encodeFileBase64(file);
      const now = new Date().toISOString();
      const record = {
        id, kind: "task_file_queue", sourceTable: "task_file_queue", source: "Локальная очередь Next",
        observedAt: now, mac: "", internalDeviceId: "",
        payload: {
          id, taskId: String(task.payload.id), sourceTaskId: "", filename, status: "pending",
          result: {}, error: "", createdAt: now, contentBase64Chars: contentBase64.length,
          contentAvailable: Boolean(contentBase64), contentRetainedInSourceDatabase: false,
          contentRetainedLocally: Boolean(localBlobKey),
          ...(contentBase64 ? { contentBase64 } : {}), ...(localBlobKey ? { localBlobKey } : {}),
        },
      };
      const db = await this.open();
      const tx = db.transaction(["legacyObservations", "fileHandles"], "readwrite", { durability: "strict" });
      const done = transactionDone(tx);
      tx.objectStore("legacyObservations").add(record);
      if (localBlobKey) tx.objectStore("fileHandles").put({ key: localBlobKey, file, filename, size, taskId: String(task.payload.id), createdAt: now });
      await done;
      queued += 1;
    }
    return { queued, invalid };
  }

  async legacyTaskQueueLocalFile(id) {
    if (typeof id !== "string" || !id) return null;
    const db = await this.open();
    const tx = db.transaction(["legacyObservations", "fileHandles"], "readonly");
    const record = await requestResult(tx.objectStore("legacyObservations").get(id));
    const localBlobKey = record?.kind === "task_file_queue" ? String(record.payload?.localBlobKey || "") : "";
    const local = localBlobKey ? await requestResult(tx.objectStore("fileHandles").get(localBlobKey)) : null;
    await transactionDone(tx);
    return local?.file instanceof Blob ? { id, taskId: String(record.payload.taskId || ""), filename: String(local.filename || record.payload.filename || "queued-file"), blob: local.file } : null;
  }

  async legacyTaskQueuePage(taskId, { after = null, limit = 20 } = {}) {
    if (typeof taskId !== "string" || !taskId) throw new TypeError("Для чтения очереди нужен ID расписания");
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readonly");
    const index = tx.objectStore("legacyObservations").index("by_kind_observed");
    const range = IDBKeyRange.bound(["task_file_queue", "", ""], ["task_file_queue", "\uffff", "\uffff"]);
    const rows = [];
    let hasMore = false;
    let nextCursor = null;
    const done = transactionDone(tx);
    const request = index.openCursor(range, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value;
      if (after && indexedDB.cmp(cursor.key, after.key) <= 0) { cursor.continue(); return; }
      if (item.payload?.taskId !== taskId || !["pending", "error"].includes(String(item.payload?.status || "pending"))) {
        cursor.continue();
        return;
      }
      if (rows.length >= pageSize) { hasMore = true; return; }
      rows.push(legacyObservationPageRecord(item));
      nextCursor = { key: cursor.key };
      cursor.continue();
    };
    await done;
    return { rows, hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async updateLegacyTaskQueueFile(id, patch = {}) {
    if (typeof id !== "string" || !id || !patch || typeof patch !== "object") throw new TypeError("Некорректное обновление файла очереди");
    const status = String(patch.status || "");
    if (!["pending", "running", "done", "error"].includes(status)) throw new TypeError("Неизвестный статус файла очереди");
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservations");
    const record = await requestResult(store.get(id));
    if (record?.kind !== "task_file_queue") {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      return false;
    }
    record.payload = {
      ...record.payload,
      status,
      ...(patch.startedAt === undefined ? {} : { startedAt: String(patch.startedAt) }),
      ...(patch.finishedAt === undefined ? {} : { finishedAt: String(patch.finishedAt) }),
      ...(patch.error === undefined ? {} : { error: String(patch.error).slice(0, 2000) }),
      ...(patch.result === undefined ? {} : { result: serializable(patch.result) }),
    };
    store.put(record);
    await done;
    return true;
  }

  async legacyTaskQueueSummaries(taskIds = []) {
    if (!Array.isArray(taskIds)) throw new TypeError("Список ID расписаний должен быть массивом");
    const requested = [...new Set(taskIds.map((id) => String(id || "")).filter(Boolean))];
    if (requested.length > 500) throw new RangeError("За один запрос можно получить сводки не более 500 расписаний");
    const summaries = new Map(requested.map((id) => [id, { pending: 0, running: 0, done: 0, error: 0, total: 0 }]));
    if (!requested.length) return summaries;
    const targets = new Set(requested);
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readonly");
    const done = transactionDone(tx);
    const index = tx.objectStore("legacyObservations").index("by_kind_observed");
    const range = IDBKeyRange.bound(["task_file_queue", "", ""], ["task_file_queue", "\uffff", "\uffff"]);
    const request = index.openCursor(range, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const taskId = String(cursor.value.payload?.taskId || "");
      if (targets.has(taskId)) {
        const summary = summaries.get(taskId);
        const status = String(cursor.value.payload?.status || "pending");
        summary.total += 1;
        if (Object.hasOwn(summary, status) && status !== "total") summary[status] += 1;
      }
      cursor.continue();
    };
    await done;
    return summaries;
  }

  async updateLegacyScheduledTaskRun(id, lastRunAt, nextRunAt) {
    if (typeof id !== "string" || !id || !Number.isFinite(Date.parse(lastRunAt)) || !Number.isFinite(Date.parse(nextRunAt))) {
      throw new TypeError("Некорректное время запуска расписания");
    }
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservations");
    const record = await requestResult(store.get(id));
    if (record?.kind !== "scheduled_tasks") {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      return false;
    }
    record.payload = { ...record.payload, lastRunAt, nextRunAt };
    store.put(record);
    await done;
    return true;
  }

  async updateLegacyScheduledTaskEnabled(id, enabled) {
    if (typeof id !== "string" || !id || typeof enabled !== "boolean") throw new TypeError("Некорректное состояние legacy-расписания");
    const db = await this.open();
    const tx = db.transaction("legacyObservations", "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const store = tx.objectStore("legacyObservations");
    const record = await requestResult(store.get(id));
    if (record?.kind !== "scheduled_tasks") {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      return false;
    }
    record.payload = { ...record.payload, enabled };
    store.put(record);
    await done;
    return true;
  }

  async legacyObservationSearchPage(filters = {}, { cursor: after = null, limit = 100 } = {}) {
    const query = legacyObservationFilterSpec(filters);
    if (query.kind && !LEGACY_OBSERVATION_KINDS.includes(query.kind)) throw new Error("Неизвестный тип legacy-наблюдения");
    const range = query.from && query.to ? IDBKeyRange.bound([query.from, ""], [query.to, "\uffff"])
      : query.from ? IDBKeyRange.lowerBound([query.from, ""])
        : query.to ? IDBKeyRange.upperBound([query.to, "\uffff"]) : null;
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const db = await this.open();
    const tx = db.transaction(["legacyObservations", "legacyObservationQueryScratch"], "readwrite");
    const index = tx.objectStore("legacyObservations").index("by_observed_id");
    const scratch = tx.objectStore("legacyObservationQueryScratch");
    const queryId = crypto.randomUUID();
    const metricNames = ["mac", "vendor", "model", "room", "source"];
    const summary = { uniqueMacs: 0, vendors: 0, models: 0, rooms: 0, sources: 0 };
    const rows = [];
    const byKind = Object.fromEntries(LEGACY_OBSERVATION_KINDS.map((kind) => [kind, 0]));
    let total = 0;
    let hasMore = false;
    let nextCursor = null;
    const done = transactionDone(tx);
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const current = request.result;
      if (!current) {
        let waiting = metricNames.length;
        const finishSummary = () => {
          waiting -= 1;
          if (waiting) return;
          const cleanup = scratch.openCursor(IDBKeyRange.bound([queryId, "", ""], [queryId, "\uffff", "\uffff"]));
          cleanup.onsuccess = () => {
            const cursor = cleanup.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
        };
        for (const metric of metricNames) {
          const countRequest = scratch.count(IDBKeyRange.bound([queryId, metric, ""], [queryId, metric, "\uffff"]));
          countRequest.onsuccess = () => {
            const summaryKey = ({ mac: "uniqueMacs", vendor: "vendors", model: "models", room: "rooms", source: "sources" })[metric];
            summary[summaryKey] = Number(countRequest.result || 0);
            finishSummary();
          };
        }
        return;
      }
      const item = current.value;
      if (!matchesLegacyObservation(item, query)) {
        current.continue();
        return;
      }
      total += 1;
      if (byKind[item.kind] !== undefined) byKind[item.kind] += 1;
      const beyondCursor = !after || indexedDB.cmp(current.key, [String(after.observedAt || ""), String(after.id || "")]) < 0;
      if (beyondCursor) {
        if (rows.length < pageSize) {
          rows.push(legacyObservationPageRecord(item));
          nextCursor = { observedAt: String(item.observedAt || ""), id: String(item.id || "") };
        } else hasMore = true;
      }
      const distinctValues = legacyObservationDistinctValues(item);
      let pending = distinctValues.length;
      if (!pending) { current.continue(); return; }
      for (const [metric, value] of distinctValues) {
        const key = [queryId, metric, value];
        const lookup = scratch.get(key);
        lookup.onsuccess = () => {
          if (!lookup.result) scratch.put({ queryId, metric, value });
          pending -= 1;
          if (!pending) current.continue();
        };
      }
    };
    await done;
    return { rows, total, byKind, summary, hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async deleteLegacyObservations(ids = []) {
    if (!Array.isArray(ids)) throw new Error("Список legacy-наблюдений должен быть массивом");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > 5_000) throw new Error("За один раз можно удалить не более 5000 наблюдений");
    if (uniqueIds.some((id) => typeof id !== "string" || !id)) throw new Error("Некорректный ID legacy-наблюдения");
    if (!uniqueIds.length) return 0;
    const db = await this.open();
    const tx = db.transaction(["legacyObservations", "legacyVendorModelPrefixCounts", "fileHandles"], "readwrite");
    const done = transactionDone(tx);
    const observations = tx.objectStore("legacyObservations");
    const prefixCounts = tx.objectStore("legacyVendorModelPrefixCounts");
    const fileHandles = tx.objectStore("fileHandles");
    let deleted = 0;
    const taskIds = new Set();
    for (const id of uniqueIds) {
      const item = await requestResult(observations.get(id));
      if (!item) continue;
      if (item.kind === "scheduled_tasks" && item.payload?.id) taskIds.add(String(item.payload.id));
      if (item.kind === "task_file_queue" && item.payload?.localBlobKey) fileHandles.delete(item.payload.localBlobKey);
      for (const row of legacyVendorPrefixRows(item)) {
        const key = [row.prefixLength, row.prefix, row.field, row.value];
        const existing = await requestResult(prefixCounts.get(key));
        if (!existing) continue;
        if (Number(existing.count) <= 1) prefixCounts.delete(key);
        else prefixCounts.put({ ...existing, count: Number(existing.count) - 1 });
      }
      observations.delete(id);
      deleted += 1;
    }
    await new Promise((resolve) => deleteLegacyTaskQueueRecords(observations, taskIds, fileHandles, (count) => {
      deleted += count;
      resolve();
    }));
    await done;
    return deleted;
  }

  async deleteLegacyObservationsByFilters(filters = {}) {
    const query = legacyObservationFilterSpec(filters);
    if (query.kind && !LEGACY_OBSERVATION_KINDS.includes(query.kind)) throw new Error("Неизвестный тип legacy-наблюдения");
    if (![query.kind, query.mac, query.source, query.vendor, query.model, query.room, query.from, query.to].some(Boolean)) {
      throw new Error("Для удаления задайте хотя бы один фильтр legacy-наблюдений");
    }
    const range = query.from && query.to ? IDBKeyRange.bound([query.from, ""], [query.to, "\uffff"])
      : query.from ? IDBKeyRange.lowerBound([query.from, ""])
        : query.to ? IDBKeyRange.upperBound([query.to, "\uffff"]) : null;
    const db = await this.open();
    const tx = db.transaction(["legacyObservations", "legacyVendorModelPrefixCounts", "fileHandles"], "readwrite");
    const done = transactionDone(tx);
    const observations = tx.objectStore("legacyObservations");
    const prefixCounts = tx.objectStore("legacyVendorModelPrefixCounts");
    const fileHandles = tx.objectStore("fileHandles");
    let deleted = 0;
    const taskIds = new Set();
    const request = observations.index("by_observed_id").openCursor(range, "prev");
    const deletePrefix = (cursor, prefixRows, position = 0) => {
      if (position >= prefixRows.length) {
        if (cursor.value.kind === "scheduled_tasks" && cursor.value.payload?.id) taskIds.add(String(cursor.value.payload.id));
        observations.delete(cursor.primaryKey);
        deleted += 1;
        cursor.continue();
        return;
      }
      const row = prefixRows[position];
      const key = [row.prefixLength, row.prefix, row.field, row.value];
      const lookup = prefixCounts.get(key);
      lookup.onsuccess = () => {
        const existing = lookup.result;
        if (existing) {
          if (Number(existing.count) <= 1) prefixCounts.delete(key);
          else prefixCounts.put({ ...existing, count: Number(existing.count) - 1 });
        }
        deletePrefix(cursor, prefixRows, position + 1);
      };
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        deleteLegacyTaskQueueRecords(observations, taskIds, fileHandles, (count) => { deleted += count; });
        return;
      }
      if (!matchesLegacyObservation(cursor.value, query)) {
        cursor.continue();
        return;
      }
      deletePrefix(cursor, legacyVendorPrefixRows(cursor.value));
    };
    await done;
    return deleted;
  }

  async historySearchPage(filters = {}, { cursor: after = null, limit = 100 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const macQuery = String(filters.mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
    const fieldQuery = String(filters.field || "").trim().toLocaleLowerCase("ru-RU");
    const sourceQuery = String(filters.source || "").trim().toLocaleLowerCase("ru-RU");
    const typeQuery = filters.type ? normalizeChangeType(filters.type) : "";
    const severityQuery = String(filters.severity || "").trim();
    const manufacturerQuery = String(filters.manufacturer || "").trim().toLocaleLowerCase("ru-RU");
    const modelQuery = String(filters.model || "").trim().toLocaleLowerCase("ru-RU");
    const roomQuery = String(filters.room || "").trim().toLocaleLowerCase("ru-RU");
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.from || "")) ? `${filters.from}T00:00:00` : "";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.to || "")) ? `${filters.to}\uffff` : "";
    if (from && to && from.slice(0, 10) > to.slice(0, 10)) throw new Error("Начальная дата позже конечной");
    const range = from && to ? IDBKeyRange.bound(from, to)
      : from ? IDBKeyRange.lowerBound(from)
        : to ? IDBKeyRange.upperBound(to) : null;
    const matchesBase = (event) => {
      const eventType = normalizeChangeType(event.type);
      if (typeQuery && eventType !== typeQuery) return false;
      if (severityQuery === "critical" && !isCriticalHistoryChange(eventType, event.field || event.label || event.fieldLabel, event.oldValue ?? event.before, event.newValue ?? event.after)) return false;
      if (fieldQuery && !String(event.label || event.field || "").toLocaleLowerCase("ru-RU").includes(fieldQuery)) return false;
      if (sourceQuery && !String(event.source || "").toLocaleLowerCase("ru-RU").includes(sourceQuery)) return false;
      return true;
    };
    const matches = (event, device = null) => {
      if (!matchesBase(event)) return false;
      if (macQuery) {
        const eventMac = String(event.mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
        const matchesPrimary = eventMac.includes(macQuery);
        const matchesAlternate = !matchesPrimary && [device?.mac, ...(device?.alternateMacs || [])]
          .some((mac) => String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase().includes(macQuery));
        if (!matchesPrimary && !matchesAlternate) return false;
      }
      if (manufacturerQuery && !String(device?.manufacturer || device?.vendor || "").toLocaleLowerCase("ru-RU").includes(manufacturerQuery)) return false;
      if (modelQuery && !String(device?.model || "").toLocaleLowerCase("ru-RU").includes(modelQuery)) return false;
      if (roomQuery && !String(device?.room || "").toLocaleLowerCase("ru-RU").includes(roomQuery)) return false;
      return true;
    };
    const db = await this.open();
    const tx = db.transaction(["history", "inventory"], "readonly");
    const index = tx.objectStore("history").index("by_timestamp");
    const inventory = tx.objectStore("inventory");
    const rows = [];
    let total = 0;
    let hasMore = false;
    let nextCursor = null;
    const done = transactionDone(tx);
    const cursorRequest = index.openCursor(range, "next");
    const collect = (current, event, device = null) => {
      const matchesEvent = matches(event, device);
      if (matchesEvent) total += 1;
      const timestamp = String(current.key || "");
      const primaryKey = current.primaryKey;
      let afterCursor = false;
      if (after) {
        const cursorTimestamp = String(after.timestamp || "");
        const timestampOrder = timestamp < cursorTimestamp ? -1 : timestamp > cursorTimestamp ? 1 : 0;
        const primaryOrder = timestampOrder === 0 ? indexedDB.cmp(primaryKey, after.id) : 1;
        afterCursor = timestampOrder < 0 || (timestampOrder === 0 && primaryOrder <= 0);
      }
      if (matchesEvent && !afterCursor) {
        if (rows.length < pageSize) {
          const rowIndex = rows.push({ ...event, device }) - 1;
          if (!device && event.deviceId !== undefined && event.deviceId !== null) {
            const inventoryRequest = inventory.get(String(event.deviceId));
            inventoryRequest.onsuccess = () => { rows[rowIndex].device = inventoryRequest.result || null; };
          }
          nextCursor = { timestamp, id: primaryKey };
        } else hasMore = true;
      }
    };
    cursorRequest.onsuccess = () => {
      const current = cursorRequest.result;
      if (!current) return;
      const event = current.value;
      if (!matchesBase(event)) {
        current.continue();
        return;
      }
      const eventMac = String(event.mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
      const needsDevice = manufacturerQuery || modelQuery || roomQuery || (macQuery && !eventMac.includes(macQuery));
      if (needsDevice) {
        if (event.deviceId === undefined || event.deviceId === null) {
          collect(current, event);
          current.continue();
          return;
        }
        const inventoryRequest = inventory.get(String(event.deviceId));
        inventoryRequest.onsuccess = () => {
          collect(current, event, inventoryRequest.result || null);
          current.continue();
        };
        return;
      }
      collect(current, event);
      current.continue();
    };
    await done;
    return { rows, total, hasMore, nextCursor: hasMore ? nextCursor : null };
  }

  async forEachMacHistoryPage(mac, visit = () => {}) {
    const macKey = normalizeMac(mac);
    if (!macKey) throw new Error("Для хронологии требуется корректный MAC-адрес");
    const db = await this.open();
    const inventoryTx = db.transaction("inventory", "readonly");
    const inventoryDone = transactionDone(inventoryTx);
    const inventoryStore = inventoryTx.objectStore("inventory");
    const deviceIds = new Set();
    for (const index of [inventoryStore.index("by_mac"), inventoryStore.index("by_alternate_mac")]) {
      const matchRequest = index.openCursor(IDBKeyRange.only(macKey));
      matchRequest.onsuccess = () => {
        const cursor = matchRequest.result;
        if (!cursor) return;
        if (cursor.value?.id !== undefined && cursor.value?.id !== null) deviceIds.add(String(cursor.value.id));
        cursor.continue();
      };
    }
    await inventoryDone;

    const historyTx = db.transaction("history", "readonly");
    const historyDone = transactionDone(historyTx);
    const historyIndex = historyTx.objectStore("history").index("by_mac_timestamp");
    const historyRange = IDBKeyRange.bound([macKey, ""], [macKey, "\uffff"]);
    const historyRequest = historyIndex.openCursor(historyRange);
    let page = [];
    let total = 0;
    let callbackError = null;
    const emitPage = (rows) => {
      total += rows.length;
      try { visit(rows); } catch (error) {
        callbackError = error;
        try { historyTx.abort(); } catch {}
      }
    };
    historyRequest.onsuccess = () => {
      const cursor = historyRequest.result;
      if (!cursor) {
        if (page.length && !callbackError) {
          emitPage(page);
          page = [];
        }
        return;
      }
      if (callbackError) return;
      page.push(cursor.value);
      if (page.length >= 500) {
        emitPage(page);
        page = [];
      }
      cursor.continue();
    };
    try { await historyDone; } catch (error) { throw callbackError || error; }

    for (const deviceId of deviceIds) {
      let cursor = null;
      do {
        const result = await this.historyPage(deviceId, { cursor, limit: 500 });
        const relatedEvents = result.rows.filter((event) => normalizeMac(event.mac) !== macKey);
        if (relatedEvents.length) {
          total += relatedEvents.length;
          visit(relatedEvents);
        }
        cursor = result.nextCursor;
        if (!result.hasMore) break;
      } while (cursor);
    }
    return total;
  }

  async deleteHistoryEvents(ids = []) {
    if (!Array.isArray(ids)) throw new Error("Список событий для удаления должен быть массивом");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > 5_000) throw new Error("За один раз можно удалить не более 5000 событий");
    if (uniqueIds.some((id) => !(typeof id === "string" && id) && !(Number.isSafeInteger(id) && id > 0))) {
      throw new Error("Некорректный ID события истории");
    }
    if (!uniqueIds.length) return 0;
    const db = await this.open();
    const tx = db.transaction("history", "readwrite");
    const store = tx.objectStore("history");
    let deleted = 0;
    for (const id of uniqueIds) {
      const request = store.getKey(id);
      request.onsuccess = () => {
        if (request.result === undefined) return;
        store.delete(id);
        deleted += 1;
      };
    }
    await transactionDone(tx);
    return deleted;
  }

  async deleteDeviceHistoryEvents(deviceId) {
    if (deviceId === undefined || deviceId === null || String(deviceId) === "") {
      throw new Error("Для удаления истории требуется ID устройства");
    }
    const db = await this.open();
    const tx = db.transaction("history", "readwrite");
    const done = transactionDone(tx);
    const index = tx.objectStore("history").index("by_device");
    const request = index.openCursor(IDBKeyRange.only(String(deviceId)));
    let deleted = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
    await done;
    return deleted;
  }

  async forEachSwitchAddressEvidence(visit) {
    const db = await this.open();
    const tx = db.transaction("switchAddressEvidence", "readonly");
    const done = transactionDone(tx);
    const request = tx.objectStore("switchAddressEvidence").openCursor();
    let callbackError = null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        visit(cursor.value);
        cursor.continue();
      } catch (error) {
        callbackError = error;
        try { tx.abort(); } catch {}
      }
    };
    try { await done; } catch (error) { throw callbackError || error; }
  }

  async forEachSwitchAddressEvidenceForIps(ips = [], visit = () => {}) {
    const keys = [...new Set(ips.map(normalizeIp).filter(Boolean))];
    if (!keys.length) return;
    const db = await this.open();
    for (let offset = 0; offset < keys.length; offset += INDEXED_DB_KEY_READ_BATCH_SIZE) {
      const tx = db.transaction("switchAddressEvidence", "readonly");
      const done = transactionDone(tx);
      const index = tx.objectStore("switchAddressEvidence").index("by_switch");
      let callbackError = null;
      for (const ip of keys.slice(offset, offset + INDEXED_DB_KEY_READ_BATCH_SIZE)) {
        const request = index.openCursor(IDBKeyRange.only(ip));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || callbackError) return;
          try {
            visit(cursor.value);
            cursor.continue();
          } catch (error) {
            callbackError = error;
            try { tx.abort(); } catch {}
          }
        };
      }
      try { await done; } catch (error) { throw callbackError || error; }
    }
  }

  async switchAddressEvidenceIpsPage(offset = 0, limit = 100) {
    const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const pageLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const db = await this.open();
    const tx = db.transaction("switchAddressEvidence", "readonly");
    const done = transactionDone(tx);
    const request = tx.objectStore("switchAddressEvidence").index("by_switch").openKeyCursor(null, "nextunique");
    const ips = [];
    let total = 0;
    let cursorError = null;
    await new Promise((resolve) => {
      request.onerror = () => {
        cursorError = request.error || new Error("Не удалось прочитать список IP коммутаторов");
        try { tx.abort(); } catch {}
        resolve();
      };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (total >= pageOffset && ips.length < pageLimit) ips.push(cursor.key);
        total += 1;
        cursor.continue();
      };
    });
    try { await done; } catch (error) { throw cursorError || error; }
    if (cursorError) throw cursorError;
    return { ips, offset: pageOffset, limit: pageLimit, total };
  }

  async smartroomRoomMappingsForIds(ids = []) {
    const keys = [...new Set(ids.map(keyText).filter(Boolean))];
    if (!keys.length) return [];
    const db = await this.open();
    return (await getByKeysInBatches(db, "smartroomRoomMappings", keys)).filter(Boolean);
  }

  async legacySmartroomRoomMappingsForIds(ids = []) {
    const keys = [...new Set(ids.map(keyText).filter(Boolean))];
    if (!keys.length) return [];
    const db = await this.open();
    const records = [];
    for (let offset = 0; offset < keys.length; offset += INDEXED_DB_KEY_READ_BATCH_SIZE) {
      const batch = keys.slice(offset, offset + INDEXED_DB_KEY_READ_BATCH_SIZE);
      const tx = db.transaction("legacySmartroomRoomMappings", "readonly");
      const done = transactionDone(tx);
      const index = tx.objectStore("legacySmartroomRoomMappings").index("by_smartroom_id");
      try {
        for (const key of batch) await new Promise((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.bound([key, ""], [key, "\uffff"]));
          request.onerror = () => reject(request.error || new Error("Не удалось найти legacy Smartroom-маппинг"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(); return; }
            records.push(cursor.value);
            cursor.continue();
          };
        });
        await done;
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
    }
    return records;
  }

  async ipAddressMappings() {
    return normalizeIpMappings(await this.getSetting("ipAddressMappings", []));
  }

  async saveIpAddressMappings(records) {
    const normalized = normalizeIpMappings(records);
    await this.setSetting("ipAddressMappings", normalized);
    return normalized;
  }

  async mergeIpAddressMappings(records, { overwriteExisting = true } = {}) {
    const incoming = normalizeIpMappings(records);
    if (!incoming.length) return this.ipAddressMappings();
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
      const settings = tx.objectStore("settings");
      const stored = await requestResult(settings.get("ipAddressMappings"));
      const byIp = new Map(normalizeIpMappings(stored?.value || []).map((item) => [item.switchIp, item]));
      for (const item of incoming) {
        if (overwriteExisting || !byIp.has(item.switchIp)) byIp.set(item.switchIp, item);
      }
      const merged = [...byIp.values()];
      settings.put({ key: "ipAddressMappings", value: serializable(merged) });
      await done;
      return merged;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async deleteIpAddressMapping(switchIp) {
    const targetIp = normalizeIp(switchIp);
    if (!targetIp) throw new TypeError("Укажите корректный IP коммутатора");
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    try {
      const settings = tx.objectStore("settings");
      const stored = await requestResult(settings.get("ipAddressMappings"));
      const mappings = normalizeIpMappings(stored?.value || []).filter((item) => item.switchIp !== targetIp);
      settings.put({ key: "ipAddressMappings", value: serializable(mappings) });
      await done;
      return mappings;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async applyIpAddressMappingsToActiveSnapshot() {
    const db = await this.open();
    const tx = db.transaction(["settings", "snapshots", "snapshotChunks", "inventory", "analyticsCache", "finalAnalyticsMetadata"], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const settings = tx.objectStore("settings");
    const snapshots = tx.objectStore("snapshots");
    const chunks = tx.objectStore("snapshotChunks");
    const inventory = tx.objectStore("inventory");
    const analyticsCache = tx.objectStore("analyticsCache");
    const finalAnalyticsMetadata = tx.objectStore("finalAnalyticsMetadata");
    const [active, mappingsSetting] = await Promise.all([
      requestResult(settings.get("activeSnapshotId")),
      requestResult(settings.get("ipAddressMappings")),
    ]);
    const snapshotId = active?.value || "";
    const rules = new Map(normalizeIpMappings(mappingsSetting?.value || []).map((item) => [item.switchIp, item]));
    if (!snapshotId) {
      tx.abort();
      try { await done; } catch {}
      throw new Error("Нет активного Final");
    }
    const metadata = await requestResult(snapshots.get(snapshotId));
    if (!metadata) {
      tx.abort();
      try { await done; } catch {}
      throw new Error("Активный Final не найден");
    }
    let filled = 0;
    let chunkCount = 0;
    let deviceCount = 0;
    const range = IDBKeyRange.bound([snapshotId, 0], [snapshotId, Number.MAX_SAFE_INTEGER]);
    try {
      await new Promise((resolve, reject) => {
      const request = chunks.openCursor(range);
      request.onerror = () => reject(request.error || new Error("Не удалось прочитать блоки Final"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          if (chunkCount !== metadata.chunkCount || deviceCount !== metadata.deviceCount) {
            reject(snapshotIntegrityError("Final повреждён: число блоков или устройств не совпадает с метаданными"));
            return;
          }
          if (filled) {
            metadata.dataRevision = Number(metadata.dataRevision || 0) + 1;
            snapshots.put(metadata);
            analyticsCache.clear();
            finalAnalyticsMetadata.delete(snapshotId);
          }
          resolve();
          return;
        }
        const chunk = cursor.value;
        chunkCount += 1;
        deviceCount += chunk.devices.length;
        let index = 0;
        let chunkFilled = false;
        const next = () => {
          while (index < chunk.devices.length) {
            const device = chunk.devices[index++];
            if (!applyIpMapping(device, rules)) continue;
            filled += 1;
            chunkFilled = true;
            const inventoryRequest = inventory.get(device.id);
            inventoryRequest.onerror = () => reject(inventoryRequest.error || new Error("Не удалось обновить Inventory"));
            inventoryRequest.onsuccess = () => {
              const record = inventoryRequest.result;
              if (record && !text(record.address)) {
                record.address = device.address;
                record.fieldSources = { ...(record.fieldSources || {}), address: device.fieldSources.address };
                inventory.put(record);
              }
              next();
            };
            return;
          }
          if (chunkFilled) cursor.update(chunk);
          cursor.continue();
        };
        next();
      };
      });
    } catch (error) {
      try { tx.abort(); } catch {}
      try { await done; } catch {}
      throw error;
    }
    await done;
    if (filled) await this.#deleteStaleFinalAnalyticsGenerations(snapshotId, "").catch(() => {});
    return { snapshotId, filled };
  }

  async getSetting(key, fallback = null) {
    const db = await this.open();
    const tx = db.transaction("settings", "readonly");
    const record = await requestResult(tx.objectStore("settings").get(key));
    await transactionDone(tx);
    return record?.value ?? fallback;
  }

  async saveDataQualityReport(snapshot, report) {
    if (!snapshot?.id || !report || !Number.isFinite(report.score) || !["A", "B", "C", "D"].includes(report.grade)) {
      throw new TypeError("Отчёт качества данных имеет неверный формат");
    }
    const record = {
      id: crypto.randomUUID(), snapshotId: String(snapshot.id), snapshotName: String(snapshot.name || snapshot.id),
      createdAt: new Date().toISOString(), score: report.score, grade: report.grade, report: serializable(report),
    };
    const db = await this.open();
    const tx = db.transaction("dataQualityReports", "readwrite", { durability: "strict" });
    tx.objectStore("dataQualityReports").add(record);
    await transactionDone(tx);
    return record;
  }

  async listDataQualityReports({ limit = 20, snapshotId = "" } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const db = await this.open();
    const tx = db.transaction("dataQualityReports", "readonly");
    const store = tx.objectStore("dataQualityReports");
    const index = snapshotId ? store.index("by_snapshot_created") : store.index("by_created");
    const range = snapshotId ? IDBKeyRange.bound([String(snapshotId), ""], [String(snapshotId), "\uffff"]) : null;
    const records = await new Promise((resolve, reject) => {
      const result = [];
      const request = index.openCursor(range, "prev");
      request.onerror = () => reject(request.error || new Error("Не удалось прочитать историю отчётов качества"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= boundedLimit) { resolve(result); return; }
        result.push(cursor.value);
        cursor.continue();
      };
    });
    await transactionDone(tx);
    return records;
  }

  async setSetting(key, value) {
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value: serializable(value) });
    await transactionDone(tx);
  }

  async setSettings(records = []) {
    if (!Array.isArray(records) || records.some((record) => !record || typeof record.key !== "string" || !record.key)) {
      throw new TypeError("Пакет настроек имеет неверный формат");
    }
    if (new Set(records.map(({ key }) => key)).size !== records.length) throw new TypeError("Пакет содержит повторяющиеся ключи настроек");
    const serialized = records.map(({ key, value }) => ({ key, value: serializable(value) }));
    if (!serialized.length) return;
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite", { durability: "strict" });
    const store = tx.objectStore("settings");
    for (const record of serialized) store.put(record);
    await transactionDone(tx);
  }

  async recordLegacySqliteImportSource(record) {
    if (!record || typeof record.importId !== "string" || !record.importId || typeof record.sourceIdbName !== "string" || !record.sourceIdbName) {
      throw new TypeError("Метаданные SQLite-источника имеют неверный формат");
    }
    const db = await this.open();
    const tx = db.transaction("fileHandles", "readwrite");
    tx.objectStore("fileHandles").put({
      key: `legacySqliteImport:${record.importId}`,
      importId: record.importId,
      sourceIdbName: record.sourceIdbName,
      fileName: String(record.fileName || "database.sqlite"),
      sourceBytes: Math.max(0, Number(record.sourceBytes) || 0),
      integrity: String(record.integrity || ""),
      importedAt: String(record.importedAt || new Date().toISOString()),
      sourceNamespace: String(record.sourceNamespace || ""),
    });
    if (/^[0-9a-f]{24}$/i.test(String(record.sourceNamespace || ""))) {
      tx.objectStore("fileHandles").put({
        key: `legacySqliteNamespace:${String(record.sourceNamespace).toLowerCase()}`,
        importId: record.importId,
        sourceIdbName: record.sourceIdbName,
        fileName: String(record.fileName || "database.sqlite"),
        sourceBytes: Math.max(0, Number(record.sourceBytes) || 0),
        sourceNamespace: String(record.sourceNamespace).toLowerCase(),
        integrity: String(record.integrity || ""),
        importedAt: String(record.importedAt || new Date().toISOString()),
      });
    }
    await transactionDone(tx);
  }

  async legacySqliteSourceForTask(taskId) {
    if (typeof taskId !== "string" || !taskId) return null;
    const namespace = /^legacy-task-([0-9a-f]{24})-[0-9a-f]{16}$/i.exec(taskId)?.[1]?.toLowerCase();
    if (!namespace) return null;
    const db = await this.open();
    const tx = db.transaction("fileHandles", "readonly");
    const record = await requestResult(tx.objectStore("fileHandles").get(`legacySqliteNamespace:${namespace}`));
    await transactionDone(tx);
    return record?.sourceNamespace === namespace ? record : null;
  }

  async recordPerformanceMetric(operation, durationMs, timestamp = new Date().toISOString()) {
    const metric = normalizePerformanceMetric({ operation, durationMs, timestamp });
    if (!metric) throw new TypeError("Метрика производительности имеет неверный формат");
    const eventId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("settings");
    const request = store.get(PERFORMANCE_METRICS_SETTING);
    request.onsuccess = () => {
      const current = Array.isArray(request.result?.value) ? request.result.value : [];
      const preview = [];
      current.forEach((candidate, index) => {
        const oldMetric = normalizePerformanceMetric(candidate);
        if (!oldMetric) return;
        const oldId = String(candidate?.eventId || `legacy-array-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
        const row = { ...oldMetric, eventId: oldId };
        preview.push(row);
        if (!candidate?.eventId) store.put({ key: `${PERFORMANCE_METRIC_PREFIX}${oldId}`, value: row });
      });
      const row = { ...metric, eventId };
      store.put({ key: `${PERFORMANCE_METRIC_PREFIX}${eventId}`, value: row });
      store.put({ key: PERFORMANCE_METRICS_SETTING, value: [...preview, row].slice(-PERFORMANCE_METRIC_LIMIT) });
    };
    await done;
    return metric;
  }

  async performanceStatistics(options = {}) {
    const preview = await this.getSetting(PERFORMANCE_METRICS_SETTING, []);
    const previewRows = Array.isArray(preview) ? preview : [];
    const previewIds = new Set(previewRows.map((row) => String(row?.eventId || "")).filter(Boolean));
    const foundPreviewIds = new Set();
    const accumulator = new PerformanceStatisticsAccumulator(options);
    for (const row of previewRows) if (!row?.eventId) accumulator.add(row);
    const db = await this.open();
    await visitSettingPrefix(db, PERFORMANCE_METRIC_PREFIX, (_key, record) => {
      const metric = record?.value;
      if (metric?.eventId && previewIds.has(String(metric.eventId))) foundPreviewIds.add(String(metric.eventId));
      accumulator.add(metric);
    });
    for (const row of previewRows) {
      const eventId = String(row?.eventId || "");
      if (eventId && !foundPreviewIds.has(eventId)) accumulator.add(row);
    }
    await visitSettingPrefix(db, LEGACY_PERFORMANCE_METRIC_PREFIX, (_key, record) => accumulator.add(record?.value));
    return accumulator.finish();
  }

  async recordApplicationLog(event, errorName = "", timestamp = new Date().toISOString()) {
    const entry = normalizeApplicationLogEntry({ event, errorName, timestamp });
    if (!entry) throw new TypeError("Запись журнала приложения имеет неверный формат");
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("settings");
    const request = store.get(APPLICATION_LOG_SETTING);
    request.onsuccess = () => {
      const current = Array.isArray(request.result?.value) ? request.result.value : [];
      store.put({ key: APPLICATION_LOG_SETTING, value: appendApplicationLog(current, entry) });
    };
    await done;
    return entry;
  }

  async applicationLog() {
    const rows = await this.getSetting(APPLICATION_LOG_SETTING, []);
    return Array.isArray(rows) ? rows.map(normalizeApplicationLogEntry).filter(Boolean) : [];
  }

  async dataDirectoryHandle() {
    const db = await this.open();
    const tx = db.transaction("fileHandles", "readonly");
    const record = await requestResult(tx.objectStore("fileHandles").get("data-directory"));
    await transactionDone(tx);
    return record?.handle || null;
  }

  async setDataDirectoryHandle(handle) {
    if (!handle || handle.kind !== "directory") throw new Error("Выбранный объект не является папкой данных");
    const db = await this.open();
    const tx = db.transaction("fileHandles", "readwrite");
    tx.objectStore("fileHandles").put({ key: "data-directory", handle });
    await transactionDone(tx);
  }

  async knownModelsForMacs(macs = []) {
    const keys = [...new Set(macs.map(normalizeMac).filter(Boolean))];
    if (!keys.length) return new Map();
    const db = await this.open();
    const tx = db.transaction("knownModels", "readonly");
    const store = tx.objectStore("knownModels");
    const models = new Map();
    for (const mac of keys) {
      const record = await requestResult(store.get(mac));
      if (record?.model) models.set(mac, record.model);
    }
    await transactionDone(tx);
    return models;
  }

  async legacyVendorModelSuggestionsForMacs(macs = [], { useMac5Match = true, useOuiMatch = true } = {}) {
    const keys = [...new Set(macs.map(normalizeMac).filter(Boolean))];
    if (!keys.length) return new Map();
    const db = await this.open();
    const tx = db.transaction(["legacyObservations", "legacyVendorModelPrefixCounts"], "readonly");
    const index = tx.objectStore("legacyObservations").index("by_mac_observed");
    const prefixIndex = tx.objectStore("legacyVendorModelPrefixCounts").index("by_prefix");
    const suggestions = new Map();
    for (const mac of keys) {
      const range = IDBKeyRange.bound([mac, "", ""], [mac, "\uffff", "\uffff"]);
      let vendorCandidate = null;
      let modelCandidate = null;
      await new Promise((resolve, reject) => {
        const request = index.openCursor(range, "prev");
        request.onerror = () => reject(request.error || new Error("Не удалось прочитать vendor/model историю"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          const observation = cursor.value;
          if (observation.kind === "vendor_model_history") {
            const payload = observation.payload && typeof observation.payload === "object" ? observation.payload : {};
            const candidate = { observedAt: observation.observedAt, sourceId: payload.id };
            const vendor = knownLegacyVendorValue(payload.vendor);
            const model = knownLegacyVendorValue(payload.model);
            if (vendor && legacyObservationIsNewer(candidate, vendorCandidate)) vendorCandidate = { ...candidate, value: vendor };
            if (model && legacyObservationIsNewer(candidate, modelCandidate)) modelCandidate = { ...candidate, value: model };
          }
          cursor.continue();
        };
      });
      let vendor = vendorCandidate?.value || "";
      let model = modelCandidate?.value || "";
      const exact = Boolean(vendor || model);
      const hex = mac.replaceAll(":", "");
      let selectedPrefix = exact ? hex : "";
      let vendorConfidence = vendor ? 0.93 : 0;
      let modelConfidence = model ? 0.93 : 0;
      let vendorPrefix = vendor ? hex : "";
      let modelPrefix = model ? hex : "";
      let matches = exact ? 1 : 0;
      const prefixOptions = [
        ...(useMac5Match ? [{ length: 10, confidence: 0.82 }, { length: 8, confidence: 0.76 }] : []),
        ...(useOuiMatch ? [{ length: 6, confidence: 0.68 }] : []),
      ];
      for (const option of prefixOptions) {
        if (vendor && model) break;
        const prefix = hex.slice(0, option.length);
        if (prefix.length !== option.length) continue;
        const candidates = { vendor: null, model: null };
        await new Promise((resolve, reject) => {
          const request = prefixIndex.openCursor(IDBKeyRange.only([option.length, prefix]));
          request.onerror = () => reject(request.error || new Error("Не удалось прочитать агрегат vendor/model истории"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(); return; }
            const row = cursor.value;
            const current = candidates[row.field];
            if ((row.field === "vendor" || row.field === "model") && (!current || Number(row.count) > Number(current.count)
              || (Number(row.count) === Number(current.count) && String(row.value) < String(current.value)))) candidates[row.field] = row;
            cursor.continue();
          };
        });
        if (!vendor && candidates.vendor) {
          vendor = candidates.vendor.value;
          vendorConfidence = option.confidence;
          vendorPrefix = prefix;
          matches = Math.max(matches, Number(candidates.vendor.count) || 0);
        }
        if (!model && candidates.model) {
          model = candidates.model.value;
          modelConfidence = option.confidence;
          modelPrefix = prefix;
          matches = Math.max(matches, Number(candidates.model.count) || 0);
        }
      }
      const usedPrefix = (vendorConfidence && vendorConfidence < 0.93) || (modelConfidence && modelConfidence < 0.93);
      if (usedPrefix && vendorPrefix !== modelPrefix) selectedPrefix = vendorConfidence <= modelConfidence ? vendorPrefix : modelPrefix;
      else selectedPrefix = vendorPrefix || modelPrefix || selectedPrefix;
      const confidenceValues = [vendorConfidence, modelConfidence].filter(Boolean);
      const confidence = confidenceValues.length ? Math.min(...confidenceValues) : 0;
      const source = exact ? (usedPrefix ? "vendor_model_history_mixed" : "vendor_model_history_exact") : "vendor_model_history_prefix";
      if (vendor || model) suggestions.set(mac, {
        vendor, model, source, confidence, matchedPrefix: selectedPrefix, matches,
        vendorConfidence, modelConfidence,
        vendorSource: vendorConfidence === 0.93 ? "vendor_model_history_exact" : "vendor_model_history_prefix",
        modelSource: modelConfidence === 0.93 ? "vendor_model_history_exact" : "vendor_model_history_prefix",
        vendorMatchedPrefix: vendorPrefix, modelMatchedPrefix: modelPrefix,
      });
    }
    await transactionDone(tx);
    return suggestions;
  }

  async mac5ModelPage({ afterPrefix = "", query = "", limit = 100 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const needle = keyText(query);
    const db = await this.open();
    const tx = db.transaction("mac5Models", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("mac5Models");
    const rows = [];
    let hasMore = false;
    await new Promise((resolve, reject) => {
      const range = afterPrefix ? IDBKeyRange.lowerBound(afterPrefix, true) : null;
      const request = store.openCursor(range, "next");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const rule = cursor.value;
        if (!needle || keyText(`${rule.prefix} ${rule.model}`).includes(needle)) {
          if (rows.length === pageSize) {
            hasMore = true;
            return resolve();
          }
          rows.push(rule);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await done;
    return { rows, nextCursor: hasMore ? rows.at(-1)?.prefix || null : null, hasMore };
  }

  async mac5ModelsMatchingModel(query = "") {
    const needle = keyText(query);
    if (!needle) return [];
    const db = await this.open();
    const tx = db.transaction("mac5Models", "readonly");
    const done = transactionDone(tx);
    const rows = [];
    await new Promise((resolve, reject) => {
      const request = tx.objectStore("mac5Models").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (keyText(cursor.value?.model).includes(needle)) rows.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await done;
    return rows;
  }

  async mac5ModelsForMacs(macs = []) {
    const prefixes = new Set();
    for (const mac of macs) {
      const hex = normalizeMac(mac).replaceAll(":", "");
      if (hex.length === 12) {
        prefixes.add(hex.slice(0, 8));
        prefixes.add(hex.slice(0, 10));
        prefixes.add(hex.slice(0, 6));
      }
    }
    if (!prefixes.size) return new Map();
    const db = await this.open();
    const rows = await getByKeysInBatches(db, "mac5Models", [...prefixes]);
    return new Map(rows.filter((row) => row?.model).map(({ prefix, model }) => [prefix, model]));
  }

  async saveMac5Model(prefix, model) {
    const normalizedPrefix = normalizeMacPrefix(prefix);
    const normalizedModel = text(model);
    if (!normalizedPrefix || !normalizedModel) throw new Error("Введите префикс MAC длиной 6, 8 или 10 символов и модель");
    const db = await this.open();
    const tx = db.transaction("mac5Models", "readwrite");
    tx.objectStore("mac5Models").put({ prefix: normalizedPrefix, model: normalizedModel, updatedAt: new Date().toISOString(), source: "Пользовательское правило" });
    await transactionDone(tx);
    return normalizedPrefix;
  }

  async deleteMac5Model(prefix) {
    const db = await this.open();
    const tx = db.transaction("mac5Models", "readwrite");
    tx.objectStore("mac5Models").delete(prefix);
    await transactionDone(tx);
  }

  async ouiPage({ afterPrefix = "", query = "", limit = 100 } = {}) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const needle = keyText(query);
    const db = await this.open();
    const tx = db.transaction("oui", "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore("oui");
    const rows = [];
    let hasMore = false;
    const range = afterPrefix ? IDBKeyRange.lowerBound(afterPrefix, true) : null;
    await new Promise((resolve, reject) => {
      const request = store.openCursor(range, "next");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const rule = cursor.value;
        if (!needle || keyText(`${rule.prefix} ${rule.vendor} ${rule.source}`).includes(needle)) {
          if (rows.length === pageSize) {
            hasMore = true;
            return resolve();
          }
          rows.push(rule);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("Не удалось прочитать OUI-правила"));
    });
    await done;
    return { rows, nextCursor: hasMore ? rows.at(-1)?.prefix || null : null, hasMore };
  }

  async importOui(records) {
    const db = await this.open();
    const tx = db.transaction("oui", "readwrite");
    const store = tx.objectStore("oui");
    let imported = 0;
    for (const record of records) {
      const prefix = normalizeOuiPrefix(record?.prefix);
      const vendor = text(record?.vendor);
      if (!prefix || !vendor) continue;
      store.put({ prefix, vendor, source: text(record?.source) || "Пользовательский справочник" });
      imported += 1;
    }
    await transactionDone(tx);
    return imported;
  }

  async saveLearnedVendorModelRules({ vendors = [], models = [] } = {}) {
    const db = await this.open();
    const tx = db.transaction(["oui", "mac5Models"], "readwrite");
    const done = transactionDone(tx);
    let savedVendors = 0;
    let savedModels = 0;
    for (const item of vendors) {
      const prefix = normalizeOuiPrefix(item?.prefix);
      const vendor = text(item?.vendor);
      if (!prefix || !vendor) continue;
      const store = tx.objectStore("oui");
      if (await requestResult(store.get(prefix))) continue;
      store.add({ prefix, vendor, source: "Обучено по локальной истории", observations: Math.max(1, Number(item.observations) || 1) });
      savedVendors += 1;
    }
    for (const item of models) {
      const prefix = normalizeMacPrefix(item?.prefix);
      const model = text(item?.model);
      if (!prefix || !model) continue;
      const store = tx.objectStore("mac5Models");
      if (await requestResult(store.get(prefix))) continue;
      store.add({ prefix, model, updatedAt: new Date().toISOString(), source: "Обучено по локальной истории", observations: Math.max(1, Number(item.observations) || 1) });
      savedModels += 1;
    }
    await done;
    return { vendors: savedVendors, models: savedModels };
  }

  async applyVendorModelRulesToActiveSnapshot() {
    const db = await this.open();
    const names = ["settings", "snapshots", "snapshotChunks", "inventory", "oui", "mac5Models", "analyticsCache", "finalAnalyticsMetadata"];
    const tx = db.transaction(names, "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    const store = (name) => tx.objectStore(name);
    try {
      const active = await requestResult(store("settings").get("activeSnapshotId"));
      const snapshotId = active?.value || "";
      const metadata = snapshotId ? await requestResult(store("snapshots").get(snapshotId)) : null;
      if (!metadata || !isFinalSnapshot(metadata)) throw new Error("Нет активного Final");
      let vendorsFilled = 0; let modelsFilled = 0; let chunksSeen = 0; let devicesSeen = 0;
      const range = IDBKeyRange.bound([snapshotId, 0], [snapshotId, Number.MAX_SAFE_INTEGER]);
      await new Promise((resolve, reject) => {
        const request = store("snapshotChunks").openCursor(range);
        request.onerror = () => reject(request.error || new Error("Не удалось прочитать блоки Final"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            if (chunksSeen !== metadata.chunkCount || devicesSeen !== metadata.deviceCount) return reject(snapshotIntegrityError("Final повреждён: число блоков или устройств не совпадает с метаданными"));
            if (vendorsFilled || modelsFilled) {
              metadata.dataRevision = Number(metadata.dataRevision || 0) + 1;
              store("snapshots").put(metadata);
              store("analyticsCache").clear();
              store("finalAnalyticsMetadata").delete(snapshotId);
            }
            return resolve();
          }
          void (async () => {
            const chunk = cursor.value; chunksSeen += 1; devicesSeen += chunk.devices.length;
            const vendorKeys = new Set(); const modelKeys = new Set();
            for (const device of chunk.devices) {
              const mac = normalizeMac(device.mac || device.macFormatted).replaceAll(":", "");
              if (mac.length !== 12) continue;
              if (!text(device.manufacturer)) for (const length of [10, 8, 6]) vendorKeys.add(mac.slice(0, length));
              if (!text(device.model)) for (const length of [10, 8, 6]) modelKeys.add(mac.slice(0, length));
            }
            const readRules = async (objectStore, keys) => new Map((await Promise.all([...keys].map((key) => requestResult(objectStore.get(key)))))
              .filter(Boolean).map((rule) => [rule.prefix, rule]));
            const [vendors, models] = await Promise.all([readRules(store("oui"), vendorKeys), readRules(store("mac5Models"), modelKeys)]);
            const changed = [];
            for (const device of chunk.devices) {
              const mac = normalizeMac(device.mac || device.macFormatted).replaceAll(":", "");
              if (mac.length !== 12) continue;
              let modified = false;
              if (!text(device.manufacturer)) {
                const rule = [10, 8, 6].map((length) => vendors.get(mac.slice(0, length))).find((row) => text(row?.vendor));
                if (rule) { device.manufacturer = text(rule.vendor); device.fieldSources = { ...(device.fieldSources || {}), manufacturer: `OUI rule ${rule.prefix}` }; vendorsFilled += 1; modified = true; }
              }
              if (!text(device.model)) {
                const rule = [10, 8, 6].map((length) => models.get(mac.slice(0, length))).find((row) => text(row?.model));
                if (rule) { device.model = text(rule.model); device.fieldSources = { ...(device.fieldSources || {}), model: `MAC rule ${rule.prefix}` }; modelsFilled += 1; modified = true; }
              }
              if (!modified) continue;
              device.sources = [...new Set([...(device.sources || []), "OUI/MAC prefix rules"])];
              changed.push(device);
            }
            if (changed.length) {
              cursor.update(chunk);
              for (const device of changed) {
                const record = await requestResult(store("inventory").get(device.id));
                if (!record) continue;
                if (!text(record.manufacturer) && text(device.manufacturer)) { record.manufacturer = device.manufacturer; record.fieldSources = { ...(record.fieldSources || {}), manufacturer: device.fieldSources.manufacturer }; }
                if (!text(record.model) && text(device.model)) { record.model = device.model; record.fieldSources = { ...(record.fieldSources || {}), model: device.fieldSources.model }; }
                store("inventory").put(record);
              }
            }
            cursor.continue();
          })().catch(reject);
        };
      });
      await done;
      if (vendorsFilled || modelsFilled) await this.#deleteStaleFinalAnalyticsGenerations(metadata.id, "").catch(() => {});
      return { snapshotId, vendorsFilled, modelsFilled };
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async ouiIndexForMacs(macs = []) {
    const prefixes = new Set();
    for (const value of macs) {
      const compact = normalizeMac(value).replaceAll(":", "");
      if (compact.length !== 12) continue;
      for (const length of [10, 9, 8, 7, 6]) prefixes.add(compact.slice(0, length));
    }
    if (!prefixes.size) return new Map();
    const db = await this.open();
    const tx = db.transaction("oui", "readonly");
    const store = tx.objectStore("oui");
    const index = new Map();
    for (const prefix of prefixes) {
      const record = await requestResult(store.get(prefix));
      if (record?.vendor) index.set(prefix, record.vendor);
    }
    await transactionDone(tx);
    return index;
  }

  async *#recordPages(storeName, pageSize = 256, includeKeys = false) {
    let lowerBound;
    while (true) {
      const db = await this.open();
      const tx = db.transaction(storeName, "readonly");
      const done = transactionDone(tx);
      const range = lowerBound === undefined ? undefined : IDBKeyRange.lowerBound(lowerBound, true);
      let lastKey;
      let exhausted = false;
      let records;
      try {
        records = await new Promise((resolve, reject) => {
          const page = [];
          const request = tx.objectStore(storeName).openCursor(range);
          request.onerror = () => reject(request.error || new Error(`Не удалось прочитать хранилище ${storeName}`));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              exhausted = true;
              resolve(page);
              return;
            }
            page.push(includeKeys ? { key: cursor.key, value: cursor.value } : cursor.value);
            lastKey = cursor.key;
            if (page.length >= pageSize) {
              resolve(page);
              return;
            }
            cursor.continue();
          };
        });
        await done;
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
      if (!records.length) return;
      yield records;
      if (exhausted) return;
      lowerBound = lastKey;
    }
  }

  async *#localArchivePages(archiveId, collection, pageSize = ARCHIVE_PAGE_SIZE) {
    let lowerBound;
    while (true) {
      const db = await this.open();
      const tx = db.transaction("archiveRecords", "readonly");
      const done = transactionDone(tx);
      const index = tx.objectStore("archiveRecords").index("by_archive_collection");
      const range = collection
        ? lowerBound === undefined
          ? IDBKeyRange.bound([archiveId, collection, ""], [archiveId, collection, "\uffff"])
          : IDBKeyRange.bound([archiveId, collection, lowerBound], [archiveId, collection, "\uffff"], true, false)
        : lowerBound === undefined
          ? IDBKeyRange.bound([archiveId, "", ""], [archiveId, "\uffff", "\uffff"])
          : IDBKeyRange.lowerBound(lowerBound, true);
      let lastKey;
      let exhausted = false;
      let records;
      try {
        records = await new Promise((resolve, reject) => {
          const page = [];
          const request = index.openCursor(range);
          request.onerror = () => reject(request.error || new Error("Не удалось прочитать локальный архив"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { exhausted = true; resolve(page); return; }
            page.push(cursor.value);
            lastKey = collection ? cursor.value.recordKey : cursor.key;
            if (page.length >= pageSize) { resolve(page); return; }
            cursor.continue();
          };
        });
        await done;
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
      if (!records.length) return;
      yield records;
      if (exhausted) return;
      lowerBound = lastKey;
    }
  }

  async #localArchiveRecord(archiveId, collection, sourceKey) {
    const db = await this.open();
    const tx = db.transaction("archiveRecords", "readonly");
    const record = await requestResult(tx.objectStore("archiveRecords").get([archiveId, collection, JSON.stringify(sourceKey)]));
    await transactionDone(tx);
    return record?.value;
  }

  async #fingerprint() {
    let hash = 2166136261;
    const feed = (value) => {
      for (const char of value) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 0xff;
      hash = Math.imul(hash, 16777619);
    };
    const feedBytes = (bytes) => {
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 0xfe;
      hash = Math.imul(hash, 16777619);
    };
    for (const collection of ARCHIVE_STORES) {
      feed(collection);
      for await (const page of this.#recordPages(collection, ARCHIVE_PAGE_SIZE, true)) {
        for (const row of page) {
          feed(JSON.stringify(row.key));
          if (collection === "originalFiles") {
            const { blob, ...metadata } = row.value || {};
            feed(JSON.stringify(metadata));
            for (let offset = 0; blob instanceof globalThis.Blob && offset < blob.size; offset += SOURCE_FILE_ARCHIVE_CHUNK_BYTES) {
              feedBytes(new Uint8Array(await blob.slice(offset, offset + SOURCE_FILE_ARCHIVE_CHUNK_BYTES).arrayBuffer()));
            }
          } else feed(JSON.stringify(row.value));
        }
      }
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async listLocalArchives() {
    const db = await this.open();
    const tx = db.transaction("archives", "readonly");
    const records = [];
    await new Promise((resolve, reject) => {
      const request = tx.objectStore("archives").openCursor();
      request.onerror = () => reject(request.error || new Error("Не удалось перечислить локальные архивы"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (cursor.value?.status === "ready") records.push(cursor.value);
        cursor.continue();
      };
    });
    await transactionDone(tx);
    return records.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async #localArchiveMetadata(archiveId) {
    const db = await this.open();
    const tx = db.transaction("archives", "readonly");
    const record = await requestResult(tx.objectStore("archives").get(archiveId));
    await transactionDone(tx);
    return record?.status === "ready" ? record : null;
  }

  async createLocalArchive(name = "") {
    const archiveId = crypto.randomUUID();
    const record = {
      id: archiveId,
      name: text(name).slice(0, 120) || `Архив ${new Date().toLocaleString("ru-RU")}`,
      createdAt: new Date().toISOString(),
      status: "building",
      recordCount: 0,
      snapshotCount: 0,
      counts: {},
    };
    const db = await this.open();
    let tx = db.transaction("archives", "readwrite");
    tx.objectStore("archives").put(record);
    await transactionDone(tx);
    try {
      const snapshots = await this.listSnapshots();
      for (const snapshot of snapshots) await this.forEachSnapshotChunk(snapshot.id, () => {});
      const before = await this.#fingerprint();
      let recordCount = 0;
      const counts = {};
      for (const collection of ARCHIVE_STORES) {
        counts[collection] = 0;
        for await (const page of this.#recordPages(collection, ARCHIVE_PAGE_SIZE, true)) {
          tx = (await this.open()).transaction("archiveRecords", "readwrite");
          const done = transactionDone(tx);
          const store = tx.objectStore("archiveRecords");
          for (const item of page) {
            store.put({ archiveId, collection, recordKey: JSON.stringify(item.key), sourceKey: item.key, value: item.value });
            counts[collection] += 1;
            recordCount += 1;
          }
          await done;
        }
      }
      if (before !== await this.#fingerprint()) throw new Error("База изменилась во время создания архива. Удалите черновик и повторите сохранение.");
      const ready = { ...record, status: "ready", recordCount, snapshotCount: snapshots.length, counts };
      tx = (await this.open()).transaction("archives", "readwrite");
      tx.objectStore("archives").put(ready);
      await transactionDone(tx);
      return ready;
    } catch (error) {
      await this.deleteLocalArchive(archiveId).catch(() => {});
      throw error;
    }
  }

  async deleteLocalArchive(archiveId) {
    const db = await this.open();
    const tx = db.transaction("archiveRecords", "readwrite");
    const done = transactionDone(tx);
    const range = IDBKeyRange.bound([archiveId, "", ""], [archiveId, "\uffff", "\uffff"]);
    tx.objectStore("archiveRecords").delete(range);
    await done;
    const archiveTx = (await this.open()).transaction("archives", "readwrite");
    archiveTx.objectStore("archives").delete(archiveId);
    await transactionDone(archiveTx);
    return true;
  }

  async restoreLocalArchive(archiveId, { preserveActiveSnapshot = false } = {}) {
    const archive = await this.#localArchiveMetadata(archiveId);
    if (!archive) throw new Error("Локальный архив не найден или ещё не готов");
    const existingSnapshots = await this.listSnapshots();
    const snapshotTimes = new Map(existingSnapshots.map((item) => [item.id, String(item.createdAt || "")]));
    const oldActiveId = await this.getSetting("activeSnapshotId", "");
    for await (const page of this.#localArchivePages(archiveId, "snapshots")) {
      for (const entry of page) {
        const snapshot = entry.value;
        if (!snapshot?.id || existingSnapshots.some((item) => item.id === snapshot.id)) continue;
        snapshotTimes.set(snapshot.id, String(snapshot.createdAt || ""));
        const expected = Number(snapshot.chunkCount ?? Math.ceil(Number(snapshot.deviceCount || 0) / CHUNK_SIZE));
        let count = 0;
        for (let index = 0; index < expected; index += 1) {
          const chunk = await this.#localArchiveRecord(archiveId, "snapshotChunks", [snapshot.stageKey ?? snapshot.id, index]);
          if (!chunk?.devices || !Array.isArray(chunk.devices)) throw new Error(`Локальный архив повреждён: отсутствует чанк ${snapshot.id}/${index}`);
          count += chunk.devices.length;
        }
        if (count !== Number(snapshot.deviceCount || 0)) throw new Error(`Локальный архив повреждён: число устройств не совпадает для ${snapshot.id}`);
        for (let index = 0; index < expected; index += 1) {
          const chunk = await this.#localArchiveRecord(archiveId, "snapshotChunks", [snapshot.stageKey ?? snapshot.id, index]);
          const db = await this.open();
          const tx = db.transaction("snapshotChunks", "readwrite");
          tx.objectStore("snapshotChunks").put({ ...chunk, snapshotId: snapshot.id, index });
          await transactionDone(tx);
        }
        const metadata = { ...snapshot };
        delete metadata.devices;
        delete metadata.stageKey;
        const db = await this.open();
        const tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").put(metadata);
        await transactionDone(tx);
        existingSnapshots.push(metadata);
      }
    }

    for await (const page of this.#localArchivePages(archiveId, "inventory")) {
      const db = await this.open();
      const tx = db.transaction("inventory", "readwrite");
      const done = transactionDone(tx);
      const store = tx.objectStore("inventory");
      await Promise.all(page.map(async ({ value: item }) => {
        if (!item?.id) return;
        const existing = await requestResult(store.get(item.id));
        const archiveTime = Date.parse(item.lastSeen || item.updatedAt || "") || 0;
        const localTime = Date.parse(existing?.lastSeen || existing?.updatedAt || "") || 0;
        const merged = mergeKnownRecord(archiveTime > localTime ? existing : item, archiveTime > localTime ? item : existing || item);
        merged.id = item.id;
        for (const field of INVENTORY_SORT_FIELDS) if (merged[field] === null || merged[field] === undefined) merged[field] = "";
        store.put(merged);
      }));
      await done;
    }

    for await (const page of this.#localArchivePages(archiveId, "history")) {
      for (const { value: item } of page) {
        if (!item || typeof item !== "object") continue;
        const db = await this.open();
        const tx = db.transaction("history", "readwrite");
        const store = tx.objectStore("history");
        const normalized = { ...item, macKey: normalizeMac(item.mac), timestamp: String(item.timestamp || item.createdAt || snapshotTimes.get(item.snapshotId) || "") };
        const existing = item.id === undefined || item.id === null ? null : await requestResult(store.get(item.id));
        const withoutId = ({ id: _archiveId, ...event }) => event;
        let duplicate = existing && JSON.stringify(withoutId(existing)) === JSON.stringify(withoutId(normalized));
        if (!duplicate && item.snapshotId && store.indexNames.contains("by_snapshot")) {
          duplicate = await new Promise((resolve, reject) => {
            const request = store.index("by_snapshot").openCursor(IDBKeyRange.only(item.snapshotId));
            request.onerror = () => reject(request.error || new Error("Не удалось проверить историю архива"));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { resolve(false); return; }
              if (JSON.stringify(withoutId(cursor.value)) === JSON.stringify(withoutId(normalized))) { resolve(true); return; }
              cursor.continue();
            };
          });
        }
        if (!duplicate) {
          if (item.id === undefined || item.id === null || !existing) store.put(normalized);
          else { const { id: _archiveId, ...withoutArchiveId } = normalized; store.add(withoutArchiveId); }
        }
        await transactionDone(tx);
      }
    }

    const simpleCollections = [
      ["settings", (item) => item?.key, (store, item) => store.add(item)],
      ["dataQualityReports", (item) => item?.id, (store, item) => store.add(item)],
      ["legacySmartroomRoomMappings", (item) => item?.id, (store, item) => store.add(item)],
      ["knownModels", (item) => item?.mac, (store, item) => store.add(item)],
      ["oui", (item) => item?.prefix, (store, item) => store.add(item)],
      ["switchAddressEvidence", (item) => item?.switchIp && item?.address && item?.snapshotId ? [item.switchIp, item.address, item.snapshotId] : null, (store, item) => store.put(item)],
      ["mac5Models", (item) => item?.prefix, (store, item) => store.add(item)],
    ];
    for (const [collection, keyFor, write] of simpleCollections) {
      for await (const page of this.#localArchivePages(archiveId, collection)) {
        const db = await this.open();
        const tx = db.transaction(collection, "readwrite");
        const done = transactionDone(tx);
        const store = tx.objectStore(collection);
        await Promise.all(page.map(async ({ value: item }) => {
          const key = keyFor(item);
          if (key === null || key === undefined || key === false) return;
          const existing = await requestResult(store.get(key));
          if (collection === "settings" && key === "ipAddressMappings" && existing) {
            store.put({ ...existing, value: normalizeIpMappings([...(item.value || []), ...(existing.value || [])]) });
          } else if (!existing) write(store, item);
        }));
        await done;
      }
    }
    for await (const page of this.#localArchivePages(archiveId, "legacyObservations")) {
      const db = await this.open();
      const tx = db.transaction(["legacyObservations", "legacyVendorModelPrefixCounts"], "readwrite");
      const done = transactionDone(tx);
      const store = tx.objectStore("legacyObservations");
      const prefixCounts = tx.objectStore("legacyVendorModelPrefixCounts");
      for (const { value: item } of page) if (item?.id && !(await requestResult(store.get(item.id)))) {
        store.put(item);
        await incrementLegacyVendorPrefixCounts(prefixCounts, item);
      }
      await done;
    }
    for await (const page of this.#localArchivePages(archiveId, "smartroomRoomMappings")) {
      for (const { value: item } of page) {
        const key = item?.smartroomIdKey || keyText(item?.smartroomId);
        if (!key || !item.sourceFinalId || !item.createdAt) continue;
        const db = await this.open();
        const tx = db.transaction("smartroomRoomMappings", "readwrite");
        const store = tx.objectStore("smartroomRoomMappings");
        const existing = await requestResult(store.get(key));
        if (!existing || (Date.parse(item.createdAt) || 0) > (Date.parse(existing.createdAt) || 0)) store.put({ ...item, smartroomIdKey: key });
        await transactionDone(tx);
      }
    }

    for await (const page of this.#localArchivePages(archiveId, "originalFiles")) {
      const db = await this.open();
      const tx = db.transaction("originalFiles", "readwrite");
      const done = transactionDone(tx);
      const store = tx.objectStore("originalFiles");
      for (const { value: item } of page) {
        if (!item?.snapshotId || !["main", "smartroom", "ddio"].includes(item.role) || !item.blob) continue;
        if (!await requestResult(store.get([item.snapshotId, item.role]))) store.put(item);
      }
      await done;
    }

    for await (const page of this.#localArchivePages(archiveId, "singleAnalyses")) {
      for (const { value: analysis } of page) {
        const db = await this.open();
        const lookupTx = db.transaction("singleAnalyses", "readonly");
        const existing = await requestResult(lookupTx.objectStore("singleAnalyses").get(analysis.id));
        await transactionDone(lookupTx);
        if (existing) continue;
        const tx = db.transaction(["archiveRecords", "singleAnalyses", "singleAnalysisChunks"], "readwrite", { durability: "strict" });
        const done = transactionDone(tx);
        const staged = tx.objectStore("archiveRecords");
        const analyses = tx.objectStore("singleAnalyses");
        const chunks = tx.objectStore("singleAnalysisChunks");
        await new Promise((resolve, reject) => {
          let index = 0;
          const fail = (error) => { try { tx.abort(); } catch {} reject(error); };
          const next = () => {
            if (index >= analysis.chunkCount) {
              analyses.add(analysis);
              resolve();
              return;
            }
            const current = index++;
            const request = staged.get([archiveId, "singleAnalysisChunks", JSON.stringify([analysis.id, current])]);
            request.onerror = () => fail(request.error || new Error("Не удалось восстановить блок анализа"));
            request.onsuccess = () => {
              const chunk = request.result?.value;
              if (!chunk || chunk.analysisId !== analysis.id || chunk.index !== current) return fail(new Error("Архив неполон: отсутствует блок анализа"));
              chunks.add(chunk);
              next();
            };
          };
          next();
        });
        await done;
      }
    }

    const candidates = existingSnapshots.filter(isFinalSnapshot).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const active = candidates.find((item) => item.id === oldActiveId) || null;
    const newest = candidates.at(-1) || null;
    const selected = active && (Date.parse(active.createdAt || "") || 0) >= (Date.parse(newest?.createdAt || "") || 0)
      ? active : newest;
    const db = await this.open();
    const stores = ["settings", "analyticsCache"];
    const tx = db.transaction(stores, "readwrite");
    const selectedActiveId = preserveActiveSnapshot && active && isFinalSnapshot(active) ? active.id : selected?.id || "";
    tx.objectStore("settings").put({ key: "activeSnapshotId", value: selectedActiveId });
    tx.objectStore("analyticsCache").clear();
    await transactionDone(tx);
    return { snapshotCount: existingSnapshots.length, activeSnapshotId: selectedActiveId };
  }

  async *#archiveJsonChunks(archiveId = "") {
    yield `{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"snapshots":[`;
    let firstSnapshot = true;
    const snapshots = archiveId ? this.#localArchivePages(archiveId, "snapshots") : this.#recordPages("snapshots");
    for await (const page of snapshots) {
      for (const entry of page) {
        const metadata = archiveId ? entry.value : entry;
        if (!firstSnapshot) yield ",";
        firstSnapshot = false;
        const prefix = JSON.stringify(metadata);
        yield `${prefix.slice(0, -1)},"devices":[`;
        const chunkCount = Number(metadata.chunkCount ?? Math.ceil(Number(metadata.deviceCount || 0) / CHUNK_SIZE));
        let firstDevice = true;
        for (let index = 0; index < chunkCount; index += 1) {
          let chunk;
          if (archiveId) chunk = await this.#localArchiveRecord(archiveId, "snapshotChunks", [metadata.id, index]);
          else {
            const db = await this.open();
            const tx = db.transaction("snapshotChunks", "readonly");
            chunk = await requestResult(tx.objectStore("snapshotChunks").get([metadata.id, index]));
            await transactionDone(tx);
          }
          for (const device of chunk?.devices || []) {
            if (!firstDevice) yield ",";
            firstDevice = false;
            yield JSON.stringify(device);
          }
        }
        yield "]}";
      }
    }
    yield "]";
    const collections = [
      ["inventory", "inventory"],
      ["history", "history"],
      ["settings", "settings"],
      ["knownModels", "knownModels"],
      ["oui", "oui"],
      ["switchAddressEvidence", "switchAddressEvidence"],
      ["mac5Models", "mac5Models"],
      ["smartroomRoomMappings", "smartroomRoomMappings"],
      ["singleAnalyses", "singleAnalyses"],
      ["singleAnalysisChunks", "singleAnalysisChunks"],
      ["legacyObservations", "legacyObservations"],
      ["dataQualityReports", "dataQualityReports"],
      ["legacySmartroomRoomMappings", "legacySmartroomRoomMappings"],
    ];
    for (const [property, storeName] of collections) {
      yield `,"${property}":[`;
      let first = true;
      const pages = archiveId ? this.#localArchivePages(archiveId, storeName) : this.#recordPages(storeName);
      for await (const page of pages) {
        for (const entry of page) {
          const record = archiveId ? entry.value : entry;
          if (!first) yield ",";
          first = false;
          yield JSON.stringify(property === "legacyObservations" ? legacyObservationArchiveRecord(record) : record);
        }
      }
      yield "]";
    }
    yield `,"originalFiles":[`;
    let firstOriginal = true;
    const originalPages = archiveId ? this.#localArchivePages(archiveId, "originalFiles") : this.#recordPages("originalFiles");
    for await (const page of originalPages) {
      for (const entry of page) {
        const record = archiveId ? entry.value : entry;
        const { blob, ...metadata } = record;
        if (!blob || typeof blob.slice !== "function" || Number(blob.size) !== Number(metadata.size)) throw new Error(`Оригинал ${metadata.name || metadata.role} повреждён и не может быть экспортирован`);
        if (!firstOriginal) yield ",";
        firstOriginal = false;
        const prefix = JSON.stringify(metadata);
        yield `${prefix.slice(0, -1)},"chunks":[`;
        let firstChunk = true;
        for (let offset = 0; offset < blob.size; offset += SOURCE_FILE_ARCHIVE_CHUNK_BYTES) {
          if (!firstChunk) yield ",";
          firstChunk = false;
          const bytes = new Uint8Array(await blob.slice(offset, offset + SOURCE_FILE_ARCHIVE_CHUNK_BYTES).arrayBuffer());
          yield JSON.stringify(bytesToBase64(bytes));
        }
        yield "]}";
      }
    }
    yield "]";
    yield "}";
  }

  exportArchiveStream() {
    return this.#streamArchive(this.#archiveJsonChunks());
  }

  async *#referenceArchiveJsonChunks() {
    const exportedAt = new Date().toISOString();
    const allSnapshots = [];
    for await (const page of this.#recordPages("snapshots")) {
      for (const snapshot of page) if (isFinalSnapshot(snapshot)) allSnapshots.push(snapshot);
    }
    allSnapshots.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    const activeId = await this.getSetting("activeSnapshotId", "");
    const current = allSnapshots.find((snapshot) => snapshot.id === activeId) || allSnapshots.at(-1) || null;
    const dashboard = await this.getSetting("analyticsDashboardSettings", {});
    const widgets = dashboard?.widgets && typeof dashboard.widgets === "object" ? dashboard.widgets : {};
    const legacyDashboard = {
      autoRefresh: dashboard?.autoRefresh === true,
      refreshInterval: Number(dashboard?.refreshIntervalSeconds) || 60,
      visibleCards: {
        total: widgets["kpi:devices"] !== false,
        changed: widgets["kpi:modified"] !== false,
        missing: widgets["kpi:absent"] !== false,
        unchanged: widgets["kpi:unchanged"] !== false,
        vendors: widgets["kpi:manufacturers"] !== false,
        rooms: widgets["kpi:rooms"] !== false,
      },
      visibleCharts: {
        dynamics: widgets["chart:totals"] !== false,
        vendors: widgets["chart:vendors"] !== false,
        fields: widgets["chart:fields"] !== false,
        missing: widgets["chart:absent-vendors"] !== false,
        presenceChurn: widgets["chart:presence-churn"] !== false,
      },
    };
    const workspace = {
      theme: await this.getSetting("theme", "light"),
      dashboardSettings: legacyDashboard,
      vendorDetectorSettings: await this.getSetting("vendorDetectorSettings", {}),
    };
    const snapshotMetadata = (snapshot) => ({
      id: String(snapshot.id),
      name: String(snapshot.name || ""),
      source: String(snapshot.source || ""),
      kind: "Final",
      fileCreatedAt: String(snapshot.fileCreatedAt || snapshot.createdAt || ""),
      savedAt: String(snapshot.createdAt || ""),
      deviceCount: Number(snapshot.deviceCount || 0),
      invalidCount: Number(snapshot.invalidCount || 0),
    });
    const writeSnapshotDevices = async function* (database, snapshot) {
      const chunkCount = Number(snapshot.chunkCount ?? Math.ceil(Number(snapshot.deviceCount || 0) / CHUNK_SIZE));
      let first = true;
      for (let index = 0; index < chunkCount; index += 1) {
        const db = await database.open();
        const tx = db.transaction("snapshotChunks", "readonly");
        const chunk = await requestResult(tx.objectStore("snapshotChunks").get([snapshot.id, index]));
        await transactionDone(tx);
        if (!chunk || chunk.snapshotId !== snapshot.id || chunk.index !== index || !Array.isArray(chunk.devices)) {
          throw new Error(`Final ${snapshot.name || snapshot.id}: отсутствует блок ${index + 1} из ${chunkCount}`);
        }
        for (const device of chunk.devices) {
          if (!first) yield ",";
          first = false;
          yield JSON.stringify(referenceArchiveDevice(device));
        }
      }
    };

    yield `{"format":"mac-analyzer-full-json","version":2,"exportedAt":${JSON.stringify(exportedAt)},"analytics":{},"workspace":${JSON.stringify(workspace)},"currentDevices":[`;
    if (current) yield* writeSnapshotDevices(this, current);
    yield `],"allDevices":[`;
    let firstInventory = true;
    for await (const page of this.#recordPages("inventory")) {
      for (const device of page) {
        if (!firstInventory) yield ",";
        firstInventory = false;
        yield JSON.stringify(referenceArchiveDevice(device));
      }
    }
    yield `],"invalidRows":[],"movementHistory":[`;
    let firstMovement = true;
    for await (const page of this.#recordPages("history")) {
      for (const movement of page) {
        if (!firstMovement) yield ",";
        firstMovement = false;
        const type = movement.type === "added" ? "Добавлено" : movement.type === "absent" ? "Отсутствует" : "Изменено";
        yield JSON.stringify({
          ...movement,
          type,
          field: String(movement.field || ""),
          before: movement.oldValue ?? movement.before ?? "",
          after: movement.newValue ?? movement.after ?? "",
          changedAt: String(movement.timestamp || movement.createdAt || ""),
        });
      }
    }
    yield `],"snapshots":[`;
    let firstSnapshot = true;
    for (const snapshot of allSnapshots) {
      if (!firstSnapshot) yield ",";
      firstSnapshot = false;
      yield `{"metadata":${JSON.stringify(snapshotMetadata(snapshot))},"devices":[`;
      yield* writeSnapshotDevices(this, snapshot);
      yield `]}`;
    }
    yield "]}";
  }

  exportReferenceArchiveStream() {
    return this.#streamArchive(this.#referenceArchiveJsonChunks());
  }

  async exportLocalArchiveStream(archiveId) {
    const record = await this.#localArchiveMetadata(archiveId);
    if (!record) throw new Error("Локальный архив не найден или ещё не готов");
    return this.#streamArchive(this.#archiveJsonChunks(archiveId));
  }

  #streamArchive(iterator) {
    const encoder = new globalThis.TextEncoder();
    let byteCount = 0;
    return new globalThis.ReadableStream({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) controller.close();
          else {
            const chunk = encoder.encode(result.value);
            byteCount += chunk.byteLength;
            if (byteCount > MAX_PORTABLE_ARCHIVE_BYTES) throw new Error("Portable archive превышает лимит 4 ГиБ");
            controller.enqueue(chunk);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        return iterator.return();
      },
    });
  }

  async importArchive(archive) {
    validateArchive(archive);
    const snapshots = Array.isArray(archive.snapshots) ? [...archive.snapshots] : [];
    const existingMetadata = await this.listSnapshots();
    const activeId = await this.getSetting("activeSnapshotId", "");
    const finalMetadata = existingMetadata.filter(isFinalSnapshot);
    const activeMetadata = finalMetadata.find((item) => item.id === activeId) || null;
    const newestLocalMetadata = finalMetadata.at(-1) || null;
    const imported = snapshots
      .filter((snapshot) => snapshot && typeof snapshot.id === "string" && Array.isArray(snapshot.devices))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const importedFinals = imported.filter(isFinalSnapshot);
    const importedNewest = importedFinals.at(-1);
    const localMetadata = !activeMetadata || (Date.parse(newestLocalMetadata?.createdAt || "") || 0) > (Date.parse(activeMetadata.createdAt || "") || 0)
      ? newestLocalMetadata
      : activeMetadata;
    const localTime = Date.parse(localMetadata?.createdAt || "") || 0;
    const importedTime = Date.parse(importedNewest?.createdAt || "") || 0;
    const selectedActiveId = localMetadata && localTime >= importedTime
      ? localMetadata.id
      : importedNewest && importedNewest.id ? importedNewest.id : activeId;
    const existingIds = new Set(existingMetadata.map((item) => item.id));
    for (const snapshot of imported) {
      if (!existingIds.has(snapshot.id)) {
        await this.saveFinal({ ...snapshot, comparison: null, activate: false, updateInventory: false });
        existingIds.add(snapshot.id);
      }
    }
    for (const archivedFile of archive.originalFiles || []) {
      if (await this.getOriginalFile(archivedFile.snapshotId, archivedFile.role)) continue;
      const chunks = archivedFile.chunks.map(base64ToBytes);
      const blob = new globalThis.Blob(chunks, { type: archivedFile.type || "application/octet-stream" });
      await this.saveOriginalFiles(archivedFile.snapshotId, [{
        role: archivedFile.role,
        file: {
          name: archivedFile.name,
          type: archivedFile.type || "application/octet-stream",
          size: blob.size,
          lastModified: archivedFile.lastModified || 0,
          slice: (...args) => blob.slice(...args),
        },
      }]);
    }
    const db = await this.open();
    const tx = db.transaction(["inventory", "history", "settings", "knownModels", "oui", "switchAddressEvidence", "mac5Models", "smartroomRoomMappings", "singleAnalyses", "singleAnalysisChunks", "legacyObservations", "legacyVendorModelPrefixCounts", "dataQualityReports", "legacySmartroomRoomMappings"], "readwrite");
    const inventoryStore = tx.objectStore("inventory");
    for (const item of archive.inventory || []) {
      if (!item?.id) continue;
      const existing = await requestResult(inventoryStore.get(item.id));
      const archiveTime = Date.parse(item.lastSeen || item.updatedAt || "") || 0;
      const localTime = Date.parse(existing?.lastSeen || existing?.updatedAt || "") || 0;
      const inventoryRecord = mergeKnownRecord(archiveTime > localTime ? existing : item, archiveTime > localTime ? item : existing || item);
      inventoryRecord.id = item.id;
      inventoryRecord.deviceIdKey = keyText(inventoryRecord.deviceId);
      inventoryRecord.serialKey = keyText(inventoryRecord.serial);
      for (const field of INVENTORY_SORT_FIELDS) if (inventoryRecord[field] === null || inventoryRecord[field] === undefined) inventoryRecord[field] = "";
      inventoryStore.put(inventoryRecord);
    }
    const historyStore = tx.objectStore("history");
    const snapshotTimes = new Map(imported.map((snapshot) => [snapshot.id, String(snapshot.createdAt || "")]));
    for (const item of archive.history || []) {
      if (!item || typeof item !== "object") continue;
      const normalized = { ...item, macKey: normalizeMac(item.mac), timestamp: String(item.timestamp || item.createdAt || snapshotTimes.get(item.snapshotId) || "") };
      if (item.id === undefined || item.id === null || !(await requestResult(historyStore.get(item.id)))) historyStore.put(normalized);
      else {
        const { id: _archiveId, ...withoutArchiveId } = normalized;
        historyStore.add(withoutArchiveId);
      }
    }
    const settingsStore = tx.objectStore("settings");
    for (const item of archive.settings || []) {
      if (item?.key && !(await requestResult(settingsStore.get(item.key)))) settingsStore.put(item);
    }
    const modelStore = tx.objectStore("knownModels");
    for (const item of archive.knownModels || []) if (item?.mac && !(await requestResult(modelStore.get(item.mac)))) modelStore.put(item);
    const ouiStore = tx.objectStore("oui");
    for (const item of archive.oui || []) if (item?.prefix && !(await requestResult(ouiStore.get(item.prefix)))) ouiStore.put(item);
    const evidenceStore = tx.objectStore("switchAddressEvidence");
    for (const item of archive.switchAddressEvidence || []) if (item?.switchIp && item?.address && item?.snapshotId) evidenceStore.put(item);
    const roomMappingStore = tx.objectStore("smartroomRoomMappings");
    for (const item of archive.smartroomRoomMappings || []) {
      const key = item?.smartroomIdKey || keyText(item?.smartroomId);
      if (!key || !item.sourceFinalId || !item.createdAt) continue;
      const existing = await requestResult(roomMappingStore.get(key));
      if (!existing || (Date.parse(item.createdAt) || 0) > (Date.parse(existing.createdAt) || 0)) roomMappingStore.put({ ...item, smartroomIdKey: key });
    }
    const mac5Store = tx.objectStore("mac5Models");
    for (const item of archive.mac5Models || []) if (!(await requestResult(mac5Store.get(item.prefix)))) mac5Store.put(item);
    const singleAnalysisStore = tx.objectStore("singleAnalyses");
    const singleAnalysisChunksStore = tx.objectStore("singleAnalysisChunks");
    const importedAnalysisIds = new Set();
    for (const item of archive.singleAnalyses || []) {
      if (!await requestResult(singleAnalysisStore.get(item.id))) {
        singleAnalysisStore.put(item);
        importedAnalysisIds.add(item.id);
      }
    }
    for (const item of archive.singleAnalysisChunks || []) {
      if (importedAnalysisIds.has(item.analysisId)) singleAnalysisChunksStore.put(item);
    }
    const legacyObservationStore = tx.objectStore("legacyObservations");
    const legacyPrefixCountStore = tx.objectStore("legacyVendorModelPrefixCounts");
    for (const rawItem of archive.legacyObservations || []) {
      const item = legacyObservationImportRecord(rawItem);
      if (item?.id && !(await requestResult(legacyObservationStore.get(item.id)))) {
        legacyObservationStore.put(item);
        await incrementLegacyVendorPrefixCounts(legacyPrefixCountStore, item);
      }
    }
    const qualityReportStore = tx.objectStore("dataQualityReports");
    for (const item of archive.dataQualityReports || []) if (item?.id && !(await requestResult(qualityReportStore.get(item.id)))) qualityReportStore.put(item);
    const legacySmartroomStore = tx.objectStore("legacySmartroomRoomMappings");
    for (const item of archive.legacySmartroomRoomMappings || []) {
      const existing = await requestResult(legacySmartroomStore.get(item.id));
      if (!existing || (Date.parse(item.updatedAt) || 0) > (Date.parse(existing.updatedAt) || 0)) legacySmartroomStore.put(item);
    }
    settingsStore.put({ key: "activeSnapshotId", value: selectedActiveId || "" });
    await transactionDone(tx);
  }

  async importArchiveEvents(header, events, { preserveActiveSnapshot = false } = {}) {
    const nativeArchive = header?.format === "MAC_ANALYZER_NEXT_ARCHIVE" && header.version === 1;
    const referenceArchive = header?.format === "mac-analyzer-full-json" && header.version === 2;
    if (!nativeArchive && !referenceArchive) throw new Error("Неподдерживаемый формат архива");
    const archiveId = crypto.randomUUID();
    const record = {
      id: archiveId,
      name: `Импорт ${new Date().toLocaleString("ru-RU")}`,
      createdAt: new Date().toISOString(),
      status: "building",
      recordCount: 0,
      snapshotCount: 0,
      counts: {},
    };
    let tx = (await this.open()).transaction("archives", "readwrite");
    tx.objectStore("archives").put(record);
    await transactionDone(tx);
    let recordCount = 0;
    let deviceCount = 0;
    let analysisRowCount = 0;
    let sequence = 0;
    const stagedSnapshotIds = new Set();
    let sourceFileBuild = null;
    const counts = {};
    const savePage = async (collection, entries, checkDuplicates = false) => {
      if (!entries.length) return;
      const db = await this.open();
      const stageTx = db.transaction("archiveRecords", "readwrite");
      const done = transactionDone(stageTx);
      const store = stageTx.objectStore("archiveRecords");
      try {
        for (const { key, value } of entries) {
          if (checkDuplicates && await requestResult(store.get([archiveId, collection, JSON.stringify(key)]))) {
            try { stageTx.abort(); } catch {}
            await done.catch(() => {});
            throw new Error(`Архив содержит повторную запись в ${collection}`);
          }
          store.add({ archiveId, collection, recordKey: JSON.stringify(key), sourceKey: key, value });
        }
        await done;
      } catch (error) {
        try { stageTx.abort(); } catch {}
        await done.catch(() => {});
        if (error?.name === "ConstraintError") throw new Error(`Архив содержит повторную запись в ${collection}`);
        throw error;
      }
    };
    try {
      for await (const event of events) {
        if (event?.type === "snapshotChunk") {
          if (!Array.isArray(event.devices) || !Number.isInteger(event.ordinal) || !Number.isInteger(event.index)) throw new Error("Некорректный чанк устройств архива");
          deviceCount += event.devices.length;
          if (deviceCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей устройств");
          await savePage("snapshotChunks", [{ key: [event.ordinal, event.index], value: { stageKey: event.ordinal, index: event.index, devices: event.devices } }]);
          continue;
        }
        if (event?.type === "snapshot") {
          const snapshot = event.value;
          if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id) throw new Error("Некорректная структура Final в архиве");
          recordCount += 1;
          if (recordCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей");
          await savePage("snapshots", [{ key: snapshot.id, value: { ...snapshot, stageKey: event.ordinal } }], true);
          stagedSnapshotIds.add(snapshot.id);
          counts.snapshots = (counts.snapshots || 0) + 1;
          continue;
        }
        if (event?.type === "originalFileStart") {
          const metadata = event.metadata;
          if (sourceFileBuild || !metadata?.snapshotId || !stagedSnapshotIds.has(metadata.snapshotId)
            || !["main", "smartroom", "ddio"].includes(metadata.role) || !Number.isSafeInteger(metadata.size)
            || metadata.size < 0 || metadata.size > MAX_SOURCE_FILE_BYTES) throw new Error("Некорректное начало оригинала исходного файла");
          sourceFileBuild = { ...metadata, expectedSize: metadata.size, size: 0, parts: [] };
          continue;
        }
        if (event?.type === "originalFileChunk") {
          if (!sourceFileBuild) throw new Error("Блок исходного файла получен вне оригинала");
          const bytes = base64ToBytes(event.chunk);
          sourceFileBuild.size += bytes.length;
          if (sourceFileBuild.size > sourceFileBuild.expectedSize) throw new Error("Исходный файл превышает объявленный размер");
          sourceFileBuild.parts.push(bytes);
          continue;
        }
        if (event?.type === "originalFileEnd") {
          if (!sourceFileBuild || sourceFileBuild.size !== sourceFileBuild.expectedSize) throw new Error("Размер импортированного оригинала не совпадает");
          recordCount += 1;
          if (recordCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей");
          const { parts, expectedSize: _expectedSize, size, ...metadata } = sourceFileBuild;
          const blob = new globalThis.Blob(parts, { type: metadata.type || "application/octet-stream" });
          if (blob.size !== size) throw new Error("Не удалось собрать исходный файл из блоков архива");
          await savePage("originalFiles", [{
            key: [metadata.snapshotId, metadata.role],
            value: { ...metadata, size, blob },
          }], true);
          counts.originalFiles = (counts.originalFiles || 0) + 1;
          sourceFileBuild = null;
          continue;
        }
        if (event?.type !== "records" || !Array.isArray(event.records)) throw new Error("Некорректный элемент потока архива");
        const collection = event.collection;
        if (!["inventory", "history", "settings", "knownModels", "oui", "switchAddressEvidence", "mac5Models", "smartroomRoomMappings", "singleAnalyses", "singleAnalysisChunks", "legacyObservations", "dataQualityReports", "legacySmartroomRoomMappings"].includes(collection)) throw new Error(`Неизвестный раздел архива: ${collection}`);
        const entries = [];
        for (const item of event.records) {
          recordCount += 1;
          if (recordCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей");
          let key;
          if (collection === "inventory") {
            if (!item || typeof item.id !== "string" || !item.id) throw new Error("Некорректная запись Inventory в архиве");
          } else if (collection === "settings") {
            if (!item || typeof item.key !== "string" || !item.key) throw new Error("Некорректная настройка в архиве");
          } else if (collection === "smartroomRoomMappings") {
            key = keyText(item?.smartroomId);
            if (!key || item.smartroomIdKey !== key || !item.sourceFinalId || !item.createdAt
              || !["confirmed", "review"].includes(item.status) || !Array.isArray(item.alternatives) || !Array.isArray(item.sampleMacs)) {
              throw new Error("Некорректное свидетельство Smartroom ID → помещение в архиве");
            }
          } else if (collection === "mac5Models") {
            key = normalizeMacPrefix(item?.prefix);
            if (!key || typeof item.model !== "string" || !text(item.model)) throw new Error("Некорректное правило MAC5 в архиве");
          } else if (collection === "singleAnalyses") {
            if (!item || typeof item.id !== "string" || !item.id || typeof item.filename !== "string"
              || !item.filename || !Number.isSafeInteger(item.deviceCount) || item.deviceCount < 0
              || !Number.isSafeInteger(item.chunkCount) || item.chunkCount < 0 || !item.storedRecordCounts) throw new Error("Некорректные метаданные анализа одного файла в архиве");
            key = item.id;
          } else if (collection === "singleAnalysisChunks") {
            if (!item || typeof item.analysisId !== "string" || !item.analysisId || !Number.isSafeInteger(item.index) || item.index < 0
              || !["devices", "invalid", "invalidMacs", "ambiguous", "identityConflicts"].every((field) => Array.isArray(item[field]) && item[field].length <= CHUNK_SIZE)) throw new Error("Некорректный блок анализа одного файла в архиве");
            analysisRowCount += item.devices.length + item.invalid.length + item.invalidMacs.length + item.ambiguous.length + item.identityConflicts.length;
            if (analysisRowCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число строк анализов");
            key = [item.analysisId, item.index];
          } else if (collection === "legacyObservations") {
            if (typeof item?.id !== "string" || !item.id
              || !LEGACY_OBSERVATION_KINDS.includes(item.kind)
              || item.sourceTable !== item.kind || typeof item.observedAt !== "string"
              || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) throw new Error("Некорректная запись legacy-наблюдения в архиве");
            key = item.id;
          } else if (collection === "dataQualityReports") {
            if (!item || typeof item.id !== "string" || !item.id || typeof item.snapshotId !== "string" || !item.snapshotId
              || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
              || !["A", "B", "C", "D"].includes(item.grade) || !item.report || typeof item.report !== "object" || Array.isArray(item.report)) throw new Error("Некорректный отчёт качества данных в архиве");
            key = item.id;
          } else if (collection === "legacySmartroomRoomMappings") {
            const smartroomIdKey = keyText(item?.smartroomId);
            const mappingId = `${smartroomIdKey}\u0000${text(item?.smartroomId)}`;
            if (!item || !smartroomIdKey || item.smartroomIdKey !== smartroomIdKey || item.id !== mappingId || !text(item.room)
              || typeof item.source !== "string" || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error("Некорректная legacy Smartroom-маппинг-запись в архиве");
            key = mappingId;
          }
          key ??= sequence++;
          entries.push({ key, value: item });
        }
          await savePage(collection, entries, collection === "smartroomRoomMappings" || collection === "legacySmartroomRoomMappings" || collection === "mac5Models" || collection === "singleAnalyses" || collection === "singleAnalysisChunks" || collection === "legacyObservations" || collection === "dataQualityReports");
        recordCount += 0;
        counts[collection] = (counts[collection] || 0) + event.records.length;
      }
      if (sourceFileBuild) throw new Error("Архив завершился до конца оригинала исходного файла");
      if (recordCount > MAX_ARCHIVE_RECORDS) throw new Error("Архив превышает допустимое число записей");
      for await (const page of this.#localArchivePages(archiveId, "smartroomRoomMappings")) {
        for (const { value: mapping } of page) {
          if (!await this.#localArchiveRecord(archiveId, "snapshots", mapping.sourceFinalId)) throw new Error("Некорректное свидетельство Smartroom ID → помещение в архиве");
        }
      }
      for await (const page of this.#localArchivePages(archiveId, "singleAnalyses")) {
        for (const { value: analysis } of page) {
          if (!analysis || typeof analysis.id !== "string" || !analysis.id || typeof analysis.filename !== "string"
            || !analysis.filename || analysis.filename.length > 1024 || typeof analysis.processedAt !== "string"
            || !analysis.processedAt || !Number.isSafeInteger(analysis.deviceCount) || analysis.deviceCount < 0
            || !Number.isSafeInteger(analysis.chunkCount) || analysis.chunkCount < 0 || !analysis.storedRecordCounts
            || !Number.isSafeInteger(analysis.storedRecordCounts.invalid) || !Number.isSafeInteger(analysis.storedRecordCounts.invalidMacs)
            || !Number.isSafeInteger(analysis.storedRecordCounts.ambiguous) || !Number.isSafeInteger(analysis.storedRecordCounts.identityConflicts)) throw new Error("Некорректные метаданные анализа одного файла в архиве");
          const expectedChunks = Math.ceil(Math.max(analysis.deviceCount, ...Object.values(analysis.storedRecordCounts), 0) / CHUNK_SIZE);
          if (analysis.chunkCount !== expectedChunks) throw new Error("Число блоков анализа в архиве не совпадает с метаданными");
          for (let index = 0; index < analysis.chunkCount; index += 1) {
            const chunk = await this.#localArchiveRecord(archiveId, "singleAnalysisChunks", [analysis.id, index]);
            if (!chunk || !["devices", "invalid", "invalidMacs", "ambiguous", "identityConflicts"].every((field) => Array.isArray(chunk[field]) && chunk[field].length <= CHUNK_SIZE)) throw new Error("В архиве отсутствует или повреждён блок анализа одного файла");
            const counts = { devices: analysis.deviceCount, ...analysis.storedRecordCounts };
            for (const [field, count] of Object.entries(counts)) if (chunk[field].length !== Math.min(CHUNK_SIZE, Math.max(0, count - index * CHUNK_SIZE))) throw new Error("Размер блока анализа одного файла не совпадает с метаданными");
          }
        }
      }
      for await (const page of this.#localArchivePages(archiveId, "singleAnalysisChunks")) {
        for (const { value: chunk } of page) {
          const analysis = await this.#localArchiveRecord(archiveId, "singleAnalyses", chunk?.analysisId);
          if (!analysis || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= analysis.chunkCount) throw new Error("В архиве есть блок без метаданных анализа");
        }
      }
      const snapshotCount = counts.snapshots || 0;
      tx = (await this.open()).transaction("archives", "readwrite");
      tx.objectStore("archives").put({ ...record, status: "ready", recordCount, snapshotCount, counts });
      await transactionDone(tx);
      const result = await this.restoreLocalArchive(archiveId, { preserveActiveSnapshot });
      return result;
    } finally {
      await this.deleteLocalArchive(archiveId).catch(() => {});
    }
  }

}

export const database = new Database();

