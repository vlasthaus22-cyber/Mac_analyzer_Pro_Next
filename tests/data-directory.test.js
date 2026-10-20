import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIRECTORY_ARCHIVE_BYTES,
  PORTABLE_ARCHIVE_FILENAME,
  getDirectoryArchiveFile,
  pickDataDirectory,
  queryDirectoryPermission,
  reauthorizeDirectoryHandle,
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
  assert.equal(await queryDirectoryPermission({ queryPermission: async () => { throw new Error("stale handle"); } }), "unavailable");
});

test("reauthorization requests the retained directory and restores data only after permission is granted", async () => {
  const calls = [];
  const handle = {
    name: "Retained directory",
    requestPermission: async (options) => { calls.push(["permission", options.mode]); return "granted"; },
  };
  const result = await reauthorizeDirectoryHandle(handle, {
    onPermission: (permission) => calls.push(["state", permission]),
    onDenied: () => calls.push(["denied"]),
    onGranted: (grantedHandle) => calls.push(["restore", grantedHandle === handle]),
  });
  assert.deepEqual(result, { permission: "granted", granted: true });
  assert.deepEqual(calls, [["permission", "readwrite"], ["state", "granted"], ["restore", true]]);
});

test("denied reauthorization refreshes controls but does not read archives or refresh database state", async () => {
  const calls = [];
  const handle = { requestPermission: async () => { calls.push(["permission"]); return "prompt"; } };
  const result = await reauthorizeDirectoryHandle(handle, {
    onPermission: (permission) => calls.push(["state", permission]),
    onDenied: (permission) => calls.push(["controls", permission]),
    onGranted: () => calls.push(["restore"]),
  });
  assert.deepEqual(result, { permission: "prompt", granted: false });
  assert.deepEqual(calls, [["permission"], ["state", "prompt"], ["controls", "prompt"]]);
});

test("directory picker passes the direct read/write request and treats user cancellation as neutral", async () => {
  let options;
  const handle = { name: "MAC data" };
  assert.equal(await pickDataDirectory(async (request) => { options = request; return handle; }), handle);
  assert.deepEqual(options, { mode: "readwrite" });
  assert.equal(await pickDataDirectory(async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }), null);
  await assert.rejects(pickDataDirectory(async () => { throw new Error("permission failure"); }), /permission failure/);
});

test("directory archive lookup returns the File for streaming import without materializing its contents", async () => {
  let file = { size: 512 * 1024 * 1024, text: async () => { throw new Error("directory archive must use the streaming importer"); } };
  const handle = {
    getFileHandle: async (name, options) => {
      assert.equal(name, PORTABLE_ARCHIVE_FILENAME);
      assert.deepEqual(options, { create: false });
      if (!file) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return { getFile: async () => file };
    },
  };
  assert.equal(await getDirectoryArchiveFile(handle), file);
  file = null;
  assert.equal(await getDirectoryArchiveFile(handle), null);
  file = { size: MAX_DIRECTORY_ARCHIVE_BYTES + 1, text: async () => { throw new Error("oversized archive must fail before reading"); } };
  await assert.rejects(getDirectoryArchiveFile(handle), /превышает лимит/);
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

test("concurrent XLSX writes to the same directory and name cannot race past the no-overwrite check", async () => {
  const existingFiles = new Set();
  let writableCount = 0;
  const handle = {
    async getFileHandle(name, options) {
      if (!options.create) {
        if (existingFiles.has(name)) return {};
        throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      }
      existingFiles.add(name);
      return {
        async createWritable() {
          writableCount += 1;
          return new globalThis.WritableStream({ async write() { await new Promise((resolve) => globalThis.setTimeout(resolve, 5)); } });
        },
      };
    },
  };
  const stream = () => new globalThis.ReadableStream({ start(controller) {
    controller.enqueue(new globalThis.TextEncoder().encode("xlsx-data"));
    controller.close();
  } });
  const results = await Promise.allSettled([
    writeDirectoryFile(handle, "same_name.xlsx", stream()),
    writeDirectoryFile(handle, "same_name.xlsx", stream()),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /уже существует/);
  assert.equal(writableCount, 1);
});

test("directory XLSX writes use the browser cross-context lock for their directory and filename", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requestedLocks = [];
  const pendingLocks = new Map();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (name, callback) => {
      requestedLocks.push(name);
      const previous = pendingLocks.get(name) || Promise.resolve();
      const current = previous.catch(() => {}).then(callback);
      pendingLocks.set(name, current);
      return current.finally(() => {
        if (pendingLocks.get(name) === current) pendingLocks.delete(name);
      });
    } } },
  });
  const existingFiles = new Set();
  let writableCount = 0;
  const makeHandle = () => ({
    name: "Reports",
    async getFileHandle(name, options) {
      assert.equal(name, "unique_report.xlsx");
      if (!options.create) {
        if (existingFiles.has(name)) return {};
        throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      }
      existingFiles.add(name);
      return { createWritable: async () => {
        writableCount += 1;
        return new globalThis.WritableStream();
      } };
    },
  });
  const stream = () => new globalThis.ReadableStream({ start(controller) { controller.close(); } });
  let results;
  try {
    // IndexedDB can return cloned directory-handle objects to separate tabs.
    results = await Promise.allSettled([
      writeDirectoryFile(makeHandle(), "unique_report.xlsx", stream()),
      writeDirectoryFile(makeHandle(), "unique_report.xlsx", stream()),
    ]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /уже существует/);
  assert.equal(writableCount, 1);
  assert.deepEqual(requestedLocks, [
    "mac-analyzer-directory-file:Reports:unique_report.xlsx",
    "mac-analyzer-directory-file:Reports:unique_report.xlsx",
  ]);
});

test("unavailable cross-context lock falls back locally without retrying an operation failure", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let writableCount = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async () => { throw new Error("lock unavailable for this origin"); } } },
  });
  const handle = {
    name: "Reports",
    async getFileHandle(_name, options) {
      if (!options.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return { createWritable: async () => { writableCount += 1; return new globalThis.WritableStream(); } };
    },
  };
  try {
    await writeDirectoryFile(handle, "lock_fallback.xlsx", new globalThis.ReadableStream({ start(controller) { controller.close(); } }));
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
  assert.equal(writableCount, 1);

  const originalLocks = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let failedWriteCount = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name, callback) => callback() } },
  });
  const failingHandle = {
    name: "Reports",
    async getFileHandle(_name, options) {
      if (!options.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return { createWritable: async () => {
        failedWriteCount += 1;
        return new globalThis.WritableStream({ write() { throw new Error("disk full"); } });
      } };
    },
  };
  try {
    const broken = new globalThis.ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await assert.rejects(writeDirectoryFile(failingHandle, "lock_failure.xlsx", broken), /disk full/);
  } finally {
    if (originalLocks) Object.defineProperty(globalThis, "navigator", originalLocks);
    else delete globalThis.navigator;
  }
  assert.equal(failedWriteCount, 1);
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
