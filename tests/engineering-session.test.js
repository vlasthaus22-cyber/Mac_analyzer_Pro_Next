import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessView,
  createEngineerCredential,
  createEngineeringSession,
  engineeringSessionRemainingSeconds,
  isEngineeringSessionActive,
  normalizeEngineeringSessionMinutes,
  verifyEngineerCredential,
} from "../src/core/engineering-session.js";

test("user and engineering roles expose only the intended top-level views", () => {
  for (const view of ["search", "analytics", "history"]) assert.equal(canAccessView(view, false), true);
  for (const view of ["single", "filecompare", "multicompare", "enrichment", "batch", "data", "rooms", "guide"]) {
    assert.equal(canAccessView(view, false), false);
    assert.equal(canAccessView(view, true), true);
  }
});

test("engineer password is salted and incorrect passwords never verify", async () => {
  const credential = await createEngineerCredential("correct horse 12");
  assert.equal(credential.version, 1);
  assert.equal(credential.algorithm, "PBKDF2-SHA-256");
  assert.notEqual(credential.salt, credential.hash);
  assert.equal(await verifyEngineerCredential("correct horse 12", credential), true);
  assert.equal(await verifyEngineerCredential("wrong password", credential), false);
  assert.equal(await verifyEngineerCredential("correct horse 12", { ...credential, hash: "xyz" }), false);
  await assert.rejects(createEngineerCredential("short"), /не менее 8 символов/);
});

test("engineer session TTL is clamped and expires at its deadline", () => {
  assert.equal(normalizeEngineeringSessionMinutes("0"), 1);
  assert.equal(normalizeEngineeringSessionMinutes("2000"), 1440);
  assert.equal(normalizeEngineeringSessionMinutes("not a number"), 30);
  const session = createEngineeringSession(2, 1_000);
  assert.deepEqual(session, { startedAt: 1_000, expiresAt: 121_000, ttlMinutes: 2 });
  assert.equal(isEngineeringSessionActive(session, 120_999), true);
  assert.equal(isEngineeringSessionActive(session, 121_000), false);
  assert.equal(engineeringSessionRemainingSeconds(session, 91_001), 30);
});
