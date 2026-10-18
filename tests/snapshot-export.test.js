import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotXlsxSheets, snapshotCsvBlob, snapshotHtmlBlob, snapshotJsonBlob, snapshotTextBlob, snapshotYamlBlob, writeSnapshotCsv, writeSnapshotHtml, writeSnapshotJson, writeSnapshotText, writeSnapshotYaml } from "../src/core/snapshot-export.js";

const metadata = { id: "final-1", name: "Final \"one\"", deviceCount: 2, createdAt: "2026-10-01T00:00:00.000Z" };
const devices = [
  { id: "a", mac: "00:11:22:33:44:55", room: "Room; \"A\"" },
  { id: "b", mac: "AA:BB:CC:DD:EE:FF", room: "Second\nroom" },
];

test("Final XLSX sheets include metadata and stream every device across bounded Excel sheets", async () => {
  const rows = [
    { mac: "00:11:22:33:44:55", room: "Room A", alternatives: ["AA:BB"] },
    { mac: "00:11:22:33:44:56", room: "Room B", alternatives: [] },
    { mac: "00:11:22:33:44:57", room: "Room C", alternatives: ["CC:DD"] },
  ];
  const calls = [];
  const database = {
    async *iterateSnapshotDevices(id, range) {
      calls.push([id, range.start, range.limit]);
      yield* rows.slice(range.start, range.start + range.limit);
    },
  };
  const sheets = createSnapshotXlsxSheets(database, { ...metadata, deviceCount: rows.length, invalidCount: 2, processingTimeMs: 19 }, [
    { key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }, { key: "alternatives", label: "Альтернативы" },
  ], { maxDataRowsPerSheet: 2 });
  assert.equal(sheets.length, 3);
  assert.equal(sheets[0].name, "Сведения о Final");
  const facts = [];
  for await (const row of sheets[0].rows) facts.push(row);
  assert.deepEqual(facts.find(([key]) => key === "Название"), ["Название", metadata.name]);
  assert.deepEqual(facts.find(([key]) => key === "Устройств"), ["Устройств", 3]);
  const exported = [];
  for (const sheet of sheets.slice(1)) for await (const row of sheet.rows) exported.push(row);
  assert.deepEqual(exported, rows.map((row) => [row.mac, row.room, JSON.stringify(row.alternatives)]));
  assert.deepEqual(calls, [[metadata.id, 0, 2], [metadata.id, 2, 1]]);
});

async function visitChunks(_snapshotId, visit) {
  await visit(devices.slice(0, 1), 0, metadata);
  await visit(devices.slice(1), 1, metadata);
}

test("Final CSV export serializes fixed-size chunk visits with the existing delimiter and quoting", async () => {
  const blob = await snapshotCsvBlob(metadata, visitChunks, [
    { key: "mac", label: "MAC" },
    { key: "room", label: "Помещение" },
  ]);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(await blob.text(), `"MAC";"Помещение"\r\n"00:11:22:33:44:55";"Room; ""A"""\r\n"AA:BB:CC:DD:EE:FF";"Second\nroom"`);
});

test("streamed CSV, TXT, JSON and YAML writers are byte-equivalent to Blob exports", async () => {
  const cases = [
    [() => snapshotCsvBlob(metadata, visitChunks, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }]), (writable) => writeSnapshotCsv(metadata, visitChunks, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }], writable)],
    [() => snapshotTextBlob(metadata, visitChunks, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }]), (writable) => writeSnapshotText(metadata, visitChunks, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }], writable)],
    [() => snapshotJsonBlob(metadata, visitChunks), (writable) => writeSnapshotJson(metadata, visitChunks, writable)],
    [() => snapshotYamlBlob(metadata, visitChunks), (writable) => writeSnapshotYaml(metadata, visitChunks, writable)],
  ];
  for (const [createBlob, writeStream] of cases) {
    const blob = await createBlob();
    const writes = [];
    await writeStream({ async write(chunk) { await Promise.resolve(); writes.push(String(chunk)); } });
    assert.deepEqual(new globalThis.TextEncoder().encode(writes.join("")), new Uint8Array(await blob.arrayBuffer()));
  }
});

