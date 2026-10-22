import test from "node:test";
import assert from "node:assert/strict";
import { allPairwiseCsv, comparisonRows, createMultiFileComparisonPlan, multiFileComparisonRowsPage, multiFileComparisonWorkbookSheets, pairwiseComparisonCsvChunks, pairwiseComparisonPairs, selectMultiFileComparisonFields } from "../src/core/multi-file-comparison.js";
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

test("multi-file comparison details page every status without flattening source arrays", () => {
  const addedRows = Array.from({ length: 5 }, (_, index) => ({ mac: `00:00:00:00:00:0${index}`, model: `Added ${index}` }));
  const guardedAdded = new Proxy(addedRows, {
    get(target, property, receiver) {
      if (property === "map" || property === Symbol.iterator) throw new Error("page lookup must not flatten the source status array");
      return Reflect.get(target, property, receiver);
    },
  });
  const pair = { file1: "one.csv", file2: "two.csv" };
  const result = { comparison: {
    added: guardedAdded,
    absent: [{ mac: "10", model: "Absent" }, { mac: "11", model: "Absent" }],
    modified: [{ before: { mac: "20", room: "101" }, after: { mac: "20", room: "102" }, changes: [{ label: "Помещение", oldValue: "101", newValue: "102" }] }],
    unchanged: [{ before: { mac: "30" }, after: { mac: "30" } }],
    ambiguous: [{ after: { mac: "40" }, candidates: [{ mac: "41" }] }],
  } };

  const first = multiFileComparisonRowsPage(pair, result, { offset: 0, limit: 4 });
  const second = multiFileComparisonRowsPage(pair, result, { offset: 4, limit: 4 });
  const last = multiFileComparisonRowsPage(pair, result, { offset: 8, limit: 4 });
  const clamped = multiFileComparisonRowsPage(pair, result, { offset: 1_000, limit: 5_000 });
  assert.equal(first.total, 10);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(first.rows.map(({ status }) => status), ["Только во втором файле", "Только во втором файле", "Только во втором файле", "Только во втором файле"]);
  assert.deepEqual(second.rows.map(({ status }) => status), ["Только во втором файле", "Только в первом файле", "Только в первом файле", "Изменено"]);
  assert.deepEqual(last.rows.map(({ status }) => status), ["Без изменений", "Неоднозначно"]);
  assert.equal(last.hasNext, false);
  assert.equal(clamped.limit, 1_000);
  assert.equal(clamped.offset, 0);
  assert.equal(clamped.rows.length, 10);
});

test("multi-file comparison keeps exact 12,249-row totals and a bounded last page", () => {
  const sourceRows = Array.from({ length: 12_249 }, (_, index) => ({ mac: `02:00:00:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256 % 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`, model: `Model ${index % 17}` }));
  const result = { comparison: { added: sourceRows, absent: [], modified: [], unchanged: [], ambiguous: [] } };
  const first = multiFileComparisonRowsPage({ file1: "a.csv", file2: "b.csv" }, result, { offset: 0, limit: 100 });
  const middle = multiFileComparisonRowsPage({ file1: "a.csv", file2: "b.csv" }, result, { offset: 6_000, limit: 100 });
  const last = multiFileComparisonRowsPage({ file1: "a.csv", file2: "b.csv" }, result, { offset: 12_248, limit: 100 });
  const smallPage = multiFileComparisonRowsPage({ file1: "a.csv", file2: "b.csv" }, result, { offset: 0, limit: 25 });

  assert.equal(first.total, 12_249);
  assert.equal(first.pageCount, 123);
  assert.equal(first.rows.length, 100);
  assert.equal(middle.offset, 6_000);
  assert.equal(middle.rows.length, 100);
  assert.equal(last.offset, 12_200);
  assert.equal(last.rows.length, 49);
  assert.equal(last.rows.at(-1).mac, sourceRows.at(-1).mac);
  assert.equal(last.hasNext, false);
  assert.equal(smallPage.rows.length, 25);
  assert.equal(smallPage.pageCount, 490);
  const comparisonPlan = createMultiFileComparisonPlan([], sourceRows, "2026-10-21T00:00:00.000Z", { mac: true });
  const plannedLastPage = multiFileComparisonRowsPage({ file1: "a.csv", file2: "b.csv" }, {
    comparison: null,
    comparisonPlan,
  }, { offset: 12_248, limit: 100 });
  assert.equal(comparisonPlan.addedCount, 12_249);
  assert.equal(plannedLastPage.total, 12_249);
  assert.equal(plannedLastPage.rows.length, 49);
  assert.equal(plannedLastPage.rows.at(-1).mac, sourceRows.at(-1).mac);
});

