import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEGACY_PYQT_SETTINGS_MAX_BYTES, normalizeLegacyAutosaveSettings, normalizeLegacyPyQtSettings } from "../src/core/legacy-pyqt-settings.js";
import { normalizeMac, normalizeMacField } from "../src/core/normalize.js";
import { historyConfidenceFromOccurrences } from "../src/core/history-confidence.js";

test("imported MAC field conversion matches the PyQt cleaner while identity rejects placeholders", () => {
  const reference = readFileSync("../MAC_ANALYZER финальная.py", "utf8");
  assert.match(reference, /clean = re\.sub\(r'\[\^0-9A-F\]', '', mac_str\)/);
  assert.match(reference, /if len\(clean\) == 10:[\s\S]*?clean = '00' \+ clean[\s\S]*?elif len\(clean\) == 11:[\s\S]*?clean = '0' \+ clean[\s\S]*?elif len\(clean\) == 8:[\s\S]*?clean = '0000' \+ clean/);

  const pyqtNormalize = (value) => {
    const clean = String(value).trim().toUpperCase().replace(/[^0-9A-F]/g, "");
    const padded = clean.length === 8 ? `0000${clean}` : clean.length === 10 ? `00${clean}` : clean.length === 11 ? `0${clean}` : clean;
    return padded.length === 12 ? padded.match(/.{2}/g).join(":") : "";
  };
  for (const value of [
    "AA-BB-CC-DD-EE-FF", "zz00:11:22:33:44:55", "AABBCCDD", "AABBCCDDEE",
    "AABBCCDDEEF", "00000000", "FF-FF-FF-FF-FF-FF", "AABBCCDDD",
  ]) {
    assert.equal(normalizeMacField(value), pyqtNormalize(value), `PyQt import normalization for ${value}`);
  }
  assert.equal(normalizeMac("00000000"), "");
  assert.equal(normalizeMac("FF-FF-FF-FF-FF-FF"), "");
  assert.equal(normalizeMacField("FF-FF-FF-FF-FF-FF"), "FF:FF:FF:FF:FF:FF");
});

test("PyQt comparison_fields and threshold control automatic fuzzy row merges", () => {
  const reference = readFileSync("../MAC_ANALYZER финальная.py", "utf8");
  assert.match(reference, /def _compare_devices\(self, dev1, dev2\):/);
  assert.match(reference, /if self\.comparison_fields\.get\('oui', True\):[\s\S]*?score \+= 100/);
  assert.match(reference, /if self\.comparison_fields\.get\('switch_port', False\):[\s\S]*?score \+= 50/);
  assert.match(reference, /score = self\._compare_devices\(primary, add_dev\)[\s\S]*?if score >= self\.comparison_threshold and score > best_score:[\s\S]*?best_match = add_dev/);
  assert.match(reference, /if best_match:[\s\S]*?enriched = self\._merge_device\(enriched, best_match, "дополнительный файл"\)/);
  assert.match(reference, /'threshold': self\.threshold_slider\.value\(\)/);
});

test("PyQt history priority runs after detection and replaces a result only at higher confidence", () => {
  const reference = readFileSync("../MAC_ANALYZER финальная.py", "utf8");
  assert.match(reference, /confidence = min\(0\.9, 0\.5 \+ min\(row\[1\], 100\) \* 0\.004\)/);
  for (const [occurrences, expected] of [[0, 0.5], [1, 0.504], [10, 0.54], [100, 0.9], [500, 0.9]]) {
    assert.equal(historyConfidenceFromOccurrences(occurrences), expected);
  }
  assert.match(reference, /if self\.priority_history or current_vendor == 'Unknown':[\s\S]*?hist_confidence > device\.get\('vendor_confidence', 0\)/);
  const enrichFast = reference.slice(reference.indexOf("    def enrich_fast(self) -> List[dict]:"));
  assert.ok(enrichFast.indexOf("self.enrich_devices(result)") < enrichFast.indexOf("self.enrich_from_history(result)"));
});

