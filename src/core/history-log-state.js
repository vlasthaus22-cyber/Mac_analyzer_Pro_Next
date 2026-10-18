export function historyLogNeedsRefresh(historyLog = {}, dataRevision = 0) {
  return !historyLog.initialized
    || !historyLog.loaded
    || historyLog.loadedRevision !== dataRevision;
}
