import test from "node:test";
import assert from "node:assert/strict";
import { applyVendorDetection, legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "../src/core/vendor-detector.js";

test("similar-device inference normalizes MACs, fills only missing values, and records confidence and source", () => {
  const devices = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "Acme", model: "Switch X", fieldSources: {} },
    { mac: "aa-bb-cc-dd-00-02", manufacturer: "", model: "", fieldSources: {} },
    { mac: "00:11:22:33:00:03", manufacturer: "Other", model: "Keep this", fieldSources: {} },
  ];
  assert.deepEqual(applyVendorDetection(devices), { vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(devices[1].manufacturer, "Acme");
  assert.equal(devices[1].model, "Switch X");
  assert.equal(devices[1].vendorConfidence, 0.7);
  assert.equal(devices[1].modelConfidence, 0.63);
  assert.equal(devices[1].fieldSources.manufacturer, "Similar device inference");
  assert.equal(devices[1].fieldSources.model, "Similar device inference");
  assert.equal(devices[2].manufacturer, "Other");
  assert.equal(devices[2].model, "Keep this");
});

test("inference respects threshold, disabled settings, missing identity, and vendor ties", () => {
  const records = [
    { mac: "001122334455", manufacturer: "Acme", model: "A" },
    { mac: "00:11:22:33:66:77", manufacturer: "Other", model: "B" },
    { mac: "00:11:22:33:88:99", manufacturer: "", model: "" },
    { mac: "bad-mac", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(records), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
  assert.deepEqual(applyVendorDetection([{ mac: "001122334455", manufacturer: "Acme" }, { mac: "001122336677" }], { confidenceThreshold: 0.8, useText: false }), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
  assert.deepEqual(applyVendorDetection([{ mac: "001122334455", manufacturer: "Acme" }, { mac: "001122336677" }], { enabled: false }), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
  assert.deepEqual(normalizeVendorDetectorSettings({ confidenceThreshold: 2 }), { enabled: true, useOui3: true, useMac5: true, useText: true, useInference: true, confidenceThreshold: 1 });
  assert.deepEqual(normalizeVendorDetectorSettings({ confidenceThreshold: Number.NaN }), { enabled: true, useOui3: true, useMac5: true, useText: true, useInference: true, confidenceThreshold: 0.6 });
});

test("vendor detector uses a valid MAC alias after an empty marker in the primary field", () => {
  const devices = [
    { mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board A" },
    { mac: "—", macFormatted: "00:11:22:33:44:66", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(devices), { vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(devices[1].manufacturer, "Acme");
  assert.equal(devices[1].model, "Board A");
});

test("legacy SQLite detector settings map snake-case aliases into Next preferences", () => {
  assert.deepEqual(legacyVendorDetectorSettings(JSON.stringify({
    enabled: false,
    use_oui_3byte: false,
    use_oui_5byte: true,
    use_text_analysis: false,
    use_inference: true,
    confidence_threshold: 0.75,
  })), {
    enabled: false, useOui3: false, useMac5: true, useText: false, useInference: true, confidenceThreshold: 0.75,
  });
  assert.deepEqual(legacyVendorDetectorSettings({ useOui3: false, confidenceThreshold: 0.4 }), {
    enabled: true, useOui3: false, useMac5: true, useText: true, useInference: true, confidenceThreshold: 0.4,
  });
  assert.equal(legacyVendorDetectorSettings("not-json"), null);
  assert.equal(legacyVendorDetectorSettings([]), null);
});

test("text detector obeys confidence threshold and runs only when enabled", () => {
  const devices = [{ model: "Cisco Catalyst Nexus Router" }];
  assert.deepEqual(applyVendorDetection(devices, { useInference: false }), { vendor: 1, model: 0, vendorFromText: 1, vendorFromInference: 0 });
  assert.equal(devices[0].manufacturer, "Cisco");
  assert.equal(devices[0].fieldSources.manufacturer.startsWith("Text:"), true);
  assert.deepEqual(applyVendorDetection([{ model: "Cisco" }], { useInference: false }), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
  assert.deepEqual(applyVendorDetection([{ model: "Cisco Catalyst Nexus Router" }], { useText: false, useInference: false }), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
});

test("text vendor detection reads the legacy device_name field used by PyQt", () => {
  const devices = [{ device_name: "Apple iPhone iPad MacBook iMac iOS iPod AirPort" }];
  assert.deepEqual(applyVendorDetection(devices, { useInference: false }), {
    vendor: 1, model: 0, vendorFromText: 1, vendorFromInference: 0,
  });
  assert.equal(devices[0].manufacturer, "Apple");
  assert.match(devices[0].fieldSources.manufacturer, /^Text: Apple iPhone/);
});