test("PyQt settings migration imports supported local preferences and omits paths and credentials", () => {
  const result = normalizeLegacyPyQtSettings({
    version: "9.5",
    theme: "dark",
    last_strategy: "add_new_rows",
    enrich_fields: { model: false, address: true, ip: false, vendor: true, room: false, switch_ip: true, switch_port: false },
    oui_formats: { 3: true, 4: false, 5: true, 6: false },
    visible_columns: ["MAC", "Модель", "IP-адрес", "MAC (форматированный)", "Неизвестная колонка"],
    vendor_detector_settings: {
      enabled: false, use_oui_3byte: false, use_oui_5byte: true,
      use_text_analysis: false, use_inference: true, confidence_threshold: 0.83,
    },
    history_enricher_settings: {
      enabled: true, priority_history: false, use_oui_match: true, use_mac5_match: false,
    },
    files: { Main: { path: "C:\\private\\main.xlsx", is_primary: true, mapping: { mac: 0 } } },
    api_settings: { api_key: "secret-token", service: "macvendors" },
    ip_address_mapping_file: "C:\\private\\mapping.xlsx",
    auto_detect_address_by_ip: false,
    ip_enrichment_settings: { overwrite: true, partial_match: true },
    comparison_fields: { mac: true },
    threshold: 90,
    engineering_mode: true, window_geometry: "private-geometry", custom_columns: ["Customer field"],
  });

  assert.equal(result.settings.theme, "dark");
  assert.equal(result.settings.enrichmentStrategy, "ALLOW_EXPANSION");
  assert.deepEqual(result.settings.enrichmentFieldSettings, {
    model: false, address: true, ip: false, vendor: true, room: false, switch_ip: true, switch_port: false,
  });
  assert.deepEqual(result.settings.ouiFormats, { 3: true, 4: false, 5: true, 6: false });
  assert.deepEqual(result.settings.vendorDetectorSettings, {
    enabled: false, useOui3: false, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.83,
  });
  assert.deepEqual(result.settings.historyEnrichmentSettings, {
    enabled: true, priorityHistory: false, precedenceProfile: "pyqt", useOuiMatch: true, useMac5Match: false,
  });
  assert.deepEqual(result.settings.ipEnrichmentSettings, { enabled: true, partialMatch: true, overwrite: true, historicalAddress: false });
  const columns = result.settings.inventoryColumnConfig.columns;
  assert.deepEqual(columns.filter((column) => column.visible).map((column) => column.key), ["rowNumber", "mac", "model", "ip", "macFormatted"]);
  assert.ok(columns.some((column) => column.custom && column.label === "Customer field" && !column.visible));
  assert.deepEqual(result.settings.comparisonSettings, {
    fields: { mac: true, oui: true, vendor: false, model: false, ip: false, address: false, room: false, switchIp: false, switchPort: false },
    threshold: 90,
  });
  assert.deepEqual(result.applied, ["theme", "last_strategy", "vendor_detector_settings", "api_settings/provider", "history_enricher_settings", "ip_enrichment_settings", "auto_detect_address_by_ip", "enrich_fields", "comparison_fields", "threshold", "oui_formats", "visible_columns", "custom_columns", "files"]);
  assert.deepEqual(result.settings.externalVendorApiSettings, { enabled: false, provider: "macvendors", rateLimit: 25, cacheTtlDays: 30, onlyUnknown: true });
  assert.ok(["engineering_mode", "ip_address_mapping_file", "window_geometry", "api_settings.api_key"].every((key) => result.ignored.includes(key)));
  assert.deepEqual(result.fileSources, [{
    id: result.fileSources[0].id, name: "main.xlsx", role: "primary", sheet: "", createdAt: "", fileDateSource: "", rowCount: 0,
    mapping: { mac: 0 },
  }]);
  assert.equal(JSON.stringify(result.fileSources).includes("C:\\private"), false);
  assert.equal(Object.hasOwn(result.settings, "comparison_fields"), false);
  assert.equal(Object.hasOwn(result.settings, "threshold"), false);
  assert.equal(JSON.stringify(result.settings).includes("secret-token"), false);
  assert.equal(JSON.stringify(result.settings).includes("C:\\private"), false);
});

