import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { compareFinals } from "../src/core/comparison.js";
import { enrich } from "../src/core/enrichment.js";
import { batchFailureAction, normalizeBatchPairing, pairBatchEntries, batchPairProblems, batchQueueProblems, prepareBatchEntries, reassignBatchSource, runBatchQueue, unmatchedBatchEntries } from "../src/core/batch.js";
import { Database } from "../src/data/database.js";
import { readTableRowBatches } from "../src/data/importer.js";
import { customInventoryColumnKey } from "../src/core/inventory-columns.js";
import { legacyXlsFile, sheetJs } from "./helpers/sheetjs-runtime.js";

function entry(id, role, date) {
  return {
    id,
    role,
    file: { name: `${id}.csv` },
    date: { date },
    mapping: role === "main" ? { mac: 0 } : role === "smartroom" ? { mac: 0 } : { reservationMac: 0, reservationIp: 1 },
  };
}

function xlsxFile(entries, name) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [path, source] of Object.entries(entries)) {
    const fileName = Buffer.from(path);
    const plain = Buffer.from(source);
    const compressed = deflateRawSync(plain);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(plain.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(plain.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, fileName);
    offset += header.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const blob = new globalThis.Blob([...local, directory, end]);
  return Object.assign(blob, { name });
}

test("batch failure policy explicitly continues, stops, and always honors cancellation", () => {
  assert.equal(batchFailureAction("continue", new Error("read failed")), "continue");
  assert.equal(batchFailureAction("stop", new Error("write failed")), "stop");
  assert.equal(batchFailureAction("continue", Object.assign(new Error("cancelled"), { name: "AbortError" })), "stop");
  assert.throws(() => batchFailureAction("silent", new Error("failed")), /Неизвестная политика очереди/);
});

test("serial batch runner continues after errors only when selected and leaves later cycles pending when stopped", async () => {
  const makePairs = () => [1, 2, 3].map((id) => ({ id, enabled: true, status: "ready", main: { file: { name: `main-${id}.csv` } } }));
  const run = async (failurePolicy) => {
    const pairs = makePairs();
    const visited = [];
    const result = await runBatchQueue(pairs, async (pair) => {
      visited.push(pair.id);
      if (pair.id === 2) throw new Error("cycle failure");
      return { metadata: { reused: pair.id === 1 } };
    }, { failurePolicy });
    return { pairs, visited, result };
  };

  const continued = await run("continue");
  assert.deepEqual(continued.visited, [1, 2, 3]);
  assert.deepEqual(continued.pairs.map((pair) => pair.status), ["reused", "error", "completed"]);
  assert.equal(continued.result.completed, 2);
  assert.equal(continued.result.errors[0].pairIndex, 2);
  assert.equal(continued.result.stopped, false);

  const stopped = await run("stop");
  assert.deepEqual(stopped.visited, [1, 2]);
  assert.deepEqual(stopped.pairs.map((pair) => pair.status), ["reused", "error", "ready"]);
  assert.equal(stopped.result.completed, 1);
  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.result.failedPairIndex, 2);
  assert.match(stopped.pairs[2].queueMessage, /Не запускался: очередь остановлена после ошибки пары №2/);

  const cancelledPairs = makePairs();
  const cancelled = await runBatchQueue(cancelledPairs, async (_pair, index) => {
    if (index === 1) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    return { metadata: {} };
  }, { failurePolicy: "continue" });
  assert.deepEqual(cancelledPairs.map((pair) => pair.status), ["completed", "cancelled", "ready"]);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.stopped, false);
  assert.match(cancelledPairs[2].queueMessage, /Не запускался: обработка отменена/);
});

