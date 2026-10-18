import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { TextDecoder } from "node:util";
import { jsPDF } from "jspdf";
import { createSnapshotPdfBlob, estimateSnapshotPdfMemoryBytes, MAX_ESTIMATED_PDF_HEAP_BYTES_EXCLUSIVE, SNAPSHOT_PDF_ROWS_PER_PAGE } from "../src/core/pdf-export.js";

const fontData = readFileSync(new URL("../assets/NotoSans-Regular.ttf", import.meta.url)).toString("binary");

function pdfSource(devices, onVisit = () => {}) {
  return async (snapshotId, visit) => {
    assert.equal(snapshotId, "final-pdf");
    for (let offset = 0; offset < devices.length; offset += 20) {
      await visit(devices.slice(offset, offset + 20));
      onVisit(devices.slice(offset, offset + 20));
    }
  };
}

function pdfPageCount(source) {
  return [...source.matchAll(/\/Type\s*\/Page\b/g)].length;
}

test("PDF export creates a standalone Unicode PDF from bounded Final chunks", async () => {
  const devices = [
    { mac: "00:11:22:33:44:55", manufacturer: "Акме", model: "Панель переговорной", room: "Переговорная 101", ip: "10.0.0.15" },
    { mac: "AA:BB:CC:DD:EE:FF", manufacturer: "Другой", model: "Терминал", room: "Зал 202", ip: "10.0.0.16" },
  ];
  const result = await createSnapshotPdfBlob({ id: "final-pdf", name: "Итоговый отчет", deviceCount: devices.length }, pdfSource(devices), [
    { key: "mac", label: "MAC" }, { key: "manufacturer", label: "Производитель" }, { key: "model", label: "Модель" },
    { key: "room", label: "Помещение" }, { key: "ip", label: "IP устройства" },
  ], { jsPDF, fontData });
  const bytes = new Uint8Array(await result.arrayBuffer());
  const source = new TextDecoder("latin1").decode(bytes);

  assert.equal(result.type, "application/pdf");
  assert.equal(source.startsWith("%PDF-"), true);
  assert.match(source, /\/Subtype \/Type0/);
  assert.match(source, /\/ToUnicode/);
  assert.match(source, /\/FontFile2/);
  assert.equal(pdfPageCount(source), 1);
});

test("PDF column accessors receive a stable one-based row number across source chunks", async () => {
  const seenRowNumbers = [];
  const devices = [
    { mac: "00:11:22:33:44:55" },
    { mac: "AA:BB:CC:DD:EE:FF" },
  ];
  await createSnapshotPdfBlob({ id: "final-pdf", deviceCount: devices.length }, pdfSource(devices), [
    { key: "rowNumber", label: "№", value: (_device, rowNumber) => { seenRowNumbers.push(rowNumber); return rowNumber; } },
  ], { jsPDF, fontData });
  assert.deepEqual(seenRowNumbers, [1, 2]);
});

test("PDF export adds pages at the source limit, counts every row and reports bounded progress", async () => {
  const devices = Array.from({ length: SNAPSHOT_PDF_ROWS_PER_PAGE + 1 }, (_, index) => ({
    mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    manufacturer: "Acme",
    room: `Room ${index}`,
  }));
  const progress = [];
  const result = await createSnapshotPdfBlob({ id: "final-pdf", deviceCount: devices.length }, pdfSource(devices), [
    { key: "mac", label: "MAC" }, { key: "manufacturer", label: "Производитель" }, { key: "room", label: "Помещение" },
  ], { jsPDF, fontData, onProgress: ({ exported, total }) => progress.push([exported, total]) });
  const source = new TextDecoder("latin1").decode(await result.arrayBuffer());

  assert.equal(pdfPageCount(source), 2);
  assert.deepEqual(progress, [[20, devices.length], [40, devices.length], [devices.length, devices.length]]);
});

test("PDF export rejects a chunk count that differs from Final metadata", async () => {
  await assert.rejects(
    createSnapshotPdfBlob({ id: "final-pdf", deviceCount: 2 }, pdfSource([{ mac: "00:11:22:33:44:55" }]), [
      { key: "mac", label: "MAC" },
    ], { jsPDF, fontData }),
    /ожидалось 2 строк, прочитано 1/,
  );
});

test("PDF export preflights estimated document memory before opening the PDF writer", async () => {
  const estimate = estimateSnapshotPdfMemoryBytes(100, 10, 1000);
  assert.equal(estimate, 100 * 10 * 768 + 2 * 16 * 1024 + 2000);
  assert.ok(MAX_ESTIMATED_PDF_HEAP_BYTES_EXCLUSIVE > estimate);
  let writerStarted = false;
  await assert.rejects(createSnapshotPdfBlob(
    { id: "final-pdf", deviceCount: 100 },
    pdfSource([]),
    [{ key: "mac", label: "MAC" }],
    {
      jsPDF: () => { writerStarted = true; },
      fontData: "font",
      memoryInfo: { jsHeapSizeLimit: 100_000_000, usedJSHeapSize: 90_000_000 },
    },
  ), { code: "PDF_HEAP_LIMIT" });
  assert.equal(writerStarted, false);
});

test("PDF export applies a static estimated-memory ceiling when heap telemetry is unavailable", async () => {
  let writerStarted = false;
  const columns = Array.from({ length: 100 }, (_, index) => ({ key: `field${index}`, label: `Field ${index}` }));
  await assert.rejects(createSnapshotPdfBlob(
    { id: "final-pdf", deviceCount: 100_000 },
    pdfSource([]),
    columns,
    { jsPDF: () => { writerStarted = true; }, fontData: "font", memoryInfo: null },
  ), { code: "PDF_HEAP_LIMIT" });
  assert.equal(writerStarted, false);
});
