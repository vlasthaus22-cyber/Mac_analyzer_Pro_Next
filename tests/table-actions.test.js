import test from "node:test";
import assert from "node:assert/strict";
import { TableTsvCollector, tableRowsTsv } from "../src/core/table-actions.js";

test("table clipboard export copies headers and escapes multi-line cell values", () => {
  assert.equal(tableRowsTsv([
    { mac: "00:11:22:33:44:55", room: "Room\tA" },
    { mac: "00:11:22:33:44:66", room: 'Room "B"\nFloor 2' },
  ], [["mac", "MAC"], ["room", "Помещение"]]), [
    "MAC\tПомещение",
    "00:11:22:33:44:55\t\"Room\tA\"",
    '00:11:22:33:44:66\t"Room ""B""\nFloor 2"',
  ].join("\r\n"));
});

test("table clipboard export supports custom Inventory field accessors", () => {
  const output = tableRowsTsv([{ id: "device-1", customFields: { custom_owner: "Иван" } }], [
    { key: "custom_owner", label: "Ответственный", value: (device) => device.customFields.custom_owner },
  ]);
  assert.equal(output, "Ответственный\r\nИван");
});

test("table clipboard export passes one-based row numbers to column accessors", () => {
  const output = tableRowsTsv([{ mac: "AA" }, { mac: "BB" }], [
    { key: "rowNumber", label: "№", value: (_device, rowNumber) => rowNumber },
  ]);
  assert.equal(output, "№\r\n1\r\n2");
});

test("empty device selection still returns a valid header-only table", () => {
  assert.equal(tableRowsTsv([], [["mac", "MAC"]]), "MAC");
  assert.equal(tableRowsTsv([{ mac: "00:11:22:33:44:55" }], [["mac", "MAC"]], { includeHeaders: false }), "00:11:22:33:44:55");
});

test("table TSV collector flushes fixed-size row chunks into a clipboard Blob", async () => {
  const collector = new TableTsvCollector([
    { key: "mac", label: "MAC" },
    { key: "rowNumber", label: "№", value: (_device, rowNumber) => rowNumber },
    { key: "room", label: "Помещение" },
  ], { chunkRows: 2 });
  collector.add({ mac: "00:11:22:33:44:01", room: "101" });
  assert.equal(collector.rows.length, 1);
  collector.add({ mac: "00:11:22:33:44:02", room: "102" });
  assert.equal(collector.rows.length, 0);
  collector.add({ mac: "00:11:22:33:44:03", room: "103" });
  const result = collector.finish();
  assert.equal(result.rowCount, 3);
  assert.equal(result.chunkCount, 2);
  assert.equal(await result.blob.text(), [
    "MAC\t№\tПомещение",
    "00:11:22:33:44:01\t1\t101",
    "00:11:22:33:44:02\t2\t102",
    "00:11:22:33:44:03\t3\t103",
  ].join("\r\n"));
  assert.throws(() => collector.add({ mac: "later" }), /already finished/);
});
