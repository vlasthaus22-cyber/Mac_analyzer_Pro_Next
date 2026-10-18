const COMPLETED_STATUS = /^(?:Полностью|Выполнено)(?::|\s)/;

export function inspectReleaseReadiness(rows = []) {
  const pending = rows.filter((row) => !COMPLETED_STATUS.test(String(row?.status || "")));
  return { ready: rows.length > 0 && pending.length === 0, total: rows.length, pending };
}
