import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";
import { readTableRowBatches } from "../src/data/importer.js";
import { createBase64FileView } from "../src/data/base64-file.js";

function encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return globalThis.btoa(binary);
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

test("Base64 file view rejects malformed payload length before reading", async () => {
  assert.throws(() => createBase64FileView("abc"), /некорректный Base64/);
  const invalidAlphabet = createBase64FileView("!!!!");
  await assert.rejects(() => invalidAlphabet.slice(0, 3).arrayBuffer(), /Invalid character/);
});

test("Base64 slice streams decode bounded chunks rather than the complete requested range", async () => {
  const bytes = Uint8Array.from({ length: 600 * 1024 }, (_, index) => (index * 73) % 256);
  const base64 = encode(bytes);
  const file = createBase64FileView(base64, { name: "large-queued.xlsx" });
  const originalAtob = globalThis.atob;
  let maximumEncodedSlice = 0;
  globalThis.atob = (value) => {
    maximumEncodedSlice = Math.max(maximumEncodedSlice, value.length);
    return originalAtob(value);
  };
  let streamedBytes = 0;
  let maximumChunkBytes = 0;
  try {
    const reader = file.slice(1, file.size - 1).stream().getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      streamedBytes += value.length;
      maximumChunkBytes = Math.max(maximumChunkBytes, value.length);
    }
  } finally {
    globalThis.atob = originalAtob;
  }
  assert.equal(streamedBytes, bytes.length - 2);
  assert.ok(maximumChunkBytes <= 256 * 1024);
  assert.ok(maximumEncodedSlice < base64.length, "a large Blob slice must not be decoded in one atob call");
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

test("Base64 file view is consumed by the production XLSX ZIP and worksheet readers", async () => {
  async function* rows() {
    yield ["00:11:22:33:44:55", "Лобби"];
    yield ["AA:BB:CC:DD:EE:FF", "Север"];
  }
  const workbook = await new globalThis.Response(createXlsxWorkbookStream([{
    name: "Оборудование",
    headings: ["MAC", "Помещение"],
    rows: rows(),
  }])).arrayBuffer();
  const file = createBase64FileView(Buffer.from(workbook).toString("base64"), { name: "queued.xlsx" });
  let headers = null;
  const batches = [];
  for await (const batch of readTableRowBatches(file, { batchSize: 1, onHeaders: ({ headers: value }) => { headers = value; } })) batches.push(batch);
  assert.deepEqual(headers, ["MAC", "Помещение"]);
  assert.deepEqual(batches, [[["00:11:22:33:44:55", "Лобби"]], [["AA:BB:CC:DD:EE:FF", "Север"]]]);
});