test("batch queue continues after an atomic Final write failure without losing earlier or later successful Finals", async () => {
  const runIntegration = async (failurePolicy) => {
    const prefix = "batch-final-" + crypto.randomUUID();
    const database = new Database(prefix);
    const failureId = prefix + "-failed";
    const nativePut = globalThis.IDBObjectStore.prototype.put;
    globalThis.IDBObjectStore.prototype.put = function injectBatchWriteFailure(value, key) {
      if (this.name === "snapshotChunks" && value?.snapshotId === failureId) {
        throw new globalThis.DOMException("Injected quota failure", "QuotaExceededError");
      }
      return nativePut.call(this, value, key);
    };
    const pairs = ["first", "failed", "later"].map((id) => ({
      id, enabled: true, status: "ready", main: { file: { name: "main-" + id + ".csv" } },
    }));
    let failed = false;
    try {
      const result = await runBatchQueue(pairs, async (pair) => {
        if (pair.id === "failed") {
          failed = true;
          return database.saveFinal({
            id: failureId, name: "Failed pair", devices: [{ id: "failed-device", mac: "AA:BB:CC:00:00:02" }],
          });
        }
        const previous = pair.id === "later" ? await database.loadSnapshot(prefix + "-first") : null;
        const devices = [{
          id: "stable-device",
          mac: "00:11:22:33:44:55",
          model: pair.id === "first" ? "Model A" : "Model B",
        }];
        return database.saveFinal({
          id: prefix + "-" + pair.id,
          name: pair.id,
          createdAt: pair.id === "first" ? "2026-10-15T00:00:00Z" : "2026-10-17T00:00:00Z",
          devices,
          comparison: previous ? compareFinals(previous.devices, devices, "2026-10-17T00:00:00Z") : null,
        });
      }, {
        failurePolicy,
        onError: (error, pair) => pair.id + ": " + error.message,
      });
      return { database, pairs, result, failed };
    } finally {
      globalThis.IDBObjectStore.prototype.put = nativePut;
    }
  };

  const continued = await runIntegration("continue");
  assert.equal(continued.failed, true);
  assert.deepEqual(continued.pairs.map(({ status }) => status), ["completed", "error", "completed"]);
  assert.equal(continued.result.completed, 2);
  assert.equal(continued.result.errors.length, 1);
  assert.equal((await continued.database.getSetting("activeSnapshotId")), continued.pairs[2].result.id);
  assert.deepEqual((await continued.database.listSnapshots()).map(({ id }) => id), [continued.pairs[0].result.id, continued.pairs[2].result.id]);
  const continuedDb = await continued.database.open();
  const continuedTx = continuedDb.transaction(["inventory", "history"], "readonly");
  const continuedDone = new Promise((resolve, reject) => {
    continuedTx.oncomplete = resolve;
    continuedTx.onerror = () => reject(continuedTx.error);
    continuedTx.onabort = () => reject(continuedTx.error);
  });
  const inventoryRequest = continuedTx.objectStore("inventory").get("stable-device");
  const failedInventoryRequest = continuedTx.objectStore("inventory").get("failed-device");
  const historyRequest = continuedTx.objectStore("history").count();
  const [stableInventory, failedInventory, historyCount] = await Promise.all([
    new Promise((resolve, reject) => { inventoryRequest.onsuccess = () => resolve(inventoryRequest.result); inventoryRequest.onerror = () => reject(inventoryRequest.error); }),
    new Promise((resolve, reject) => { failedInventoryRequest.onsuccess = () => resolve(failedInventoryRequest.result); failedInventoryRequest.onerror = () => reject(failedInventoryRequest.error); }),
    new Promise((resolve, reject) => { historyRequest.onsuccess = () => resolve(historyRequest.result); historyRequest.onerror = () => reject(historyRequest.error); }),
  ]);
  await continuedDone;
  assert.equal(stableInventory.model, "Model B");
  assert.equal(stableInventory.observationCount, 2);
  assert.equal(failedInventory, undefined);
  assert.equal(historyCount, 1);

  const stopped = await runIntegration("stop");
  assert.deepEqual(stopped.pairs.map(({ status }) => status), ["completed", "error", "ready"]);
  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.result.failedPairIndex, 2);
  assert.equal((await stopped.database.getSetting("activeSnapshotId")), stopped.pairs[0].result.id);
  assert.deepEqual((await stopped.database.listSnapshots()).map(({ id }) => id), [stopped.pairs[0].result.id]);
  assert.match(stopped.pairs[2].queueMessage, /Не запускался: очередь остановлена после ошибки пары №2/);
});

test("batch assignment is one-to-one and chooses globally closest dates", () => {
  const pairs = pairBatchEntries(
    [entry("main-1", "main", "2026-09-01T08:00:00Z"), entry("main-2", "main", "2026-09-01T18:00:00Z")],
    [entry("sr-1", "smartroom", "2026-09-01T09:00:00Z")],
    [entry("ddio-1", "ddio", "2026-09-01T17:00:00Z"), entry("ddio-2", "ddio", "2026-09-02T02:00:00Z")],
  );
  assert.equal(pairs[0].smartroom.id, "sr-1");
  assert.equal(pairs[1].smartroom, null);
  assert.equal(pairs[0].ddio.id, "ddio-2");
  assert.equal(pairs[1].ddio.id, "ddio-1");
  assert.deepEqual(pairs.unmatched, []);
});

