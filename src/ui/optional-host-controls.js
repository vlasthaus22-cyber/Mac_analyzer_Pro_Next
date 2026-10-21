const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES = 512 * 1024 * 1024;
export const MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_OPTIONAL_HOST_HISTORY_BATCH_EVENTS = 500;
const MAX_OPTIONAL_HOST_HISTORY_REQUEST_BYTES = 900 * 1024;
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
