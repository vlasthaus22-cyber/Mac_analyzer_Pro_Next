export function historyLogNeedsRefresh(historyLog = {}, dataRevision = 0) {
  return !historyLog.initialized
    || !historyLog.loaded
    || historyLog.loadedRevision !== dataRevision;
}

export function defaultHistoryLogFilters(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { from: localDate(start), fromTime: "00:00:00", to: localDate(now), toTime: "23:59:59" };
}