test("Final TXT export includes metadata, escaped tabular values and a bounded streaming writer", async () => {
  const columns = [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }];
  const blob = await snapshotTextBlob(metadata, visitChunks, columns);
  const text = await blob.text();
  assert.equal(blob.type, "text/plain;charset=utf-8");
  assert.match(text, /^Final MAC Analyzer Pro Next\nID Final: "final-1"\nНазвание: "Final \\\"one\\\""/);
  assert.match(text, /Устройств: 2\nНекорректных строк: 0\n\nУстройства\nMAC\tПомещение/);
  assert.match(text, /"Room; \\\"A\\\""/);
  const writes = [];
  await writeSnapshotText(metadata, visitChunks, columns, { async write(chunk) { writes.push(String(chunk)); } });
  assert.equal(writes.join(""), text);
  assert.ok(writes.length >= 2);
});

test("streamed structured exports flush bounded row groups and preserve every record", async () => {
  const rows = Array.from({ length: 4_000 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:33:${(index >> 8).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    room: `Room & Conference ${index}`,
  }));
  const snapshot = { id: "large-structured", name: "Large Final", deviceCount: rows.length };
  const visit = async (_id, accept) => {
    for (let offset = 0; offset < rows.length; offset += 173) await accept(rows.slice(offset, offset + 173));
  };
  for (const writer of [
    (sink) => writeSnapshotCsv(snapshot, visit, [{ key: "id", label: "ID" }, { key: "room", label: "Room" }], sink),
    (sink) => writeSnapshotJson(snapshot, visit, sink),
    (sink) => writeSnapshotYaml(snapshot, visit, sink),
  ]) {
    const writes = [];
    await writer({ async write(chunk) { writes.push(String(chunk)); } });
    const output = writes.join("");
    assert.ok(writes.length > 2);
    assert.ok(Math.max(...writes.map((chunk) => chunk.length * 2)) <= 256 * 1024 + 2_000);
    assert.equal((output.match(/device-3999/g) || []).length, 1);
    assert.equal((output.match(/Room &amp; Conference/g) || []).length, 0, "structured formats preserve JSON escaping, not HTML entities");
    assert.equal((output.match(/Room & Conference/g) || []).length, rows.length);
  }
});

test("Final JSON export retains the full snapshot contract while consuming device chunks", async () => {
  const blob = await snapshotJsonBlob(metadata, visitChunks);
  assert.deepEqual(JSON.parse(await blob.text()), { ...metadata, devices });
});

test("Final YAML export streams every device with complete metadata and escaped values", async () => {
  const blob = await snapshotYamlBlob(metadata, visitChunks);
  const output = await blob.text();
  const deviceRows = output.split("\n").filter((line) => line.startsWith("  - ")).map((line) => JSON.parse(line.slice(4)));

  assert.equal(blob.type, "application/yaml;charset=utf-8");
  assert.match(output, /^---\n"id": "final-1"\n/);
  assert.match(output, /"name": "Final \\\"one\\\""/);
  assert.match(output, /"devices":\n/);
  assert.deepEqual(deviceRows, devices);
});

test("Final YAML export represents an empty device collection as an empty array", async () => {
  const blob = await snapshotYamlBlob({ id: "empty", deviceCount: 0 }, async () => {});
  assert.equal(await blob.text(), '---\n"id": "empty"\n"deviceCount": 0\n"devices": []\n');
});

