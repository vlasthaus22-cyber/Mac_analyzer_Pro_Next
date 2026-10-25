import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyVendorDetection, applyVendorDetectionAsync, legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "../src/core/vendor-detector.js";

test("text vendor confidence follows the complete PyQt and Web reference paths", () => {
  const pyqt = readFileSync("../MAC_ANALYZER финальная.py", "utf8");
  const web = readFileSync("../Mac_analyzer_Pro/backend/services/detection/vendor_detector_service.py", "utf8");
  const next = readFileSync("src/core/vendor-detector.js", "utf8");
  assert.match(pyqt, /text_vendor, text_conf = self\.extract_vendor_from_text\(text\)[\s\S]*?text_conf \* 0\.8/);
  assert.match(web, /confidence = min\(\(matches \/ max\(1, len\(keywords\)\)\) \* 2, 1\.0\) \* 0\.8/);
  assert.match(next, /Math\.min\(score \/ keywords\.length \* 2, 1\) \* 0\.8/);
});

test("similarity index stores exact-MAC exclusion counters in one compact evidence map", () => {
  const source = readFileSync("src/core/vendor-detector.js", "utf8");
  assert.match(source, /let sameMacEvidence = group\.macs\.get\(hex\)/);
  assert.match(source, /addMacEvidenceCount\(sameMacEvidence, `model:\$\{modelKey\}`\)/);
  assert.match(source, /addMacEvidenceCount\(sameMacEvidence, `vendor:\$\{vendorKey\}`\)/);
  assert.match(source, /macVendorModelPrefix\(vendorKey\)/);
  assert.match(source, /macEvidenceView\(macEvidence, "vendor:"\)/);
  assert.match(source, /macEvidenceView\(macEvidence, "model:"\)/);
  assert.doesNotMatch(source, /macModels/);
});

test("similar-device inference normalizes MACs, fills only missing values, and records confidence and source", () => {
  const devices = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "Acme", model: "Switch X", fieldSources: {} },
    { mac: "aa-bb-cc-dd-00-02", manufacturer: "", model: "", fieldSources: {} },
    { mac: "00:11:22:33:00:03", manufacturer: "Other", model: "Keep this", fieldSources: {} },
  ];
  assert.deepEqual(applyVendorDetection(devices), { vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(devices[1].manufacturer, "Acme");
  assert.equal(devices[1].model, "Switch X");
  assert.equal(devices[1].vendorConfidence, 0.78);
  assert.ok(Math.abs(devices[1].modelConfidence - 0.702) < 1e-12);
  assert.equal(devices[1].fieldSources.manufacturer, "Similar device inference");
  assert.equal(devices[1].fieldSources.model, "Similar device inference");
  assert.equal(devices[2].manufacturer, "Other");
  assert.equal(devices[2].model, "Keep this");
});

