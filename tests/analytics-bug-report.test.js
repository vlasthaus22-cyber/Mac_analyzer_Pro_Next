import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalyticsBugReport } from "../src/core/analytics-bug-report.js";
import { Database } from "../src/data/database.js";
import { build as buildDataset, renderOverview } from "../src/core/analytics-detail.js";
import { detectMappingReport, effectiveMergeMapping } from "../src/data/importer.js";
import { normalizeDevice } from "../src/core/normalize.js";
import { enrich } from "../src/core/enrichment.js";

test("local bug report reads all Final chunks and excludes imported text and error messages", async () => {
  const database = new Database("mac-analyzer-pro-next-test-" + crypto.randomUUID());
  const devices = Array.from({ length: 1207 }, (_, index) => ({
    id: `secret-device-${index}`, mac: "02:00:" + index.toString(16).padStart(8, "0").match(/../g).join(":"),
    room: index < 600 ? "" : "secret-room", smartroomId: "secret-location-id",
    address: "secret-address", hostname: "secret-host", ip: "192.0.2.19", sources: ["Main"],
  }));
  await database.saveFinal({ id: "secret-snapshot", name: "secret-file.csv", devices });
  let chunks = 0;
  const dataset = buildDataset(devices);
  const result = await buildAnalyticsBugReport({
    analytics: { dataset, statusDataset: buildDataset([]), dashboardFilters: { status: "missing" } },
    uiCounts: { devices: 1207, withoutRoom: 600 },
    visitCurrentChunks: (visit) => database.forEachSnapshotChunk("secret-snapshot", (rows) => { chunks++; return visit(rows); }),
    applicationLog: [{ event: "ui_error", errorName: "TypeError", message: "secret-password" }, { event: "secret-event", errorName: "secret-token" }],
  });
  assert.ok(chunks > 1);
  assert.equal(result.mismatchCount, 0);
  assert.match(result.text, /scan.emptyRoom=600\nscan.idWithoutRoom=600/);
  assert.match(result.text, /OK EMPTY_ROOM_UI: 600 \/ 600/);
  assert.match(result.text, /status.devices=0/);
  assert.doesNotMatch(result.text, /secret-|192\.0\.2\.19|02:00:/);
});

test("local bug report flags status roster replacing Final and a floor fragment", async () => {
  const result = await buildAnalyticsBugReport({
    analytics: { dataset: { summary: { devices: 7 }, roomOccupancy: { unassignedDevices: 5 } }, dashboardFilters: { status: "missing" } },
    uiCounts: { devices: 7, withoutRoom: 5 },
    visitCurrentChunks: async (visit) => {
      visit([{ mac: "00:11:22:33:44:55", room: "", address: "4 этаж", city: "private-city" }]);
      return { deviceCount: 1 };
    },
  });
  assert.equal(result.mismatchCount, 5);
  assert.match(result.text, /BUG DATASET_CURRENT_FINAL: 7 \/ 1/);
  assert.match(result.text, /BUG ADDRESS_FRAGMENT: 1/);
  assert.doesNotMatch(result.text, /private-city/);
});

test("SmartRoom screenshot schema maps the location ID to Final room ID and preserves full address", async () => {
  const headers = Array.from({ length: 38 }, (_, index) => "Column " + index);
  const row = Array(38).fill("");
  const values = [
    [0, "SmartRoom ID локации", "ROOM-123"], [1, "Наименование локации", "Кабинет 2085"],
    [5, "Адрес локации", "ЦА, Москва, Цветной Бульвар, 1 этаж"],
    [28, "ID устройства", "DEVICE-456"], [29, "Тип", "Кодек"], [30, "Производитель", "Vendor"],
    [31, "Модель", "Model"], [32, "IP адрес", "192.0.2.1"], [33, "MAC адрес", "00:11:22:33:44:55"],
    [37, "Серийный номер", "SERIAL-789"],
  ];
  for (const [index, header, value] of values) { headers[index] = header; row[index] = value; }
  const mapping = effectiveMergeMapping("smartroom", detectMappingReport(headers, [row], "smartroom").mapping);
  assert.equal(mapping.smartroomId, 0);
  assert.equal(mapping.deviceId, 28);
  const result = await enrich({ mainRows: [[row[33]]], smartroomRows: [row], mappings: { main: { mac: 0 }, smartroom: mapping } });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].smartroomId, "ROOM-123");
  assert.equal(result.devices[0].address, row[5]);
  assert.equal(result.devices[0].room, "Кабинет 2085");
});

test("normalization restores a full physical address instead of a floor fragment", () => {
  const address = "ЦА, Москва, Цветной Бульвар, 4 этаж";
  assert.equal(normalizeDevice({ address: "4 этаж", physicalAddress: address }, "SmartRoom").address, address);
  assert.equal(normalizeDevice({ address: "Другой полный адрес", physicalAddress: address }, "SmartRoom").address, "Другой полный адрес");
  assert.equal(normalizeDevice({ businessUnit: "ЦА", city: "Москва", site: "Цветной Бульвар", address: "4 этаж" }, "SmartRoom").address, address);
});

test("local report remains downloadable when Final or comparison cannot be read", async () => {
  const result = await buildAnalyticsBugReport({
    visitCurrentChunks: async () => { throw new Error("secret imported text"); }, comparisonReadFailures: 2,
  });
  assert.equal(result.mismatchCount, 2);
  assert.match(result.text, /BUG FINAL_SCAN/);
  assert.match(result.text, /BUG COMPARISON_SCAN/);
  assert.doesNotMatch(result.text, /secret imported text/);
});

test("room overview agrees with named-room roster while SmartRoom IDs remain a separate metric", async () => {
  const dataset = buildDataset([{ mac: "00:11:22:33:44:55", room: "", smartroomId: "ROOM-ID" }]);
  assert.equal(dataset.roomOccupancy.uniqueRooms, 0);
  assert.equal(dataset.roomOccupancy.unassignedDevices, 1);
  assert.match(renderOverview(dataset), /Помещений<\/span><strong>0<\/strong>/);
  assert.match(renderOverview(dataset), /Smartroom ID<\/span><strong>1<\/strong>/);
  const report = await buildAnalyticsBugReport({
    analytics: { dataset }, chartCounts: { roomOverview: 1 },
    visitCurrentChunks: async (visit) => { visit([{ mac: "00:11:22:33:44:55", room: "", smartroomId: "ROOM-ID" }]); return { deviceCount: 1 }; },
  });
  assert.equal(report.mismatchCount, 1);
  assert.match(report.text, /BUG ROOM_OVERVIEW: 1 \/ 0/);
});
