import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationSummaryAccumulator } from "../src/core/notification-summary.js";

test("notification summary counts known address and room values across bounded chunks", () => {
  const summary = createNotificationSummaryAccumulator();
  summary.acceptChunk([
    { address: " HQ ", room: "101" },
    { address: "Unknown", room: "Не указано" },
  ]);
  summary.acceptChunk([
    { address: "—", room: "202" },
    { address: "Building B", room: "нет данных" },
  ]);
  assert.deepEqual(summary.finish(), { filledAddresses: 2, rooms: 2 });
  const snapshot = summary.finish();
  snapshot.rooms = 0;
  assert.deepEqual(summary.finish(), { filledAddresses: 2, rooms: 2 }, "mutating the returned snapshot does not alter accumulation");
});

test("notification summary rejects non-chunk values instead of silently changing counts", () => {
  const summary = createNotificationSummaryAccumulator();
  assert.throws(() => summary.acceptChunk(null), /Final chunk must be an array/);
  assert.deepEqual(summary.finish(), { filledAddresses: 0, rooms: 0 });
});
