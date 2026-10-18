import test from "node:test";
import assert from "node:assert/strict";
import { FILE_COMPARISON_COLUMNS, fileComparisonColumns, fileComparisonExportRows } from "../src/core/file-comparison-export.js";
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