test("multi-file count planning detects changed fields without changing streamed detail rows", () => {
  const before = Array.from({ length: 1_205 }, (_, index) => ({
    id: `device-${index}`,
    serial: `SER-${index}`,
    model: "Before",
  }));
  const after = before.map((device, index) => index % 3 === 0 ? { ...device, model: "After" } : { ...device });
  const timestamp = "2026-10-22T00:00:00Z";
  const full = compareFinals(before, after, timestamp);
  const plan = createMultiFileComparisonPlan(before, after, timestamp, { model: true });
  const streamedChanges = [...plan.events("modified")].map(({ row }) => [row.identity, row.changes.map(({ field, oldValue, newValue }) => [field, oldValue, newValue])]);
  assert.deepEqual([plan.addedCount, plan.absentCount, plan.modifiedDeviceCount, plan.unchangedCount], [
    full.addedCount,
    full.absentCount,
    full.modified.length,
    full.unchangedCount,
  ]);
  assert.deepEqual(streamedChanges, full.modified.map(({ identity, changes }) => [identity, changes.map(({ field, oldValue, newValue }) => [field, oldValue, newValue])]));
});

test("multi-file comparison plan retains compact marks and streams selected pages and workbook rows", async () => {
  const before = [
    { id: "same", mac: "00:11:22:33:44:01", model: "Stable" },
    { id: "changed", mac: "00:11:22:33:44:02", model: "Old" },
    { id: "removed", mac: "00:11:22:33:44:03", room: "101" },
  ];
  const after = [
    { id: "same", mac: "00:11:22:33:44:01", model: "Stable" },
    { id: "changed", mac: "00:11:22:33:44:02", model: "New" },
    { id: "added", mac: "00:11:22:33:44:04", model: "New device" },
  ];
  const comparisonPlan = createMultiFileComparisonPlan(before, after, "2026-10-21T00:00:00.000Z", { model: true });
  const result = { comparison: null, comparisonPlan, before: { summary: { valid: 3 } }, after: { summary: { valid: 3 } } };
  assert.deepEqual([
    comparisonPlan.addedCount,
    comparisonPlan.absentCount,
    comparisonPlan.modifiedDeviceCount,
    comparisonPlan.unchangedCount,
    comparisonPlan.ambiguousCount,
  ], [1, 1, 1, 1, 0]);
  assert.equal("added" in comparisonPlan, false, "the plan must not retain per-device status arrays");
  const first = multiFileComparisonRowsPage({ file1: "before.csv", file2: "after.csv" }, result, { limit: 2 });
  const second = multiFileComparisonRowsPage({ file1: "before.csv", file2: "after.csv" }, result, { offset: 2, limit: 2 });
  assert.deepEqual(first.rows.map((row) => row.status), ["Только во втором файле", "Только в первом файле"]);
  assert.deepEqual(second.rows.map((row) => row.status), ["Изменено", "Без изменений"]);
  assert.equal(second.rows[0].changes, "Модель: Old → New");
  const noSelectedFields = createMultiFileComparisonPlan(before, after, "2026-10-21T00:00:00.000Z", {});
  assert.deepEqual([noSelectedFields.modifiedDeviceCount, noSelectedFields.unchangedCount], [0, 2]);
  const csv = [...pairwiseComparisonCsvChunks({ file1: "before.csv", file2: "after.csv" }, result)].join("");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 4);
  assert.match(csv, /Изменено/);
  assert.match(csv, /Без изменений/);
  const pair = { id: "0:1", first: 0, second: 1 };
  const files = [{ file: { name: "before.csv" } }, { file: { name: "after.csv" } }];
  const sheets = multiFileComparisonWorkbookSheets([pair], files, async () => ({
    ...result,
    pair: { file1: "before.csv", file2: "after.csv" },
  }));
  const detailRows = [];
  for await (const row of sheets[0].rows) detailRows.push(row);
  const statsRows = [];
  for await (const row of sheets[1].rows) statsRows.push(row);
  assert.equal(detailRows.length, 4);
  assert.deepEqual(statsRows.slice(0, 6), [
    ["Устройств только в первом файле", 1],
    ["Устройств только во втором файле", 1],
    ["Общих устройств", 2],
    ["Изменённых устройств", 1],
    ["Совпадающих устройств", 1],
    ["Неоднозначных соответствий", 0],
  ]);
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
  const plan = createMultiFileComparisonPlan(before, after, new Date().toISOString(), { mac: true, oui: true });
  assert.deepEqual([...plan.events("modified")][0].row.changes.map((change) => change.field).sort(), ["mac", "oui"]);
});
