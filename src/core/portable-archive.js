export const PORTABLE_ARCHIVE_RECORD_COLLECTIONS = Object.freeze([
  "inventory",
  "history",
  "settings",
  "knownModels",
  "oui",
  "switchAddressEvidence",
  "mac5Models",
  "smartroomRoomMappings",
  "singleAnalyses",
  "singleAnalysisChunks",
  "legacyObservations",
  "dataQualityReports",
  "legacySmartroomRoomMappings",
]);

export function selectArchiveSnapshotIds(snapshots, archivedIds, { from = "", to = "" } = {}) {
  if (from && to && from > to) throw new Error("Начальная дата позже конечной");
  const start = from ? Date.parse(`${from}T00:00:00`) : -Infinity;
  const end = to ? Date.parse(`${to}T23:59:59.999`) : Infinity;
  return snapshots.filter((snapshot) => {
    if (archivedIds.has(snapshot.id)) return false;
    if (!from && !to) return true;
    const date = Date.parse(snapshot.createdAt);
    return date >= start && date <= end;
  }).map(({ id }) => id);
}
