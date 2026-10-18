import { addCustomInventoryColumn, customInventoryColumnKey, defaultInventoryColumnConfig, inventoryColumnConfigFromLegacyPreferences, normalizeInventoryColumnConfig } from "./inventory-columns.js";
import { legacyThemeChoice } from "./theme.js";
import { DEFAULT_VENDOR_DETECTOR_SETTINGS, legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "./vendor-detector.js";
import { normalizeEnrichmentFieldSettings } from "./enrichment-settings.js";
import { normalizeOuiFormats } from "./oui-formats.js";
import { normalizeSourceMappingPreferences, rememberSourceMapping, SOURCE_MAPPING_ROLES } from "./source-mapping-preferences.js";
import { legacyAnalyticsDashboardSettings } from "./analytics-dashboard-settings.js";
import { normalizeIpMappings } from "./ip-mapping.js";
import { normalizeDashboardFilters } from "./dashboard-filter.js";

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
  let customCount = 0;
  for (const raw of Array.isArray(customValue) ? customValue : []) {
    if (customCount >= 512) break;
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
    customCount += 1;
  }

  if (!Array.isArray(visibleValue)) return customLabels.size ? config : null;
  const orderedKeys = [];
  for (const raw of visibleValue.slice(0, 512)) {
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

function legacyCustomColumnDefinitions(source, baseConfig) {
  const result = new Map();
  let config = baseConfig || defaultInventoryColumnConfig();
  const labels = object(source.customColumnLabels) || object(source.customLabels) || {};
  const rawCustomColumns = Array.isArray(source.customColumns) ? source.customColumns : [];
  for (let index = 0; index < rawCustomColumns.length && index < 512; index += 1) {
    const raw = rawCustomColumns[index];
    const oldKey = typeof raw === "string" ? raw.trim().slice(0, 80) : String(raw?.key || "").trim().slice(0, 80);
    if (!/^custom_[\p{L}\p{N}_-]{1,64}$/iu.test(oldKey)) continue;
    if (/^custom_[0-9a-f-]{36}$/i.test(oldKey)) {
      result.set(oldKey, oldKey);
      continue;
    }
    const suppliedLabel = typeof labels[oldKey] === "string" ? labels[oldKey] : typeof raw?.title === "string" ? raw.title : "";
    const label = (suppliedLabel || oldKey.slice("custom_".length).replace(/[_-]+/gu, " "))
      .trim().slice(0, 60).replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("ru-RU"));
    if (!label) continue;
    const key = customInventoryColumnKey(label);
    result.set(oldKey, key);
    if (!config.columns.some((column) => column.key === key)) config = addCustomInventoryColumn(config, label);
  }
  return { config: normalizeInventoryColumnConfig(config), keyMap: result };
}

function preserveLegacyColumnLayout(config, source, customKeyMap) {
  if (!Array.isArray(source.columnOrder)) return config;
  const legacyToNext = new Map([
    ["vendor", "manufacturer"], ["serialNumber", "serial"],
    ...(Number.isInteger(Number(source.ouiLength)) && Number(source.ouiLength) >= 3 && Number(source.ouiLength) <= 6
      ? [["oui", `oui${Number(source.ouiLength)}`]] : []),
  ]);
  const mapKey = (raw) => customKeyMap.get(String(raw)) || legacyToNext.get(String(raw)) || String(raw);
  const byKey = new Map(config.columns.map((column) => [column.key, column]));
  const order = [];
  for (const legacyKey of source.columnOrder.slice(0, 512)) {
    const key = mapKey(legacyKey);
    if (byKey.has(key) && !order.includes(key)) order.push(key);
  }
  if (byKey.has("rowNumber") && !order.includes("rowNumber")) order.unshift("rowNumber");
  const completeOrder = [...order, ...config.columns.map(({ key }) => key).filter((key) => !order.includes(key))];
  const visible = Array.isArray(source.visibleColumns) ? new Set(source.visibleColumns.slice(0, 512).map(mapKey)) : null;
  const widths = object(source.columnWidths) || {};
  const oldKeyFor = new Map();
  for (const legacyKey of source.columnOrder.slice(0, 512)) if (!oldKeyFor.has(mapKey(legacyKey))) oldKeyFor.set(mapKey(legacyKey), legacyKey);
  return normalizeInventoryColumnConfig({
    columns: completeOrder.map((key) => {
      const column = byKey.get(key);
      const legacyKey = oldKeyFor.get(key);
      const legacyWidth = legacyKey ? widths[legacyKey] : undefined;
      return {
        ...column,
        ...(visible ? { visible: key === "rowNumber" ? true : visible.has(key) } : {}),
        ...(legacyWidth !== undefined ? { width: legacyWidth } : {}),
      };
    }),
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

export function normalizeLegacyAutosaveSettings(value) {
  const source = object(value);
  if (!source) throw new TypeError("Автосохранение MAC Analyzer Pro должно содержать JSON-объект");
  const settings = {};
  const applied = [];
  const theme = legacyThemeChoice(source.theme);
  if (theme) { settings.theme = theme; applied.push("theme"); }
  const strategy = source.enrichmentStrategy || ({ add_new_rows: "ALLOW_EXPANSION", keep_primary_only: "NO_EXPANSION", keep_only: "NO_EXPANSION" })[source.last_strategy];
  if (["ALLOW_EXPANSION", "NO_EXPANSION"].includes(strategy)) {
    settings.enrichmentStrategy = strategy;
    applied.push("enrichmentStrategy");
  }
  const detectorSource = object(source.vendorDetectorSettings) || object(source.vendor_detector_settings);
  const historySource = object(source.historyEnrichmentSettings) || object(source.history_enricher_settings);
  if (detectorSource || historySource) {
    settings.vendorDetectorSettings = detectorSource
      ? normalizeVendorDetectorSettings(detectorSource)
      : mergedDetectorSettings({ vendor_detector_settings: null, history_enricher_settings: historySource });
    if (historySource && detectorSource) {
      settings.vendorDetectorSettings = normalizeVendorDetectorSettings({
        ...settings.vendorDetectorSettings,
        enabled: settings.vendorDetectorSettings.enabled && historySource.enabled !== false,
        useOui3: historySource.useOuiMatch ?? historySource.use_oui_match ?? settings.vendorDetectorSettings.useOui3,
        useMac5: historySource.useMac5Match ?? historySource.use_mac5_match ?? settings.vendorDetectorSettings.useMac5,
      });
    }
    applied.push("vendorDetectorSettings/historyEnrichmentSettings");
  }
  const fields = object(source.enrichmentFieldSettings) || object(source.enrich_fields);
  if (fields) {
    settings.enrichmentFieldSettings = normalizeEnrichmentFieldSettings(fields);
    applied.push("enrichmentFieldSettings");
  }
  const formats = object(source.ouiFormats) || object(source.oui_formats);
  if (formats) {
    settings.ouiFormats = normalizeOuiFormats(formats);
    applied.push("ouiFormats");
  }
  const columnConfig = object(source.inventoryColumnConfig);
  const nativeColumnOrder = Array.isArray(source.columnOrder) ? source.columnOrder : source.visibleColumns;
  const nativeColumnConfig = Array.isArray(nativeColumnOrder)
    ? inventoryColumnConfigFromLegacyPreferences({
      order: nativeColumnOrder.slice(0, 512),
      visible: Array.isArray(source.visibleColumns) ? source.visibleColumns.slice(0, 512) : nativeColumnOrder.slice(0, 512),
      widths: source.columnWidths,
    })
    : null;
  const migratedColumnConfig = columnConfig
    ? normalizeInventoryColumnConfig({ ...columnConfig, columns: Array.isArray(columnConfig.columns) ? columnConfig.columns.slice(0, 512) : [] })
    : nativeColumnConfig || legacyColumnConfig(source.visible_columns, source.custom_columns)
      || (Array.isArray(source.customColumns) && source.customColumns.length ? defaultInventoryColumnConfig() : null);
  if (migratedColumnConfig) {
    const customColumns = legacyCustomColumnDefinitions(source, migratedColumnConfig);
    settings.inventoryColumnConfig = preserveLegacyColumnLayout(customColumns.config, source, customColumns.keyMap);
    applied.push("inventoryColumnConfig");
  }
  const dashboardSettings = object(source.dashboardSettings);
  if (dashboardSettings) {
    const mappedDashboard = legacyAnalyticsDashboardSettings(dashboardSettings);
    settings.analyticsDashboardSettings = {
      ...mappedDashboard,
      filters: normalizeDashboardFilters({
        query: dashboardSettings.query,
        manufacturer: dashboardSettings.vendor,
        room: dashboardSettings.room,
        status: dashboardSettings.status,
      }),
    };
    applied.push("dashboardSettings");
  }
  const ipAddressMappings = normalizeIpMappings(source.ipMappings);
  if (ipAddressMappings.length) {
    settings.ipAddressMappings = ipAddressMappings;
    applied.push("ipMappings");
  }
  let mappingPreferences = normalizeSourceMappingPreferences(source.sourceMappingPreferences || {});
  const legacyCustomColumns = legacyCustomColumnDefinitions(source, settings.inventoryColumnConfig);
  const remember = (role, candidate) => {
    if (!candidate || !Array.isArray(candidate.headers) || !candidate.headers.length || candidate.headers.length > 512 || !candidate.mapping) return;
    const headers = candidate.headers.map((header) => typeof header === "string" || typeof header === "number"
      ? header
      : header && typeof header === "object" && !Array.isArray(header)
        ? header.name ?? header.label ?? header.title ?? header.value ?? ""
        : "");
    const mapping = {};
    let mappingCount = 0;
    for (const field in candidate.mapping) {
      if (!Object.hasOwn(candidate.mapping, field)) continue;
      mapping[field] = candidate.mapping[field];
      mappingCount += 1;
      if (mappingCount >= 512) break;
    }
    for (const [oldKey, nextKey] of legacyCustomColumns.keyMap) {
      if (oldKey !== nextKey && Object.hasOwn(mapping, oldKey)) {
        mapping[nextKey] = mapping[oldKey];
        delete mapping[oldKey];
      }
    }
    const preference = rememberSourceMapping(headers, mapping);
    if (preference) mappingPreferences[role] = [...mappingPreferences[role].filter((entry) => entry.headers.join("\u0000") !== preference.headers.join("\u0000")), preference].slice(-8);
  };
  for (const file of Array.isArray(source.files) ? source.files : []) {
    const role = ["smartroom", "smart-room", "sr", "enrichment", "secondary"].includes(String(file?.role || "").toLowerCase()) ? "smartroom" : "main";
    const mapping = { ...(file.mapping || {}) };
    if (String(file.id || "") === String(source.activeMappingFileId || "")) {
      const legacyMappings = object(source.customColumnMappings) || {};
      let mappingCount = 0;
      for (const oldKey in legacyMappings) {
        if (!Object.hasOwn(legacyMappings, oldKey)) continue;
        const rawIndex = legacyMappings[oldKey];
        const nextKey = legacyCustomColumns.keyMap.get(oldKey);
        const index = Number(rawIndex);
        if (nextKey && Number.isInteger(index) && index >= 0 && index < file.headers?.length) mapping[nextKey] = index;
        mappingCount += 1;
        if (mappingCount >= 512) break;
      }
    }
    remember(role, { ...file, mapping });
  }
  remember("ddio", source.ddioFile);
  if (SOURCE_MAPPING_ROLES.some((role) => mappingPreferences[role].length)) {
    settings.sourceMappingPreferences = mappingPreferences;
    applied.push("sourceMappingPreferences");
  }
  if (!applied.length) throw new Error("В автосохранении нет совместимых локальных настроек для восстановления");
  return { settings, applied };
}
