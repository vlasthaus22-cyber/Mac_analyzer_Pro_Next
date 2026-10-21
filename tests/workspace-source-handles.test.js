import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceSourceHandleRecord,
  inspectWorkspaceSourceHandle,
  requestWorkspaceSourcePermission,
  workspaceSourceFileMatchesRecord,
  workspaceSourceHandleKey,
} from "../src/core/workspace-source-handles.js";

test("workspace source handles keep only origin-local file metadata and a valid role", () => {
  const handle = { kind: "file", getFile() {} };
  const record = createWorkspaceSourceHandleRecord("main", handle, {
    name: "Main.csv", type: "text/csv", size: 17, lastModified: 123,
  }, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(record, {
    key: "workspace-source:main", role: "main", handle, name: "Main.csv", type: "text/csv",
    size: 17, lastModified: 123, savedAt: "2026-10-21T00:00:00.000Z",
  });
  assert.throws(() => workspaceSourceHandleKey("inventory"), /Неизвестная роль/);
  assert.throws(() => createWorkspaceSourceHandleRecord("main", { kind: "directory" }, { size: 0 }), /дескриптор файла/);
  assert.throws(() => createWorkspaceSourceHandleRecord("main", handle, { size: -1 }), /Метаданные/);
});

test("workspace source file fingerprint requires unchanged name, size, and modified time", () => {
  const record = { name: "Main.csv", size: 17, lastModified: 123 };
  assert.equal(workspaceSourceFileMatchesRecord({ ...record }, record), true);
  assert.equal(workspaceSourceFileMatchesRecord({ ...record, lastModified: 124 }, record), false);
  assert.equal(workspaceSourceFileMatchesRecord({ ...record, size: 18 }, record), false);
  assert.equal(workspaceSourceFileMatchesRecord({ ...record, name: "Other.csv" }, record), false);
});

test("saved workspace handles are not read until the browser reports granted permission", async () => {
  let opened = 0;
  const file = { name: "Main.csv", size: 10 };
  const handle = { kind: "file", queryPermission: async ({ mode }) => { assert.equal(mode, "read"); return "prompt"; }, getFile: async () => { opened += 1; return file; } };
  assert.deepEqual(await inspectWorkspaceSourceHandle({ handle }), {
    permission: "prompt", file: null, error: "Браузеру нужно разрешить доступ к исходному файлу",
  });
  assert.equal(opened, 0);
  handle.queryPermission = async () => "granted";
  assert.deepEqual(await inspectWorkspaceSourceHandle({ handle }), { permission: "granted", file, error: "" });
  assert.equal(opened, 1);
});

test("workspace handle reauthorization requests read-only access and contains rejected permissions", async () => {
  const calls = [];
  const handle = { kind: "file", requestPermission: async (options) => { calls.push(options); return "granted"; } };
  assert.equal(await requestWorkspaceSourcePermission(handle), "granted");
  assert.deepEqual(calls, [{ mode: "read" }]);
  assert.equal(await requestWorkspaceSourcePermission({ kind: "file", requestPermission: async () => { throw new Error("denied"); } }), "unavailable");
  assert.equal(await requestWorkspaceSourcePermission({ kind: "directory" }), "unavailable");
});
