const SOURCE_ROLES = Object.freeze(["main", "smartroom", "ddio"]);

export async function prepareOriginalSourceRecovery(snapshotId, {
  database,
  readTable,
  createFile = (record) => new globalThis.File([record.blob], record.name, {
    type: record.type || "application/octet-stream",
    lastModified: Number(record.lastModified) || 0,
  }),
  isAuthorized = () => true,
  onProgress = () => {},
} = {}) {
  if (!snapshotId) throw new Error("Не выбран Final для восстановления исходных файлов");
  if (!database?.listOriginalFiles || !database?.getOriginalFile || typeof readTable !== "function") {
    throw new TypeError("Не настроено восстановление исходных файлов");
  }
  if (!isAuthorized()) throw new Error("Восстановление файлов доступно только в активном инженерном сеансе");

  const metadata = await database.listOriginalFiles(snapshotId);
  const availableRoles = new Set((Array.isArray(metadata) ? metadata : [])
    .map(({ role }) => role)
    .filter((role) => SOURCE_ROLES.includes(role)));
  const roles = SOURCE_ROLES.filter((role) => availableRoles.has(role));
  if (!roles.length) throw new Error("Для выбранного Final исходные файлы не сохранены");

  const prepared = [];
  for (const role of roles) {
    if (!isAuthorized()) throw new Error("Инженерный сеанс завершился до восстановления файлов");
    const record = await database.getOriginalFile(snapshotId, role);
    if (!record?.blob || !Number.isSafeInteger(Number(record.size)) || Number(record.size) !== Number(record.blob.size)) {
      throw new Error(`Не удалось проверить сохранённый исходный файл ${role.toUpperCase()}`);
    }
    const file = createFile(record, role);
    if (!file || Number(file.size) !== Number(record.size)) {
      throw new Error(`Не удалось восстановить файл ${role.toUpperCase()} без изменения размера`);
    }
    const table = await readTable(file, role);
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
      throw new Error(`Не удалось прочитать сохранённый файл ${role.toUpperCase()}`);
    }
    if (!isAuthorized()) throw new Error("Инженерный сеанс завершился до восстановления файлов");
    prepared.push({ role, file, table });
    onProgress({ role, index: prepared.length, total: roles.length });
  }
  return prepared;
}
