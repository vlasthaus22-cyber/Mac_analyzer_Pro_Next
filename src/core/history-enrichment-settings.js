export const DEFAULT_HISTORY_ENRICHMENT_SETTINGS = Object.freeze({
  enabled: true,
  priorityHistory: true,
  useOuiMatch: true,
  useMac5Match: true,
});

export function normalizeHistoryEnrichmentSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_HISTORY_ENRICHMENT_SETTINGS).map(([key, fallback]) => [
    key,
    typeof source[key] === "boolean" ? source[key] : fallback,
  ]));
}

function legacyColumnIndex(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return NaN;
}

export function normalizeLegacyWorkspaceFiles(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 500) throw new TypeError("В архиве слишком много сводок исходных файлов");
  return value.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new TypeError("Некорректная сводка исходного файла");
    const role = String(file.role || "");
    if (!["primary", "smartroom", "ddio", "additional"].includes(role)) throw new TypeError("Некорректная роль исходного файла");
    const rowCount = Number(file.rowCount ?? 0);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new TypeError("Некорректное число строк в сводке файла");
    const mapping = {};
    const entries = Object.entries(file.mapping && typeof file.mapping === "object" && !Array.isArray(file.mapping) ? file.mapping : {});
    if (entries.length > 128) throw new TypeError("В сводке файла слишком много сопоставлений колонок");
    for (const [key, column] of entries) {
      if (column === null || column === "") continue;
      const index = legacyColumnIndex(column);
      if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(key) || !Number.isSafeInteger(index) || index < 0 || index > 16_383) {
        throw new TypeError("Некорректное сопоставление колонок в сводке файла");
      }
      mapping[key] = index;
    }
    return {
      id: String(file.id || "").slice(0, 160),
      name: String(file.name || "").slice(0, 1024),
      role,
      sheet: String(file.sheet || "").slice(0, 1024),
      createdAt: String(file.createdAt || "").slice(0, 80),
      fileDateSource: String(file.fileDateSource || "").slice(0, 80),
      rowCount,
      mapping,
    };
  });
}
