import { addCustomInventoryColumn, customInventoryColumnKey, defaultInventoryColumnConfig, inventoryColumnConfigFromLegacyPreferences, normalizeInventoryColumnConfig } from "./inventory-columns.js";
import { legacyThemeChoice } from "./theme.js";
import { legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "./vendor-detector.js";
import { normalizeEnrichmentFieldSettings } from "./enrichment-settings.js";
import { normalizeComparisonSettings } from "./comparison-settings.js";
import { normalizeHistoryEnrichmentSettings } from "./history-enrichment-settings.js";
import { normalizeOuiFormats } from "./oui-formats.js";
import { normalizeSourceMappingPreferences, rememberSourceMapping, SOURCE_MAPPING_ROLES } from "./source-mapping-preferences.js";
import { legacyAnalyticsDashboardSettings } from "./analytics-dashboard-settings.js";
import { normalizeIpMappings } from "./ip-mapping.js";
import { normalizeDashboardFilters } from "./dashboard-filter.js";
import { normalizeIpEnrichmentSettings } from "./ip-mapping.js";
import { EXTERNAL_VENDOR_PROVIDERS, normalizeExternalVendorSettings } from "./external-vendor-settings.js";

export const LEGACY_PYQT_SETTINGS_MAX_BYTES = 1024 * 1024;

function legacyFileName(alias, path) {
  const pathValue = typeof path === "string" ? path : "";
  const basename = pathValue.split(/[\\/]/).filter(Boolean).at(-1);
  const candidate = basename || String(alias || "").split(/[\\/]/).filter(Boolean).at(-1) || "без имени";
  return candidate.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 1024) || "без имени";
}

function legacyFileId(alias) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(alias || "")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n);
  }
  return `pyqt-settings-${hash.toString(16).padStart(16, "0")}`;
}

function normalizeLegacyPyQtFiles(value) {
  if (value === undefined || value === null) return [];
  const source = object(value);
  if (!source) throw new TypeError("Список файлов в настройках PyQt должен быть объектом");
  const entries = Object.entries(source);
  if (entries.length > 50) throw new TypeError("В настройках PyQt слишком много сохранённых файлов");
  let primaryCount = 0;
  const files = entries.map(([alias, raw]) => {
    const file = object(raw);
    if (!file || typeof file.is_primary !== "boolean") throw new TypeError("Некорректная сводка файла в настройках PyQt");
    if (file.is_primary) primaryCount += 1;
    const rawMapping = file.mapping === undefined || file.mapping === null ? {} : object(file.mapping);
    if (!rawMapping) throw new TypeError("Некорректное сопоставление колонок в настройках PyQt");
    const mappingEntries = Object.entries(rawMapping);
    if (mappingEntries.length > 128) throw new TypeError("В настройках PyQt слишком много сопоставлений колонок");
    const mapping = {};
    for (const [field, column] of mappingEntries) {
      if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(field) || !Number.isSafeInteger(column) || column < 0 || column > 16_383) {
        throw new TypeError("Некорректное сопоставление колонок в настройках PyQt");
      }
      mapping[field] = column;
    }
    return {
      id: legacyFileId(alias),
      name: legacyFileName(alias, file.path),
      role: file.is_primary ? "primary" : "additional",
      sheet: "",
      createdAt: "",
      fileDateSource: "",
      rowCount: 0,
      mapping,
    };
  });
  if (primaryCount > 1) throw new TypeError("В настройках PyQt не может быть больше одного основного файла");
  return files;
}

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

function isEmptyLegacyPyQtCollection(key, value) {
  if (key === "files") return Boolean(object(value) && Object.keys(value).length === 0);
  return ["custom_columns", "visible_columns"].includes(key) && Array.isArray(value) && value.length === 0;
}

