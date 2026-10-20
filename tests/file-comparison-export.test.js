import test from "node:test";
import assert from "node:assert/strict";
import { FILE_COMPARISON_COLUMNS, fileComparisonColumns, fileComparisonCsvChunks, fileComparisonCsvChunksFromDevices, fileComparisonExportRows, fileComparisonExportRowsFromDevices, fileComparisonJsonFromDevices, fileComparisonRowsPage, fileComparisonRowsPagesFromDevices } from "../src/core/file-comparison-export.js";
import { compareFinals } from "../src/core/comparison.js";
import { readableTextStreamFromIterable } from "../src/core/stream-writer.js";
import { writePrettyJson } from "../src/core/json-stream.js";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";

test("file comparison export covers every status with usable device and diagnostic details", () => {
  const result = {
    added: [{ mac: "AA:BB:CC:00:00:01", model: "New" }],
    absent: [{ mac: "AA:BB:CC:00:00:02", model: "Old" }],
    modified: [{ after: { mac: "AA:BB:CC:00:00:03", room: "202" }, changes: [{ label: "Помещение", oldValue: "101", newValue: "202" }] }],
    unchanged: [{ after: { mac: "AA:BB:CC:00:00:04" } }],
    ambiguous: [{ after: { mac: "AA:BB:CC:00:00:05" }, candidates: [{ mac: "AA:BB:CC:00:00:06" }, { serial: "S-2" }] }],
  };
  const rows = [...fileComparisonExportRows(result)];
  assert.deepEqual(rows.map(({ status }) => status), ["Добавлено", "Отсутствует", "Изменено", "Без изменений", "Неоднозначно"]);
  assert.equal(rows[2].room, "202");
  assert.equal(rows[2].changes, "Помещение: 101 → 202");
  assert.equal(rows[4].changes, "AA:BB:CC:00:00:06, S-2");
  assert.equal(rows[0].oui3, "AA:BB:CC");
  assert.deepEqual(fileComparisonColumns({ 3: false, 4: true, 5: false, 6: true }).filter(({ key }) => key.startsWith("oui")).map(({ key }) => key), ["oui4", "oui6"]);
  assert.equal(FILE_COMPARISON_COLUMNS.at(-1).label, "Изменения / кандидаты");
});

test("file comparison exports OUI prefixes only for the selected formats", () => {
  const comparison = { added: [{ mac: "00:1A:11:22:33:44" }], absent: [], modified: [], unchanged: [], ambiguous: [] };
  const [row] = fileComparisonExportRows(comparison, { 3: false, 4: true, 5: false, 6: true });
  assert.equal(row.oui3, undefined);
  assert.equal(row.oui4, "00:1A:11:22");
  assert.equal(row.oui6, "00:1A:11:22:33:44");
});

test("file comparison CSV emits one escaped row per iterator step with unchanged columns and OUI order", () => {
  const comparison = {
    added: [{ mac: "AA:BB:CC:00:00:01", smartroomId: "SR;\"1\"", authenticationTime: "2026-10-18T12:34:56.000Z" }],
    absent: [{ mac: "AA:BB:CC:00:00:02" }],
    modified: [{ after: { mac: "AA:BB:CC:00:00:03" }, changes: [{ label: "Помещение", oldValue: "101", newValue: "202" }] }],
    unchanged: [{ after: { mac: "AA:BB:CC:00:00:04" } }],
    ambiguous: [{ after: { mac: "AA:BB:CC:00:00:05" }, candidates: [{ mac: "AA:BB:CC:00:00:06" }] }],
  };
  const iterator = fileComparisonCsvChunks(comparison, { 3: true, 4: true, 5: false, 6: false });
  const heading = iterator.next();
  assert.equal(heading.done, false);
  assert.match(heading.value, /^\uFEFF"Статус";"MAC";"OUI \(3 байта\)";"OUI \(4 байт\)";"IP-адрес"/);
  assert.match(heading.value, /"Время аутентификации"/);
  const rows = [];
  for (let item = iterator.next(); !item.done; item = iterator.next()) rows.push(item.value);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /^\r\n"Добавлено";/);
  assert.match(rows[0], /"SR;""1"""/);
  assert.match(rows[0], /"AA:BB:CC";"AA:BB:CC:00"/);
  assert.match(rows[0], /"2026-10-18T12:34:56\.000Z"/);
  assert.match(rows[2], /"Изменено"/);
  assert.match(rows[2], /"Помещение: 101 → 202"/);
  assert.match(rows[4], /"Неоднозначно"/);
});

