import { visitDeviceAlternateMacs } from "../core/identity.js";
import { normalizeMac } from "../core/normalize.js";
import { MAX_DEVICE_ALTERNATIVES } from "../core/normalize.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES = 512 * 1024 * 1024;
export const MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_OPTIONAL_HOST_APP_BACKUP_BYTES = 512 * 1024;
const MAX_OPTIONAL_HOST_HISTORY_BATCH_EVENTS = 500;
const MAX_OPTIONAL_HOST_HISTORY_REQUEST_BYTES = 900 * 1024;
const MAX_OPTIONAL_HOST_INVENTORY_BATCH_DEVICES = 500;
const MAX_OPTIONAL_HOST_INVENTORY_REQUEST_BYTES = 900 * 1024;
const MAX_OPTIONAL_HOST_BATCH_METADATA_FILES = 25_000;
const MAX_OPTIONAL_HOST_BATCH_METADATA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OPTIONAL_HOST_DIAGNOSTICS_RESPONSE_BYTES = 1024 * 1024;
const MAX_OPTIONAL_HOST_DATABASE_SEARCH_RESPONSE_BYTES = 1024 * 1024;
const MAX_OPTIONAL_HOST_DIAGNOSTIC_CHECKS = 100;
const SQLITE_HEADER = new globalThis.TextEncoder().encode("SQLite format 3\0");

async function readBoundedResponseText(response, maximumBytes, limitLabel = "1 МиБ") {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error("Ответ optional host не поддерживает ограниченное чтение");
  const bytes = new Uint8Array(maximumBytes);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Ответ optional host содержит некорректный поток");
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Ответ optional host превышает предел ${limitLabel}`);
      }
      bytes.set(value, totalBytes - value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  return new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, totalBytes));
}

function validateOptionalHostDiagnosticReport(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.checks) || result.checks.length > MAX_OPTIONAL_HOST_DIAGNOSTIC_CHECKS) {
    throw new Error("Optional host вернул некорректный отчёт диагностики");
  }
  const ids = new Set();
  const counts = { passed: 0, warnings: 0, errors: 0 };
  for (const item of result.checks) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id || item.id.length > 100
      || ids.has(item.id)
      || typeof item.title !== "string" || !item.title || item.title.length > 200
      || typeof item.detail !== "string" || item.detail.length > 8192
      || !["ok", "info", "warning", "error"].includes(item.status)) {
      throw new Error("Optional host вернул некорректную проверку диагностики");
    }
    ids.add(item.id);
    if (item.status === "ok") counts.passed += 1;
    else if (item.status === "warning") counts.warnings += 1;
    else if (item.status === "error") counts.errors += 1;
  }
  for (const [key, expected] of Object.entries(counts)) {
    if (result[key] !== expected) throw new Error("Optional host вернул несогласованные счётчики диагностики");
  }
  return result;
}

export function optionalHostDatabaseExportHref(locationLike = globalThis.location) {
  if (locationLike?.protocol !== "http:") return "";
  const hostname = String(locationLike.hostname || "").toLowerCase();
  const port = Number(locationLike.port);
  if (!LOOPBACK_HOSTS.has(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) return "";
  return "/api/database/export";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAppBackupDocument(content, expectedBytes) {
  if (typeof content !== "string") throw new Error("JSON-копия не содержит текст документа");
  const byteLength = new globalThis.TextEncoder().encode(content).byteLength;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_OPTIONAL_HOST_APP_BACKUP_BYTES
    || byteLength !== expectedBytes) {
    throw new Error("Размер JSON-копии не совпадает с подтверждённым размером");
  }
  let payload;
  try { payload = JSON.parse(content); } catch { throw new Error("JSON-копия содержит некорректный документ"); }
  if (!isRecord(payload) || !Number.isSafeInteger(payload.version) || payload.version < 0 || payload.version > 1
    || !isRecord(payload.state)) {
    throw new Error("JSON-копия имеет неподдерживаемую версию или не содержит состояние");
  }
  return payload;
}

export async function saveWorkspaceBackupToOptionalHost(state, {
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("JSON-копия состояния доступна только через локальный optional host");
  if (!isRecord(state)) throw new Error("Рабочее состояние должно быть JSON-объектом");
  let stateBytes;
  try { stateBytes = new globalThis.TextEncoder().encode(JSON.stringify(state)).byteLength; }
  catch { throw new Error("Рабочее состояние нельзя сериализовать в JSON"); }
  if (stateBytes > MAX_OPTIONAL_HOST_APP_BACKUP_BYTES) throw new Error("Рабочее состояние превышает предел JSON-копии 512 КиБ");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request("/api/backup/export", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
  } catch {
    throw new Error("Не удалось сохранить JSON-копию в папку optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не сохранил JSON-копию (HTTP ${Number(response?.status) || 0})`);
  let result;
  try {
    const encoded = await readBoundedResponseText(response, MAX_OPTIONAL_HOST_APP_BACKUP_BYTES * 2 + 32 * 1024, "1,1 МиБ");
    result = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректную JSON-копию");
    throw error;
  }
  if (!isRecord(result) || result.ok !== true || result.filename !== "mac-analyzer-backup.json"
    || result.mimeType !== "application/json" || typeof result.storedPath !== "string" || !result.storedPath
    || result.storedPath.length > 32_768) {
    throw new Error("Optional host вернул неполные сведения JSON-копии");
  }
  const payload = parseAppBackupDocument(result.content, result.bytes);
  if (payload.version !== 1 || JSON.stringify(payload.state) !== JSON.stringify(state)) {
    throw new Error("Optional host сохранил другое рабочее состояние");
  }
  return { filename: result.filename, mimeType: result.mimeType, content: result.content, bytes: result.bytes, storedPath: result.storedPath };
}

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return globalThis.btoa(binary);
}

