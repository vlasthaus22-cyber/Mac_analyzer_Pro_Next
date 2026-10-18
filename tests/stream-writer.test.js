import test from "node:test";
import assert from "node:assert/strict";
import { writeReadableStreamToWritable } from "../src/core/stream-writer.js";

function streamOf(...chunks) {
  return new globalThis.ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("stream writer copies one chunk at a time and closes the selected file", async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const writes = [];
  let closed = false;
  let aborted = false;

  const result = await writeReadableStreamToWritable(streamOf(...chunks), {
    async write(chunk) { writes.push([...chunk]); },
    async close() { closed = true; },
    async abort() { aborted = true; },
  });

  assert.equal(result, true);
  assert.deepEqual(writes, [[1, 2], [3, 4]]);
  assert.equal(closed, true);
  assert.equal(aborted, false);
});

test("stream writer aborts the output and stops after cancellation", async () => {
  const controller = new globalThis.AbortController();
  const writes = [];
  let abortReason;
  let closed = false;
  await assert.rejects(writeReadableStreamToWritable(streamOf("first", "second"), {
    async write(chunk) {
      writes.push(chunk);
      controller.abort();
    },
    async close() { closed = true; },
    async abort(error) { abortReason = error; },
  }, { signal: controller.signal }), { name: "AbortError" });

  assert.deepEqual(writes, ["first"]);
  assert.equal(abortReason?.name, "AbortError");
  assert.equal(closed, false);
});

test("stream writer preserves the write failure while aborting the target", async () => {
  const failure = new Error("disk full");
  let abortReason;
  await assert.rejects(writeReadableStreamToWritable(streamOf("first"), {
    async write() { throw failure; },
    async close() {},
    async abort(error) { abortReason = error; },
  }), failure);
  assert.equal(abortReason, failure);
});