test("file comparison result pages preserve status order and exact totals without flattening all statuses", () => {
  const comparison = {
    added: Array.from({ length: 150 }, (_, index) => ({ mac: `00:00:00:00:00:${String(index).padStart(2, "0")}` })),
    absent: Array.from({ length: 80 }, (_, index) => ({ mac: `00:00:00:01:00:${String(index).padStart(2, "0")}` })),
    modified: Array.from({ length: 90 }, (_, index) => ({ after: { mac: `00:00:00:02:00:${String(index).padStart(2, "0")}` }, changes: [] })),
    unchanged: [{ after: { mac: "00:00:00:03:00:01" } }],
    ambiguous: Array.from({ length: 241 }, (_, index) => ({ after: { mac: `00:00:00:04:00:${String(index).padStart(2, "0")}` }, candidates: [] })),
  };
  const second = fileComparisonRowsPage(comparison, { offset: 100, limit: 100 });
  const fourth = fileComparisonRowsPage(comparison, { offset: 300, limit: 100 });
  const ambiguousLast = fileComparisonRowsPage(comparison, { statuses: ["Неоднозначно"], offset: 200, limit: 100 });
  const bounded = fileComparisonRowsPage(comparison, { limit: 5_000 });

  assert.equal(second.total, 320);
  assert.equal(second.offset, 100);
  assert.equal(second.rows.length, 100);
  assert.deepEqual(new Set(second.rows.map(({ status }) => status)), new Set(["Добавлено", "Отсутствует"]));
  assert.equal(second.rows[0].mac, comparison.added[100].mac);
  assert.equal(second.rows.at(-1).mac, comparison.absent[49].mac);
  assert.equal(fourth.total, 320);
  assert.equal(fourth.rows.length, 20);
  assert.ok(fourth.rows.every(({ status }) => status === "Изменено"));
  assert.equal(ambiguousLast.total, 241);
  assert.equal(ambiguousLast.rows.length, 41);
  assert.equal(ambiguousLast.hasNext, false);
  assert.equal(bounded.limit, 1_000);
  assert.equal(bounded.rows.length, 320);
});

test("file comparison computes one requested page per visible section without retaining full status rows", () => {
  const previous = [
    { id: "absent", mac: "00:11:22:33:44:01", model: "Removed" },
    { id: "modified", mac: "00:11:22:33:44:02", model: "Old model" },
    { id: "same", mac: "00:11:22:33:44:03", model: "Same model" },
    { id: "candidate-a", deviceId: "shared", mac: "00:11:22:33:44:04" },
    { id: "candidate-b", deviceId: "shared", mac: "00:11:22:33:44:05" },
  ];
  const current = [
    { id: "added", mac: "00:11:22:33:44:06", model: "New" },
    { id: "modified", mac: "00:11:22:33:44:02", model: "New model" },
    { id: "same", mac: "00:11:22:33:44:03", model: "Same model" },
    { deviceId: "shared", mac: "00:11:22:33:44:07" },
  ];
  const full = compareFinals(previous, current, "2026-10-18T00:00:00Z");
  const compact = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
  });
  assert.deepEqual([compact.added.length, compact.absent.length, compact.modified.length, compact.unchanged.length, compact.ambiguous.length], [0, 0, 0, 0, 0]);
  assert.deepEqual([compact.addedCount, compact.absentCount, compact.modifiedDeviceCount, compact.unchangedCount, compact.ambiguousCount], [1, 1, 1, 1, 1]);
  const pages = fileComparisonRowsPagesFromDevices(previous, current, compact, [
    { key: "changed", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: 0, limit: 2 },
    { key: "ambiguous", statuses: ["Неоднозначно"], offset: 0, limit: 10 },
    { key: "all", statuses: ["Добавлено", "Отсутствует", "Изменено", "Без изменений", "Неоднозначно"], offset: 2, limit: 2 },
  ]);
  assert.deepEqual(pages.changed.rows.map(({ status }) => status), ["Добавлено", "Отсутствует"]);
  assert.equal(pages.changed.total, 3);
  assert.equal(pages.ambiguous.rows[0].changes, "00:11:22:33:44:04, 00:11:22:33:44:05");
  assert.deepEqual(pages.all.rows.map(({ status }) => status), ["Изменено", "Без изменений"]);
  assert.equal(pages.all.rows[0].changes, "Модель: Old model → New model");
  assert.deepEqual(pages.all.rows, fileComparisonRowsPage(full, { statuses: ["Добавлено", "Отсутствует", "Изменено", "Без изменений", "Неоднозначно"], offset: 2, limit: 2 }).rows);
});

