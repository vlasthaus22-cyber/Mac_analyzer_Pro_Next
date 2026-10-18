import test from "node:test";
import assert from "node:assert/strict";
import { readableTextStreamFromIterable, writeReadableStreamToWritable } from "../src/core/stream-writer.js";

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

test("text stream encodes async rows on demand and stops its iterator after cancellation", async () => {
  const controller = new globalThis.AbortController();
  let produced = 0;
  let finalized = false;
  async function* rows() {
    try {
      for (const row of ["Строка 1\r\n", "Строка 2\r\n", "Строка 3\r\n"]) {
        produced += 1;
        yield row;
      }
    } finally {
      finalized = true;
    }
  }
  const stream = readableTextStreamFromIterable(rows(), { signal: controller.signal });
  const writes = [];
  await assert.rejects(writeReadableStreamToWritable(stream, {
    async write(chunk) {
      writes.push(new globalThis.TextDecoder().decode(chunk));
      controller.abort();
    },
    async close() { assert.fail("an aborted output must not close"); },
    async abort() {},
  }, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(writes, ["Строка 1\r\n"]);
  assert.equal(produced, 1);
  assert.equal(finalized, true);
});

test("text stream preserves all UTF-8 text chunks when consumed to completion", async () => {
  const stream = readableTextStreamFromIterable(["\uFEFFЗаголовок\r\n", "Данные\r\n"]);
  const blob = await new globalThis.Response(stream).blob();
  assert.equal(new globalThis.TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()), "\uFEFFЗаголовок\r\nДанные\r\n");
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
