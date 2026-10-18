import test from "node:test";
import assert from "node:assert/strict";
import { createDataQualityAccumulator } from "../src/core/data-quality.js";

test("quality analysis matches source score, completeness, and duplicate semantics across chunks", () => {
  const quality = createDataQualityAccumulator();
  quality.accept([{ mac: "aa-bb-cc-00-00-01", vendor: "Vendor", model: "Switch", address: "HQ", ip: "10.0.0.1", room: "101", switchIp: "10.0.0.254", switchPort: "1", source: "Main" }]);
  quality.accept([{ mac: "AABB.CC00.0001", vendor: "Vendor", model: "Switch", address: "HQ", ip: "10.0.0.2", room: "102", switchIp: "10.0.0.254", switchPort: "2", source: "Main" }]);
  const result = quality.finish();
  assert.equal(result.summary.devices, 2);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.duplicateMacs, 1);
  assert.equal(result.summary.completeness, 100);
  assert.equal(result.score, 70);
  assert.equal(result.grade, "C");
  assert.equal(result.issues.find((item) => item.id === "duplicate_macs").count, 1);
});

test("duplicate issue count reports distinct duplicated MACs while summary counts extra device rows", () => {
  const quality = createDataQualityAccumulator();
  quality.accept([
    { mac: "aa-bb-cc-00-00-01" },
    { mac: "AABB.CC00.0001" },
    { mac: "AA:BB:CC:00:00:01" },
  ]);
  const result = quality.finish();
  assert.equal(result.duplicateMacs, 1);
  assert.equal(result.summary.duplicates, 2);
  assert.equal(result.issues.find((item) => item.id === "duplicate_macs").count, 1);
});

test("quality analysis reports source issue taxonomy and field coverage", () => {
  const result = createDataQualityAccumulator().finish();
  assert.equal(result.grade, "D");
  assert.equal(result.score, 0);
  const quality = createDataQualityAccumulator();
  quality.accept([
    { mac: "invalid", vendor: "Unknown", model: "", ip: "300.2.3.4", switchIp: "bad", room: "", switchPort: "" },
    { mac: "00:11:22:33:44:02", vendor: "Acme", model: "M", ip: "10.0.0.2", switchIp: "10.0.0.254", room: "A", switchPort: "1" },
  ]);
  const report = quality.finish();
  assert.deepEqual(report.issues.map((item) => item.id), ["malformed_macs", "unknown_vendors", "missing_models", "missing_addresses", "malformed_ips", "malformed_switches", "missing_rooms", "missing_ports"]);
  const vendorIssue = report.issues.find((item) => item.id === "unknown_vendors");
  assert.equal(vendorIssue.recommendation, "Use the local IEEE vendor registry or add a local vendor mapping.");
  assert.doesNotMatch(vendorIssue.recommendation, /API|upload|external/i);
  assert.equal(report.fieldCoverage.vendor.filled, 1);
  assert.equal(report.fieldCoverage.address.filled, 0);
  assert.equal(report.summary.sources, 1);
});

test("quality treats placeholder values as empty and reports address coverage only below 50 percent", () => {
  const quality = createDataQualityAccumulator();
  quality.accept([
    { mac: "00:11:22:33:44:01", vendor: "Unknown", model: "Не указано", address: "Не указано", ip: "10.0.0.1", room: "Unknown", switchIp: "10.0.0.254", switchPort: "Не указано" },
    { mac: "00:11:22:33:44:02", vendor: "Acme", model: "Switch", address: "HQ", ip: "10.0.0.2", room: "101", switchIp: "10.0.0.254", switchPort: "2" },
  ]);
  const report = quality.finish();
  assert.equal(report.fieldCoverage.vendor.filled, 1);
  assert.equal(report.fieldCoverage.model.filled, 1);
  assert.equal(report.fieldCoverage.address.filled, 1);
  assert.equal(report.fieldCoverage.room.filled, 1);
  assert.equal(report.fieldCoverage.switchPort.filled, 1);
  assert.equal(report.issues.some((item) => item.id === "missing_addresses"), false);

  const belowThreshold = createDataQualityAccumulator();
  belowThreshold.accept([
    { mac: "00:11:22:33:44:03", address: "Unknown" },
    { mac: "00:11:22:33:44:04", address: "Не указано" },
    { mac: "00:11:22:33:44:05", address: "HQ" },
  ]);
  const addressIssue = belowThreshold.finish().issues.find((item) => item.id === "missing_addresses");
  assert.equal(addressIssue.count, 2);
  assert.match(addressIssue.recommendation, /IP-to-address mapping/);
});

test("quality rejects IPv6 with an unmatched leading or trailing colon", () => {
  const quality = createDataQualityAccumulator();
  quality.accept([
    { ip: ":1:2:3:4:5:6:7:8", switchIp: "1:2:3:4:5:6:7:8:" },
    { ip: "2001:db8::1", switchIp: "::" },
  ]);

  const report = quality.finish();
  assert.equal(report.issues.find((item) => item.id === "malformed_ips").count, 1);
  assert.equal(report.issues.find((item) => item.id === "malformed_switches").count, 1);
});

test("quality report preserves source recommendations, dominant source, and invalid-row input", () => {
  const quality = createDataQualityAccumulator({ invalidRows: 2 });
  quality.accept(Array.from({ length: 26 }, (_, index) => ({
    mac: `00:11:22:33:44:${String(index).padStart(2, "0")}`,
    vendor: "Acme", model: "Switch", ip: `10.0.0.${index + 1}`, room: "101", switchIp: "10.0.0.254", switchPort: "1", source: "Main",
  })));
  const report = quality.finish();
  assert.equal(report.issues[0].id, "invalid_rows");
  assert.equal(report.summary.invalidRows, 2);
  assert.deepEqual(report.dominantSource, { name: "Main", devices: 26 });
  assert.ok(report.recommendations.some((item) => item.includes("Compare this upload")));
});

test("quality source statistics preserve a literal Unknown source label", () => {
  const quality = createDataQualityAccumulator();
  quality.accept([{ mac: "00:11:22:33:44:01", source: "Unknown" }]);

  const report = quality.finish();
  assert.equal(report.summary.sources, 1);
  assert.deepEqual(report.dominantSource, { name: "Unknown", devices: 1 });
});
