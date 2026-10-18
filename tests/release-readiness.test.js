import test from "node:test";
import assert from "node:assert/strict";
import { inspectReleaseReadiness } from "../scripts/release-readiness.js";

test("release readiness requires every parity requirement to be explicitly complete", () => {
  const rows = [
    { id: 1, status: "Полностью: implemented and verified" },
    { id: 2, status: "Выполнено: tested" },
    { id: 3, status: "Частично: browser check remains open" },
    { id: 4, status: "Не закрыто: not implemented" },
  ];
  const result = inspectReleaseReadiness(rows);
  assert.equal(result.ready, false);
  assert.deepEqual(result.pending.map(({ id }) => id), [3, 4]);
});

test("an empty parity matrix cannot accidentally pass release readiness", () => {
  assert.deepEqual(inspectReleaseReadiness([]), { ready: false, total: 0, pending: [] });
});

test("all complete requirements pass release readiness", () => {
  const rows = [{ id: 1, status: "Полностью: verified" }, { id: 2, status: "Выполнено: verified" }];
  assert.deepEqual(inspectReleaseReadiness(rows), { ready: true, total: 2, pending: [] });
});
