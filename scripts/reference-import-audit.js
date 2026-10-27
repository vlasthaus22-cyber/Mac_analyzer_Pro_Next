const EXACT_RESTORE_COLLECTIONS = Object.freeze([
  "snapshots",
  "inventory",
  "history",
  "legacyObservations",
  "settings",
  "oui",
  "mac5Models",
  "dataQualityReports",
  "legacySmartroomRoomMappings",
]);
const MAPPED_RECORD_COLLECTIONS = EXACT_RESTORE_COLLECTIONS;
const LEGACY_SETTING_KEY_PREFIXES = Object.freeze([
  "legacyAppSetting:",
  "legacyAutosave:",
  "legacyColumnPreferences:",
  "legacyPerformanceMetric:",
]);

export function isImportedSQLiteSettingKey(key) {
  const value = String(key ?? "");
  return value === "ipAddressMappings" || LEGACY_SETTING_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function readCount(source, key) {
  const value = source instanceof Map ? source.get(key) : source?.[key];
  if (value === undefined || value === null) return 0;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : Number.NaN;
}

export function inspectReferenceImportAuditCounts({ restoreCounts, storeCounts, imported, migratedSettingCount } = {}) {
  const exactRestoreChecks = EXACT_RESTORE_COLLECTIONS.map((collection) => {
    const expected = readCount(restoreCounts, collection);
    const actual = collection === "settings" ? readCount({ settings: migratedSettingCount }, collection) : readCount(storeCounts, collection);
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
