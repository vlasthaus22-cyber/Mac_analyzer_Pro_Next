import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIRECTORY_ARCHIVE_BYTES,
  PORTABLE_ARCHIVE_FILENAME,
  getDirectoryArchiveFile,
  pickDataDirectory,
  queryDirectoryPermission,
  readDirectoryArchive,
  requestDirectoryPermission,
  writeDirectoryArchive,
  writeDirectoryFile,
} from "../src/data/data-directory.js";

test("directory permission checks and requests use read/write mode", async () => {
  const modes = [];
  const handle = {
    queryPermission: async (options) => { modes.push(["query", options.mode]); return "prompt"; },
    requestPermission: async (options) => { modes.push(["request", options.mode]); return "granted"; },
  };
  assert.equal(await queryDirectoryPermission(handle), "prompt");
  assert.equal(await requestDirectoryPermission(handle), "granted");
  assert.deepEqual(modes, [["query", "readwrite"], ["request", "readwrite"]]);
  assert.equal(await queryDirectoryPermission(null), "unavailable");
});

test("directory picker passes the direct read/write request and treats user cancellation as neutral", async () => {
  let options;
  const handle = { name: "MAC data" };
  assert.equal(await pickDataDirectory(async (request) => { options = request; return handle; }), handle);
  assert.deepEqual(options, { mode: "readwrite" });
  assert.equal(await pickDataDirectory(async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }), null);
  await assert.rejects(pickDataDirectory(async () => { throw new Error("permission failure"); }), /permission failure/);
});

test("directory archive reader handles missing, valid, oversized and invalid archive files", async () => {
  let file = { size: 2, text: async () => '{"version":1}' };
  const handle = {
    getFileHandle: async (name, options) => {
      assert.equal(name, PORTABLE_ARCHIVE_FILENAME);
      assert.deepEqual(options, { create: false });
      if (!file) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return { getFile: async () => file };
    },
  };
  assert.equal(await getDirectoryArchiveFile(handle), file);
  assert.deepEqual(await readDirectoryArchive(handle), { version: 1 });
  file = null;
  assert.equal(await getDirectoryArchiveFile(handle), null);
  assert.equal(await readDirectoryArchive(handle), null);
  file = { size: MAX_DIRECTORY_ARCHIVE_BYTES + 1, text: async () => "{}" };
  await assert.rejects(readDirectoryArchive(handle), /превышает лимит/);
  file = { size: 2, text: async () => "{" };
  await assert.rejects(readDirectoryArchive(handle), /Не удалось прочитать portable archive/);
});

test("directory archive writer pipes the portable stream to one file", async () => {
  let fileName = "";
  let created = false;
  let contents = "";
  const handle = {
    getFileHandle: async (name, options) => {
      fileName = name;
      created = options.create;
      return {
        createWritable: async () => new globalThis.WritableStream({ write(chunk) { contents += new globalThis.TextDecoder().decode(chunk); } }),
      };
    },
  };
  const stream = new globalThis.ReadableStream({ start(controller) { controller.enqueue(new globalThis.TextEncoder().encode("portable-data")); controller.close(); } });
  await writeDirectoryArchive(handle, stream);
  assert.equal(fileName, PORTABLE_ARCHIVE_FILENAME);
  assert.equal(created, true);
  assert.equal(contents, "portable-data");
});

test("directory archive writer aborts a partial write and preserves the write error", async () => {
  let aborted = null;
  const failure = new Error("disk full");
  const handle = {
    getFileHandle: async () => ({
      createWritable: async () => new globalThis.WritableStream({
        write() {},
        abort(error) { aborted = error; },
      }),
    }),
  };
  const stream = new globalThis.ReadableStream({
    pull(controller) { controller.error(failure); },
  });
  await assert.rejects(writeDirectoryArchive(handle, stream), (error) => error === failure);
  assert.equal(aborted, failure);
});

test("directory archive writer aborts without committing an archive over its transfer limit", async () => {
  let committed = false;
  let aborted = null;
  const handle = {
    getFileHandle: async () => ({
      createWritable: async () => new globalThis.WritableStream({
        write() {},
        close() { committed = true; },
        abort(error) { aborted = error; },
      }),
    }),
  };
  const stream = new globalThis.ReadableStream({ start(controller) {
    controller.enqueue(new globalThis.TextEncoder().encode("too-large"));
    controller.close();
  } });
  await assert.rejects(writeDirectoryArchive(handle, stream, { maxBytes: 4 }), /превышает лимит/);
  assert.equal(committed, false);
  assert.match(aborted.message, /превышает лимит/);
});

test("directory file writer streams unique XLSX files and refuses to overwrite existing files", async () => {
  let contents = "";
  let writableCreated = false;
  const calls = [];
  const handle = {
    getFileHandle: async (name, options) => {
      calls.push([name, options.create]);
      if (name === "autosave_existing.xlsx" && !options.create) return {};
      if (name === "autosave_existing.xlsx") throw new Error("Existing file must not be opened for writing");
      if (!options.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return {
        createWritable: async (optionsArg) => {
          writableCreated = true;
          assert.deepEqual(optionsArg, { keepExistingData: false });
          return new globalThis.WritableStream({ write(chunk) { contents += new globalThis.TextDecoder().decode(chunk); } });
        },
      };
    },
  };
  const stream = () => new globalThis.ReadableStream({ start(controller) {
    controller.enqueue(new globalThis.TextEncoder().encode("xlsx-data"));
    controller.close();
  } });
  assert.deepEqual(await writeDirectoryFile(handle, "autosave_20261017_120000_001_a1b2c3d4.xlsx", stream()), {
    fileName: "autosave_20261017_120000_001_a1b2c3d4.xlsx",
    bytesWritten: 9,
  });
  assert.equal(contents, "xlsx-data");
  assert.equal(writableCreated, true);
  await assert.rejects(writeDirectoryFile(handle, "autosave_existing.xlsx", stream()), /уже существует/);
  assert.deepEqual(calls.slice(-1), [["autosave_existing.xlsx", false]]);
  await assert.rejects(writeDirectoryFile(handle, "../unsafe.xlsx", stream()), /Недопустимое имя/);
});

test("directory XLSX writer aborts an oversized partial file", async () => {
  let committed = false;
  let aborted = null;
  const handle = {
    getFileHandle: async (_name, options) => options.create
      ? { createWritable: async () => new globalThis.WritableStream({ close() { committed = true; }, abort(error) { aborted = error; } }) }
      : Promise.reject(Object.assign(new Error("missing"), { name: "NotFoundError" })),
  };
  const stream = new globalThis.ReadableStream({ start(controller) {
    controller.enqueue(new globalThis.TextEncoder().encode("too-large"));
    controller.close();
  } });
  await assert.rejects(writeDirectoryFile(handle, "autosave_test_12345.xlsx", stream, { maxBytes: 4 }), /превышает лимит/);
  assert.equal(committed, false);
  assert.match(aborted.message, /превышает лимит/);
});
