import test from "node:test";
import assert from "node:assert/strict";
import { formatReferenceImportHeartbeat } from "../scripts/reference-import-progress.js";

test("reference import heartbeat reports elapsed time while waiting for the first checkpoint", () => {
  assert.equal(
    formatReferenceImportHeartbeat({ elapsedMs: 65_000 }),
    "[heartbeat] import still running; elapsed 1m 5s; waiting for the first checkpoint",
  );
});

test("reference import heartbeat distinguishes the last checkpoint from committed completion", () => {
  assert.equal(
    formatReferenceImportHeartbeat({
      elapsedMs: 3_661_000,
      now: 20_000,
      lastProgress: { stage: "restoring", subject: "legacyObservations", processed: 610_000, total: 1_005_968, at: 5_000 },
    }),
    "[heartbeat] restoring legacyObservations 610,000/1,005,968; last checkpoint 15s ago; elapsed 1h 1m 1s",
  );
});