test("large two-file comparison renders exact bounded pages across 12,249 devices", () => {
  const totalDevices = 12_249;
  const previous = Array.from({ length: totalDevices }, (_, index) => ({ id: `device-${index}`, model: `model-${index}` }));
  const current = previous.flatMap((device, index) => {
    if (index % 4 === 2) return [];
    return [{ ...device, ...(index % 4 === 1 ? { model: `changed-${index}` } : {}) }];
  });
  current.push(...Array.from({ length: Math.ceil(totalDevices / 4) }, (_, index) => ({ id: `added-${index}`, model: "new" })));
  const comparison = compareFinals(previous, current, "2026-10-18T00:00:00Z", {
    collectRows: false,
    includeUnchangedRows: false,
    includeCriticalRows: false,
    includeDiagnosticRows: false,
  });
  const changedTotal = comparison.addedCount + comparison.absentCount + comparison.modifiedDeviceCount;
  const lastOffset = Math.floor((changedTotal - 1) / 100) * 100;
  const pages = fileComparisonRowsPagesFromDevices(previous, current, comparison, [
    { key: "first", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: 0, limit: 100 },
    { key: "boundary", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: Math.floor(comparison.addedCount / 100) * 100, limit: 100 },
    { key: "middle", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: Math.floor(changedTotal / 2 / 100) * 100, limit: 100 },
    { key: "last", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: lastOffset, limit: 100 },
    { key: "unchanged", statuses: ["Без изменений"], offset: 0, limit: 100 },
  ]);
  assert.deepEqual([comparison.added.length, comparison.absent.length, comparison.modified.length, comparison.unchanged.length], [0, 0, 0, 0]);
  assert.equal(pages.first.total, changedTotal);
  assert.equal(pages.first.rows.length, 100);
  assert.equal(pages.boundary.rows.filter(({ status }) => status === "Добавлено").length, comparison.addedCount % 100);
  assert.equal(pages.boundary.rows.filter(({ status }) => status === "Отсутствует").length, 100 - comparison.addedCount % 100);
  assert.equal(pages.middle.rows.length, 100);
  assert.equal(pages.last.rows.length, changedTotal - lastOffset);
  assert.equal(pages.unchanged.total, comparison.unchangedCount);
  assert.equal(pages.unchanged.rows.length, 100);
  for (const page of Object.values(pages)) assert.ok(page.rows.length <= 100);
});

