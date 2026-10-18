import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_PYQT_SETTINGS_MAX_BYTES, normalizeLegacyAutosaveSettings, normalizeLegacyPyQtSettings } from "../src/core/legacy-pyqt-settings.js";

test("PyQt settings migration imports supported local preferences and omits paths, credentials, and unsafe merge controls", () => {
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
    files: { Main: { path: "C:\\private\\main.xlsx", mapping: { mac: 0 } } },
    api_settings: { api_key: "secret-token", service: "macvendors" },
    ip_address_mapping_file: "C:\\private\\mapping.xlsx",
    ip_enrichment_settings: { overwrite: true, partial_match: true },
    comparison_fields: { mac: true },
    engineering_mode: true, window_geometry: "private-geometry", custom_columns: ["Customer field"],
  });

  assert.equal(result.settings.theme, "dark");
  assert.equal(result.settings.enrichmentStrategy, "ALLOW_EXPANSION");
  assert.deepEqual(result.settings.enrichmentFieldSettings, {
    model: false, address: true, ip: false, vendor: true, room: false, switch_ip: true, switch_port: false,
  });
  assert.deepEqual(result.settings.ouiFormats, { 3: true, 4: false, 5: true, 6: false });
  assert.deepEqual(result.settings.vendorDetectorSettings, {
    enabled: false, useOui3: true, useMac5: false, useText: false, useInference: true, confidenceThreshold: 0.83,
  });
  const columns = result.settings.inventoryColumnConfig.columns;
  assert.deepEqual(columns.filter((column) => column.visible).map((column) => column.key), ["rowNumber", "mac", "model", "ip", "macFormatted"]);
  assert.ok(columns.some((column) => column.custom && column.label === "Customer field" && !column.visible));
  assert.deepEqual(result.applied, ["theme", "last_strategy", "vendor_detector_settings/history_enricher_settings", "enrich_fields", "oui_formats", "visible_columns", "custom_columns"]);
  assert.ok(["files", "api_settings", "engineering_mode", "ip_enrichment_settings", "comparison_fields", "window_geometry"].every((key) => result.ignored.includes(key)));
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

test("PyQt settings migration rejects malformed or unsupported-only JSON", () => {
  assert.throws(() => normalizeLegacyPyQtSettings([]), /JSON-объект/);
  assert.throws(() => normalizeLegacyPyQtSettings({ api_settings: { api_key: "secret" } }), /нет совместимых настроек/);
  assert.equal(LEGACY_PYQT_SETTINGS_MAX_BYTES, 1024 * 1024);
});

test("legacy autosave recovery restores only compatible settings and source mappings", () => {
  const result = normalizeLegacyAutosaveSettings({
    theme: "dark",
    enrichmentStrategy: "ALLOW_EXPANSION",
    vendorDetectorSettings: { enabled: false, useOui3: true, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.7 },
    enrichmentFieldSettings: { ip: false, room: true },
    ouiFormats: { 3: true, 4: true, 5: false, 6: false },
    visibleColumns: ["MAC", "Модель"],
    customColumns: ["Клиентское поле"],
    files: [{ role: "primary", headers: ["MAC-адрес", "Имя"], mapping: { mac: 0, hostname: 1 } }],
    ddioFile: { headers: ["Calling-Station-ID", "IP-адрес"], mapping: { mac: 0, ip: 1 }, path: "C:\\private\\ddio.xlsx" },
    engineeringToken: "must-not-transfer",
    externalApiSettings: { apiKey: "must-not-transfer" },
  });

  assert.equal(result.settings.theme, "dark");
  assert.equal(result.settings.enrichmentStrategy, "ALLOW_EXPANSION");
  assert.deepEqual(result.settings.vendorDetectorSettings, {
    enabled: false, useOui3: true, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.7,
  });
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
