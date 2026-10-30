import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPARISON_SETTINGS,
  normalizeComparisonSettings,
  resolveConfiguredComparison,
  scoreConfiguredComparison,
} from "../src/core/comparison-settings.js";

test("comparison settings migrate PyQt aliases and clamp threshold", () => {
  assert.deepEqual(normalizeComparisonSettings({
    comparison_fields: { compare_mac: false, compare_oui: true, compare_switch_ip: true, threshold: 84 },
  }), {
    fields: { mac: false, oui: true, vendor: false, model: false, ip: false, address: false, room: false, switchIp: true, switchPort: false },
    threshold: 84,
  });
  assert.equal(normalizeComparisonSettings({ threshold: 140 }).threshold, 100);
  assert.equal(normalizeComparisonSettings({ threshold: -3 }).threshold, 0);
  assert.equal(normalizeComparisonSettings({ threshold: "nope" }).threshold, DEFAULT_COMPARISON_SETTINGS.threshold);
});

test("weighted configured score uses only selected, known-equal fields", () => {
  const score = scoreConfiguredComparison(
    { vendor: "Acme", model: "A1", ip: "10.0.0.2" },
    { vendor: "Acme", model: "A1", ip: "10.0.0.3" },
    { fields: { mac: false, oui: false, vendor: true, model: true, ip: true }, threshold: 70 },
  );
  assert.equal(score.score, 100 / 150 * 100);
  assert.equal(score.scorePoints, 100);
  assert.equal(score.totalPoints, 150);
  assert.deepEqual(score.matchedFields, ["vendor", "model"]);
  assert.equal(scoreConfiguredComparison({ manufacturer: "Acme" }, { vendor: "Acme" }, {
    fields: { mac: false, oui: false, vendor: true, model: false, ip: false, address: false, room: false, switchIp: false, switchPort: false },
  }).score, 100);
});

test("weak candidates merge only with unique high score and independent corroboration", () => {
  const candidate = { vendor: "Acme", model: "A1", room: "R-1", ip: "10.0.0.2" };
  const settings = { fields: { mac: false, oui: false, vendor: true, model: true, room: true, ip: true }, threshold: 70 };
  const devices = [
    { position: 4, device: { id: "target-1", vendor: "Acme", model: "A1", room: "R-1", ip: "10.0.0.9", mac: "00:11:22:33:44:55" } },
    { position: 9, device: { id: "target-2", vendor: "Other", model: "A2", room: "R-2", ip: "10.0.0.2", mac: "00:11:22:33:44:66" } },
  ];
  const result = resolveConfiguredComparison(candidate, devices, settings);
  assert.equal(result.status, "matched");
  assert.equal(result.position, 4);
  assert.equal(result.match.id, "target-1");
});

test("comparison never merges IP/OUI-only evidence, a score tie, conflicting identity, or overflow", () => {
  const candidate = { vendor: "Acme", model: "A1", room: "R-1", ip: "10.0.0.2", oui: "001122" };
  const settings = { fields: { mac: false, oui: false, vendor: true, model: true, room: true }, threshold: 70 };
  assert.equal(resolveConfiguredComparison(candidate, [
    { position: 0, device: { id: "a", vendor: "Other", model: "A2", ip: "10.0.0.2", oui: "001122" } },
  ], { fields: { ip: true, oui: true }, threshold: 0 }).status, "unresolved");
  const equal = { vendor: "Acme", model: "A1", room: "R-1" };
  assert.equal(resolveConfiguredComparison(candidate, [
    { position: 0, device: { ...equal, id: "a" } },
    { position: 1, device: { ...equal, id: "b" } },
  ], settings).reason, "score-tie");
  assert.equal(resolveConfiguredComparison({ ...candidate, mac: "00:11:22:33:44:55" }, [
    { position: 0, device: { ...equal, id: "a", mac: "00:11:22:33:44:66" } },
  ], settings).reason, "strong-identity-conflict");
  assert.equal(resolveConfiguredComparison(candidate, [
    { position: 0, device: equal },
  ], settings, { candidateOverflow: true }).reason, "candidate-overflow");
});
