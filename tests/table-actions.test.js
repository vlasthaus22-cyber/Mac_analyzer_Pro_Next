import test from "node:test";
import assert from "node:assert/strict";
import { inventorySearchCsvChunks, inventorySearchTsvChunks, TableTsvCollector, tableRowsTsv } from "../src/core/table-actions.js";

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

test("Inventory CSV pages preserve filter numbering and stream bounded escaped chunks", async () => {
  const pages = [
    { rows: [{ id: "a", mac: "AA", vendor: "Acme" }, { id: "b", mac: "BB", vendor: "Other" }], nextCursor: "b", hasMore: true },
    { rows: [{ id: "c", mac: "CC", vendor: 'Acme "North"' }, { id: "d", mac: "DD", vendor: "Other" }], nextCursor: "d", hasMore: true },
    { rows: [{ id: "e", mac: "EE", vendor: "Acme" }], nextCursor: null, hasMore: false },
  ];
  const seenCursors = [];
  const chunks = [];
  for await (const chunk of inventorySearchCsvChunks({
    readPage: async ({ afterId, limit }) => {
      assert.equal(limit, 2);
      seenCursors.push(afterId);
      return pages[seenCursors.length - 1];
    },
    query: "acme",
    columns: [
      { key: "rowNumber", label: "№" },
      { key: "mac", label: "MAC" },
      { key: "vendor", label: "Производитель" },
    ],
    matches: (device, query) => device.vendor.toLowerCase().includes(query),
    cellText: (device, key, rowNumber) => key === "rowNumber" ? rowNumber : device[key],
    pageSize: 2,
    chunkRows: 2,
  })) chunks.push(chunk);

  assert.deepEqual(seenCursors, [null, "b", "d"]);
  assert.equal(chunks.join(""), [
    "\uFEFF\"№\";\"MAC\";\"Производитель\"\r\n",
    "\"1\";\"AA\";\"Acme\"\r\n\"2\";\"CC\";\"Acme \"\"North\"\"\"\r\n",
    "\"3\";\"EE\";\"Acme\"",
  ].join(""));
  assert.ok(pages.every(({ rows }) => rows.every((row) => row === null)));
});

test("Inventory CSV rejects a stalled page cursor instead of looping forever", async () => {
  const chunks = inventorySearchCsvChunks({
    readPage: async () => ({ rows: [], nextCursor: null, hasMore: true }),
    columns: [],
  });
  await chunks.next();
  await assert.rejects(chunks.next(), /не продвинуло курсор/);
});

test("filtered Inventory TSV copies bounded keyset pages with exact escaping and counts", async () => {
  const pages = [
    { rows: [{ id: "a", mac: "AA", manufacturer: "Acme" }, { id: "b", mac: "BB", manufacturer: "Other" }], nextCursor: "b", hasMore: true },
    { rows: [{ id: "c", mac: "CC", manufacturer: "Acme\tNorth" }, { id: "d", mac: "DD", manufacturer: "Acme" }], nextCursor: null, hasMore: false },
  ];
  const seenCursors = [];
  const progress = [];
  const chunks = [];
  for await (const chunk of inventorySearchTsvChunks({
    readPage: async ({ afterId, limit }) => {
      assert.equal(limit, 2);
      seenCursors.push(afterId);
      return pages[seenCursors.length - 1];
    },
    query: "Acme",
    columns: [{ key: "rowNumber", label: "№" }, { key: "mac", label: "MAC" }, { key: "manufacturer", label: "Производитель" }],
    matches: (device, query) => device.manufacturer.includes(query),
    cellText: (device, key, rowNumber) => key === "rowNumber" ? rowNumber : device[key],
    pageSize: 2,
    chunkRows: 1,
    onProgress: (value) => progress.push(value),
  })) chunks.push(chunk);
  assert.deepEqual(seenCursors, [null, "b"]);
  assert.equal(chunks.join(""), [
    "№\tMAC\tПроизводитель\r\n",
    "1\tAA\tAcme\r\n",
    "2\tCC\t\"Acme\tNorth\"\r\n",
    "3\tDD\tAcme\r\n",
  ].join(""));
  assert.deepEqual(progress.at(-1), { rowsScanned: 4, rowsMatched: 3 });
  assert.ok(pages.every(({ rows }) => rows.every((row) => row === null)));
});

test("filtered Inventory TSV stops reading pages when its clipboard consumer aborts", async () => {
  const controller = new globalThis.AbortController();
  let reads = 0;
  const chunks = inventorySearchTsvChunks({
    readPage: async () => {
      reads += 1;
      return { rows: [{ id: "a", mac: "AA" }], nextCursor: "a", hasMore: true };
    },
    columns: [{ key: "mac", label: "MAC" }],
    pageSize: 1,
    signal: controller.signal,
    onProgress: ({ rowsScanned }) => { if (rowsScanned === 1) controller.abort(); },
  });
  assert.equal((await chunks.next()).value, "MAC\r\n");
  await assert.rejects(chunks.next(), { name: "AbortError" });
  assert.equal(reads, 1);
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
