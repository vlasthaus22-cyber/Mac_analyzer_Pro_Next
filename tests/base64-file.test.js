import test from "node:test";
import assert from "node:assert/strict";
import { readTableRowBatches } from "../src/data/importer.js";
import { createBase64FileView } from "../src/data/base64-file.js";

function encode(bytes) {
  return globalThis.btoa(String.fromCharCode(...bytes));
}

test("Base64 file view decodes only the requested byte ranges with Blob slice semantics", async () => {
  const bytes = Uint8Array.from({ length: 257 }, (_, index) => (index * 37) % 256);
  const base64 = encode(bytes);
  const file = createBase64FileView(base64, { name: "queued.xlsx", type: "Application/XLSX", lastModified: 123 });
  assert.equal(file.name, "queued.xlsx");
  assert.equal(file.type, "application/xlsx");
  assert.equal(file.size, bytes.length);
  assert.equal(file.lastModified, 123);
  for (const [start, end] of [[0, 1], [1, 2], [2, 5], [3, 65], [64, 257], [-9, 257], [250, -1], [257, 300]]) {
    const expected = new globalThis.Blob([bytes]).slice(start, end);
    assert.deepEqual(new Uint8Array(await file.slice(start, end).arrayBuffer()), new Uint8Array(await expected.arrayBuffer()), `${start}:${end}`);
  }
  assert.deepEqual(new Uint8Array(await file.slice(0, file.size).arrayBuffer()), bytes);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

test("Base64 file view rejects malformed payload length before reading", () => {
  assert.throws(() => createBase64FileView("abc"), /некорректный Base64/);
  const invalidAlphabet = createBase64FileView("!!!!");
  assert.throws(() => invalidAlphabet.slice(0, 3), /Invalid character/);
});

test("Base64 file view is consumed as a bounded CSV source by the production importer", async () => {
  const csv = "MAC,Room\r\n00:11:22:33:44:55,101\r\n00:11:22:33:44:66,102\r\n";
  const file = createBase64FileView(encode(new globalThis.TextEncoder().encode(csv)), { name: "queued.csv" });
  let headers = null;
  const batches = [];
  for await (const batch of readTableRowBatches(file, { batchSize: 1, onHeaders: ({ headers: value }) => { headers = value; } })) batches.push(batch);
  assert.deepEqual(headers, ["MAC", "Room"]);
  assert.deepEqual(batches, [[["00:11:22:33:44:55", "101"]], [["00:11:22:33:44:66", "102"]]]);
});