test("batch assignment leaves unknown dates and out-of-window files for manual pairing", () => {
  const pairs = pairBatchEntries(
    [entry("main", "main", "")],
    [entry("smartroom", "smartroom", "")],
    [entry("ddio", "ddio", "2026-09-04T00:00:00Z")],
  );
  assert.equal(pairs[0].smartroom, null);
  assert.equal(pairs[0].ddio, null);
  assert.deepEqual(pairs.unmatched.map((item) => item.id).sort(), ["ddio", "smartroom"]);
});

test("manual batch reassignment stays one-to-one, invalidates review, and lists newly unmatched files", () => {
  const candidates = [entry("sr-a", "smartroom", "2026-09-01T00:00:00Z"), entry("sr-b", "smartroom", "2026-09-01T01:00:00Z"), entry("sr-c", "smartroom", "2026-09-01T02:00:00Z")];
  const pairs = [
    { id: "pair-1", smartroom: candidates[0], ddio: null, reviewed: true },
    { id: "pair-2", smartroom: candidates[1], ddio: null, reviewed: true, enabled: false },
  ];
  const entries = { smartroom: candidates, ddio: [] };
  reassignBatchSource(pairs, entries, 0, "smartroom", "sr-b");
  assert.equal(pairs[0].smartroom, candidates[1]);
  assert.equal(pairs[1].smartroom, null);
  assert.equal(pairs[0].reviewed, false);
  assert.deepEqual(unmatchedBatchEntries(pairs, entries), [candidates[0], candidates[2]]);
  reassignBatchSource(pairs, entries, 0, "smartroom", "");
  assert.equal(pairs[0].smartroom, null);
  assert.deepEqual(unmatchedBatchEntries(pairs, entries), [candidates[0], candidates[1], candidates[2]]);
  assert.throws(() => reassignBatchSource(pairs, entries, 0, "main", "sr-a"), /SmartRoom или DDIO/);
});

test("batch supports same-calendar-day pairing and a configurable nearest-date tolerance", () => {
  const mains = [entry("main", "main", "2026-09-01T23:30:00Z")];
  const candidates = [entry("next-day", "smartroom", "2026-09-02T00:10:00Z")];
  assert.equal(pairBatchEntries(mains, candidates, [], { mode: "same-date" })[0].smartroom, null);
  assert.equal(pairBatchEntries(mains, candidates, [], { mode: "nearest", toleranceHours: 1 })[0].smartroom.id, "next-day");
  assert.equal(pairBatchEntries(mains, candidates, [], { mode: "nearest", toleranceHours: 0.5 })[0].smartroom, null);
});

test("batch pairing normalizes tolerance and honors the complete supported 0–720 hour range", () => {
  assert.deepEqual(normalizeBatchPairing({ mode: "same-date", toleranceHours: "0.25" }), { mode: "same-date", toleranceHours: 0.25 });
  assert.deepEqual(normalizeBatchPairing({ mode: "unknown", toleranceHours: -1 }), { mode: "nearest", toleranceHours: 0 });
  assert.deepEqual(normalizeBatchPairing({ toleranceHours: 721 }), { mode: "nearest", toleranceHours: 720 });
  assert.deepEqual(normalizeBatchPairing({ toleranceHours: Number.NaN }), { mode: "nearest", toleranceHours: 24 });

  const mains = [entry("main", "main", "2026-09-01T00:00:00Z")];
  const exact = [entry("exact", "smartroom", "2026-10-01T00:00:00Z")];
  const beyond = [entry("beyond", "smartroom", "2026-10-01T00:01:00Z")];
  assert.equal(pairBatchEntries(mains, exact, [], { toleranceHours: 720 })[0].smartroom.id, "exact");
  assert.equal(pairBatchEntries(mains, beyond, [], { toleranceHours: 720 })[0].smartroom, null);
  const halfHour = [entry("half-hour", "smartroom", "2026-09-01T00:30:00Z")];
  assert.equal(pairBatchEntries(mains, halfHour, [], { toleranceHours: 0.5 })[0].smartroom.id, "half-hour");
  assert.equal(pairBatchEntries(mains, halfHour, [], { toleranceHours: 0.49 })[0].smartroom, null);
});

