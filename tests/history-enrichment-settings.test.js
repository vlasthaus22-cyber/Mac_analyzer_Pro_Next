import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HISTORY_ENRICHMENT_SETTINGS, normalizeHistoryEnrichmentSettings, normalizeLegacyWorkspaceFiles } from "../src/core/history-enrichment-settings.js";

test("legacy history-enrichment settings retain the four supported boolean choices", () => {
  assert.deepEqual(normalizeHistoryEnrichmentSettings({
    enabled: false,
    priorityHistory: false,
    useOuiMatch: true,
    useMac5Match: false,
    token: "ignored",
  }), {
    enabled: false,
    priorityHistory: false,
    useOuiMatch: true,
    useMac5Match: false,
  });
  assert.deepEqual(normalizeHistoryEnrichmentSettings({ enabled: false, useOuiMatch: "false" }), {
    ...DEFAULT_HISTORY_ENRICHMENT_SETTINGS,
    enabled: false,
  });
});

test("legacy workspace file summaries keep safe metadata and bounded mappings", () => {
  assert.deepEqual(normalizeLegacyWorkspaceFiles([{
    id: "file-1", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01",
    fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3, ignored: null },
    path: "C:\\private\\Main.csv", content: "not retained",
  }]), [{
    id: "file-1", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01",
    fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3 },
  }]);
  assert.throws(() => normalizeLegacyWorkspaceFiles(Array.from({ length: 501 }, () => ({ role: "primary" }))), /слишком много/);
  assert.throws(() => normalizeLegacyWorkspaceFiles([{ role: "primary", mapping: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index])) }]), /слишком много сопоставлений/);
  assert.throws(() => normalizeLegacyWorkspaceFiles([{ role: "primary", mapping: { mac: " " } }]), /Некорректное сопоставление/);
  assert.throws(() => normalizeLegacyWorkspaceFiles([{ role: "primary", mapping: { mac: "0x0" } }]), /Некорректное сопоставление/);
  assert.deepEqual(normalizeLegacyWorkspaceFiles([{ role: "primary", mapping: { mac: "0", vendor: 2 } }])[0].mapping, { mac: 0, vendor: 2 });
  assert.equal(normalizeLegacyWorkspaceFiles([{ id: "extra", role: "additional" }])[0].role, "additional");
});
