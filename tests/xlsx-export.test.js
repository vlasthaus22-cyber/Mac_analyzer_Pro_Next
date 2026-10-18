import test from "node:test";
import assert from "node:assert/strict";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";
import { createSnapshotXlsxSheets } from "../src/core/snapshot-export.js";
import { writeDirectoryFile } from "../src/data/data-directory.js";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function readZip(stream) {
  const bytes = new Uint8Array(await new globalThis.Response(stream).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new globalThis.TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    const descriptor = dataStart + size;
    assert.equal(view.getUint32(descriptor, true), 0x08074b50);
    assert.equal(view.getUint32(descriptor + 4, true), crc);
    assert.equal(crc32(data), crc);
    entries.set(name, new globalThis.TextDecoder().decode(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("streamed XLSX is a valid ZIP workbook with escaped inline cells and sheet relationships", async () => {
  async function* rows() {
    yield ["00:11:22:33:44:55", "<Комната & 1>", 7];
    yield ["AA:BB:CC:DD:EE:FF", " край ", 2];
  }
  const entries = await readZip(createXlsxWorkbookStream([
    { name: "Inventory", headings: ["MAC", "Помещение", "Наблюдений"], rows: rows() },
    { name: "Хронология", headings: ["Дата"], rows: (async function* () { yield ["2026-10-14"]; })() },
  ]));
  assert.equal(entries.get("[Content_Types].xml").includes("sheet2.xml"), true);
  assert.match(entries.get("xl/workbook.xml"), /name="Хронология" sheetId="2" r:id="rId2"/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /&lt;Комната &amp; 1&gt;/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /r="C2"><v>7<\/v>/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /xml:space="preserve"> край <\/t>/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /2026-10-14/);
});

test("Final XLSX exporter produces a valid multi-sheet workbook with snapshot metadata and every ranged device", async () => {
  const devices = [
    { mac: "00:11:22:33:44:51", room: "Room A" },
    { mac: "00:11:22:33:44:52", room: "Room B" },
    { mac: "00:11:22:33:44:53", room: "Room C" },
  ];
  const database = {
    async *iterateSnapshotDevices(_id, { start, limit }) { yield* devices.slice(start, start + limit); },
  };
  const sheets = createSnapshotXlsxSheets(database, {
    id: "final-xlsx-integration", name: "Room inventory", source: "main.xlsx", createdAt: "2026-10-15T00:00:00.000Z",
    deviceCount: devices.length, invalidCount: 1,
  }, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }], { maxDataRowsPerSheet: 2 });
  const entries = await readZip(createXlsxWorkbookStream(sheets));
  assert.match(entries.get("xl/workbook.xml"), /name="Сведения о Final"/);
  assert.match(entries.get("xl/workbook.xml"), /name="Устройства"/);
  assert.match(entries.get("xl/workbook.xml"), /name="Устройства 2"/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /Room inventory/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /main\.xlsx/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /r="B7"><v>3<\/v>/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /00:11:22:33:44:51/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /00:11:22:33:44:52/);
  assert.doesNotMatch(entries.get("xl/worksheets/sheet2.xml"), /00:11:22:33:44:53/);
  assert.match(entries.get("xl/worksheets/sheet3.xml"), /00:11:22:33:44:53/);
});

test("Final auto-save writes the complete chunk-backed workbook into the selected directory", async () => {
  const devices = [
    { mac: "00:11:22:33:44:61", room: "Room A" },
    { mac: "00:11:22:33:44:62", room: "Room B" },
    { mac: "00:11:22:33:44:63", room: "Room C" },
  ];
  const database = {
    async *iterateSnapshotDevices(_id, { start, limit }) { yield* devices.slice(start, start + limit); },
  };
  const snapshot = {
    id: "final-autosave-integration", name: "Current Final", source: "main.xlsx",
    createdAt: "2026-10-17T00:00:00.000Z", deviceCount: devices.length, invalidCount: 0,
  };
  const sheets = createSnapshotXlsxSheets(database, snapshot, [
    { key: "mac", label: "MAC" }, { key: "room", label: "Помещение" },
  ], { maxDataRowsPerSheet: 2 });
  const chunks = [];
  const calls = [];
  let committed = false;
  const directory = {
    async getFileHandle(name, { create }) {
      calls.push([name, create]);
      if (!create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return {
        async createWritable(options) {
          assert.deepEqual(options, { keepExistingData: false });
          return new globalThis.WritableStream({
            write(chunk) { chunks.push(new Uint8Array(chunk)); },
            close() { committed = true; },
          });
        },
      };
    },
  };

  const result = await writeDirectoryFile(directory, "autosave_20261017_120000_007_a1b2c3d4.xlsx", createXlsxWorkbookStream(sheets));
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const entries = await readZip(new globalThis.ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));

  assert.deepEqual(result, { fileName: "autosave_20261017_120000_007_a1b2c3d4.xlsx", bytesWritten: bytes.length });
  assert.deepEqual(calls, [[result.fileName, false], [result.fileName, true]]);
  assert.equal(committed, true);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /00:11:22:33:44:61/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /00:11:22:33:44:62/);
  assert.match(entries.get("xl/worksheets/sheet3.xml"), /00:11:22:33:44:63/);
});

test("XLSX workbook requires async row streams and valid sheet names", async () => {
  assert.throws(() => createXlsxWorkbookStream([{ name: "Sheet", headings: ["A"], rows: [] }]), /должны поступать потоком/);
  assert.throws(() => createXlsxWorkbookStream([{ name: "Sheet", headings: [], rows: (async function* () {})() }]), /нет заголовков/);
});
