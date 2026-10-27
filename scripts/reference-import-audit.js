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
    const mapped = readCount(imported, collection);
    const restored = readCount(restoreCounts, collection);
    // Inventory IDs are stable keys. The SQLite importer merges repeated
    // observations with the same ID into one restored catalogue row.
    if (collection === "inventory") {
      return {
        collection,
        expected: mapped,
        restored,
        transformation: "duplicate stable IDs merged",
        merged: Number.isSafeInteger(mapped) && Number.isSafeInteger(restored) ? mapped - restored : Number.NaN,
        passed: Number.isSafeInteger(mapped) && Number.isSafeInteger(restored) && restored <= mapped,
      };
    }
    // IP mappings are represented in the settings collection as one normalized
    // setting; they have a separate mapper counter and are not included in the
    // generic imported.settings total.
    const expected = collection === "settings"
      ? mapped + readCount(imported, "ipAddressMappings")
      : mapped;
    return { collection, expected, restored, passed: Number.isSafeInteger(expected) && expected === restored };
  });
  return {
    exactRestoreChecks,
    mappedRecordChecks,
    passed: exactRestoreChecks.every(({ passed }) => passed) && mappedRecordChecks.every(({ passed }) => passed),
  };
}
