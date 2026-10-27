import "fake-indexeddb/auto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initSQLite, iterator, useMemoryStorage, withExistDB } from "@subframe7536/sqlite-wasm";
import { Database } from "../src/data/database.js";
import { importLegacySQLiteFile } from "../src/data/sqlite-database-importer.js";
import { inspectReferenceImportAuditCounts } from "./reference-import-audit.js";
import { formatReferenceImportHeartbeat } from "./reference-import-progress.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Передайте путь к SQLite-файлу: node scripts/check-reference-sqlite-import.mjs <database.db>");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wasm = await readFile(resolve(root, "node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm"));
const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
const databaseName = `mac-analyzer-reference-import-${randomUUID()}`;

async function openReadOnlyFile(path) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`Путь должен указывать на файл: ${basename(path)}`);
  const handle = await open(path, "r");
  return {
    file: {
      name: basename(path),
      size: fileStat.size,
      slice(start, end) {
        const from = Math.max(0, Number(start) || 0);
        const to = end === undefined ? fileStat.size : Math.min(Number(end) || 0, fileStat.size);
        const length = Math.max(0, to - from);
        return {
          async arrayBuffer() {
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, from);
            return buffer.subarray(0, bytesRead).buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
          },
        };
      },
    },
    close: () => handle.close(),
  };
}

function countStore(database, storeName) {
  return new Promise((resolveCount, reject) => {
    const tx = database.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).count();
    request.onsuccess = () => resolveCount(request.result);
    request.onerror = () => reject(request.error || new Error(`Не удалось посчитать ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Чтение ${storeName} отменено`));
  });
}

function deleteDisposableDatabase(name) {
  return new Promise((resolveDelete, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolveDelete();
    request.onerror = () => reject(request.error || new Error("Не удалось удалить временную IndexedDB"));
    request.onblocked = () => reject(new Error("Временная IndexedDB всё ещё открыта и не может быть удалена"));
  });
}

const runtime = {
  initSQLite,
  iterator,
  withExistDB,
  useIdbStorage: async (name, options) => ({ ...await useMemoryStorage(options), path: name }),
};
const database = new Database(databaseName);
const source = await openReadOnlyFile(sourcePath);
let wal = null;
let lastProgressKey = "";
let lastProgressAt = 0;
const auditStartedAt = Date.now();
let latestProgress = null;
const restoreCounts = new Map();
const heartbeat = setInterval(() => {
  process.stdout.write(`${formatReferenceImportHeartbeat({
    elapsedMs: Date.now() - auditStartedAt,
    lastProgress: latestProgress,
  })}\n`);
}, 15_000);
heartbeat.unref?.();

try {
  try {
    wal = await openReadOnlyFile(`${sourcePath}-wal`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const progress = (entry = {}) => {
    const stage = String(entry.stage || "import");
    const subject = String(entry.collection || entry.table || entry.fileName || "");
    const processed = Number(entry.recordsProcessed ?? entry.bytesRead);
    const total = Number(entry.totalRecords ?? entry.totalBytes);
    if (stage === "restoring" && subject && Number.isSafeInteger(total) && total >= 0) restoreCounts.set(subject, total);
    const now = Date.now();
    latestProgress = { stage, subject, processed, total, at: now };
    const key = `${stage}\u0000${subject}`;
    const complete = Number.isFinite(total) && total > 0 && processed >= total;
    if (key !== lastProgressKey || now - lastProgressAt >= 10_000 || complete) {
      const suffix = Number.isFinite(processed) && processed >= 0
        ? ` ${Math.trunc(processed).toLocaleString("en-US")}${Number.isFinite(total) && total > 0 ? `/${Math.trunc(total).toLocaleString("en-US")}` : ""}`
        : "";
      process.stdout.write(`[${stage}]${subject ? ` ${subject}` : ""}${suffix}\n`);
      lastProgressKey = key;
      lastProgressAt = now;
    }
  };
  const report = await importLegacySQLiteFile(source.file, database, {
    runtime,
    wasmUrl,
    walFile: wal?.file || null,
    deleteTemporaryDatabase: async () => {},
    onProgress: progress,
  });
  const target = await database.open();
  const storeNames = [
    "snapshots", "inventory", "history", "legacyObservations", "settings", "oui", "mac5Models",
    "dataQualityReports", "legacySmartroomRoomMappings",
  ];
  const storeCounts = {};
  for (const storeName of storeNames) {
    if (target.objectStoreNames.contains(storeName)) storeCounts[storeName] = await countStore(target, storeName);
  }
  const auditCounts = inspectReferenceImportAuditCounts({
    restoreCounts,
    storeCounts,
    imported: report.imported,
  });
  process.stdout.write(`${JSON.stringify({
    source: basename(sourcePath),
    sourceBytes: source.file.size,
    walBytes: wal?.file.size || 0,
    integrity: report.integrity,
    tables: report.tables,
    imported: report.imported,
    restoreCounts: Object.fromEntries(restoreCounts),
    storeCounts,
    exactRestoreChecks: auditCounts.exactRestoreChecks,
    mappedRecordChecks: auditCounts.mappedRecordChecks,
    skippedTables: report.skippedTables,
    skippedRows: report.skippedRows,
    destination: "unique disposable in-memory IndexedDB",
  }, null, 2)}\n`);
  if (report.integrity !== "ok" || !auditCounts.passed
    || Object.values(report.skippedRows || {}).some((count) => Number(count) > 0)) process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  database.connection?.close();
  try {
    await deleteDisposableDatabase(databaseName);
  } finally {
    await Promise.all([source.close(), ...(wal ? [wal.close()] : [])]);
  }
}