test("PyQt result-column migration preserves formatted MAC, OUI, note, date, and visible custom columns", () => {
  const result = normalizeLegacyPyQtSettings({
    visible_columns: ["[Пользовательская] Площадь", "MAC (форматированный)", "OUI (3 байта)", "Примечание", "Дата добавления"],
    custom_columns: ["[Пользовательская] Площадь"],
  });
  const columns = result.settings.inventoryColumnConfig.columns;
  const visible = columns.filter((column) => column.visible);
  assert.equal(visible[0].key, "rowNumber");
  assert.match(visible[1].key, /^custom_/);
  assert.deepEqual(visible.slice(2).map(({ key }) => key), ["macFormatted", "oui3", "matchDetails", "addedAt"]);
  assert.equal(visible[1].custom, true);
  assert.equal(visible[1].label, "Площадь");
  assert.equal(result.applied.includes("custom_columns"), true);
});

test("PyQt settings migration accepts keep-primary mode and reports only equivalent controls", () => {
  const result = normalizeLegacyPyQtSettings({ last_strategy: "keep_primary_only", theme: "light" });
  assert.equal(result.settings.enrichmentStrategy, "NO_EXPANSION");
  assert.equal(result.settings.theme, "light");
  assert.deepEqual(result.ignored, []);
});

test("legacy address auto-detection maps to repeat-confirmed Final history, not single-run rule creation", () => {
  const settings = normalizeLegacyPyQtSettings({ auto_detect_address_by_ip: false });
  assert.deepEqual(settings.settings.ipEnrichmentSettings, {
    enabled: true, partialMatch: true, overwrite: false, historicalAddress: false,
  });
  assert.deepEqual(settings.applied, ["auto_detect_address_by_ip"]);
  assert.deepEqual(settings.ignored, []);
  const autosave = normalizeLegacyAutosaveSettings({ auto_detect_address_by_ip: false });
  assert.equal(autosave.settings.ipEnrichmentSettings.historicalAddress, false);
});

test("PyQt saved source mappings retain only safe file summaries and require an explicit role for extra files", () => {
  const result = normalizeLegacyPyQtSettings({
    files: {
      "Main alias": { path: "C:\\private\\Main.csv", is_primary: true, mapping: { mac: 0, deviceId: 1 } },
      "Extra alias": { path: "D:\\secure\\switch.xlsx", is_primary: false, mapping: { macFormatted: 0, vendor: 2 } },
    },
  });
  assert.equal(result.applied.includes("files"), true);
  assert.deepEqual(result.fileSources.map(({ name, role, mapping }) => ({ name, role, mapping })), [
    { name: "Main.csv", role: "primary", mapping: { mac: 0, deviceId: 1 } },
    { name: "switch.xlsx", role: "additional", mapping: { macFormatted: 0, vendor: 2 } },
  ]);
  assert.equal(JSON.stringify(result.fileSources).includes("C:\\private"), false);
  assert.equal(JSON.stringify(result.fileSources).includes("D:\\secure"), false);
  assert.throws(() => normalizeLegacyPyQtSettings({ files: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`file-${index}`, { is_primary: index === 0, mapping: {} }])) }), /слишком много сохранённых файлов/);
  assert.throws(() => normalizeLegacyPyQtSettings({ files: { Main: { is_primary: true }, Main2: { is_primary: true } } }), /больше одного основного файла/);
  assert.throws(() => normalizeLegacyPyQtSettings({ files: { Main: { is_primary: true, mapping: { mac: "0" } } } }), /Некорректное сопоставление колонок/);
});