test("similar-device inference excludes the same normalized MAC and can select the next vendor", () => {
  const sameMac = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "Acme", model: "Switch X" },
    { mac: "aabb.ccdd.0001", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(sameMac), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
  assert.equal(sameMac[1].manufacturer, "");
  assert.equal(sameMac[1].model, "");

  const competing = [
    { mac: "AA:BB:CC:DD:00:11", manufacturer: "Acme", model: "Same-device model" },
    { mac: "aabb.ccdd.0011", manufacturer: "Acme", model: "Same-device model" },
    { mac: "AA:BB:CC:DD:00:21", manufacturer: "Other", model: "Other model" },
    { mac: "AA:BB:CC:DD:00:22", manufacturer: "Other", model: "Other model" },
    { mac: "AA:BB:CC:DD:00:11", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(competing), { vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(competing[4].manufacturer, "Other");
  assert.equal(competing[4].model, "Other model");
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

test("model inference leaves ties unresolved and uses a unique most common model", () => {
  const tied = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "Acme", model: "Codec A" },
    { mac: "AA:BB:CC:DD:00:02", manufacturer: "Acme", model: "Codec B" },
    { mac: "AA:BB:CC:DD:00:03", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(tied), { vendor: 1, model: 0, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(tied[2].manufacturer, "Acme");
  assert.equal(tied[2].model, "");

  const majority = [
    { mac: "AA:BB:CC:DD:00:11", manufacturer: "Acme", model: "Codec A" },
    { mac: "AA:BB:CC:DD:00:12", manufacturer: "Acme", model: " codec a " },
    { mac: "AA:BB:CC:DD:00:13", manufacturer: "Acme", model: "Codec B" },
    { mac: "AA:BB:CC:DD:00:14", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(majority), { vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1 });
  assert.equal(majority[3].model, "Codec A");
  assert.equal(majority[3].modelSource, "Similar device inference");
});

test("similar-device inference prefers a unanimous five-byte group over a broader majority", () => {
  const devices = [
    { mac: "AA:BB:CC:DD:EE:01", manufacturer: "Specific", model: "Narrow Model" },
    { mac: "AA:BB:CC:DD:EE:02", manufacturer: "Specific", model: "Narrow Model" },
    { mac: "AA:BB:CC:DD:F0:01", manufacturer: "Broad", model: "Common Model" },
    { mac: "AA:BB:CC:DD:F0:02", manufacturer: "Broad", model: "Common Model" },
    { mac: "AA:BB:CC:DD:F0:03", manufacturer: "Broad", model: "Common Model" },
    { mac: "AA:BB:CC:DD:EE:FF", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(devices, { useText: false }), {
    vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1,
  });
  assert.equal(devices[5].manufacturer, "Specific");
  assert.equal(devices[5].vendorConfidence, 0.78);
  assert.equal(devices[5].model, "Narrow Model");
  assert.ok(Math.abs(devices[5].modelConfidence - 0.702) < 1e-12);
});

test("PyQt and Web inference profiles follow their reference prefix and tie rules", () => {
  const makeDevices = () => [
    { mac: "AA:BB:CC:DD:EE:01", manufacturer: "Specific", model: "Narrow A" },
    { mac: "AA:BB:CC:DD:EE:02", manufacturer: "Specific", model: "Narrow B" },
    { mac: "AA:BB:CC:DD:F0:01", manufacturer: "Broad", model: "Broad First" },
    { mac: "AA:BB:CC:DD:F0:02", manufacturer: "Broad", model: "Broad Second" },
    { mac: "AA:BB:CC:DD:F0:03", manufacturer: "Broad", model: "Broad Third" },
    { mac: "AA:BB:CC:DD:EE:FF", manufacturer: "", model: "" },
  ];
  const pyqt = makeDevices();
  applyVendorDetection(pyqt, { useText: false, inferenceProfile: "pyqt" });
  assert.equal(pyqt[5].manufacturer, "Broad", "PyQt uses the four-byte group majority rather than the narrower five-byte group");
  assert.equal(pyqt[5].model, "Broad First", "PyQt uses the first model found for its selected vendor");
  assert.equal(pyqt[5].vendorConfidence, 0.7);
  assert.equal(pyqt[5].modelConfidence, 0.63);

  const web = makeDevices();
  applyVendorDetection(web, { useText: false, inferenceProfile: "web" });
  assert.equal(web[5].manufacturer, "Specific", "Web uses the most specific matching MAC-prefix group");
  assert.equal(web[5].model, "", "Web keeps conflicting models unresolved");

  const tied = [
    { mac: "00:11:22:33:44:01", manufacturer: "First", model: "First Model" },
    { mac: "00:11:22:33:55:01", manufacturer: "Second", model: "Second Model" },
    { mac: "00:11:22:33:66:01", manufacturer: "", model: "" },
  ];
  applyVendorDetection(tied, { useText: false, inferenceProfile: "pyqt" });
  assert.equal(tied[2].manufacturer, "First", "PyQt's Counter tie follows first-observation order");
  assert.equal(tied[2].model, "First Model");
});

test("similar-device inference falls back from five-byte to OUI evidence and applies its confidence", () => {
  const devices = [
    { mac: "0A:1B:2C:11:22:01", manufacturer: "Acme", model: "Board" },
    { mac: "0A:1B:2C:33:44:01", manufacturer: "Acme", model: "Board" },
    { mac: "0A:1B:2C:55:66:FF", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(devices, { useText: false, confidenceThreshold: 0.62 }), {
    vendor: 1, model: 0, vendorFromText: 0, vendorFromInference: 1,
  });
  assert.equal(devices[2].manufacturer, "Acme");
  assert.equal(devices[2].vendorConfidence, 0.62);
  assert.equal(devices[2].model, "");
  const lowerThreshold = [
    { mac: "0A:1B:2C:11:22:01", manufacturer: "Acme", model: "Board" },
    { mac: "0A:1B:2C:33:44:01", manufacturer: "Acme", model: "Board" },
    { mac: "0A:1B:2C:55:66:FF", manufacturer: "", model: "" },
  ];
  applyVendorDetection(lowerThreshold, { useText: false, confidenceThreshold: 0.55 });
  assert.equal(lowerThreshold[2].model, "Board");
  assert.ok(Math.abs(lowerThreshold[2].modelConfidence - 0.558) < 1e-12);
  assert.deepEqual(applyVendorDetection([
    { mac: "0A:1B:2C:11:22:01", manufacturer: "Acme" },
    { mac: "0A:1B:2C:55:66:FF" },
  ], { useText: false, confidenceThreshold: 0.63 }), {
    vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0,
  });
});

test("similar-device inference can infer a model from peers with no vendor", () => {
  const devices = [
    { mac: "AA:BB:CC:DD:EE:01", manufacturer: "", model: "Codec Only" },
    { mac: "AA:BB:CC:DD:EE:02", manufacturer: "", model: " codec only " },
    { mac: "AA:BB:CC:DD:EE:FF", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(devices, { useText: false }), {
    vendor: 0, model: 1, vendorFromText: 0, vendorFromInference: 0,
  });
  assert.equal(devices[2].manufacturer, "");
  assert.equal(devices[2].model, "Codec Only");
  assert.equal(devices[2].modelSource, "Similar device inference");
  assert.ok(Math.abs(devices[2].modelConfidence - 0.702) < 1e-12);
});

test("model-only similar-device evidence excludes the same MAC and leaves model ties unresolved", () => {
  const sameMac = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "", model: "Self model" },
    { mac: "aa-bb-cc-dd-00-01", manufacturer: "", model: "" },
    { mac: "AA:BB:CC:DD:00:02", manufacturer: "", model: "Peer model" },
    { mac: "AA:BB:CC:DD:00:03", manufacturer: "", model: "Peer model" },
  ];
  assert.deepEqual(applyVendorDetection(sameMac, { useText: false }), {
    vendor: 0, model: 1, vendorFromText: 0, vendorFromInference: 0,
  });
  assert.equal(sameMac[1].model, "Peer model");

  const tied = [
    { mac: "AA:BB:CC:DD:11:01", manufacturer: "", model: "Codec A" },
    { mac: "AA:BB:CC:DD:11:02", manufacturer: "", model: "Codec B" },
    { mac: "AA:BB:CC:DD:11:FF", manufacturer: "", model: "" },
  ];
  assert.deepEqual(applyVendorDetection(tied, { useText: false }), {
    vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0,
  });
  assert.equal(tied[2].model, "");
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
  assert.equal(legacyVendorDetectorSettings({ confidenceThreshold: 0 }).confidenceThreshold, 0.6);
  assert.equal(legacyVendorDetectorSettings({ confidence_threshold: "0" }).confidenceThreshold, 0.6);
  assert.equal(normalizeVendorDetectorSettings({ confidenceThreshold: 0 }).confidenceThreshold, 0,
    "native Next settings continue to honor an explicit zero threshold");
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

test("text vendor confidence matches the PyQt candidate score at the configured threshold", () => {
  const device = { deviceName: "Juniper SRX" };
  assert.deepEqual(applyVendorDetection([device], { useInference: false, confidenceThreshold: 0.5 }), {
    vendor: 1, model: 0, vendorFromText: 1, vendorFromInference: 0,
  });
  assert.equal(device.manufacturer, "Juniper");
  assert.ok(Math.abs(device.vendorConfidence - (2 / 6 * 2 * 0.8)) < 1e-12);
  assert.deepEqual(applyVendorDetection([{ deviceName: "Juniper SRX" }], {
    useInference: false, confidenceThreshold: 0.55,
  }), { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 });
});

test("text-only vendor detection skips similarity indexing and does not read MAC fields", () => {
  const device = { model: "Cisco Catalyst Nexus Router" };
  Object.defineProperty(device, "mac", { get() { throw new Error("text-only detection must not read MAC"); } });
  assert.deepEqual(applyVendorDetection([device], { useInference: false }), {
    vendor: 1, model: 0, vendorFromText: 1, vendorFromInference: 0,
  });
  assert.equal(device.manufacturer, "Cisco");
});

test("text vendor detection reads the legacy device_name field used by PyQt", () => {
  const devices = [{ device_name: "Apple iPhone iPad MacBook iMac iOS iPod AirPort" }];
  assert.deepEqual(applyVendorDetection(devices, { useInference: false }), {
    vendor: 1, model: 0, vendorFromText: 1, vendorFromInference: 0,
  });
  assert.equal(devices[0].manufacturer, "Apple");
  assert.match(devices[0].fieldSources.manufacturer, /^Text: Apple iPhone/);
});

test("async vendor detection preserves synchronous results and yields between bounded indexing batches", async () => {
  const source = [
    { mac: "AA:BB:CC:DD:00:01", manufacturer: "Acme", model: "Switch X", fieldSources: {} },
    { mac: "aa-bb-cc-dd-00-02", manufacturer: "", model: "", fieldSources: {} },
    { mac: "00:11:22:33:00:03", manufacturer: "Other", model: "Keep this", fieldSources: {} },
  ];
  const syncDevices = globalThis.structuredClone(source);
  const asyncDevices = globalThis.structuredClone(source);
  assert.deepEqual(await applyVendorDetectionAsync(asyncDevices), applyVendorDetection(syncDevices));
  assert.deepEqual(asyncDevices, syncDevices);

  const controller = new globalThis.AbortController();
  let reads = 0;
  const devices = Array.from({ length: 1_000 }, (_, index) => {
    const device = { mac: `00:11:22:33:44:${(index % 256).toString(16).padStart(2, "0")}` };
    Object.defineProperty(device, "manufacturer", {
      get() {
        reads += 1;
        if (reads === 1) globalThis.setImmediate(() => controller.abort());
        return "Acme";
      },
    });
    return device;
  });
  await assert.rejects(applyVendorDetectionAsync(devices, undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 501, "cancellation is observed after the first bounded indexing batch and one early missing-field probe");
});

test("async vendor detection writes only Final pages where inference changed a device", async () => {
  const records = Array.from({ length: 500 }, (_, index) => ({
    mac: `AA:BB:CC:DD:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    manufacturer: "Acme",
    model: "Board",
    fieldSources: {},
  }));
  records.push({ mac: "AA:BB:CC:DD:02:00", manufacturer: "", model: "", fieldSources: {} });
  const writes = [];
  const store = {
    count: records.length,
    async readPage(offset, limit) { return records.slice(offset, offset + limit).map((row) => globalThis.structuredClone(row)); },
    async writePage(offset, page) {
      writes.push(offset);
      for (let index = 0; index < page.length; index += 1) records[offset + index] = globalThis.structuredClone(page[index]);
    },
  };

  assert.deepEqual(await applyVendorDetectionAsync(store, { useText: false }), {
    vendor: 1, model: 1, vendorFromText: 0, vendorFromInference: 1,
  });
  assert.deepEqual(writes, [500], "unchanged pages must not be rewritten to IndexedDB");
  assert.equal(records[500].manufacturer, "Acme");
  assert.equal(records[500].model, "Board");
});

test("async text-only detection scans and writes each Final page once", async () => {
  const records = Array.from({ length: 501 }, () => ({ deviceName: "Cisco Catalyst access switch" }));
  const reads = [];
  const writes = [];
  const store = {
    count: records.length,
    async readPage(offset, limit) {
      reads.push(offset);
      return records.slice(offset, offset + limit).map((row) => globalThis.structuredClone(row));
    },
    async writePage(offset, page) {
      writes.push(offset);
      for (let index = 0; index < page.length; index += 1) records[offset + index] = globalThis.structuredClone(page[index]);
    },
  };

  assert.deepEqual(await applyVendorDetectionAsync(store, { useInference: false }), {
    vendor: 501, model: 0, vendorFromText: 501, vendorFromInference: 0,
  });
  assert.deepEqual(reads, [0, 500], "text-only analysis must not preflight the full Final in a separate read pass");
  assert.deepEqual(writes, [0, 500]);
});

test("async inference skips similarity indexing when every device already has vendor and model", async () => {
  const records = Array.from({ length: 501 }, () => ({ manufacturer: "Acme", model: "Board" }));
  for (const record of records) Object.defineProperty(record, "mac", {
    get() { throw new Error("complete Final must not allocate a MAC similarity index"); },
  });
  const reads = [];
  const writes = [];
  const store = {
    count: records.length,
    async readPage(offset, limit) {
      reads.push(offset);
      return records.slice(offset, offset + limit);
    },
    async writePage(offset) { writes.push(offset); },
  };

  assert.deepEqual(await applyVendorDetectionAsync(store), {
    vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0,
  });
  assert.deepEqual(reads, [0, 500], "the missing-field scan stops after one pass and avoids indexing passes");
  assert.deepEqual(writes, []);
});
