import test from "node:test";
import assert from "node:assert/strict";
import { createRequestGate } from "../src/core/request-gate.js";

test("only the newest analytics request can commit its result", () => {
  const gate = createRequestGate();
  const older = gate.begin();
  const newer = gate.begin();

  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);
});

test("database refresh invalidates every in-flight analytics request", () => {
  const gate = createRequestGate();
  const request = gate.begin();
  gate.invalidate();

  assert.equal(gate.isCurrent(request), false);
  assert.equal(gate.isCurrent(gate.begin()), true);
});
