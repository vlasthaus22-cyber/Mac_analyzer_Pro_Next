import test from "node:test";
import assert from "node:assert/strict";
import { createVendorModelRuleLearner } from "../src/core/vendor-model-learning.js";

test("vendor and model rules are learned at 3, 4, and 5 byte prefixes with stable tie handling", () => {
  const learner = createVendorModelRuleLearner({ minimumCount: 2 });
  learner.add({ mac: "00:11:22:33:44:55", manufacturer: "Vendor B", model: "Router B" });
  learner.add({ mac: "00:11:22:33:44:66", manufacturer: "Vendor A", model: "Router A" });
  learner.add({ mac: "00:11:22:33:44:77", manufacturer: "Vendor A", model: "Router A" });
  const result = learner.result();
  assert.deepEqual(result.vendors.filter(({ prefix }) => prefix === "001122").map(({ vendor, observations }) => [vendor, observations]), [["Vendor A", 2]]);
  assert.deepEqual(result.vendors.filter(({ prefix }) => prefix === "00112233").map(({ vendor, observations }) => [vendor, observations]), [["Vendor A", 2]]);
  assert.deepEqual(result.vendors.filter(({ prefix }) => prefix === "0011223344").map(({ vendor, observations }) => [vendor, observations]), [["Vendor A", 2]]);
  assert.deepEqual(result.models.filter(({ prefix }) => prefix === "001122").map(({ model, observations }) => [model, observations]), [["Router A", 2]]);
  assert.equal(result.scannedDevices, 3);
});

test("learning applies minimum count, source filter and existing-rule protection", () => {
  const learner = createVendorModelRuleLearner({ minimumCount: 2, sourceFilter: "main.csv" });
  learner.add({ mac: "00:11:22:33:44:55", vendor: "Acme", model: "Switch X", source: "main.csv" });
  learner.add({ mac: "00:11:22:33:44:66", vendor: "Acme", model: "Switch X", source: "other.csv" });
  learner.add({ mac: "00:11:22:33:44:77", vendor: "Acme", model: "Switch X", source: "main.csv" });
  learner.add({ mac: "invalid", vendor: "Acme", model: "Switch X", source: "main.csv" });
  const result = learner.result({ existingVendorPrefixes: new Set(["001122"]), existingModelPrefixes: new Set(["00112233"]) });
  assert.equal(result.matchedDevices, 2);
  assert.equal(result.vendors.some(({ prefix }) => prefix === "001122"), false);
  assert.equal(result.vendors.some(({ prefix }) => prefix === "00112233"), true);
  assert.equal(result.models.some(({ prefix }) => prefix === "00112233"), false);
  assert.equal(result.models.find(({ prefix }) => prefix === "001122").observations, 2);
});

test("vendor and model learning uses a valid MAC alias after a placeholder primary MAC", () => {
  const learner = createVendorModelRuleLearner({ minimumCount: 1 });
  learner.add({ mac: "—", macFormatted: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board" });
  const result = learner.result();
  assert.ok(result.vendors.some(({ prefix, vendor }) => prefix === "001122" && vendor === "Acme"));
  assert.ok(result.models.some(({ prefix, model }) => prefix === "001122" && model === "Board"));
});