export async function restoreWorkspaceBackupFromOptionalHost(file, {
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Восстановление JSON-копии доступно только через локальный optional host");
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_OPTIONAL_HOST_APP_BACKUP_BYTES
    || typeof file.arrayBuffer !== "function") {
    throw new Error("Выберите JSON-копию размером до 512 КиБ");
  }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error("Не удалось прочитать выбранную JSON-копию"); }
  if (bytes.byteLength !== file.size) throw new Error("Размер выбранной JSON-копии изменился при чтении");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request("/api/backup/restore", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentBase64: encodeBase64(bytes) }),
    });
  } catch {
    throw new Error("Не удалось передать JSON-копию локальному optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не принял JSON-копию (HTTP ${Number(response?.status) || 0})`);
  let result;
  try {
    const encoded = await readBoundedResponseText(response, MAX_OPTIONAL_HOST_APP_BACKUP_BYTES * 2 + 32 * 1024, "1,1 МиБ");
    result = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректный результат восстановления JSON-копии");
    throw error;
  }
  if (!isRecord(result) || result.ok !== true || !isRecord(result.state)
    || !Number.isSafeInteger(result.version) || result.version < 0 || result.version > 1
    || result.bytes !== file.size || typeof result.storedPath !== "string" || !result.storedPath || result.storedPath.length > 32_768) {
    throw new Error("Optional host вернул неполный или несогласованный результат JSON-копии");
  }
  return { state: result.state, version: result.version, bytes: result.bytes, storedPath: result.storedPath };
}

export async function loadOptionalHostDiagnostics({
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) return null;
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request("/api/system/diagnostics", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new Error("Не удалось прочитать диагностику локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не вернул диагностику (HTTP ${Number(response?.status) || 0})`);
  let result;
  try {
    result = JSON.parse(await readBoundedResponseText(response, MAX_OPTIONAL_HOST_DIAGNOSTICS_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректный отчёт диагностики");
    throw error;
  }
  return validateOptionalHostDiagnosticReport(result);
}

export async function listOptionalHostOuiReference({
  after = "",
  limit = 500,
  signal = null,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("OUI-справочник доступен только через локальный optional host");
  if (typeof after !== "string" || after.length > 10 || (after && !/^[0-9A-F]{6,10}$/.test(after))) {
    throw new Error("Курсор OUI должен быть нормализованным префиксом");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Размер страницы OUI должен быть от 1 до 500");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    const query = new globalThis.URLSearchParams({ after, limit: String(limit) });
    response = await request(`/api/reference/oui?${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error("Не удалось прочитать OUI-справочник локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не вернул OUI-справочник (HTTP ${Number(response?.status) || 0})`);
  let result;
  try { result = JSON.parse(await readBoundedResponseText(response, MAX_OPTIONAL_HOST_DATABASE_SEARCH_RESPONSE_BYTES)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректную страницу OUI-справочника");
    throw error;
  }
  if (!isRecord(result) || !Array.isArray(result.items) || result.items.length > limit
    || !Number.isSafeInteger(result.total) || result.total < 0
    || (result.nextAfter !== null && (typeof result.nextAfter !== "string" || !/^[0-9A-F]{6,10}$/.test(result.nextAfter) || result.nextAfter <= after))) {
    throw new Error("Optional host вернул некорректную страницу OUI-справочника");
  }
  let previous = after;
  for (const item of result.items) {
    if (!isRecord(item) || typeof item.prefix !== "string" || !/^[0-9A-F]{6,10}$/.test(item.prefix)
      || item.prefix <= previous || typeof item.vendor !== "string" || !item.vendor.trim() || item.vendor.length > 512
      || !["builtin", "reference"].includes(item.source)) {
      throw new Error("Optional host вернул некорректную строку OUI-справочника");
    }
    previous = item.prefix;
  }
  if (result.nextAfter !== null && (!result.items.length || result.items.at(-1).prefix !== result.nextAfter)) {
    throw new Error("Optional host вернул несогласованный курсор OUI-справочника");
  }
  return result;
}

export async function importOptionalHostOuiReferenceIntoDatabase(database, {
  signal = null,
  onProgress = () => {},
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!database || typeof database.importOui !== "function") throw new Error("IndexedDB недоступна для импорта OUI");
  let after = "";
  let total = null;
  let received = 0;
  let imported = 0;
  while (after !== null) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const page = await listOptionalHostOuiReference({ after, limit: 500, signal, locationLike, fetchImpl });
    if (total === null) total = page.total;
    if (page.total !== total || received + page.items.length > total || (!page.items.length && page.nextAfter)) {
      throw new Error("Справочник optional host изменился во время передачи или вернул неполную страницу");
    }
    if (page.items.length) {
      const rows = page.items.map(({ prefix, vendor }) => ({ prefix, vendor, source: "Справочник optional host" }));
      imported += await database.importOui(rows, { overwriteExisting: true, overwriteSources: ["Справочник optional host"] });
      received += rows.length;
    }
    after = page.nextAfter;
    onProgress({ received, total: total || 0, imported });
  }
  if (received !== total) throw new Error(`Optional host передал ${received.toLocaleString("ru-RU")} из ${(total || 0).toLocaleString("ru-RU")} OUI-префиксов`);
  return { total: total || 0, received, imported };
}

export async function runOptionalHostDatabaseMaintenance({
  integrity = true,
  optimize = true,
  vacuum = false,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Обслуживание доступно только для SQLite optional host на этом компьютере");
  if (![integrity, optimize, vacuum].every((value) => typeof value === "boolean")) {
    throw new Error("Параметры обслуживания базы имеют неверный формат");
  }
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request("/api/database/maintenance", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ integrity, optimize, vacuum }),
    });
  } catch {
    throw new Error("Не удалось выполнить обслуживание SQLite optional host");
  }
  let result;
  try {
    result = JSON.parse(await readBoundedResponseText(response, 1024 * 1024));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректный результат обслуживания базы");
    throw error;
  }
  if (!response?.ok) {
    const detail = typeof result?.integrity === "string" ? `: ${result.integrity.slice(0, 500)}` : "";
    throw new Error(`Обслуживание SQLite optional host не выполнено (HTTP ${Number(response?.status) || 0})${detail}`);
  }
  const validSummary = (summary) => summary && typeof summary === "object" && !Array.isArray(summary)
    && Number.isSafeInteger(summary.sizeBytes) && summary.sizeBytes >= 0
    && Number.isSafeInteger(summary.tableCount) && summary.tableCount >= 0
    && summary.counts && typeof summary.counts === "object" && !Array.isArray(summary.counts)
    && Object.values(summary.counts).every((count) => Number.isSafeInteger(count) && count >= 0);
  if (result?.ok !== true || !["ok", "skipped"].includes(result.integrity)
    || !["ok", "skipped"].includes(result.afterIntegrity)
    || result.optimized !== optimize || result.vacuumed !== vacuum
    || !validSummary(result.before) || !validSummary(result.after)
    || !Number.isSafeInteger(result.reclaimedBytes) || result.reclaimedBytes < 0) {
    throw new Error("Optional host вернул неполный или несогласованный результат обслуживания базы");
  }
  return result;
}

export async function scanOptionalHostBatchFolders(paths, {
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Windows-даты папок доступны только через локальный optional host");
  if (!paths || typeof paths !== "object" || Array.isArray(paths)
    || Object.keys(paths).some((role) => !["main", "smartroom", "ddio"].includes(role))) {
    throw new Error("Укажите папки Main, SmartRoom и DDIO");
  }
  for (const role of ["main", "smartroom", "ddio"]) {
    if (paths[role] !== undefined && (typeof paths[role] !== "string" || paths[role].length > 32_768)) {
      throw new Error(`Путь папки ${role} слишком длинный или имеет неверный формат`);
    }
  }
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request("/api/batch/folders/scan", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
  } catch {
    throw new Error("Не удалось выполнить локальное сканирование папок");
  }
  if (!response?.ok) throw new Error(`Локальный optional host не смог просканировать папки (HTTP ${Number(response?.status) || 0})`);
  const encoded = await response.text().catch(() => "");
  if (new globalThis.TextEncoder().encode(encoded).byteLength > MAX_OPTIONAL_HOST_BATCH_METADATA_RESPONSE_BYTES) {
    throw new Error("Ответ сканера папок превышает 8 МиБ");
  }
  let result;
  try { result = JSON.parse(encoded); } catch { result = null; }
  if (!result || result.ok !== true || !result.folders || typeof result.folders !== "object"
    || !Array.isArray(result.files) || result.files.length > MAX_OPTIONAL_HOST_BATCH_METADATA_FILES) {
    throw new Error("Локальный optional host вернул некорректный список файлов");
  }
  for (const file of result.files) {
    if (!file || !["main", "smartroom", "ddio"].includes(file.role)
      || typeof file.name !== "string" || file.name.length > 1024
      || typeof file.relativePath !== "string" || file.relativePath.length > 4096
      || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.date !== "string" || file.date.length > 80
      || !["filename", "xlsx.created", "filesystem.created", "filesystem.modified"].includes(file.dateSource)) {
      throw new Error("Локальный optional host вернул некорректные метаданные файла");
    }
  }
  return result;
}

export async function listOptionalHostSnapshots({
  after = "",
  limit = 50,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Список Final доступен только через локальный optional host");
  if (typeof after !== "string" || after.length > 200) throw new Error("Курсор Final имеет неверный формат");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Размер страницы Final должен быть от 1 до 100");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    const query = new globalThis.URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) });
    response = await request(`/api/snapshots?${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
    });
  } catch {
    throw new Error("Не удалось прочитать список Final локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не вернул список Final (HTTP ${Number(response?.status) || 0})`);
  const result = await response.json().catch(() => null);
  if (!result || !Array.isArray(result.snapshots) || !Number.isSafeInteger(result.total) || result.total < 0
    || (result.nextCursor !== null && typeof result.nextCursor !== "string")) {
    throw new Error("Optional host вернул некорректную страницу Final");
  }
  for (const item of result.snapshots) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 200
      || typeof item.name !== "string" || !Number.isSafeInteger(item.deviceCount) || item.deviceCount < 0
      || typeof item.createdAt !== "string") throw new Error("Метаданные Final от optional host имеют неверный формат");
  }
  return result;
}

export async function searchOptionalHostDatabase(query = "", {
  limit = 100,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Поиск доступен только в SQLite optional host на этом компьютере");
  if (typeof query !== "string" || query.length > 256) throw new Error("Запрос должен содержать не более 256 символов");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Размер поиска должен быть от 1 до 500");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");

  let response;
  try {
    const params = new globalThis.URLSearchParams({ query: query.trim(), limit: String(limit) });
    response = await request("/api/database/search?" + params, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new Error("Не удалось выполнить поиск в SQLite optional host");
  }
  if (!response?.ok) throw new Error("Optional host не вернул результаты поиска (HTTP " + (Number(response?.status) || 0) + ")");
  let result;
  try {
    result = JSON.parse(await readBoundedResponseText(response, MAX_OPTIONAL_HOST_DATABASE_SEARCH_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Optional host вернул некорректные результаты поиска");
    throw error;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.results) || result.results.length > limit
    || !Number.isSafeInteger(result.count) || result.count !== result.results.length) {
    throw new Error("Optional host вернул некорректную страницу поиска");
  }
  for (const item of result.results) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !["device", "vendorModel", "ipMapping"].includes(item.type)
      || typeof item.mac !== "string" || item.mac.length > 32
      || typeof item.title !== "string" || item.title.length > 256
      || typeof item.subtitle !== "string" || item.subtitle.length > 512
      || typeof item.source !== "string" || item.source.length > 128
      || typeof item.updatedAt !== "string" || item.updatedAt.length > 64) {
      throw new Error("Optional host вернул некорректную строку поиска");
    }
  }
  return result;
}

export async function listOptionalHostHistoryForMac(mac, {
  after = 0,
  limit = 100,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("История optional host доступна только через локальный optional host");
  const normalizedMac = normalizeMac(mac);
  if (!normalizedMac) throw new Error("Для поиска History укажите корректный MAC-адрес");
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Курсор History должен быть неотрицательным целым числом");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Размер страницы History должен быть от 1 до 500");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    const query = new globalThis.URLSearchParams({ mac: normalizedMac, after: String(after), limit: String(limit) });
    response = await request(`/api/history?${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
    });
  } catch {
    throw new Error("Не удалось прочитать History выбранного MAC из локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не вернул History выбранного MAC (HTTP ${Number(response?.status) || 0})`);
  const result = await response.json().catch(() => null);
  if (!result || !Array.isArray(result.events) || !Number.isSafeInteger(result.total) || result.total < 0
    || (result.nextCursor !== null && (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= after))) {
    throw new Error("Optional host вернул некорректную страницу History выбранного MAC");
  }
  for (const event of result.events) {
    if (!event || typeof event !== "object" || !Number.isSafeInteger(event.id) || event.id < 1
      || typeof event.sourceFinalId !== "string" || !event.sourceFinalId
      || typeof event.observedAt !== "string"
      || !["added", "absent", "modified"].includes(event.eventType)) {
      throw new Error("Optional host вернул некорректное событие History выбранного MAC");
    }
  }
  return result;
}

export async function deleteOptionalHostSnapshot(snapshotId, {
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Удаление Final доступно только через локальный optional host");
  if (typeof snapshotId !== "string" || !snapshotId.trim() || snapshotId.length > 200) throw new Error("ID Final имеет неверный формат");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request(`/api/snapshots/${encodeURIComponent(snapshotId.trim())}`, {
      method: "DELETE", credentials: "same-origin", cache: "no-store", redirect: "error",
    });
  } catch {
    throw new Error("Не удалось удалить Final локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не удалил Final (HTTP ${Number(response?.status) || 0})`);
  const result = await response.json().catch(() => null);
  if (result?.ok !== true || result.snapshotId !== snapshotId.trim() || result.deletedSnapshotCount !== 1
    || !Number.isSafeInteger(result.deletedHistoryCount) || result.deletedHistoryCount < 0
    || result.inventoryPreserved !== true) throw new Error("Optional host не подтвердил удаление только выбранного Final");
  return result;
}

export async function deleteOptionalHostSnapshots(snapshotIds, options = {}) {
  if (!Array.isArray(snapshotIds) || snapshotIds.length < 1 || snapshotIds.length > 50) {
    throw new Error("Можно удалить от 1 до 50 выбранных Final за один проход");
  }
  const normalized = snapshotIds.map((snapshotId) => {
    if (typeof snapshotId !== "string" || !snapshotId.trim() || snapshotId.length > 200) {
      throw new Error("ID Final имеет неверный формат");
    }
    return snapshotId.trim();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Список выбранных Final содержит повторяющийся ID");
  const deletedIds = [];
  const failures = [];
  for (const snapshotId of normalized) {
    try {
      await deleteOptionalHostSnapshot(snapshotId, options);
      deletedIds.push(snapshotId);
    } catch (error) {
      failures.push({ snapshotId, message: error?.message || String(error) });
    }
  }
  return { deletedIds, failures };
}

export async function uploadSQLiteBackupToOptionalHost(file, {
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Восстановление доступно только через локальный optional host");
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size < 100) {
    throw new Error("Выберите SQLite-файл размером не менее 100 байт");
  }
  if (file.size > MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES) throw new Error("SQLite-файл превышает предел 512 МиБ");
  if (typeof fetchImpl !== "function" && typeof globalThis.fetch !== "function") throw new Error("Локальный optional host недоступен");
  const header = new Uint8Array(await file.slice(0, SQLITE_HEADER.byteLength).arrayBuffer());
  if (header.length !== SQLITE_HEADER.length || header.some((value, index) => value !== SQLITE_HEADER[index])) {
    throw new Error("Выбранный файл не является базой SQLite");
  }

  let response;
  const requestOptions = {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.sqlite3" },
    credentials: "same-origin",
    body: file,
  };
  try {
    response = fetchImpl
      ? await fetchImpl("/api/database/restore", requestOptions)
      : await globalThis.fetch("/api/database/restore", requestOptions);
  } catch {
    throw new Error("Не удалось передать SQLite-файл локальному optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не сохранил SQLite-копию (HTTP ${Number(response?.status) || 0})`);
  const result = await response.json().catch(() => null);
  if (result?.ok !== true || result.integrity !== "ok") throw new Error("Optional host не подтвердил целостность SQLite-копии");
  return result;
}

export async function uploadFinalSnapshotToOptionalHost(metadata, devices, {
  locationLike = globalThis.location,
  fetchImpl = null,
  TextEncoderImpl = globalThis.TextEncoder,
  signal = undefined,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Передача Final доступна только локальному optional host");
  const snapshotId = typeof metadata?.id === "string" ? metadata.id.trim() : "";
  const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
  const createdAt = typeof metadata?.createdAt === "string" ? metadata.createdAt : "";
  const deviceCount = Number(metadata?.deviceCount);
  if (!snapshotId || snapshotId.length > 200 || !name || !Number.isSafeInteger(deviceCount) || deviceCount < 0 || deviceCount > 150_000) {
    throw new Error("Активный Final содержит некорректные метаданные");
  }
  if (!Number.isFinite(Date.parse(createdAt)) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(createdAt)) {
    throw new Error("У Final отсутствует корректное время с часовым поясом");
  }
  if (!devices || typeof devices[Symbol.asyncIterator] !== "function") throw new Error("Поток устройств Final недоступен");
  if (typeof TextEncoderImpl !== "function" || typeof globalThis.Blob !== "function") {
    throw new Error("Передача Final в optional host не поддерживается этим браузером");
  }
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  const encoder = new TextEncoderImpl();
  const records = (async function* snapshotNdjson() {
    const metadataLine = encoder.encode(`${JSON.stringify({
      type: "snapshot", id: snapshotId, name, source: "IndexedDB Final", createdAt, deviceCount,
    })}\n`);
    let byteCount = metadataLine.byteLength;
    if (byteCount > MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES) throw new Error("Final превышает предел загрузки optional host 256 МиБ");
    let sent = 0;
    let frameParts = [metadataLine];
    let frameBytes = metadataLine.byteLength;
    const takeFrame = () => {
      const frame = new Uint8Array(frameBytes);
      let offset = 0;
      for (const part of frameParts) { frame.set(part, offset); offset += part.byteLength; }
      frameParts = [];
      frameBytes = 0;
      return frame;
    };
    for await (const device of devices) {
      if (sent >= deviceCount) throw new Error("Поток Final содержит больше устройств, чем указано в метаданных");
      let line;
      try { line = JSON.stringify(device); }
      catch { throw new Error("Устройство Final не сериализуется в JSON"); }
      if (typeof line !== "string") throw new Error("Устройство Final не сериализуется в JSON");
      const encoded = encoder.encode(`${line}\n`);
      if (encoded.byteLength > 256 * 1024) throw new Error("Запись Final превышает предел 256 КиБ optional host");
      byteCount += encoded.byteLength;
      if (byteCount > MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES) throw new Error("Final превышает предел загрузки optional host 256 МиБ");
      let offset = 0;
      while (offset < encoded.byteLength) {
        const available = 64 * 1024 - frameBytes;
        const length = Math.min(available, encoded.byteLength - offset);
        frameParts.push(encoded.subarray(offset, offset + length));
        frameBytes += length;
        offset += length;
        if (frameBytes === 64 * 1024) yield takeFrame();
      }
      sent += 1;
    }
    if (sent !== deviceCount) throw new Error(`В потоке Final ${sent} устройств вместо ${deviceCount}`);
    if (frameParts.length) yield takeFrame();
  }());
  const bodyChunks = [];
  for await (const chunk of records) bodyChunks.push(chunk);
  const body = new globalThis.Blob(bodyChunks, { type: "application/x-ndjson" });
  let response;
  try {
    response = await request(`/api/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Не удалось передать Final локальному optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не сохранил Final (HTTP ${Number(response?.status) || 0}); существующий снимок не заменяется`);
  const result = await response.json().catch(() => null);
  if (result?.snapshotId !== snapshotId || result.deviceCount !== deviceCount || !/^[\da-f]{64}$/i.test(String(result?.signature || ""))) {
    throw new Error("Optional host не подтвердил целостность скопированного Final");
  }
  return result;
}

export async function uploadSnapshotHistoryToOptionalHost(snapshotId, pages, {
  locationLike = globalThis.location,
  fetchImpl = null,
  TextEncoderImpl = globalThis.TextEncoder,
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Передача History доступна только локальному optional host");
  const id = typeof snapshotId === "string" ? snapshotId.trim() : "";
  if (!id || id.length > 200) throw new Error("У Final отсутствует корректный ID для History");
  if (!pages || typeof pages[Symbol.asyncIterator] !== "function") throw new Error("Поток History Final недоступен");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function" || typeof TextEncoderImpl !== "function") throw new Error("Локальный optional host недоступен");
  const encoder = new TextEncoderImpl();
  let batch = [];
  let batchBytes = 12;
  let eventCount = 0;
  let insertedCount = 0;
  let duplicateCount = 0;

  const sendBatch = async () => {
    if (!batch.length) return;
    const events = batch;
    const body = JSON.stringify({ events });
    let response;
    try {
      response = await request("/api/history", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body,
      });
    } catch {
      throw new Error("Не удалось передать History локальному optional host");
    }
    if (!response?.ok) throw new Error(`Optional host не сохранил History (HTTP ${Number(response?.status) || 0})`);
    const result = await response.json().catch(() => null);
    const inserted = Number(result?.insertedCount);
    const duplicates = Number(result?.duplicateCount);
    if (!Number.isSafeInteger(inserted) || inserted < 0 || !Number.isSafeInteger(duplicates) || duplicates < 0
      || inserted + duplicates !== events.length) {
      throw new Error("Optional host не подтвердил число сохранённых событий History");
    }
    eventCount += events.length;
    insertedCount += inserted;
    duplicateCount += duplicates;
    batch = [];
    batchBytes = 12;
  };

  for await (const page of pages) {
    if (!Array.isArray(page)) throw new Error("Страница History содержит некорректные данные");
    for (const sourceEvent of page) {
      if (!sourceEvent || typeof sourceEvent !== "object" || sourceEvent.snapshotId !== id) {
        throw new Error("Событие History не связано с копируемым Final");
      }
      const eventType = String(sourceEvent.type || "");
      if (!["added", "absent", "modified"].includes(eventType)) throw new Error("В History обнаружен неизвестный тип события");
      const record = {
        sourceFinalId: id,
        observedAt: String(sourceEvent.timestamp || sourceEvent.createdAt || ""),
        internalDeviceId: String(sourceEvent.deviceId || ""),
        eventType,
        ...(typeof sourceEvent.mac === "string" && sourceEvent.mac ? { mac: sourceEvent.mac } : {}),
        ...(typeof sourceEvent.source === "string" && sourceEvent.source ? { source: sourceEvent.source } : {}),
      };
      if (eventType === "modified") {
        const field = sourceEvent.field || sourceEvent.label || sourceEvent.fieldLabel;
        const before = sourceEvent.fromValue ?? sourceEvent.oldValue ?? sourceEvent.before;
        const after = sourceEvent.toValue ?? sourceEvent.newValue ?? sourceEvent.after;
        if (typeof field !== "string" || typeof before !== "string" || typeof after !== "string") {
          throw new Error("Изменённое событие History не содержит поле и оба значения");
        }
        record.field = field;
        record.fromValue = before;
        record.toValue = after;
      }
      const encodedSize = encoder.encode(JSON.stringify(record)).byteLength;
      if (encodedSize > 256 * 1024) throw new Error("Событие History превышает предел 256 КиБ");
      if (batch.length && (batch.length >= MAX_OPTIONAL_HOST_HISTORY_BATCH_EVENTS
        || batchBytes + encodedSize + 1 > MAX_OPTIONAL_HOST_HISTORY_REQUEST_BYTES)) {
        await sendBatch();
      }
      if (batchBytes + encodedSize + 1 > MAX_OPTIONAL_HOST_HISTORY_REQUEST_BYTES) {
        throw new Error("Событие History превышает предел пакета передачи");
      }
      batch.push(record);
      batchBytes += encodedSize + (batch.length > 1 ? 1 : 0);
    }
  }
  await sendBatch();
  return { eventCount, insertedCount, duplicateCount };
}

export async function uploadInventoryToOptionalHost(pages, {
  locationLike = globalThis.location,
  fetchImpl = null,
  TextEncoderImpl = globalThis.TextEncoder,
  onProgress = () => {},
} = {}) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Передача Inventory доступна только локальному optional host");
  if (!pages || typeof pages[Symbol.asyncIterator] !== "function") throw new Error("Поток Inventory недоступен");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function" || typeof TextEncoderImpl !== "function") throw new Error("Локальный optional host недоступен");
  const encoder = new TextEncoderImpl();
  let batch = [];
  let batchBytes = 14;
  let deviceCount = 0;
  let savedCount = 0;
  let conflictCount = 0;
  const conflicts = [];

  const sendBatch = async () => {
    if (!batch.length) return;
    const devices = batch;
    let response;
    try {
      response = await request("/api/devices", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ devices }),
      });
    } catch {
      throw new Error("Не удалось передать Inventory локальному optional host");
    }
    if (!response?.ok) throw new Error(`Optional host не сохранил Inventory (HTTP ${Number(response?.status) || 0})`);
    const result = await response.json().catch(() => null);
    const saved = Number(result?.savedCount);
    const rejected = Number(result?.conflictCount);
    if (!Number.isSafeInteger(saved) || saved < 0 || !Number.isSafeInteger(rejected) || rejected < 0
      || saved + rejected !== devices.length || !Array.isArray(result?.conflicts) || result.conflicts.length !== rejected) {
      throw new Error("Optional host не подтвердил число сохранённых устройств Inventory");
    }
    deviceCount += devices.length;
    savedCount += saved;
    conflictCount += rejected;
    if (conflicts.length < 50) conflicts.push(...result.conflicts.slice(0, 50 - conflicts.length));
    onProgress({ deviceCount, savedCount, conflictCount });
    batch = [];
    batchBytes = 14;
  };

  for await (const page of pages) {
    if (!Array.isArray(page)) throw new Error("Страница Inventory содержит некорректные данные");
    for (const source of page) {
      if (!source || typeof source !== "object" || !String(source.id || "").trim()) {
        throw new Error("Устройство Inventory не содержит внутренний ID");
      }
      const observationCount = source.observationCount;
      if (!Number.isSafeInteger(observationCount) || observationCount < 0) throw new Error("Устройство Inventory содержит некорректное число наблюдений");
      const alternateMacs = [];
      let alternateMacsTruncated = false;
      visitDeviceAlternateMacs(source, (mac) => {
        if (alternateMacs.length >= MAX_DEVICE_ALTERNATIVES) {
          alternateMacsTruncated = true;
          return false;
        }
        alternateMacs.push(mac);
        return true;
      });
      const record = {
        internalDeviceId: String(source.id),
        mac: String(source.mac || ""),
        macFormatted: String(source.macFormatted || ""),
        deviceId: String(source.deviceId || ""),
        serialNumber: String(source.serialNumber ?? source.serial ?? ""),
        vendor: String(source.vendor ?? source.manufacturer ?? ""),
        manufacturer: String(source.manufacturer ?? source.vendor ?? ""),
        model: String(source.model || ""),
        oui: String(source.oui || ""),
        vendorConfidence: source.vendorConfidence,
        modelConfidence: source.modelConfidence,
        vendorSource: String(source.vendorSource || ""),
        modelSource: String(source.modelSource || ""),
        deviceType: String(source.deviceType || ""),
        ip: String(source.ip || ""),
        address: String(source.address ?? source.physicalAddress ?? ""),
        physicalAddress: String(source.physicalAddress || ""),
        room: String(source.room || ""),
        smartroomId: String(source.smartroomId || ""),
        switchIp: String(source.switchIp || ""),
        switchPort: String(source.switchPort || ""),
        hostname: String(source.hostname || ""),
        deviceName: String(source.deviceName || ""),
        businessUnit: String(source.businessUnit || ""),
        city: String(source.city || ""),
        site: String(source.site || ""),
        floor: String(source.floor || ""),
        authenticationTime: String(source.authenticationTime || ""),
        firstSeen: String(source.firstSeen || ""),
        lastSeen: String(source.lastSeen || ""),
        lastMissing: String(source.lastMissing || ""),
        ...(typeof source.present === "boolean" ? { present: source.present } : {}),
        snapshotId: String(source.snapshotId || ""),
        possibleIps: Array.isArray(source.possibleIps) ? source.possibleIps : [],
        possibleIpsTruncated: Boolean(source.possibleIpsTruncated),
        source: String(source.source || ""),
        sources: Array.isArray(source.sources) ? source.sources : [],
        alternateMacs,
        alternateMacsTruncated: Boolean(source.alternateMacsTruncated || alternateMacsTruncated),
        customFields: source.customFields && typeof source.customFields === "object" && !Array.isArray(source.customFields) ? source.customFields : {},
        customFieldSources: source.customFieldSources && typeof source.customFieldSources === "object" && !Array.isArray(source.customFieldSources) ? source.customFieldSources : {},
        fieldSources: source.fieldSources && typeof source.fieldSources === "object" && !Array.isArray(source.fieldSources) ? source.fieldSources : {},
        conflicts: Array.isArray(source.conflicts) ? source.conflicts : [],
        conflictsTruncated: Boolean(source.conflictsTruncated),
        observationCount,
      };
      const encodedSize = encoder.encode(JSON.stringify(record)).byteLength;
      if (encodedSize > 256 * 1024) throw new Error("Запись Inventory превышает предел 256 КиБ");
      if (batch.length && (batch.length >= MAX_OPTIONAL_HOST_INVENTORY_BATCH_DEVICES
        || batchBytes + encodedSize + 1 > MAX_OPTIONAL_HOST_INVENTORY_REQUEST_BYTES)) await sendBatch();
      if (batchBytes + encodedSize + 1 > MAX_OPTIONAL_HOST_INVENTORY_REQUEST_BYTES) throw new Error("Запись Inventory превышает предел пакета передачи");
      batch.push(record);
      batchBytes += encodedSize + (batch.length > 1 ? 1 : 0);
    }
  }
  await sendBatch();
  return { deviceCount, savedCount, conflictCount, conflicts };
}