test("PyQt settings migration rejects malformed or unsupported-only JSON", () => {
  assert.throws(() => normalizeLegacyPyQtSettings([]), /JSON-объект/);
  assert.throws(() => normalizeLegacyPyQtSettings({ api_settings: { api_key: "secret" } }), /нет совместимых настроек/);
  assert.equal(LEGACY_PYQT_SETTINGS_MAX_BYTES, 1024 * 1024);
});

test("empty PyQt file and column collections are not reported as lost settings", () => {
  const result = normalizeLegacyPyQtSettings({
    theme: "light",
    files: {},
    custom_columns: [],
    visible_columns: [],
  });

  assert.deepEqual(result.applied, ["theme"]);
  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.fileSources, []);
});

test("legacy autosave recovery restores only compatible settings and source mappings", () => {
  const result = normalizeLegacyAutosaveSettings({
    theme: "dark",
    enrichmentStrategy: "ALLOW_EXPANSION",
    vendorDetectorSettings: { enabled: false, useOui3: true, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.7 },
    historyEnrichmentSettings: { enabled: false, priorityHistory: false, useOuiMatch: false, useMac5Match: true },
    ipEnrichmentSettings: { enabled: false, partialMatch: false, overwrite: true },
    enrichmentFieldSettings: { ip: false, room: true },
    comparisonSettings: { fields: { mac: false, vendor: true, model: true }, threshold: 82 },
    ouiFormats: { 3: true, 4: true, 5: false, 6: false },
    visibleColumns: ["MAC", "Модель"],
    customColumns: ["Клиентское поле"],
    dashboardSettings: {
      query: "camera", vendor: "Acme", room: "101", status: "changed", autoRefresh: true,
      visibleCards: { total: false }, visibleCharts: { vendors: false },
    },
    ipMappings: [{ switchIp: "10.0.0.1", address: "Корпус А", source: "PyQt" }],
    files: [{ role: "primary", headers: ["MAC-адрес", "Имя"], mapping: { mac: 0, hostname: 1 } }],
    ddioFile: { headers: ["Calling-Station-ID", "IP-адрес"], mapping: { mac: 0, ip: 1 }, path: "C:\\private\\ddio.xlsx" },
    engineeringToken: "must-not-transfer",
    externalApiSettings: { apiKey: "must-not-transfer" },
  });

  assert.equal(result.settings.theme, "dark");
  assert.equal(result.settings.enrichmentStrategy, "ALLOW_EXPANSION");
  assert.deepEqual(result.settings.comparisonSettings, {
    fields: { mac: false, oui: true, vendor: true, model: true, ip: false, address: false, room: false, switchIp: false, switchPort: false },
    threshold: 82,
  });
  assert.deepEqual(result.settings.analyticsDashboardSettings.filters, {
    query: "camera", manufacturer: "Acme", room: "101", status: "changed",
  });
  assert.equal(result.settings.analyticsDashboardSettings.widgets["kpi:devices"], false);
  assert.equal(result.settings.analyticsDashboardSettings.widgets["chart:vendors"], false);
  assert.deepEqual(result.settings.ipAddressMappings, [
    { switchIp: "10.0.0.1", address: "Корпус А", source: "PyQt" },
  ]);
  assert.deepEqual(result.settings.vendorDetectorSettings, {
    enabled: false, useOui3: true, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.7,
  });
  assert.deepEqual(result.settings.historyEnrichmentSettings, {
    enabled: false, priorityHistory: false, precedenceProfile: "pyqt", useOuiMatch: false, useMac5Match: true,
  });
  assert.deepEqual(result.settings.ipEnrichmentSettings, { enabled: false, partialMatch: false, overwrite: true, historicalAddress: true });
  assert.deepEqual(result.settings.sourceMappingPreferences.main[0], {
    headers: ["mac-адрес", "имя"], mapping: { mac: 0, hostname: 1 },
  });
  assert.deepEqual(result.settings.sourceMappingPreferences.ddio[0].mapping, { mac: 0, ip: 1 });
  assert.equal(JSON.stringify(result.settings).includes("must-not-transfer"), false);
  assert.equal(JSON.stringify(result.settings).includes("C:\\private"), false);
  assert.ok(result.applied.includes("sourceMappingPreferences"));
});

