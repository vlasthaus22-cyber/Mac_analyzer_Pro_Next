const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES = 512 * 1024 * 1024;
export const MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES = 256 * 1024 * 1024;
export const OPTIONAL_HOST_SNAPSHOT_PAGE_SIZE = 100;
const SQLITE_HEADER = new globalThis.TextEncoder().encode("SQLite format 3\0");

async function getOptionalHostJson(path, { locationLike, fetchImpl }) {
  if (!optionalHostDatabaseExportHref(locationLike)) throw new Error("Чтение доступно только через локальный optional host");
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== "function") throw new Error("Локальный optional host недоступен");
  let response;
  try {
    response = await request(path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch {
    throw new Error("Не удалось прочитать данные локального optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не вернул страницу данных (HTTP ${Number(response?.status) || 0})`);
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Optional host вернул некорректную страницу данных");
  return result;
}

export async function loadOptionalHostSnapshotPage({
  after = "",
  limit = OPTIONAL_HOST_SNAPSHOT_PAGE_SIZE,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  const cursor = typeof after === "string" ? after : "";
  if (cursor.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Курсор или размер страницы SQLite-снимков некорректен");
  }
  const query = new globalThis.URLSearchParams({ limit: String(limit), ...(cursor ? { after: cursor } : {}) });
  const result = await getOptionalHostJson(`/api/snapshots?${query}`, { locationLike, fetchImpl });
  if (!Array.isArray(result.snapshots) || !Number.isSafeInteger(result.total) || result.total < 0
    || !(result.nextCursor === null || typeof result.nextCursor === "string")) {
    throw new Error("Optional host вернул некорректный список снимков");
  }
  for (const snapshot of result.snapshots) {
    if (!snapshot || typeof snapshot.id !== "string" || typeof snapshot.name !== "string"
      || !Number.isSafeInteger(snapshot.deviceCount) || snapshot.deviceCount < 0 || typeof snapshot.createdAt !== "string") {
      throw new Error("Optional host вернул некорректные метаданные снимка");
    }
  }
  return result;
}

export async function loadOptionalHostSnapshotDevicePage(snapshotId, {
  after = 0,
  limit = OPTIONAL_HOST_SNAPSHOT_PAGE_SIZE,
  locationLike = globalThis.location,
  fetchImpl = null,
} = {}) {
  const id = typeof snapshotId === "string" ? snapshotId.trim() : "";
  if (!id || id.length > 200 || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Идентификатор снимка или курсор устройств некорректен");
  }
  const query = new globalThis.URLSearchParams({ limit: String(limit), after: String(after) });
  const result = await getOptionalHostJson(`/api/snapshots/${encodeURIComponent(id)}/devices?${query}`, { locationLike, fetchImpl });
  if (result.snapshotId !== id || !Number.isSafeInteger(result.deviceCount) || result.deviceCount < 0
    || !Array.isArray(result.devices) || !(result.nextCursor === null || (Number.isSafeInteger(result.nextCursor) && result.nextCursor >= 0))
    || result.devices.some((device) => !device || typeof device !== "object" || Array.isArray(device))) {
    throw new Error("Optional host вернул некорректную страницу устройств");
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

export async function uploadFinalSnapshotToOptionalHost(metadata, devices, {
  locationLike = globalThis.location,
  fetchImpl = null,
  ReadableStreamImpl = globalThis.ReadableStream,
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
  if (typeof ReadableStreamImpl !== "function" || typeof TextEncoderImpl !== "function") {
    throw new Error("Потоковая передача Final не поддерживается этим браузером");
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
  const body = new ReadableStreamImpl({
    async pull(controller) {
      try {
        const next = await records.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) { await records.return(reason); },
  });
  let response;
  try {
    response = await request(`/api/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      duplex: "half",
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Не удалось потоково передать Final локальному optional host");
  }
  if (!response?.ok) throw new Error(`Optional host не сохранил Final (HTTP ${Number(response?.status) || 0}); существующий снимок не заменяется`);
  const result = await response.json().catch(() => null);
  if (result?.snapshotId !== snapshotId || result.deviceCount !== deviceCount || !/^[\da-f]{64}$/i.test(String(result?.signature || ""))) {
    throw new Error("Optional host не подтвердил целостность скопированного Final");
  }
  return result;
}
