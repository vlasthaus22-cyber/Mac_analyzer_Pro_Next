import test from "node:test";
import assert from "node:assert/strict";
import { runLegacyTaskQueue } from "../src/core/legacy-task-queue.js";

test("legacy task queue is paged and serial, persists each outcome, and continues after a file error", async () => {
  const pages = new Map([
    ["start", { rows: [{ id: "a", payload: { filename: "a.csv" } }, { id: "b", payload: { filename: "b.xlsx" } }], hasMore: true, nextCursor: { key: ["task_file_queue", "2026-01-02", "b"] } }],
    ["next", { rows: [{ id: "c", payload: { filename: "c.csv" } }], hasMore: false, nextCursor: null }],
  ]);
  const updates = [];
  const order = [];
  const progress = [];
  let pageCalls = 0;
  const result = await runLegacyTaskQueue("task-1", {
    pageSize: 2,
    async loadPage(taskId, { after, limit }) {
      assert.equal(taskId, "task-1");
      assert.equal(limit, 2);
      pageCalls += 1;
      return pages.get(after ? "next" : "start");
    },
    async updateItem(id, patch) { updates.push({ id, patch }); },
    async processItem(item) {
      order.push(`start:${item.id}`);
      if (item.id === "b") throw new Error("invalid workbook");
      await Promise.resolve();
      order.push(`finish:${item.id}`);
      return { processedAt: "2026-01-03T00:00:00.000Z", result: { snapshotId: `final-${item.id}` } };
    },
    onProgress(value) { progress.push(value); },
  });
  assert.deepEqual(result, { processed: 3, done: 2, errors: 1 });
  assert.equal(pageCalls, 2);
  assert.deepEqual(order, ["start:a", "finish:a", "start:b", "start:c", "finish:c"]);
  assert.deepEqual(updates.map(({ id, patch }) => [id, patch.status]), [
    ["a", "running"], ["a", "done"], ["b", "running"], ["b", "error"], ["c", "running"], ["c", "done"],
  ]);
  assert.equal(updates.find(({ id, patch }) => id === "b" && patch.status === "error").patch.error, "invalid workbook");
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).errors, 1);
});

test("legacy task queue rejects a missing continuation cursor instead of silently truncating work", async () => {
  await assert.rejects(runLegacyTaskQueue("task-1", {
    async loadPage() { return { rows: [], hasMore: true, nextCursor: null }; },
    async updateItem() {},
    async processItem() {},
  }), /не вернула курсор/);
});
