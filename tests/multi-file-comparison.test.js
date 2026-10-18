import test from "node:test";
import assert from "node:assert/strict";
import { allPairwiseCsv, comparisonRows, multiFileComparisonWorkbookSheets, pairwiseComparisonCsvChunks, pairwiseComparisonPairs, selectMultiFileComparisonFields } from "../src/core/multi-file-comparison.js";
import { compareFinals } from "../src/core/comparison.js";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";

test("multi-file comparison creates every directed pair for two through ten files", () => {
  assert.deepEqual(pairwiseComparisonPairs(2).map(({ id }) => id), ["0:1", "1:0"]);
  assert.equal(pairwiseComparisonPairs(10).length, 90);
  assert.throws(() => pairwiseComparisonPairs(1), /не менее двух/);
  assert.throws(() => pairwiseComparisonPairs(11), /не более 10/);
});

test("all-pair export retains pair names and ambiguous identity diagnostics", () => {
  const pair = { file1: "before.csv", file2: "after.csv" };
  const result = { comparison: {
    added: [{ mac: "AA:BB:CC:00:00:03", ip: "10.0.0.3" }],
    absent: [{ mac: "AA:BB:CC:00:00:01", room: "101" }],
    modified: [{ before: { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.1" }, after: { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.2" }, changes: [{ label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" }] }],
    unchanged: [],
    ambiguous: [{ after: { mac: "AA:BB:CC:00:00:04" }, candidates: [{ mac: "AA:BB:CC:00:00:05" }] }],
  } };
  const rows = comparisonRows(pair, result);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.file1 === pair.file1 && row.file2 === pair.file2));
  const csv = allPairwiseCsv([{ pair, result }]);
  assert.match(csv, /before\.csv/);
  assert.match(csv, /Неоднозначно/);
  assert.match(csv, /Сильные идентификаторы конфликтуют/);
});

test("multi-file comparison CSV yields escaped rows incrementally without flattening comparison statuses", () => {
  const pair = { file1: 'before;"1".csv', file2: "after.csv" };
  const comparison = {
    added: [{ mac: "AA:BB:CC:00:00:01", manufacturer: 'Vendor "A"' }],
    absent: [{ mac: "AA:BB:CC:00:00:02", room: "101" }],
    modified: [{ before: { mac: "AA:BB:CC:00:00:03", ip: "10.0.0.1" }, after: { mac: "AA:BB:CC:00:00:03", ip: "10.0.0.2" }, changes: [{ label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" }] }],
    unchanged: [{ before: { mac: "AA:BB:CC:00:00:04" }, after: { mac: "AA:BB:CC:00:00:04" } }],
    ambiguous: [{ after: { mac: "AA:BB:CC:00:00:05" }, candidates: [{ mac: "AA:BB:CC:00:00:06" }] }],
  };
  let readCount = 0;
  const added = {
    *[Symbol.iterator]() {
      readCount += 1;
      yield* comparison.added;
    },
  };
  const iterator = pairwiseComparisonCsvChunks(pair, { comparison: { ...comparison, added } });
  assert.equal(readCount, 0, "the first output row is not built until the consumer asks for it");
  const rows = [...iterator];
  assert.equal(readCount, 1);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /^"before;""1""\.csv";"after\.csv";"Только во втором файле";/);
  assert.match(rows[0], /"Производитель: Vendor ""A"""/);
  assert.match(rows[2], /"IP: 10\.0\.0\.1 → 10\.0\.0\.2"/);
  assert.match(rows[4], /"Неоднозначно"/);
  assert.match(rows[4], /"Сильные идентификаторы конфликтуют; проверьте вручную"/);
});

test("multi-file XLSX streams per-file totals, every pair detail, and PyQt-style pair statistics", async () => {
  const files = [
    { file: { name: "before.xlsx" } },
    { file: { name: "after.xlsx" } },
  ];
  let loads = 0;
  const pair = { id: "0:1", first: 0, second: 1 };
  const result = {
    pair: { file1: "before.xlsx", file2: "after.xlsx", first: 0, second: 1 },
    before: { summary: { valid: 4 } },
    after: { summary: { valid: 5 } },
    comparison: {
      absent: [{ mac: "00:11:22:33:44:01", model: "Old" }],
      added: [{ mac: "00:11:22:33:44:02", room: "101" }],
      modified: [{ before: { mac: "00:11:22:33:44:03", ip: "10.0.0.1" }, after: { mac: "00:11:22:33:44:03", ip: "10.0.0.2" }, changes: [{ label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" }] }],
      unchanged: [{ before: { mac: "00:11:22:33:44:04" }, after: { mac: "00:11:22:33:44:04" } }],
      ambiguous: [{ after: { mac: "00:11:22:33:44:05" }, candidates: [{ serial: "S-5" }] }],
    },
  };
  const sheets = multiFileComparisonWorkbookSheets([pair], files, async () => { loads += 1; return result; });
  assert.equal(sheets.length, 3);
  const sheetRows = [];
  for (const sheet of sheets) {
    const rows = [];
    for await (const row of sheet.rows) rows.push(row);
    sheetRows.push({ name: sheet.name, headings: sheet.headings, rows });
  }
  assert.equal(loads, 1, "the detail and statistics sheets share one streamed pair result");
  assert.deepEqual(sheetRows[0].rows.map((row) => row[1]), ["Только в первом файле", "Только во втором файле", "Изменено", "Без изменений", "Неоднозначно"]);
  assert.deepEqual(sheetRows[1].rows, [
    ["Устройств только в первом файле", 1],
    ["Устройств только во втором файле", 1],
    ["Общих устройств", 2],
    ["Изменённых устройств", 1],
    ["Совпадающих устройств", 1],
    ["Неоднозначных соответствий", 1],
  ]);
  assert.deepEqual(sheetRows[2].rows, [["before.xlsx", 4], ["after.xlsx", 5]]);

  const archiveSheets = multiFileComparisonWorkbookSheets([pair], files, async () => result);
  const archive = await new globalThis.Response(createXlsxWorkbookStream(archiveSheets)).arrayBuffer();
  const archiveText = new globalThis.TextDecoder().decode(archive);
  assert.match(archiveText, /Общая статистика/);
  assert.match(archiveText, /before.xlsx/);
  assert.match(archiveText, /Устройств только в первом файле/);
  assert.match(archiveText, /Сильные идентификаторы конфликтуют/);
});

test("multi-file XLSX abort stops loading or yielding further pair rows", async () => {
  const files = [{ file: { name: "first.xlsx" } }, { file: { name: "second.xlsx" } }];
  const pair = { id: "0:1", first: 0, second: 1 };
  const controller = new globalThis.AbortController();
  let loads = 0;
  const sheets = multiFileComparisonWorkbookSheets([pair], files, async () => {
    loads += 1;
    return {
      before: { summary: { valid: 1 } },
      after: { summary: { valid: 1 } },
      comparison: { absent: [], added: [], modified: [], unchanged: [{ before: { mac: "00:11:22:33:44:01" }, after: { mac: "00:11:22:33:44:01" } }], ambiguous: [] },
    };
  }, { signal: controller.signal });
  const rows = sheets[0].rows[Symbol.asyncIterator]();
  assert.deepEqual((await rows.next()).value, ["00:11:22:33:44:01", "Без изменений", "Нет данных", "Нет данных", "Данные совпадают"]);
  controller.abort();
  await assert.rejects(rows.next(), { name: "AbortError" });
  assert.equal(loads, 1);

  const alreadyAborted = new globalThis.AbortController();
  alreadyAborted.abort();
  const canceledBeforeLoad = multiFileComparisonWorkbookSheets([pair], files, async () => { loads += 1; }, { signal: alreadyAborted.signal });
  await assert.rejects(canceledBeforeLoad[0].rows[Symbol.asyncIterator]().next(), { name: "AbortError" });
  assert.equal(loads, 1, "an aborted export must not start reading source files");
});

test("multi-file field selection applies defaults and can report OUI changes separately", () => {
  const before = [{ id: "stable", mac: "00:11:22:33:44:55", manufacturer: "Old", model: "A", ip: "10.0.0.1", room: "101" }];
  const after = [{ id: "stable", mac: "00:11:23:33:44:55", manufacturer: "New", model: "B", ip: "10.0.0.2", room: "102" }];
  const raw = compareFinals(before, after);
  const defaults = selectMultiFileComparisonFields(raw, { mac: true, oui: true });
  assert.deepEqual(defaults.modified[0].changes.map((change) => change.field).sort(), ["mac", "oui"]);
  const all = selectMultiFileComparisonFields(raw, { mac: true, oui: true, vendor: true, model: true, ip: true, room: true });
  assert.deepEqual(all.modified[0].changes.map((change) => change.field).sort(), ["ip", "mac", "manufacturer", "model", "oui", "room"]);
});