test("batch ignores import-time fallback dates and disabled cycles need no review", () => {
  const main = entry("main", "main", "2026-09-01T00:00:00Z");
  const candidate = entry("candidate", "smartroom", "2026-09-01T00:01:00Z");
  main.date.source = "import-time";
  const pairs = pairBatchEntries([main], [candidate], []);
  assert.equal(pairs[0].smartroom, null);
  pairs[0].enabled = false;
  assert.deepEqual(batchQueueProblems(pairs), ["Включите хотя бы один цикл массового объединения"]);
  pairs.push({ ...entry("ready", "main", "2026-09-02T00:00:00Z"), main: entry("ready", "main", "2026-09-02T00:00:00Z"), enabled: true, reviewed: true, smartroom: null, ddio: null });
  assert.deepEqual(batchQueueProblems(pairs), []);
});

test("batch pair validation requires strong identity and a complete DDIO pair", () => {
  const pair = {
    main: entry("main", "main", "2026-09-01T00:00:00Z"),
    smartroom: null,
    ddio: entry("ddio", "ddio", "2026-09-01T00:00:00Z"),
  };
  pair.main.mapping = {};
  pair.ddio.mapping = { reservationMac: 0 };
  assert.equal(batchPairProblems(pair).length, 2);
});

test("batch identity validation accepts persistent IDs and alternate MACs", () => {
  const pair = {
    main: { ...entry("main", "main", "2026-09-01T00:00:00Z"), mapping: { id: 0 } },
    smartroom: { ...entry("smartroom", "smartroom", "2026-09-01T00:00:00Z"), mapping: { mac2: 0 } },
    ddio: null,
  };
  assert.deepEqual(batchPairProblems(pair), []);
});

test("batch validation rejects an empty Main snapshot before starting", () => {
  const pair = {
    main: { ...entry("empty-main", "main", "2026-09-01T00:00:00Z"), rowCount: 0, mapping: { id: 0 } },
    smartroom: null,
    ddio: null,
  };
  assert.deepEqual(batchPairProblems(pair), ["Main: основной файл не содержит строк устройств"]);
  pair.main.rowCount = null;
  assert.deepEqual(batchPairProblems(pair), []);
});

test("batch queue cannot start until each file pair is reviewed", () => {
  const pair = { main: entry("main", "main", "2026-09-01T00:00:00Z"), smartroom: null, ddio: null, reviewed: false };
  assert.match(batchQueueProblems([pair])[0], /подтвердите проверку/);
  pair.reviewed = true;
  assert.deepEqual(batchQueueProblems([pair]), []);
});

test("batch file previews read several sources concurrently with a fixed worker limit and stable ordering", async () => {
  let active = 0;
  let maximumActive = 0;
  const files = Array.from({ length: 7 }, (_, index) => {
    const bytes = new globalThis.TextEncoder().encode(`MAC,Device ID\n00:11:22:33:44:${String(index).padStart(2, "0")},device-${index}`);
    return {
      name: `main-${index}.csv`,
      size: bytes.byteLength,
      lastModified: 1_700_000_000_000 + index,
      arrayBuffer: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
          return bytes.slice().buffer;
        } finally {
          active -= 1;
        }
      },
    };
  });
  const entries = await prepareBatchEntries(files, "main");
  assert.equal(entries.length, files.length);
  assert.deepEqual(entries.map(({ file }) => file.name), files.map(({ name }) => name));
  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 3);
  assert.ok(entries.every((item) => !item.error && item.previewRows.length === 1));
});

test("legacy XLS is previewed and mapped in the batch queue", async () => {
  const previousXlsx = globalThis.XLSX;
  globalThis.XLSX = sheetJs;
  try {
    const [entry] = await prepareBatchEntries([legacyXlsFile("main_2026-09-01.xls")], "main");
    assert.equal(entry.file.name, "main_2026-09-01.xls");
    assert.equal(entry.error, "");
    assert.deepEqual(entry.headers, ["MAC", "IP", "Модель", "Дата"]);
    assert.equal(entry.previewRows.length, 2);
    assert.equal(entry.mapping.mac, 0);
    assert.deepEqual(entry.date, { date: "2026-09-01T00:00:00.000Z", source: "filename" });
    assert.deepEqual(batchPairProblems({ main: entry }), []);
  } finally {
    if (previousXlsx === undefined) delete globalThis.XLSX;
    else globalThis.XLSX = previousXlsx;
  }
});