test("all comparison export formats stream complete ordered statuses without materializing comparison arrays", async () => {
  const previous = [
    { id: "absent", mac: "00:11:22:33:44:01", model: "Removed" },
    { id: "modified", mac: "00:11:22:33:44:02", model: "Old model" },
    { id: "same", mac: "00:11:22:33:44:03", model: "Same model" },
    { id: "candidate-a", deviceId: "shared", mac: "00:11:22:33:44:04" },
    { id: "candidate-b", deviceId: "shared", mac: "00:11:22:33:44:05" },
    { id: "conflict-a", deviceId: "asset-a", mac: "00:11:22:33:44:08" },
    { id: "conflict-b", deviceId: "asset-b", mac: "00:11:22:33:44:09" },
  ];
  const current = [
    { id: "added", mac: "00:11:22:33:44:06", model: "New" },
    { id: "modified", mac: "00:11:22:33:44:02", model: "New model" },
    { id: "same", mac: "00:11:22:33:44:03", model: "Same model" },
    { deviceId: "shared", mac: "00:11:22:33:44:07" },
    { id: "conflict-a", deviceId: "asset-b", mac: "00:11:22:33:44:08" },
  ];
  const timestamp = "2026-10-18T00:00:00Z";
  const comparison = compareFinals(previous, current, timestamp);
  const rowOptions = { 3: true, 4: false, 5: true, 6: false };
  const expectedRows = [...fileComparisonExportRows(comparison, rowOptions)];
  const streamedRows = [...fileComparisonExportRowsFromDevices(previous, current, timestamp, rowOptions)];
  assert.deepEqual(streamedRows, expectedRows);
  assert.deepEqual([...fileComparisonCsvChunksFromDevices(previous, current, timestamp, rowOptions)], [...fileComparisonCsvChunks(comparison, rowOptions)]);

  const value = {
    before: { devices: previous },
    after: { devices: current },
    comparison: fileComparisonJsonFromDevices(previous, current, comparison, rowOptions),
  };
  for (const list of ["added", "absent", "modified", "unchanged", "ambiguous", "critical", "identityConflicts"]) {
    assert.equal(Array.isArray(value.comparison[list]), false, `${list} must remain a stream`);
  }
  const chunks = [];
  await writePrettyJson(value, { write: async (chunk) => chunks.push(chunk) }, { chunkChars: 128 });
  const parsed = JSON.parse(chunks.join(""));
  assert.deepEqual(parsed.comparison.added, comparison.added);
  assert.deepEqual(parsed.comparison.absent, comparison.absent);
  assert.deepEqual(parsed.comparison.modified, comparison.modified);
  assert.deepEqual(parsed.comparison.unchanged, comparison.unchanged);
  assert.deepEqual(parsed.comparison.ambiguous, comparison.ambiguous);
  assert.deepEqual(parsed.comparison.critical, comparison.critical);
  assert.deepEqual(parsed.comparison.identityConflicts, comparison.identityConflicts);

  const stream = readableTextStreamFromIterable(fileComparisonCsvChunksFromDevices(previous, current, timestamp, rowOptions));
  const bytes = await new globalThis.Response(stream).arrayBuffer();
  assert.equal(new globalThis.TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), [...fileComparisonCsvChunks(comparison, rowOptions)].join(""));

  async function* xlsxRows() {
    for (const row of fileComparisonExportRowsFromDevices(previous, current, timestamp, rowOptions)) yield fileComparisonColumns(rowOptions).map(({ key }) => row[key]);
  }
  const workbook = await new globalThis.Response(createXlsxWorkbookStream([{
    name: "Сравнение",
    headings: fileComparisonColumns(rowOptions).map(({ label }) => label),
    rows: xlsxRows(),
  }])).arrayBuffer();
  const workbookText = new globalThis.TextDecoder().decode(workbook);
  assert.match(workbookText, /Изменения \/ кандидаты/);
  assert.match(workbookText, /00:11:22:33:44:06/);
});

test("file comparison XLSX export accepts the complete status-row stream", async () => {
  const comparison = {
    added: [{ mac: "AA:BB:CC:00:00:01" }],
    absent: [],
    modified: [{ after: { mac: "AA:BB:CC:00:00:02" }, changes: [{ label: "Room", oldValue: "1", newValue: "2" }] }],
    unchanged: [],
    ambiguous: [],
  };
  async function* rows() {
    for (const row of fileComparisonExportRows(comparison)) yield fileComparisonColumns().map(({ key }) => row[key]);
  }
  const bytes = await new globalThis.Response(createXlsxWorkbookStream([{
    name: "Сравнение",
    headings: fileComparisonColumns().map(({ label }) => label),
    rows: rows(),
  }])).arrayBuffer();
  const archiveText = new globalThis.TextDecoder().decode(bytes);
  assert.match(archiveText, /Добавлено/);
  assert.match(archiveText, /AA:BB:CC:00:00:01/);
  assert.match(archiveText, /Изменено/);
  assert.match(archiveText, /Room: 1 → 2/);
});
