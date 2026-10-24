import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSQLite, iterator, useMemoryStorage, withExistDB } from "@subframe7536/sqlite-wasm";
import { importLegacySQLiteFile } from "../src/data/sqlite-database-importer.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Передайте путь к SQLite-файлу: node scripts/check-reference-sqlite-mapper.mjs <database.db>");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wasm = await readFile(resolve(root, "node_modules/@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm"));
const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
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

const source = await openReadOnlyFile(sourcePath);
let wal = null;
try {
  try {
    wal = await openReadOnlyFile(`${sourcePath}-wal`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
} catch (error) {
  await source.close();
  throw error;
}
const file = source.file;
const walFile = wal?.file || null;

const runtime = {
  initSQLite,
  iterator,
  withExistDB,
  useIdbStorage: async (name, options) => ({ ...await useMemoryStorage(options), path: name }),
};
const counts = {};
const maxBatchSize = {};
let totalRows = 0;
let snapshotDeviceRows = 0;
let nonRecordEvents = 0;
const sink = {
  async importArchiveEvents(header, events) {
    if (header?.format !== "MAC_ANALYZER_NEXT_ARCHIVE" || header.version !== 1) {
      throw new Error("Production SQLite mapper returned an unexpected archive header");
    }
    for await (const event of events) {
      if (event?.type === "records") {
        const collection = String(event.collection || "unknown");
        const size = Array.isArray(event.records) ? event.records.length : 0;
        counts[collection] = (counts[collection] || 0) + size;
        maxBatchSize[collection] = Math.max(maxBatchSize[collection] || 0, size);
        totalRows += size;
      } else if (event?.type === "snapshotChunk") {
        snapshotDeviceRows += Array.isArray(event.devices) ? event.devices.length : 0;
      } else {
        nonRecordEvents += 1;
      }
    }
  },
};

try {
  const report = await importLegacySQLiteFile(file, sink, {
    runtime,
    wasmUrl,
    walFile,
    deleteTemporaryDatabase: async () => {},
  });
  process.stdout.write(`${JSON.stringify({
    file: basename(sourcePath),
    bytes: source.file.size,
    walBytes: walFile?.size || 0,
    integrity: report.integrity,
    tables: report.tables,
    imported: report.imported,
    mapperRows: totalRows,
    snapshotDeviceRows,
    maxBatchSize,
    skippedTables: report.skippedTables,
    skippedRows: report.skippedRows,
    nonRecordEvents,
    destinationWritten: false,
  }, null, 2)}\n`);
  if (report.integrity !== "ok" || Object.values(report.skippedRows || {}).some((count) => Number(count) > 0)) process.exitCode = 1;
} finally {
  await source.close();
  await wal?.close();
}
