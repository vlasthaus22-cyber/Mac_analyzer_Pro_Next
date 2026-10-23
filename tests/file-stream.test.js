import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream, WritableStream } from "node:stream/web";
import { requestReadableStreamFileHandle, saveReadableStreamToFile } from "../src/core/file-stream.js";

test("portable archive stream is piped to the user-selected file without building a Blob", async () => {
  const chunks = ["{\"archive\":", "\"data\"}"];
  let pickerOptions;
  let written = "";
  let closed = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  });
  const saved = await saveReadableStreamToFile(stream, {
    suggestedName: "devices.macarchive.json",
    description: "Archive",
    mimeType: "application/json",
    extension: ".macarchive.json",
    picker: async (options) => {
      pickerOptions = options;
      return {
        createWritable: async () => new WritableStream({
          write(chunk) { written += chunk; },
          close() { closed = true; },
        }),
      };
    },
  });

  assert.equal(saved, true);
  assert.equal(written, "{\"archive\":\"data\"}");
  assert.equal(closed, true);
  assert.equal(pickerOptions.suggestedName, "devices.macarchive.json");
  assert.deepEqual(pickerOptions.types, [{ description: "Archive", accept: { "application/json": [".macarchive.json"] } }]);
});

test("stream export reports unavailable picker without consuming the archive", async () => {
  let reads = 0;
  const stream = { pipeTo: async () => { reads += 1; } };
  assert.equal(await saveReadableStreamToFile(stream, { picker: null }), false);
  assert.equal(reads, 0);
});

test("stream export preserves picker and filesystem write errors", async () => {
  const cancelled = new globalThis.DOMException("The user aborted a request.", "AbortError");
  await assert.rejects(saveReadableStreamToFile(new ReadableStream(), { picker: async () => { throw cancelled; } }), { name: "AbortError" });
  await assert.rejects(saveReadableStreamToFile(new ReadableStream(), {
    picker: async () => ({ createWritable: async () => { throw new Error("disk full"); } }),
  }), /disk full/);
});

test("a save handle requested before async archive work can be reused without another picker", async () => {
  let resolveHandle;
  let pickerCalls = 0;
  let written = "";
  const handlePromise = requestReadableStreamFileHandle({
    suggestedName: "history.madb.json",
    extension: ".madb.json",
    picker: async (options) => {
      pickerCalls += 1;
      assert.equal(options.suggestedName, "history.madb.json");
      return new Promise((resolve) => { resolveHandle = resolve; });
    },
  });
  assert.equal(pickerCalls, 1);
  const handle = { createWritable: async () => new WritableStream({ write(chunk) { written += chunk; } }) };
  resolveHandle(handle);
  const saved = await saveReadableStreamToFile(new ReadableStream({ start(controller) { controller.enqueue("archive"); controller.close(); } }), {
    fileHandle: await handlePromise,
    picker: () => { throw new Error("picker must not be called twice"); },
  });
  assert.equal(saved, true);
  assert.equal(written, "archive");
  assert.equal(pickerCalls, 1);
});
