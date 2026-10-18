export const FINAL_SNAPSHOT_TYPE = "final";
export const SINGLE_ANALYSIS_SNAPSHOT_TYPE = "single-analysis";

export function resolveSnapshotType(snapshotType, name = "") {
  if (snapshotType === FINAL_SNAPSHOT_TYPE || snapshotType === SINGLE_ANALYSIS_SNAPSHOT_TYPE) return snapshotType;
  if (snapshotType !== undefined && snapshotType !== null && snapshotType !== "") {
    throw new TypeError("Неизвестный тип снимка");
  }
  return /^(?:single\s+file|scheduled\s+task)\s*:/i.test(String(name || "").trim())
    ? SINGLE_ANALYSIS_SNAPSHOT_TYPE
    : FINAL_SNAPSHOT_TYPE;
}

export function isFinalSnapshot(snapshot) {
  return resolveSnapshotType(snapshot?.snapshotType, snapshot?.name) === FINAL_SNAPSHOT_TYPE;
}
