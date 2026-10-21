export const WORKSPACE_SOURCE_ROLES = Object.freeze(["main", "smartroom", "ddio"]);

export function workspaceSourceHandleKey(role) {
  if (!WORKSPACE_SOURCE_ROLES.includes(role)) throw new TypeError("Неизвестная роль файла рабочей области");
  return `workspace-source:${role}`;
}

export function createWorkspaceSourceHandleRecord(role, handle, file, savedAt = new Date().toISOString()) {
  workspaceSourceHandleKey(role);
  if (!handle || handle.kind !== "file") {
    throw new TypeError("Для сохранения доступа нужен дескриптор файла браузера");
  }
  if (!file || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0
    || !Number.isSafeInteger(Number(file.lastModified || 0)) || Number(file.lastModified || 0) < 0) {
    throw new TypeError("Метаданные сохранённого файла имеют неверный формат");
  }
  return {
    key: workspaceSourceHandleKey(role),
    role,
    handle,
    name: String(file.name || "Без имени").slice(0, 255),
    type: String(file.type || "application/octet-stream").slice(0, 128),
    size: Number(file.size),
    lastModified: Number(file.lastModified || 0),
    savedAt: String(savedAt),
  };
}

export function workspaceSourceFileMatchesRecord(file, record) {
  return Boolean(file && record
    && String(file.name || "Без имени") === String(record.name || "Без имени")
    && Number(file.size) === Number(record.size)
    && Number(file.lastModified || 0) === Number(record.lastModified || 0));
}

export async function inspectWorkspaceSourceHandle(record) {
  const handle = record?.handle;
  if (!handle || handle.kind !== "file" || typeof handle.getFile !== "function") {
    return { permission: "unavailable", file: null, error: "Дескриптор исходного файла недоступен" };
  }
  let permission = "unavailable";
  try {
    if (typeof handle.queryPermission === "function") permission = await handle.queryPermission({ mode: "read" });
  } catch {
    permission = "unavailable";
  }
  if (permission !== "granted") return { permission, file: null, error: "Браузеру нужно разрешить доступ к исходному файлу" };
  try {
    return { permission, file: await handle.getFile(), error: "" };
  } catch (error) {
    return { permission: "unavailable", file: null, error: error?.message || "Не удалось открыть сохранённый исходный файл" };
  }
}

export async function requestWorkspaceSourcePermission(handle) {
  if (!handle || handle.kind !== "file") return "unavailable";
  try {
    if (typeof handle.requestPermission === "function") return await handle.requestPermission({ mode: "read" });
    if (typeof handle.queryPermission === "function") return await handle.queryPermission({ mode: "read" });
  } catch {
    return "unavailable";
  }
  return "unavailable";
}