test("Final HTML export streams every chunk, includes metadata and escapes imported values", async () => {
  const snapshot = { ...metadata, name: '<Final "one">' };
  const rows = [
    { mac: "00:11:22:33:44:55", room: '<img src=x onerror="alert(1)">', customProperty: "<script>alert(1)</script>", fieldSources: { room: "SmartRoom" } },
    { mac: "AA:BB:CC:DD:EE:FF", room: "Room & Office" },
  ];
  const visits = [];
  const blob = await snapshotHtmlBlob(snapshot, async (id, visit) => {
    visits.push(id);
    await visit(rows.slice(0, 1));
    await visit(rows.slice(1));
  }, [{ key: "mac", label: "MAC" }, { key: "room", label: "Помещение" }]);
  const output = await blob.text();

  assert.equal(blob.type, "text/html;charset=utf-8");
  assert.deepEqual(visits, ["final-1", "final-1"], "HTML first gathers field names, then streams output rows");
  assert.match(output, /<meta charset="utf-8">/);
  assert.match(output, /&lt;Final &quot;one&quot;&gt;/);
  assert.match(output, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(output, /Room &amp; Office/);
  assert.match(output, /<th scope="col">customProperty<\/th>/);
  assert.match(output, /<th scope="col">fieldSources<\/th>/);
  assert.match(output, /&quot;room&quot;:&quot;SmartRoom&quot;/);
  assert.match(output, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((output.match(/<tbody><tr>/g) || []).length, 1);
  assert.equal((output.match(/<\/tr><tr>/g) || []).length, 1);
  assert.doesNotMatch(output, /<img src=x/);
});

test("Final HTML export supports a valid empty roster", async () => {
  const blob = await snapshotHtmlBlob({ id: "empty", deviceCount: 0 }, async () => {}, [{ key: "mac", label: "MAC" }]);
  const output = await blob.text();
  assert.match(output, /<th scope="col">MAC<\/th>/);
  assert.match(output, /<tbody><\/tbody>/);
});

test("Final HTML export flushes row markup in bounded groups without dropping devices", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => {
    const suffix = index.toString(16).toUpperCase().padStart(4, "0");
    return { mac: `00:11:22:33:${suffix.slice(0, 2)}:${suffix.slice(2)}` };
  });
  const blob = await snapshotHtmlBlob({ id: "large", deviceCount: rows.length }, async (_id, visit) => visit(rows), [{ key: "mac", label: "MAC" }]);
  const output = await blob.text();
  assert.equal((output.match(/<tbody><tr>/g) || []).length, 1);
  assert.equal((output.match(/<\/tr><tr>/g) || []).length, rows.length - 1);
  assert.match(output, /00:11:22:33:01:F4/);
});

test("Final HTML file writer emits byte-equivalent escaped markup in bounded awaited chunks", async () => {
  const rows = Array.from({ length: 2_000 }, (_, index) => ({
    mac: `00:11:22:33:${(index >> 8).toString(16).padStart(2, "0")}:${(index & 255).toString(16).padStart(2, "0")}`,
    room: index % 2 ? "Room <B>" : "Room & Office",
    source: { index, note: "escaped \"value\"" },
  }));
  const snapshot = { id: "streamed-html", name: "<Streamed Final>", deviceCount: rows.length };
  const visit = async (_id, accept) => {
    for (let offset = 0; offset < rows.length; offset += 137) await accept(rows.slice(offset, offset + 137));
  };
  const expected = await snapshotHtmlBlob(snapshot, visit, [{ key: "mac", label: "MAC" }]);
  const written = [];
  const writable = { async write(chunk) { await Promise.resolve(); written.push(String(chunk)); } };
  await writeSnapshotHtml(snapshot, visit, [{ key: "mac", label: "MAC" }], writable);
  assert.equal(written.join(""), await expected.text());
  assert.ok(written.length > 3, "header, multiple bounded row groups and footer are written separately");
  assert.ok(Math.max(...written.map((chunk) => chunk.length * 2)) <= 256 * 1024 + 2_000);
  assert.equal((written.join("").match(/<tbody><tr>/g) || []).length, 1);
  assert.equal((written.join("").match(/<\/tr><tr>/g) || []).length, rows.length - 1);
});