test("legacy autosave settings with only secrets or workspace paths are rejected", () => {
  assert.throws(() => normalizeLegacyAutosaveSettings({ engineeringToken: "secret", externalApiSettings: { endpoint: "https://private" } }), /нет совместимых/);
  assert.throws(() => normalizeLegacyAutosaveSettings([]), /JSON-объект/);
});

test("legacy autosave column order, visibility, and widths map to the Next Inventory columns", () => {
  const result = normalizeLegacyAutosaveSettings({
    columnOrder: ["model", "macFormatted", "vendor", "switchPort"],
    visibleColumns: ["macFormatted", "vendor", "switchPort"],
    columnWidths: { model: 210, macFormatted: 222, vendor: 180, switchPort: 111 },
  });
  const columns = result.settings.inventoryColumnConfig.columns;
  assert.deepEqual(columns.filter(({ visible }) => visible).map(({ key }) => key), ["rowNumber", "macFormatted", "manufacturer", "switchPort"]);
  assert.equal(columns.find(({ key }) => key === "macFormatted").width, 222);
  assert.equal(columns.find(({ key }) => key === "manufacturer").width, 180);
  assert.equal(columns.find(({ key }) => key === "model").visible, false);
  assert.equal(columns.find(({ key }) => key === "model").width, 210);
});

test("legacy autosave source mappings normalize the reference app's header objects", () => {
  const result = normalizeLegacyAutosaveSettings({
    files: [{
      role: "primary",
      headers: [{ name: "MAC-адрес", index: 0 }, { name: "Имя устройства", index: 1 }],
      mapping: { mac: 0, deviceName: 1, custom_owner: 1 },
    }],
    ddioFile: {
      headers: [{ name: "Calling-Station-ID", index: 0 }, { name: "IP-адрес", index: 1 }],
      mapping: { mac: 0, ip: 1 },
    },
  });

  assert.deepEqual(result.settings.sourceMappingPreferences.main, [{
    headers: ["mac-адрес", "имя устройства"], mapping: { mac: 0, deviceName: 1, custom_owner: 1 },
  }]);
  assert.deepEqual(result.settings.sourceMappingPreferences.ddio, [{
    headers: ["calling-station-id", "ip-адрес"], mapping: { mac: 0, ip: 1 },
  }]);
});

test("legacy custom result columns and active source mappings migrate to stable Next custom fields", () => {
  const result = normalizeLegacyAutosaveSettings({
    files: [{
      id: "main-file",
      role: "primary",
      headers: [{ name: "MAC", index: 0 }, { name: "Владелец", index: 1 }],
      mapping: { mac: 0 },
    }],
    activeMappingFileId: "main-file",
    customColumns: ["custom_owner"],
    customColumnMappings: { custom_owner: 1 },
    columnOrder: ["macFormatted", "custom_owner", "vendor"],
    visibleColumns: ["macFormatted", "custom_owner"],
    columnWidths: { custom_owner: 205 },
  });
  const column = result.settings.inventoryColumnConfig.columns.find(({ custom }) => custom);
  assert.match(column.key, /^custom_[0-9a-f-]{36}$/i);
  assert.equal(column.label, "Owner");
  assert.equal(column.visible, true);
  assert.equal(column.width, 205);
  assert.ok(result.settings.inventoryColumnConfig.columns.findIndex(({ key }) => key === column.key)
    < result.settings.inventoryColumnConfig.columns.findIndex(({ key }) => key === "manufacturer"));
  assert.deepEqual(result.settings.sourceMappingPreferences.main[0].mapping, { mac: 0, [column.key]: 1 });

  const sparse = normalizeLegacyAutosaveSettings({ customColumns: ["custom_owner"] });
  assert.equal(sparse.settings.inventoryColumnConfig.columns.filter(({ custom }) => custom).length, 1);
});
