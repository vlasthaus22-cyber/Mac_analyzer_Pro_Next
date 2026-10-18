import { addCustomInventoryColumn, defaultInventoryColumnConfig, normalizeInventoryColumnConfig } from "./inventory-columns.js";
import { legacyThemeChoice } from "./theme.js";
import { DEFAULT_VENDOR_DETECTOR_SETTINGS, legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "./vendor-detector.js";
import { normalizeEnrichmentFieldSettings } from "./enrichment-settings.js";
import { normalizeOuiFormats } from "./oui-formats.js";

export const LEGACY_PYQT_SETTINGS_MAX_BYTES = 1024 * 1024;

const COLUMN_KEYS = Object.freeze({
  "№": "rowNumber", "MAC": "mac", "MAC (форматированный)": "macFormatted",
  "OUI (3 байта)": "oui3", "OUI (4 байта)": "oui4", "OUI (5 байт)": "oui5", "OUI (6 байт)": "oui6",
  "Производитель": "manufacturer", "Модель": "model", "IP-адрес": "ip",
  "Физический адрес": "address", "Адрес": "address", "Помещение": "room",
  "IP коммутатора": "switchIp", "Порт подключения": "switchPort", "Примечание": "matchDetails",
  "Дата добавления": "addedAt", "Тип устройства": "deviceType", "Hostname": "hostname", "Серийный номер": "serial",
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function legacyColumnConfig(visibleValue, customValue) {
  let config = defaultInventoryColumnConfig();
  const customKeys = new Map();
  const customLabels = new Set();
  for (const raw of Array.isArray(customValue) ? customValue : []) {
    if (typeof raw !== "string") continue;
    const original = raw.trim().slice(0, 100);
    const label = original.replace(/^\[Пользовательская\]\s*/u, "").trim().slice(0, 60);
    const normalizedLabel = label.toLocaleLowerCase("ru-RU");
    if (!label || customLabels.has(normalizedLabel)) continue;
    config = addCustomInventoryColumn(config, label);
    const column = config.columns.at(-1);
    column.visible = false;
    const prefixedName = `[Пользовательская] ${label}`;
    customKeys.set(prefixedName.toLocaleLowerCase("ru-RU"), column.key);
    customKeys.set(label.toLocaleLowerCase("ru-RU"), column.key);
    customLabels.add(normalizedLabel);
  }

  if (!Array.isArray(visibleValue)) return customLabels.size ? config : null;
  const orderedKeys = [];
  for (const raw of visibleValue) {
    const label = String(raw || "").trim();
    const customKey = customKeys.get(label.toLocaleLowerCase("ru-RU"));
    const key = customKey || COLUMN_KEYS[label];
    if (key && !orderedKeys.includes(key)) orderedKeys.push(key);
  }
  if (!orderedKeys.length) return customLabels.size ? config : null;
  if (!orderedKeys.includes("rowNumber")) orderedKeys.unshift("rowNumber");

  const byKey = new Map(config.columns.map((column) => [column.key, column]));
  const visible = orderedKeys.map((key) => ({ ...byKey.get(key), visible: true }));
  const hidden = config.columns.filter(({ key }) => !orderedKeys.includes(key)).map((column) => ({ ...column, visible: false }));
  return normalizeInventoryColumnConfig({ columns: [...visible, ...hidden] });
}

function mergedDetectorSettings(source) {
  const detector = legacyVendorDetectorSettings(source.vendor_detector_settings) || { ...DEFAULT_VENDOR_DETECTOR_SETTINGS };
  const history = object(source.history_enricher_settings);
  if (!history) return detector;
  return normalizeVendorDetectorSettings({
    ...detector,
    enabled: history.enabled === undefined ? detector.enabled : detector.enabled && Boolean(history.enabled),
    useOui3: history.use_oui_match === undefined ? detector.useOui3 : Boolean(history.use_oui_match),
    useMac5: history.use_mac5_match === undefined ? detector.useMac5 : Boolean(history.use_mac5_match),
  });
}

export function normalizeLegacyPyQtSettings(value) {
  const source = object(value);
  if (!source) throw new TypeError("Файл настроек PyQt должен содержать JSON-объект");
  const settings = {};
  const applied = [];
  const theme = legacyThemeChoice(source.theme);
  if (theme) { settings.theme = theme; applied.push("theme"); }
  if (source.last_strategy === "add_new_rows") {
    settings.enrichmentStrategy = "ALLOW_EXPANSION";
    applied.push("last_strategy");
  } else if (["keep_primary_only", "keep_only"].includes(source.last_strategy)) {
    settings.enrichmentStrategy = "NO_EXPANSION";
    applied.push("last_strategy");
  }
  if (object(source.vendor_detector_settings) || object(source.history_enricher_settings)) {
    settings.vendorDetectorSettings = mergedDetectorSettings(source);
    applied.push("vendor_detector_settings/history_enricher_settings");
  }
  if (object(source.enrich_fields)) {
    settings.enrichmentFieldSettings = normalizeEnrichmentFieldSettings(source.enrich_fields);
    applied.push("enrich_fields");
  }
  if (object(source.oui_formats)) {
    settings.ouiFormats = normalizeOuiFormats(source.oui_formats);
    applied.push("oui_formats");
  }
  const inventoryColumnConfig = legacyColumnConfig(source.visible_columns, source.custom_columns);
  if (inventoryColumnConfig) {
    settings.inventoryColumnConfig = inventoryColumnConfig;
    if (Array.isArray(source.visible_columns) && source.visible_columns.length) applied.push("visible_columns");
    if (inventoryColumnConfig.columns.some(({ custom }) => custom)) applied.push("custom_columns");
  }
  if (!applied.length) throw new Error("В файле нет совместимых настроек PyQt для переноса");
  const appliedKeys = new Set(applied.flatMap((key) => key.split("/")));
  const ignored = Object.keys(source).filter((key) => !["version"].includes(key) && !appliedKeys.has(key));
  return { settings, applied, ignored };
}
