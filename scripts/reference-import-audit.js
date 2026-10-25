const EXACT_RESTORE_COLLECTIONS = Object.freeze([
  "snapshots",
  "inventory",
  "history",
  "legacyObservations",
  "oui",
  "mac5Models",
]);
const MAPPED_RECORD_COLLECTIONS = Object.freeze(["history", "legacyObservations"]);

function readCount(source, key) {
  const value = source instanceof Map ? source.get(key) : source?.[key];
  if (value === undefined || value === null) return 0;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : Number.NaN;
}

export function inspectReferenceImportAuditCounts({ restoreCounts, storeCounts, imported } = {}) {
  const exactRestoreChecks = EXACT_RESTORE_COLLECTIONS.map((collection) => {
    const expected = readCount(restoreCounts, collection);
    const actual = readCount(storeCounts, collection);
    return { collection, expected, actual, passed: Number.isSafeInteger(expected) && expected === actual };
  });
  const mappedRecordChecks = MAPPED_RECORD_COLLECTIONS.map((collection) => {
    const expected = readCount(imported, collection);
    const restored = readCount(restoreCounts, collection);
    return { collection, expected, restored, passed: Number.isSafeInteger(expected) && expected === restored };
  });
  return {
    exactRestoreChecks,
    mappedRecordChecks,
    passed: exactRestoreChecks.every(({ passed }) => passed) && mappedRecordChecks.every(({ passed }) => passed),
  };
}
