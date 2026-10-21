export const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

export function isAutoSaveDue(lastAttemptAt, now = Date.now(), interval = AUTO_SAVE_INTERVAL_MS) {
  if (lastAttemptAt === null || lastAttemptAt === undefined || lastAttemptAt === "") return false;
  const previous = Number(lastAttemptAt);
  const current = Number(now);
  const delay = Number(interval);
  return Number.isFinite(previous) && Number.isFinite(current) && Number.isFinite(delay)
    && delay > 0 && current >= previous + delay;
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

export function autoSaveXlsxFilename(date = new Date(), uniqueToken = "") {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("Для имени autosave нужна корректная дата");
  const token = String(uniqueToken).toLowerCase();
  if (!/^[a-z0-9]{4,32}$/.test(token)) throw new TypeError("Для autosave нужен уникальный безопасный суффикс");
  const timestamp = `${date.getFullYear()}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}_${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}_${String(date.getMilliseconds()).padStart(3, "0")}`;
  return `autosave_${timestamp}_${token}.xlsx`;
}
