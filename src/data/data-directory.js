export const PORTABLE_ARCHIVE_FILENAME = "mac-analyzer-data.madb";
export const MAX_PORTABLE_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_DIRECTORY_ARCHIVE_BYTES = MAX_PORTABLE_ARCHIVE_BYTES;
const directoryFileWriteQueues = new WeakMap();

function serializeDirectoryFileWrite(handle, fileName, write) {
  let queues = directoryFileWriteQueues.get(handle);
  if (!queues) {
    queues = new Map();
    directoryFileWriteQueues.set(handle, queues);
  }
  const previous = queues.get(fileName) || Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  queues.set(fileName, next);
  return next.finally(() => {
    if (queues.get(fileName) !== next) return;
    queues.delete(fileName);
    if (queues.size === 0) directoryFileWriteQueues.delete(handle);
  });
}

function withDirectoryFileLock(handle, fileName, write) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== "function") return serializeDirectoryFileWrite(handle, fileName, write);
  const lockName = `mac-analyzer-directory-file:${handle.name || "local"}:${fileName}`;
  return locks.request(lockName, () => serializeDirectoryFileWrite(handle, fileName, write));
}

export async function queryDirectoryPermission(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return "unavailable";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    // A persisted handle can become invalid between sessions. Keep startup usable
    // and let the UI offer a fresh folder selection instead of aborting bootstrap.
    return "unavailable";
  }
}

export async function requestDirectoryPermission(handle) {
  if (!handle || typeof handle.requestPermission !== "function") return "unavailable";
  return handle.requestPermission({ mode: "readwrite" });
}

export async function reauthorizeDirectoryHandle(handle, { onPermission, onDenied, onGranted } = {}) {
  const permission = await requestDirectoryPermission(handle);
  await onPermission?.(permission);
  if (permission !== "granted") {
    await onDenied?.(permission);
    return { permission, granted: false };
  }
  await onGranted?.(handle);
  return { permission, granted: true };
}

export async function pickDataDirectory(picker) {
  if (typeof picker !== "function") throw new TypeError("Для выбора папки нужен browser picker");
  try {
    return await picker({ mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  }
}

export async function getDirectoryArchiveFile(handle) {
  let fileHandle;
  try {
    fileHandle = await handle.getFileHandle(PORTABLE_ARCHIVE_FILENAME, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
  const file = await fileHandle.getFile();
  if (file.size > MAX_DIRECTORY_ARCHIVE_BYTES) {
    throw new Error(`Архив папки превышает лимит ${Math.floor(MAX_DIRECTORY_ARCHIVE_BYTES / (1024 * 1024))} МиБ`);
  }
  return file;
}

export async function writeDirectoryArchive(handle, stream, { maxBytes = MAX_DIRECTORY_ARCHIVE_BYTES } = {}) {
  const fileHandle = await handle.getFileHandle(PORTABLE_ARCHIVE_FILENAME, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    let bytesWritten = 0;
    const limited = stream.pipeThrough(new globalThis.TransformStream({
      transform(chunk, controller) {
        bytesWritten += chunk.byteLength;
        if (bytesWritten > maxBytes) throw new Error(`Архив папки превышает лимит ${Math.floor(maxBytes / (1024 * 1024))} МиБ`);
        controller.enqueue(chunk);
      },
    }));
    await limited.pipeTo(writable);
  } catch (error) {
    try { await writable.abort(error); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export async function writeDirectoryFile(handle, fileName, stream, { maxBytes = MAX_DIRECTORY_ARCHIVE_BYTES } = {}) {
  if (!handle || typeof handle.getFileHandle !== "function") throw new TypeError("Для записи нужен разрешённый дескриптор папки");
  const safeName = String(fileName || "");
  if (!/^[a-z0-9_-]+\.xlsx$/i.test(safeName)) throw new TypeError("Недопустимое имя локального XLSX файла");
  if (!stream || typeof stream.pipeThrough !== "function") throw new TypeError("Для записи нужен поток файла");
  return withDirectoryFileLock(handle, safeName, async () => {
    try {
      await handle.getFileHandle(safeName, { create: false });
      throw new Error(`Файл ${safeName} уже существует; перезапись запрещена`);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
    const fileHandle = await handle.getFileHandle(safeName, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
      let bytesWritten = 0;
      const limited = stream.pipeThrough(new globalThis.TransformStream({
        transform(chunk, controller) {
          bytesWritten += chunk.byteLength;
          if (bytesWritten > maxBytes) throw new Error(`Файл превышает лимит ${Math.floor(maxBytes / (1024 * 1024))} МиБ`);
          controller.enqueue(chunk);
        },
      }));
      await limited.pipeTo(writable);
      return { fileName: safeName, bytesWritten };
    } catch (error) {
      try { await writable.abort(error); } catch { /* Preserve the original write error. */ }
      throw error;
    }
  });
}
