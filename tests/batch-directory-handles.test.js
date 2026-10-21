import test from "node:test";
import assert from "node:assert/strict";
import {
  batchDirectoryHandleKey,
  batchSourceFileRelativePath,
  createBatchDirectoryHandleRecord,
  inspectBatchDirectoryHandle,
  listBatchDirectoryFiles,
  requestBatchDirectoryPermission,
} from "../src/core/batch-directory-handles.js";

function directory(name, entries = [], permission = "granted") {
  return {
    kind: "directory",
    name,
    queryPermission: async ({ mode }) => { assert.equal(mode, "read"); return permission; },
    requestPermission: async ({ mode }) => { assert.equal(mode, "read"); return permission; },
    async *entries() { for (const entry of entries) yield entry; },
  };
}

function file(name) {
  let reads = 0;
  return {
    kind: "file",
    name,
    get reads() { return reads; },
    async getFile() { reads += 1; return { name, size: 12, lastModified: 34 }; },
  };
}

test("batch directory handles validate roles and store only the browser handle name", () => {
  const handle = directory("Main exports");
  assert.deepEqual(createBatchDirectoryHandleRecord("main", handle, "2026-10-21T00:00:00Z"), {
    key: "workspace-batch-directory:main", role: "main", handle, name: "Main exports", savedAt: "2026-10-21T00:00:00Z",
  });
  assert.equal(batchDirectoryHandleKey("ddio"), "workspace-batch-directory:ddio");
  assert.throws(() => batchDirectoryHandleKey("history"), /Неизвестная роль/);
  assert.throws(() => createBatchDirectoryHandleRecord("main", { kind: "file", entries() {} }), /дескриптор папки/);
});

test("saved batch directories are enumerated only after read permission is granted", async () => {
  let scans = 0;
  const handle = directory("Main", [], "prompt");
  const originalEntries = handle.entries;
  handle.entries = async function* entries() { scans += 1; yield* originalEntries.call(this); };
  assert.deepEqual(await inspectBatchDirectoryHandle({ handle }), {
    permission: "prompt", handle: null, error: "Браузеру нужно разрешить чтение папки",
  });
  assert.equal(scans, 0);
  handle.queryPermission = async () => "granted";
  const inspected = await inspectBatchDirectoryHandle({ handle });
  assert.equal(inspected.handle, handle);
  assert.equal((await listBatchDirectoryFiles(inspected.handle)).length, 0);
  assert.equal(scans, 1);
});

test("batch directory traversal recursively returns supported files in stable order", async () => {
  const first = file("2026-10-21-main.csv");
  const nestedXlsx = file("2026-10-21-smartroom.xlsx");
  const ignored = file("readme.md");
  const nested = directory("z", [[nestedXlsx.name, nestedXlsx]]);
  const root = directory("Main", [
    [ignored.name, ignored],
    ["nested", nested],
    [first.name, first],
  ]);
  const files = await listBatchDirectoryFiles(root);
  assert.deepEqual(files.map((item) => item.name), [first.name, nestedXlsx.name]);
  assert.equal(first.reads, 1);
  assert.equal(nestedXlsx.reads, 1);
  assert.equal(ignored.reads, 0);
});

test("restored batch files keep distinct relative paths when nested folders reuse a basename", async () => {
  const firstFile = Object.assign(new globalThis.Blob(["MAC\n00:11:22:33:44:55\n"]), { name: "main_2026-10-21.csv", lastModified: 1 });
  const secondFile = Object.assign(new globalThis.Blob(["MAC\n00:11:22:33:44:66\n"]), { name: "main_2026-10-21.csv", lastModified: 1 });
  const root = directory("exports", [
    ["west", directory("west", [[firstFile.name, { kind: "file", getFile: async () => firstFile }]])],
    ["east", directory("east", [[secondFile.name, { kind: "file", getFile: async () => secondFile }]])],
  ]);
  const files = await listBatchDirectoryFiles(root);
  assert.deepEqual(files.map(batchSourceFileRelativePath), [
    "exports/east/main_2026-10-21.csv",
    "exports/west/main_2026-10-21.csv",
  ]);
  assert.equal(files[0].name, files[1].name, "the parser keeps the original base filename");
});

test("batch directory reauthorization requests read-only access and contains denial", async () => {
  const handle = directory("Main", [], "granted");
  assert.equal(await requestBatchDirectoryPermission(handle), "granted");
  assert.equal(await requestBatchDirectoryPermission({ kind: "file" }), "unavailable");
  assert.equal(await requestBatchDirectoryPermission({ kind: "directory", requestPermission: async () => { throw new Error("denied"); } }), "unavailable");
});
