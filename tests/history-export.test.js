import test from "node:test";
import assert from "node:assert/strict";
import { historyExportRow, historyExportSheets } from "../src/core/history-export.js";

test("history export maps source movements into the reference XLSX columns", () => {
  assert.deepEqual(historyExportRow({
    timestamp: "2026-04-01T12:00:00.000Z", mac: "00:11:22:33:44:55", field: "switchIp",
    oldValue: "—", newValue: "10.0.0.1", source: "C:\\imports\\main.xlsx", type: "modified",
  }), ["2026-04-01T12:00:00.000Z", "00:11:22:33:44:55", "IP коммутатора", "—", "10.0.0.1", "main.xlsx", "Добавление"]);
  assert.equal(historyExportRow({ type: "absent", oldValue: "known", newValue: "—" })[6], "Удаление");
  assert.equal(historyExportRow({ type: "modified", field: "custom", oldValue: "A", newValue: "B" })[2], "custom");
});

test("history XLSX rows page through the complete date range without truncation", async () => {
  const calls = [];
  const pages = [
    { rows: [{ timestamp: "2026-04-01T00:00:00Z", mac: "00:11:22:33:44:55", field: "model", oldValue: "A", newValue: "B" }], hasMore: true, nextCursor: { timestamp: "2026-04-01T00:00:00Z", id: "one" } },
    { rows: [{ timestamp: "2026-04-02T00:00:00Z", mac: "00:11:22:33:44:66", field: "room", oldValue: "101", newValue: "102" }], hasMore: false, nextCursor: null },
  ];
  const database = { historyDateRangePage: async (filters, options) => { calls.push({ filters, options }); return pages.shift(); } };
  const [sheet] = historyExportSheets(database, { from: "2026-04-01", to: "2026-04-30" });
  const rows = [];
  for await (const row of sheet.rows) rows.push(row);
  assert.equal(sheet.name, "История изменений");
  assert.equal(rows.length, 2);
  assert.deepEqual(calls.map(({ options }) => options.cursor), [null, { timestamp: "2026-04-01T00:00:00Z", id: "one" }]);
  assert.ok(calls.every(({ filters }) => filters.from === "2026-04-01" && filters.to === "2026-04-30"));
});