test("batch mapping streams and persists custom fields from Main, SmartRoom, and DDIO", async () => {
  const makeCsv = (name, text) => Object.assign(new globalThis.Blob([text], { type: "text/csv" }), {
    name,
    lastModified: Date.UTC(2026, 9, 18),
  });
  const files = {
    main: makeCsv("main.csv", "MAC;Department\n00:11:22:33:44:55;Finance\n"),
    smartroom: makeCsv("smartroom.csv", "MAC;Room note\n00:11:22:33:44:55;Room 305\n"),
    ddio: makeCsv("ddio.csv", "Reservation MAC;Reservation IP;Rack\n00:11:22:33:44:55;10.0.0.5;Rack 7\n"),
  };
  const [main] = await prepareBatchEntries([files.main], "main");
  const [smartroom] = await prepareBatchEntries([files.smartroom], "smartroom");
  const [ddio] = await prepareBatchEntries([files.ddio], "ddio");
  const department = customInventoryColumnKey("Department");
  const roomNote = customInventoryColumnKey("Room note");
  const rack = customInventoryColumnKey("Rack");
  main.mapping = { mac: 0, [department]: 1 };
  smartroom.mapping = { mac: 0, [roomNote]: 1 };
  ddio.mapping = { reservationMac: 0, reservationIp: 1, [rack]: 2 };
  const pair = { main, smartroom, ddio };
  assert.deepEqual(batchPairProblems(pair), []);
  const rowsFor = (file) => readTableRowBatches(file, { batchSize: 1 });
  const result = await enrich({
    mainRows: rowsFor(main.file),
    smartroomRows: rowsFor(smartroom.file),
    ddioRows: rowsFor(ddio.file),
    mappings: { main: main.mapping, smartroom: smartroom.mapping, ddio: ddio.mapping },
  });
  assert.equal(result.devices.length, 1);
  assert.deepEqual(result.devices[0].customFields, {
    [department]: "Finance",
    [roomNote]: "Room 305",
    [rack]: "Rack 7",
  });
  assert.deepEqual(result.devices[0].customFieldSources, {
    [department]: "Main",
    [roomNote]: "SmartRoom",
    [rack]: "DDIO",
  });
  const database = new Database(`batch-custom-fields-${crypto.randomUUID()}`);
  await database.saveFinal({ id: "batch-custom-fields-final", devices: result.devices });
  const stored = (await database.inventoryPage({ limit: 10 })).rows[0];
  assert.deepEqual(stored.customFields, result.devices[0].customFields);
  assert.deepEqual(stored.customFieldSources, result.devices[0].customFieldSources);
  database.connection?.close();
  database.connection = null;
});

test("batch file scanner accepts macro-enabled XLSM workbooks", async () => {
  const files = [{
    name: "main_2026-09-01.xlsm",
    size: 0,
    lastModified: Date.UTC(2026, 8, 1),
    slice: () => new globalThis.Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
  }];
  const entries = await prepareBatchEntries(files, "main");
  assert.equal(entries.length, 1);
  assert.match(entries[0].error, /ZIP-директория/);
});

test("batch file scanner accepts TXT delimited sources with bounded previews", async () => {
  const file = Object.assign(new globalThis.Blob(["CallingStationID;NasIP\n00:11:22:33:44:55;10.0.0.1\n"]), {
    name: "main.txt",
    lastModified: Date.UTC(2026, 5, 17),
  });
  const [prepared] = await prepareBatchEntries([file], "main");
  assert.equal(prepared.error, "");
  assert.deepEqual(prepared.headers, ["CallingStationID", "NasIP"]);
  assert.deepEqual(prepared.mapping, { mac: 0, switchIp: 1 });
  assert.equal(prepared.rowCount, 1);
});

test("batch scanner uses XLSX creation metadata when the filename has no date", async () => {
  const file = xlsxFile({
    "docProps/core.xml": '<cp:coreProperties xmlns:cp="cp" xmlns:dcterms="dcterms"><dcterms:created>2026-06-17T09:42:00Z</dcterms:created></cp:coreProperties>',
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>CallingStationID</t></si><si><t>B_ReceiptTime</t></si><si><t>00:11:22:33:44:55</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>46000</v></c></row></sheetData></worksheet>',
  }, "main.xlsx");
  const [prepared] = await prepareBatchEntries([file], "main");
  assert.equal(prepared.date.date, "2026-06-17T09:42:00.000Z");
  assert.equal(prepared.date.source, "xlsx.created");
  assert.equal(prepared.sheet, "Devices");
  assert.equal(prepared.rowCount, 1);
  assert.equal(prepared.workbookCreatedAt, "2026-06-17T09:42:00.000Z");
  assert.deepEqual(prepared.previewRows, [["00:11:22:33:44:55", "46000"]]);
});
