const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES = 512 * 1024 * 1024;
const SQLITE_HEADER = new globalThis.TextEncoder().encode("SQLite format 3\0");

export function optionalHostDatabaseExportHref(locationLike = globalThis.location) {
  if (locationLike?.protocol !== "http:") return "";
  const hostname = String(locationLike.hostname || "").toLowerCase();
  const port = Number(locationLike.port);
  if (!LOOPBACK_HOSTS.has(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) return "";
  return "/api/database/export";
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
  const result = await response.json().catch(() => null);
  if (!result || !Array.isArray(result.checks)) throw new Error("Optional host вернул некорректный отчёт диагностики");
  return result;
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
