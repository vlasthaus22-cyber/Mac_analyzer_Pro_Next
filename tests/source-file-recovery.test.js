import test from "node:test";
import assert from "node:assert/strict";
import { prepareOriginalSourceRecovery } from "../src/core/source-file-recovery.js";

function createDependencies(records, overrides = {}) {
  const reads = [];
  const database = {
    async listOriginalFiles(snapshotId) {
      assert.equal(snapshotId, "snapshot-1");
      return records.map(({ role, name, size }) => ({ role, name, size }));
    },
    async getOriginalFile(snapshotId, role) {
      assert.equal(snapshotId, "snapshot-1");
      return records.find((record) => record.role === role) || null;
    },
  };
  return {
    reads,
    database,
    createFile: (record) => ({ name: record.name, size: record.size, type: record.type, lastModified: record.lastModified, blob: record.blob }),
    readTable: async (file, role) => {
      reads.push({ role, name: file.name });
      return { headers: ["MAC"], rows: [[`${role}-mac`]], rowCount: 1 };
    },
    ...overrides,
  };
}

test("original source recovery stages saved files by role without mutating the database", async () => {
  const records = [
    { role: "ddio", name: "leases.csv", size: 4, blob: new globalThis.Blob(["ddio"]) },
    { role: "main", name: "devices.csv", size: 4, blob: new globalThis.Blob(["main"]) },
    { role: "smartroom", name: "rooms.csv", size: 5, blob: new globalThis.Blob(["rooms"]) },
  ];
  const dependencies = createDependencies(records);
  const progress = [];
  const result = await prepareOriginalSourceRecovery("snapshot-1", {
    database: dependencies.database,
    createFile: dependencies.createFile,
    readTable: dependencies.readTable,
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(result.map(({ role, file }) => [role, file.name]), [
    ["main", "devices.csv"], ["smartroom", "rooms.csv"], ["ddio", "leases.csv"],
  ]);
  assert.deepEqual(dependencies.reads.map(({ role }) => role), ["main", "smartroom", "ddio"]);
  assert.deepEqual(progress.at(-1), { role: "ddio", index: 3, total: 3 });
});

test("original source recovery validates every staged file before returning a queue", async () => {
  const records = [
    { role: "main", name: "devices.csv", size: 4, blob: new globalThis.Blob(["main"]) },
    { role: "smartroom", name: "rooms.csv", size: 5, blob: new globalThis.Blob(["rooms"]) },
  ];
  const dependencies = createDependencies(records, {
    readTable: async (file, role) => {
      if (role === "smartroom") throw new Error("invalid source file");
      return { headers: ["MAC"], rows: [["00:11:22:33:44:55"]] };
    },
  });
  await assert.rejects(prepareOriginalSourceRecovery("snapshot-1", dependencies), /invalid source file/);
});

test("original source recovery refuses missing files, corrupt sizes and expired engineer sessions", async () => {
  const missing = createDependencies([]);
  await assert.rejects(prepareOriginalSourceRecovery("snapshot-1", missing), /исходные файлы не сохранены/);
  await assert.rejects(prepareOriginalSourceRecovery("", missing), /Не выбран Final/);

  const corrupt = createDependencies([{ role: "main", name: "devices.csv", size: 99, blob: new globalThis.Blob(["main"]) }]);
  await assert.rejects(prepareOriginalSourceRecovery("snapshot-1", corrupt), /проверить сохранённый исходный файл MAIN/);

  const records = [{ role: "main", name: "devices.csv", size: 4, blob: new globalThis.Blob(["main"]) }];
  const expired = createDependencies(records, { isAuthorized: () => false });
  await assert.rejects(prepareOriginalSourceRecovery("snapshot-1", expired), /активном инженерном сеансе/);
});

test("original source recovery rejects a session that expires during parsing", async () => {
  const records = [{ role: "main", name: "devices.csv", size: 4, blob: new globalThis.Blob(["main"]) }];
  let checks = 0;
  const dependencies = createDependencies(records, {
    isAuthorized: () => ++checks < 3,
  });
  await assert.rejects(prepareOriginalSourceRecovery("snapshot-1", dependencies), /сеанс завершился/);
});