function normalizedHistoryEnrichmentSettings(source) {
  return normalizeHistoryEnrichmentSettings({
    enabled: source.enabled,
    priorityHistory: source.priorityHistory ?? source.priority_history,
    useOuiMatch: source.useOuiMatch ?? source.use_oui_match,
    useMac5Match: source.useMac5Match ?? source.use_mac5_match,
  });
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
  const detectorSource = object(source.vendor_detector_settings);
  if (detectorSource) {
    settings.vendorDetectorSettings = legacyVendorDetectorSettings(detectorSource);
    applied.push("vendor_detector_settings");
  }
  const legacyApiSettings = object(source.api_settings);
  if (legacyApiSettings && EXTERNAL_VENDOR_PROVIDERS.includes(String(legacyApiSettings.service || "").trim().toLowerCase())) {
    const provider = String(legacyApiSettings.service || "").trim().toLowerCase();
    settings.externalVendorApiSettings = normalizeExternalVendorSettings({
      enabled: false,
      provider,
    });
    applied.push("api_settings/provider");
  }
  const historySettings = object(source.history_enricher_settings) || object(source.historyEnrichmentSettings);
  if (historySettings) {
    settings.historyEnrichmentSettings = normalizedHistoryEnrichmentSettings(historySettings);
    applied.push(object(source.history_enricher_settings) ? "history_enricher_settings" : "historyEnrichmentSettings");
  }
  const legacyIpSettings = object(source.ip_enrichment_settings);
  const hasLegacyAddressDetection = typeof source.auto_detect_address_by_ip === "boolean";
  if (legacyIpSettings || hasLegacyAddressDetection) {
    settings.ipEnrichmentSettings = normalizeIpEnrichmentSettings({
      ...(legacyIpSettings || {}),
      ...(hasLegacyAddressDetection ? { historicalAddress: source.auto_detect_address_by_ip } : {}),
    });
    if (legacyIpSettings) applied.push("ip_enrichment_settings");
    if (hasLegacyAddressDetection) applied.push("auto_detect_address_by_ip");
  }
  if (object(source.enrich_fields)) {
    settings.enrichmentFieldSettings = normalizeEnrichmentFieldSettings(source.enrich_fields);
    applied.push("enrich_fields");
  }
  const comparisonFields = object(source.comparison_fields);
  if (comparisonFields) {
    settings.comparisonSettings = normalizeComparisonSettings({ fields: comparisonFields, threshold: comparisonFields.threshold ?? source.threshold });
    applied.push("comparison_fields");
    if (source.threshold !== undefined && comparisonFields.threshold === undefined) applied.push("threshold");
  } else if (Number.isFinite(Number(source.threshold))) {
    settings.comparisonSettings = normalizeComparisonSettings({ threshold: source.threshold });
    applied.push("threshold");
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
  const fileSources = normalizeLegacyPyQtFiles(source.files);
  if (fileSources.length) applied.push("files");
  if (!applied.length) throw new Error("В файле нет совместимых настроек PyQt для переноса");
  const appliedKeys = new Set(applied.flatMap((key) => key.split("/")));
  const ignored = Object.keys(source).filter((key) => !["version"].includes(key)
    && !appliedKeys.has(key) && !isEmptyLegacyPyQtCollection(key, source[key]));
  if (legacyApiSettings) {
    const omittedApiFields = Object.keys(legacyApiSettings).filter((key) => key !== "service");
    if (omittedApiFields.length) ignored.push(...omittedApiFields.map((key) => `api_settings.${key}`));
  }
  return { settings, applied, ignored, fileSources };
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
  if (detectorSource) {
    settings.vendorDetectorSettings = source.vendorDetectorSettings
      ? normalizeVendorDetectorSettings(detectorSource)
      : legacyVendorDetectorSettings(detectorSource);
    applied.push("vendorDetectorSettings");
  }
  if (historySource) {
    settings.historyEnrichmentSettings = normalizedHistoryEnrichmentSettings(historySource);
    applied.push("historyEnrichmentSettings");
  }
  const ipSettings = object(source.ipEnrichmentSettings) || object(source.ip_enrichment_settings);
  const hasLegacyAddressDetection = typeof source.auto_detect_address_by_ip === "boolean";
  if (ipSettings || hasLegacyAddressDetection) {
    settings.ipEnrichmentSettings = normalizeIpEnrichmentSettings({
      ...(ipSettings || {}),
      ...(hasLegacyAddressDetection ? { historicalAddress: source.auto_detect_address_by_ip } : {}),
    });
    if (ipSettings) applied.push("ipEnrichmentSettings");
    if (hasLegacyAddressDetection) applied.push("auto_detect_address_by_ip");
  }
  const fields = object(source.enrichmentFieldSettings) || object(source.enrich_fields);
  if (fields) {
    settings.enrichmentFieldSettings = normalizeEnrichmentFieldSettings(fields);
    applied.push("enrichmentFieldSettings");
  }
  const comparisonSettings = object(source.comparisonSettings) || object(source.comparison_fields);
  if (comparisonSettings) {
    settings.comparisonSettings = normalizeComparisonSettings({
      fields: comparisonSettings.fields || comparisonSettings,
      threshold: comparisonSettings.threshold ?? source.threshold,
    });
    applied.push(object(source.comparisonSettings) ? "comparisonSettings" : "comparison_fields");
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
