export const BATCH_DIRECTORY_ROLES = Object.freeze(["main", "smartroom", "ddio"]);
const BATCH_FILE_EXTENSION = /\.(?:csv|tsv|txt|json|xlsx|xlsm|xls)$/i;
const batchDirectoryFilePaths = new WeakMap();

export function batchDirectoryFileRelativePath(file) {
  return batchDirectoryFilePaths.get(file) || "";
}

export function batchSourceFileRelativePath(file) {
  return String(file?.webkitRelativePath || batchDirectoryFileRelativePath(file) || file?.name || "");
}

export function batchDirectoryHandleKey(role) {
  if (!BATCH_DIRECTORY_ROLES.includes(role)) throw new TypeError("Неизвестная роль папки массового объединения");
  return `workspace-batch-directory:${role}`;
}

export function createBatchDirectoryHandleRecord(role, handle, savedAt = new Date().toISOString()) {
  if (!handle || handle.kind !== "directory") throw new TypeError("Для массового объединения нужен дескриптор папки браузера");
  return {
    key: batchDirectoryHandleKey(role),
    role,
    handle,
    name: String(handle.name || "Выбранная папка").slice(0, 255),
    savedAt: String(savedAt),
  };
}

function assertDirectoryHandle(handle) {
  if (!handle || handle.kind !== "directory" || typeof handle.entries !== "function") {
    throw new TypeError("Для массового объединения нужен дескриптор папки браузера");
  }
  return handle;
}

export async function inspectBatchDirectoryHandle(record) {
  const handle = record?.handle;
  if (!handle || handle.kind !== "directory" || typeof handle.entries !== "function") {
    return { permission: "unavailable", handle: null, error: "Дескриптор папки недоступен" };
  }
  let permission = "unavailable";
  try {
    if (typeof handle.queryPermission === "function") permission = await handle.queryPermission({ mode: "read" });
  } catch {
    permission = "unavailable";
  }
  if (permission !== "granted") return { permission, handle: null, error: "Браузеру нужно разрешить чтение папки" };
  return { permission, handle, error: "" };
}

export async function requestBatchDirectoryPermission(handle) {
  if (!handle || handle.kind !== "directory") return "unavailable";
  try {
    if (typeof handle.requestPermission === "function") return await handle.requestPermission({ mode: "read" });
    if (typeof handle.queryPermission === "function") return await handle.queryPermission({ mode: "read" });
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

export async function listBatchDirectoryFiles(handle) {
  assertDirectoryHandle(handle);
  const pending = [{ handle, path: String(handle.name || "") }];
  const files = [];
  while (pending.length) {
    const current = pending.pop();
    const entries = [];
    for await (const [name, entry] of current.handle.entries()) entries.push([String(name), entry]);
    entries.sort(([left], [right]) => left.localeCompare(right, "en"));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [name, entry] = entries[index];
      const path = current.path ? `${current.path}/${name}` : name;
      if (entry.kind === "directory") {
        pending.push({ handle: entry, path });
      } else if (entry.kind === "file" && BATCH_FILE_EXTENSION.test(name)) {
        const file = await entry.getFile();
        files.push({ path, file });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const { file, path } of files) batchDirectoryFilePaths.set(file, path);
  return files.map(({ file }) => file);
}
