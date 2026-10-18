import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENRICHMENT_FIELD_SETTINGS, normalizeEnrichmentFieldSettings } from "../src/core/enrichment-settings.js";

test("enrichment field settings default to the PyQt behavior and normalize only explicit booleans", () => {
  assert.deepEqual(normalizeEnrichmentFieldSettings(null), DEFAULT_ENRICHMENT_FIELD_SETTINGS);
  assert.deepEqual(normalizeEnrichmentFieldSettings({ model: false, ip: 0, room: true, unknown: false }), {
    ...DEFAULT_ENRICHMENT_FIELD_SETTINGS,
    model: false,
    room: true,
  });
});
