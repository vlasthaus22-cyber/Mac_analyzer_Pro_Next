import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { normalizeDevice } from "../src/core/normalize.js";
import { PORTABLE_ARCHIVE_RECORD_COLLECTIONS } from "../src/core/portable-archive.js";
import { assertBrowserHeapCapacity, assertBrowserHeapReserve, assertFilePairCapacity, assertSharedStringCapacity, assertSourceFileCapacity, assertTableCapacity, assertZipDirectoryCapacity, assertZipDirectoryHeaderCapacity, IMPORT_LIMITS } from "../src/core/import-limits.js";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";
import { decodeTextBuffer, detectDelimiter, detectMapping, detectMappingReport, fileObservationDate, inspectPortableArchiveHeader, listXlsxSheets, mappingRecommendationsWithoutReservedColumns, parseDelimited, readPortableArchiveEvents, readTable, readTablePreview, readTableRowBatches } from "../src/data/importer.js";
import { legacyXlsFile, sheetJs } from "./helpers/sheetjs-runtime.js";

function testCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCompressedXlsx(entries, {
  diskNumber = 0,
  directoryDisk = 0,
  entriesOnDisk = null,
  reportedEntries = null,
  localNameOverrides = {},
  localMethodOverrides = {},
  flagOverrides = {},
  crcOverrides = {},
  descriptorCrcOverrides = {},
  descriptorSignature = true,
  localGapsAfter = {},
  compressedSizeOverrides = {},
  directoryGap = Buffer.alloc(0),
  eocdComment = Buffer.alloc(0),
  trailingBytes = Buffer.alloc(0),
} = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const entryList = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [name, value] of entryList) {
    const nameBytes = Buffer.from(name);
    const localNameBytes = Buffer.from(localNameOverrides[name] ?? name);
    const uncompressed = Buffer.from(value);
    const crc = crcOverrides[name] ?? testCrc32(uncompressed);
    const compressed = deflateRawSync(uncompressed);
    const compressedSize = compressedSizeOverrides[name] ?? compressed.length;
    const flags = flagOverrides[name] ?? 0;
    const hasDataDescriptor = Boolean(flags & 0x0008);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(localMethodOverrides[name] ?? 8, 8);
    local.writeUInt32LE(hasDataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(hasDataDescriptor ? 0 : compressedSize, 18);
    local.writeUInt32LE(hasDataDescriptor ? 0 : uncompressed.length, 22);
    local.writeUInt16LE(localNameBytes.length, 26);
    localParts.push(local, localNameBytes, compressed);
    if (hasDataDescriptor) {
      const descriptorOffset = descriptorSignature ? 4 : 0;
      const descriptor = Buffer.alloc(descriptorSignature ? 16 : 12);
      if (descriptorSignature) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(descriptorCrcOverrides[name] ?? crc, descriptorOffset);
      descriptor.writeUInt32LE(compressedSize, descriptorOffset + 4);
      descriptor.writeUInt32LE(uncompressed.length, descriptorOffset + 8);
      localParts.push(descriptor);
    }
    const localGap = localGapsAfter[name] || Buffer.alloc(0);
    if (localGap.length) localParts.push(localGap);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + localNameBytes.length + compressed.length + (hasDataDescriptor ? (descriptorSignature ? 16 : 12) : 0) + localGap.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(diskNumber, 4);
  end.writeUInt16LE(directoryDisk, 6);
  end.writeUInt16LE(entriesOnDisk ?? reportedEntries ?? entryList.length, 8);
  end.writeUInt16LE(reportedEntries ?? entryList.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(eocdComment.length, 20);
  const blob = new globalThis.Blob([...localParts, centralDirectory, directoryGap, end, eocdComment, trailingBytes]);
  return {
    name: "streamed.xlsx",
    size: blob.size,
    slice: (...args) => blob.slice(...args),
    arrayBuffer() { throw new Error("the whole XLSX file must not be read into one ArrayBuffer"); },
  };
}

test("portable archive record collections share one ordered importer/exporter manifest", () => {
  assert.deepEqual(PORTABLE_ARCHIVE_RECORD_COLLECTIONS, [
    "inventory", "history", "settings", "knownModels", "oui", "switchAddressEvidence", "mac5Models",
    "smartroomRoomMappings", "singleAnalyses", "singleAnalysisChunks", "legacyObservations", "dataQualityReports",
    "legacySmartroomRoomMappings",
  ]);
  assert.equal(Object.isFrozen(PORTABLE_ARCHIVE_RECORD_COLLECTIONS), true);
});

test("CSV parser handles quoted delimiters and line breaks", () => {
  const rows = parseDelimited('MAC;Room\n"00:11:22:33:44:55";"Room; A"\n', ";");
  assert.deepEqual(rows, [["MAC", "Room"], ["00:11:22:33:44:55", "Room; A"]]);
  assert.equal(detectDelimiter("A;B\n1;2", "test.csv"), ";");
});

test("delimiter detection ignores quoted delimiters and favors consistent records", () => {
  const csv = 'MAC,Room,Comment\n00:11:22:33:44:55,"Room; East","switch, primary"\n'
    + '00:11:22:33:44:66,Room West,"contains; a comma, too"\n';
  assert.equal(detectDelimiter(csv, "devices.csv"), ",");
  assert.equal(detectDelimiter("a|b|c\n1|2|3\nheader;noise\n", "devices.csv"), "|");
  assert.equal(detectDelimiter('"value,with,commas"\n"another;value"', "devices.tsv"), "\t");
});

test("Main, SmartRoom and DDIO mappings use documented aliases", () => {
  assert.equal(detectMapping(["Internal ID", "MAC"], [["device-1", "00:11:22:33:44:55"]], "main").id, 0);
  assert.equal(detectMapping(["Smartroom ID локации"], [], "main").smartroomId, 0);
  assert.equal(detectMapping(["MAC", "Secondary MAC"], [], "main").mac2, 1);
  assert.deepEqual(detectMapping(["CallingStationID", "NasIP", "NasPortID", "B_ReceiptTime"], [], "main"), { mac: 0, switchIp: 1, switchPort: 2, authenticationTime: 3 });
  const smartroom = detectMapping(["MAC", "IP адрес", "Производитель", "Модель", "Тип модели", "Smartroom ID локации", "Название комнаты"], [], "smartroom");
  assert.equal(smartroom.mac, 0);
  assert.equal(smartroom.ip, 1);
  assert.equal(smartroom.deviceType, 4);
  assert.equal(smartroom.smartroomId, 5);
  assert.equal(detectMapping(["MAC", "Location Path"], [], "smartroom").locationPath, 1);
  const ddio = detectMapping(["Column1", "Column2", "Column3", "Column9", "Column10"], [], "ddio");
  assert.deepEqual(ddio, { reservationMac: 2, reservationIp: 1, leaseMac: 4, leaseIp: 3 });
  assert.equal(detectMapping(["Device ID", "Reservation IP", "Reservation MAC"], [], "ddio").deviceId, 0);
});

test("legacy column presets keep their exact secondary-MAC and Main spelling aliases", () => {
  for (const alias of ["MAC-адрес 2", "MAC дополнительного интерфейса"]) {
    assert.equal(detectMapping(["MAC", alias], [], "smartroom").mac2, 1, alias);
  }
  assert.equal(detectMapping(["CallingStarionID", "NasIP"], [], "main").mac, 0);
});

test("mapping report exposes confidence, alternatives, examples and required identity gaps", () => {
  const report = detectMappingReport(
    ["Device MAC", "MAC address", "Hostname"],
    [["00:11:22:33:44:55", "00:11:22:33:44:66", "switch-a"]],
    "main",
  );
  assert.equal(report.hasStrongIdentity, true);
  assert.equal(report.mapping.mac, 1);
  assert.equal(report.details.mac.confidence, 100);
  assert.equal(report.details.mac.examples[0], "00:11:22:33:44:66");
  assert.ok(report.details.mac.alternatives.some((item) => item.header === "Device MAC"));
  assert.equal(report.details.mac2.conflict, true);

  const missingIdentity = detectMappingReport(["Name", "Vendor"], [["device-a", "Acme"]], "main");
  assert.equal(missingIdentity.hasStrongIdentity, false);
  assert.equal(missingIdentity.mapping.mac, undefined);

  const incompleteDdIo = detectMappingReport(["Reservation MAC", "Other"], [["00:11:22:33:44:55", "x"]], "ddio");
  assert.equal(incompleteDdIo.validDdIoPair, false);
});

test("mapping samples the first 100 rows like the PyQt AI detector", () => {
  const rows = Array.from({ length: 100 }, (_, index) => [index < 80 ? "" : `00:11:22:33:44:${String(index).padStart(2, "0")}`]);
  const report = detectMappingReport(["MAC hardware"], rows, "main");
  assert.equal(report.details.mac.sampleCount, 100);
  assert.equal(report.mapping.mac, 0, "MAC evidence in rows 81–100 must participate in the bounded sample");
  assert.equal(report.hasStrongIdentity, true);
});

test("PyQt AI score uses at most 50 non-null values and keeps its strict MAC threshold", () => {
  const buildRows = (matches) => Array.from({ length: 100 }, (_, index) => [
    index < matches ? `00:11:22:33:44:${String(index).padStart(2, "0")}` : `other-${index}`,
  ]);
  const recognized = detectMappingReport(["Column A"], buildRows(17), "main");
  assert.equal(recognized.details.mac.recommendedPyqtAiScore, 0.255);
  assert.equal(recognized.mapping.mac, 0);

  const belowThreshold = detectMappingReport(["Column A"], buildRows(16), "main");
  assert.equal(belowThreshold.details.mac.recommendedPyqtAiScore, 0.24);
  assert.equal(belowThreshold.mapping.mac, undefined, "PyQt auto selection requires a score strictly above 0.25");

  const capProbe = detectMappingReport(["Column A"], Array.from({ length: 100 }, (_, index) => [
    index < 50 ? "not-a-mac" : `00:11:22:33:44:${String(index).padStart(2, "0")}`,
  ]), "main");
  assert.equal(capProbe.details.mac.recommendedPyqtAiScore, 0);
  assert.equal(capProbe.mapping.mac, undefined, "values after the first 50 non-null cells do not affect PyQt's AI score");

  const nullsAreDroppedBeforeTheCap = detectMappingReport(["Column A"], Array.from({ length: 100 }, (_, index) => [
    index < 60 ? null : `00:11:22:33:44:${String(index).padStart(2, "0")}`,
  ]), "main");
  assert.equal(nullsAreDroppedBeforeTheCap.details.mac.recommendedPyqtAiScore, 0.75);
  assert.equal(nullsAreDroppedBeforeTheCap.mapping.mac, 0);

  const placeholdersConsumeTheCap = detectMappingReport(["Column A"], Array.from({ length: 100 }, (_, index) => [
    index < 50 ? (index % 2 ? "nan" : "None") : `00:11:22:33:44:${String(index).padStart(2, "0")}`,
  ]), "main");
  assert.equal(placeholdersConsumeTheCap.details.mac.recommendedPyqtAiScore, 0);
  assert.equal(placeholdersConsumeTheCap.mapping.mac, undefined);
});

test("PyQt text patterns match from the start of each value like Python re.match", () => {
  const embedded = detectMappingReport(["Column A"], [
    ["Cisco manufacturer series"],
    ["Conference room 1"],
    ["Gi1/0/1 interface"],
    ["Rack location east"],
  ], "smartroom");
  assert.equal(embedded.details.manufacturer.recommendedPyqtAiScore, 0);
  assert.equal(embedded.details.room.recommendedPyqtAiScore, 0);
  assert.equal(embedded.details.switchPort.recommendedPyqtAiScore, 0);
  assert.equal(embedded.details.address.recommendedPyqtAiScore, 0);

  const prefixed = detectMappingReport(["Column A"], [
    ["manufacturer: Cisco"],
    ["room 101"],
    ["interface Gi1/0/1"],
    ["location: building 2"],
  ], "smartroom");
  assert.equal(Math.round(prefixed.details.manufacturer.recommendedPyqtAiScore * 1_000_000) / 1_000_000, 0.15);
  assert.equal(Math.round(prefixed.details.room.recommendedPyqtAiScore * 1_000_000) / 1_000_000, 0.15);
  assert.equal(Math.round(prefixed.details.switchPort.recommendedPyqtAiScore * 1_000_000) / 1_000_000, 0.140625);
  assert.equal(Math.round(prefixed.details.address.recommendedPyqtAiScore * 1_000_000) / 1_000_000, 0.13125);
});

test("mapping review recommendations expose PyQt dialog candidates above 15 percent without weakening identity", () => {
  const report = detectMappingReport(["Device MAC", "Column B"], [
    ["00:11:22:33:44:51", "10.0.0.1"],
    ["00:11:22:33:44:52", "unknown-a"],
    ["00:11:22:33:44:53", "unknown-b"],
    ["00:11:22:33:44:54", "unknown-c"],
  ], "main");
  assert.equal(report.mapping.mac, 0);
  assert.equal(report.mapping.ip, undefined, "normal auto-mapping keeps its stricter IP threshold");
  assert.equal(report.recommendations.mac, 0);
  assert.equal(report.recommendations.ip, 1, "review offers the PyQt dialog's >0.15 recommendation");
  const assignedColumns = Object.values(report.recommendations).filter(Number.isInteger);
  assert.equal(new Set(assignedColumns).size, assignedColumns.length, "review recommendations never reuse a source column");
  assert.equal(report.hasStrongIdentity, true, "the MAC identity remains required and selected");
  assert.deepEqual(mappingRecommendationsWithoutReservedColumns(report, [1]), { mac: 0 }, "a manually assigned custom column cannot be recommended for IP too");
});

test("mapping report profiles sample values for vendor, switch port, location, and identity candidates", () => {
  const report = detectMappingReport(
    ["Column A", "Column B", "Column C", "Column D"],
    [
      ["00:11:22:33:44:51", "Gi1/0/1", "г. Москва, площадка 1, этаж 2, офис 305", "SN-001"],
      ["00:11:22:33:44:52", "Gi1/0/2", "г. Москва, площадка 1, этаж 2, офис 306", "SN-002"],
      ["00:11:22:33:44:53", "Te1/0/3", "г. Москва, площадка 2, этаж 1, офис 101", "SN-003"],
    ],
    "main",
  );
  assert.equal(report.mapping.mac, 0);
  assert.equal(report.mapping.switchPort, 1);
  assert.equal(report.mapping.locationPath, 2);
  assert.equal(report.mapping.serial, 3);
  assert.ok(report.details.switchPort.confidence > 0);
  assert.equal(report.hasStrongIdentity, true);

  const smartroom = detectMappingReport(["Column A", "Manufacturer"], [
    ["00:11:22:33:44:61", "Cisco Systems"],
    ["00:11:22:33:44:62", "Cisco Systems"],
  ], "smartroom");
  assert.equal(smartroom.mapping.manufacturer, 1);
  const unlabeledVendor = detectMappingReport(["Column A", "Column B"], [
    ["00:11:22:33:44:61", "Cisco Systems"],
    ["00:11:22:33:44:62", "Cisco Systems"],
  ], "smartroom");
  assert.equal(unlabeledVendor.mapping.manufacturer, undefined, "descriptive text must not become Vendor without a labeled column");
  assert.ok(unlabeledVendor.details.manufacturer.alternatives.some((item) => item.index === 1));
});

test("sample profiling never maps NasIP to both device IP and switch IP", () => {
  const mapping = detectMapping(
    ["CallingStationID", "NasIP"],
    [["00:11:22:33:44:55", "10.0.0.1"], ["00:11:22:33:44:56", "10.0.0.2"]],
    "main",
  );
  assert.deepEqual(mapping, { mac: 0, switchIp: 1 });
});

test("unlabeled IP samples default to device IP while explicit switch headers remain switch IP", () => {
  const unlabeled = detectMapping(["unknown", "location"], [
    ["00:11:22:33:44:55", "10.0.0.1"],
  ], "main");
  assert.equal(unlabeled.mac, 0);
  assert.equal(unlabeled.ip, 1);
  assert.equal(unlabeled.switchIp, undefined);

  const explicit = detectMapping(["MAC", "Switch IP"], [
    ["00:11:22:33:44:55", "10.0.0.1"],
  ], "main");
  assert.equal(explicit.switchIp, 1);
  assert.equal(explicit.ip, undefined);
});

test("semantic column scoring separates Host, Switch, interface, and place columns locally", () => {
  const report = detectMappingReport(
    ["Device ID", "Host", "Switch", "Iface", "Place"],
    [
      ["00:11:22:33:44:55", "192.168.10.11", "10.0.0.1", "Gi1/0/1", "Rack A"],
      ["00:11:22:33:44:66", "192.168.10.12", "10.0.0.1", "Gi1/0/2", "Rack B"],
      ["00:11:22:33:44:77", "192.168.10.13", "10.0.0.2", "Gi1/0/3", "Rack C"],
    ],
    "main",
  );
  assert.equal(report.mapping.mac, 0);
  assert.equal(report.mapping.deviceId, undefined, "MAC-shaped samples must not be relabeled as a stable device ID");
  assert.equal(report.mapping.ip, 1);
  assert.equal(report.mapping.switchIp, 2);
  assert.equal(report.mapping.switchPort, 3);
  assert.equal(report.mapping.address, 4);
  assert.match(report.details.ip.reason, /конечное устройство/);
  assert.ok(report.details.switchIp.alternatives.some((item) => item.index === 1));
});

test("mapping report keeps the best legacy model recommendation visible when auto-selection has a column conflict", () => {
  const report = detectMappingReport(
    ["Device ID", "Host IP", "Switch IP", "Location", "Device Type", "Vendor Name"],
    [
      ["00:11:22:33:44:55", "192.0.2.10", "10.0.0.1", "Rack A", "Catalyst 9200", "Cisco"],
      ["00:11:22:33:44:66", "192.0.2.11", "10.0.0.1", "Rack B", "Catalyst 9300", "Cisco"],
    ],
    "main",
  );
  assert.equal(report.mapping.deviceType, 4);
  assert.equal(report.mapping.mac, 0);
  assert.ok(report.details.mac.recommendedConfidence > 50, "confidence follows the source header, sample and semantic signal scale");
  assert.equal(report.mapping.model, undefined, "automatic mapping keeps each source column unique");
  assert.equal(report.details.model.selectedIndex, null);
  assert.equal(report.details.model.recommendedIndex, 4);
  assert.ok(report.details.model.recommendedConfidence > 50);
  assert.equal(report.details.model.conflict, true);
  assert.deepEqual(report.details.model.alternatives[0].examples, ["Catalyst 9200", "Catalyst 9300"]);
});

test("Main and SmartRoom mapping expose the full device attribute schema", () => {
  const headers = [
    "MAC", "Serial", "Device ID", "Hostname", "IP", "Switch IP", "Switch Port", "Authentication Time",
    "Manufacturer", "Model", "Device Type", "Device Name", "Smartroom ID", "Business Unit", "City", "Site",
    "Floor", "Room", "Address", "Physical Address", "Location Path",
  ];
  const row = [
    "00:11:22:33:44:55", "SER-0001", "DEV-0001", "codec-1", "192.0.2.1", "10.0.0.1", "Gi1/0/1", "2026-10-14 10:00:00",
    "Acme", "Board X", "Codec", "Meeting Room Display", "SR-001", "ЦА", "Москва", "Главный офис", "3", "Переговорная 1",
    "ул. Примерная 1", "Примерная 1, этаж 3", "Москва, Главный офис, этаж 3, Переговорная 1",
  ];
  for (const role of ["main", "smartroom"]) {
    const mapping = detectMapping(headers, [row], role);
    for (const [field, header] of Object.entries({
      mac: "MAC", serial: "Serial", deviceId: "Device ID", hostname: "Hostname", ip: "IP", switchIp: "Switch IP",
      switchPort: "Switch Port", authenticationTime: "Authentication Time", manufacturer: "Manufacturer", model: "Model",
      deviceType: "Device Type", deviceName: "Device Name", smartroomId: "Smartroom ID", businessUnit: "Business Unit",
      city: "City", site: "Site", floor: "Floor", room: "Room", address: "Address", physicalAddress: "Physical Address",
      locationPath: "Location Path",
    })) {
      assert.equal(mapping[field], headers.indexOf(header), `${role} should map ${field}`);
    }
  }
});

test("delimited parsing stops at configured row and cell limits", () => {
  assert.throws(() => parseDelimited("a;b\n1;2\n3;4", ";", { maxRows: 2 }), /Слишком много строк/);
  assert.throws(() => parseDelimited("a;b\n1;2", ";", { maxCells: 3 }), /Слишком много ячеек/);
});

test("file size is checked before browser APIs read the file", async () => {
  const file = { name: "large.csv", size: 65 * 1024 * 1024, text: () => { throw new Error("file should not be read"); } };
  assert.throws(() => assertSourceFileCapacity(file), (error) => error.code === "IMPORT_CAPACITY_LIMIT");
  await assert.rejects(readTable(file), (error) => error.code === "IMPORT_CAPACITY_LIMIT");
});

test("XLSX directory limits reject excessive expansion before sheet parsing", () => {
  assert.throws(() => assertZipDirectoryCapacity([
    { name: "xl/worksheets/sheet1.xml", uncompressed: 129 * 1024 * 1024 },
  ]), /Слишком большая часть XLSX/);
  assert.throws(() => assertTableCapacity(150_001, 10), /Слишком много строк/);
});

test("XLSX central-directory metadata is bounded before the directory slice is read", async () => {
  assert.deepEqual(assertZipDirectoryHeaderCapacity(10, 512), { entryCount: 10, directoryBytes: 512 });
  assert.throws(() => assertZipDirectoryHeaderCapacity(IMPORT_LIMITS.zipEntryCount + 1, 512), /Слишком много частей XLSX/);
  assert.throws(() => assertZipDirectoryHeaderCapacity(1, IMPORT_LIMITS.zipDirectoryBytes + 1), /Слишком большой каталог XLSX/);

  const directoryBytes = IMPORT_LIMITS.zipDirectoryBytes + 1;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directoryBytes, 12);
  eocd.writeUInt32LE(0, 16);
  const endRecord = new globalThis.Blob([eocd]);
  const file = {
    name: "oversized-directory.xlsx",
    size: directoryBytes + endRecord.size,
    slice(start, end) {
      if (start === this.size - 65_557 && end === undefined) return endRecord;
      throw new Error("central directory bytes must not be read after the metadata limit fails");
    },
  };
  await assert.rejects(readTable(file), /Слишком большой каталог XLSX/);
});

test("XLSX rejects duplicate ZIP member paths before parsing workbook parts", async () => {
  const file = makeCompressedXlsx([
    ["xl/workbook.xml", "<workbook/>"],
    ["xl/workbook.xml", "<workbook><sheets/></workbook>"],
  ]);
  await assert.rejects(readTable(file), /повторяется ZIP-путь xl\/workbook\.xml/);
});

test("XLSX central-directory counts reject multi-volume and hidden trailing records", async () => {
  const parts = [["xl/workbook.xml", "<workbook/>"], ["xl/worksheets/sheet1.xml", "<worksheet/>" ]];
  await assert.rejects(readTable(makeCompressedXlsx(parts, { diskNumber: 1 })), /многотомный ZIP-каталог не поддерживается/);
  await assert.rejects(readTable(makeCompressedXlsx(parts, { reportedEntries: 1 })), /число записей не совпадает с размером ZIP-каталога/);
});

test("XLSX EOCD must end at EOF and the central directory must directly precede it", async () => {
  const parts = {
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
  };
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, { directoryGap: Buffer.from("hidden-central-record") })),
    /ZIP-каталог не совпадает с границами EOCD/,
  );

  const fakeEocdInComment = Buffer.alloc(22);
  fakeEocdInComment.writeUInt32LE(0x06054b50, 0);
  const validWithSignatureInComment = makeCompressedXlsx(parts, { eocdComment: fakeEocdInComment });
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, { trailingBytes: Buffer.from("hidden trailing bytes") })),
    /не найдена ZIP-директория/,
  );
  assert.deepEqual(await listXlsxSheets(validWithSignatureInComment), ["Devices"]);
});

test("XLSX local records cannot overlap the next local record", async () => {
  const parts = [
    ["xl/workbook.xml", "<workbook/>"] ,
    ["xl/next-part.xml", "<root/>"] ,
  ];
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, { compressedSizeOverrides: { "xl/workbook.xml": 65_535 } })),
    /данные записи xl\/workbook\.xml перекрываются со следующей локальной записью/,
  );
});

test("XLSX local headers must match the central-directory filename and compression method", async () => {
  const workbook = { "xl/workbook.xml": "<workbook/>" };
  await assert.rejects(
    readTable(makeCompressedXlsx(workbook, { localNameOverrides: { "xl/workbook.xml": "xl/other.xml" } })),
    /имя локальной записи не совпадает с ZIP-каталогом/,
  );
  await assert.rejects(
    readTable(makeCompressedXlsx(workbook, { localMethodOverrides: { "xl/workbook.xml": 0 } })),
    /локальный заголовок xl\/workbook\.xml не совпадает с ZIP-каталогом/,
  );
  await assert.rejects(
    readTable(makeCompressedXlsx(workbook, { crcOverrides: { "xl/workbook.xml": 0 } })),
    /CRC32 распакованной части xl\/workbook\.xml не совпадает с ZIP-каталогом/,
  );
});

test("XLSX rejects encrypted and unsupported ZIP flags but accepts UTF-8 names", async () => {
  for (const flags of [0x0001, 0x0010, 0x0020, 0x0040, 0x2000, 0x4000]) {
    await assert.rejects(
      readTable(makeCompressedXlsx({ "xl/workbook.xml": "<workbook/>" }, { flagOverrides: { "xl/workbook.xml": flags } })),
      /зашифрованные или неподдерживаемые ZIP-флаги/,
    );
  }
  const utf8Named = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Устройства" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
  }, { flagOverrides: { "xl/workbook.xml": 0x0800, "xl/_rels/workbook.xml.rels": 0x0800, "xl/worksheets/sheet1.xml": 0x0800 } });
  assert.deepEqual(await listXlsxSheets(utf8Named), ["Устройства"]);

  const parts = {
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
  };
  const descriptorFlags = Object.fromEntries(Object.keys(parts).map((name) => [name, 0x0008]));
  assert.deepEqual(await listXlsxSheets(makeCompressedXlsx(parts, { flagOverrides: descriptorFlags })), ["Devices"]);
  assert.deepEqual(await listXlsxSheets(makeCompressedXlsx(parts, { flagOverrides: descriptorFlags, descriptorSignature: false })), ["Devices"]);
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, {
      flagOverrides: descriptorFlags,
      descriptorCrcOverrides: { "xl/workbook.xml": 0 },
    })),
    /ZIP data descriptor записи xl\/workbook\.xml не совпадает с ZIP-каталогом/,
  );
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, { localGapsAfter: { "xl/workbook.xml": Buffer.from("hidden bytes") } })),
    /между локальными ZIP-записями xl\/workbook\.xml обнаружены лишние данные/,
  );
});

test("streamed worksheet XML rejects CRC corruption after consuming the full sheet", async () => {
  const parts = {
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>MAC</t></si><si><t>AA:BB:CC:DD:EE:FF</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>',
  };
  await assert.rejects(
    readTable(makeCompressedXlsx(parts, { crcOverrides: { "xl/worksheets/sheet1.xml": 0 } })),
    /CRC32 распакованной части xl\/worksheets\/sheet1\.xml не совпадает с ZIP-каталогом/,
  );
});

test("XLSX directory rejects malformed uncompressed sizes instead of treating them as zero", () => {
  for (const uncompressed of [Number.NaN, Number.POSITIVE_INFINITY, -1, null, "128", "invalid"]) {
    assert.throws(() => assertZipDirectoryCapacity([
      { name: "xl/worksheets/sheet1.xml", uncompressed },
    ]), (error) => error.code === "IMPORT_CAPACITY_LIMIT" && /Некорректный размер части XLSX/.test(error.message));
  }
});

test("browser heap preflight reserves headroom and rejects XLSX expansion before decompression", () => {
  const memory = { jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 200_000_000 };
  assert.deepEqual(assertBrowserHeapCapacity(700_000_000, memory), {
    checked: true, estimatedBytes: 700_000_000, safeAvailableBytes: 700_000_000,
  });
  assert.throws(() => assertBrowserHeapCapacity(700_000_001, memory), (error) => error.code === "BROWSER_HEAP_LIMIT");
  assert.equal(assertBrowserHeapCapacity(1_000_000, null).checked, false, "unsupported heap telemetry keeps static parser limits active");
  assert.throws(() => assertZipDirectoryCapacity(
    [{ name: "xl/worksheets/sheet1.xml", uncompressed: 128 }],
    { zipEntryCount: 10, expandedEntryBytes: 1024, expandedZipBytes: 1024 },
    { jsHeapSizeLimit: 1_000, usedJSHeapSize: 0 },
  ), (error) => error.code === "BROWSER_HEAP_LIMIT");
});

test("streaming operations stop before consuming the browser JavaScript heap reserve", () => {
  const healthy = { jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 200_000_000 };
  assert.deepEqual(assertBrowserHeapReserve(healthy), { checked: true, availableBytes: 800_000_000, reserveBytes: 100_000_000 });
  assert.equal(assertBrowserHeapReserve(null).checked, false, "browsers without heap telemetry retain the static import limits");
  assert.throws(() => assertBrowserHeapReserve({ jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 950_000_001 }), (error) => error.code === "BROWSER_HEAP_RESERVE" && error.actual < error.maximum);
});

test("browser heap reserve uses the 64 MiB floor for small heaps and allows its exact boundary", () => {
  const reserveBytes = 64 * 1024 * 1024;
  const belowFloor = { jsHeapSizeLimit: 512 * 1024 * 1024, usedJSHeapSize: 512 * 1024 * 1024 - reserveBytes + 1 };
  const atFloor = { ...belowFloor, usedJSHeapSize: belowFloor.usedJSHeapSize - 1 };
  assert.throws(() => assertBrowserHeapReserve(belowFloor), (error) => error.code === "BROWSER_HEAP_RESERVE" && error.maximum === reserveBytes);
  assert.deepEqual(assertBrowserHeapReserve(atFloor), {
    checked: true,
    availableBytes: reserveBytes,
    reserveBytes,
  });
});

test("streamed table readers enforce the heap reserve before handing each batch to consumers", async () => {
  const blob = new globalThis.Blob(["MAC,Room\n00:11:22:33:44:55,101\n"]);
  const file = Object.assign(blob, { name: "devices.csv" });
  const reader = readTableRowBatches(file, {
    batchSize: 1,
    memoryInfo: { jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 950_000_001 },
  });
  await assert.rejects(reader.next(), (error) => error.code === "BROWSER_HEAP_RESERVE");
});

test("two-file comparison preflights both source sizes and combined heap estimate", () => {
  const files = [{ size: 20_000_000 }, { size: 30_000_000 }];
  const memory = { jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 200_000_000 };
  assert.deepEqual(assertFilePairCapacity(files, memory), {
    totalSourceBytes: 50_000_000,
    estimatedAdditionalBytes: 100_000_000,
    heapChecked: true,
  });
  assert.throws(() => assertFilePairCapacity([{ size: 20_000_000 }, { size: 600_000_000 }], memory),
    (error) => error.code === "IMPORT_CAPACITY_LIMIT");
  assert.throws(() => assertFilePairCapacity(files, { jsHeapSizeLimit: 250_000_000, usedJSHeapSize: 100_000_000 }),
    (error) => error.code === "BROWSER_HEAP_LIMIT");
  assert.equal(assertFilePairCapacity(files, null).heapChecked, false);
});

test("full CSV and legacy XLS reads preflight heap capacity before loading whole files", async () => {
  const memoryInfo = { jsHeapSizeLimit: 1_000_000_000, usedJSHeapSize: 950_000_001 };
  let bytesRead = false;
  const csv = { name: "large.csv", size: 20_000_000, arrayBuffer: async () => { bytesRead = true; throw new Error("must preflight first"); } };
  await assert.rejects(readTable(csv, { memoryInfo }), (error) => error.code === "BROWSER_HEAP_LIMIT");
  assert.equal(bytesRead, false);

  const xls = { name: "small.xls", size: 1_024, arrayBuffer: async () => { bytesRead = true; throw new Error("must preflight first"); } };
  const reader = readTableRowBatches(xls, { memoryInfo });
  await assert.rejects(reader.next(), (error) => error.code === "BROWSER_HEAP_LIMIT");
  assert.equal(bytesRead, false);
});

test("legacy XLS reads selected sheets and bounds preview and streamed batches", async () => {
  const previousXlsx = globalThis.XLSX;
  const readOptions = [];
  globalThis.XLSX = {
    ...sheetJs,
    read(bytes, options) {
      readOptions.push(options);
      const workbook = sheetJs.read(bytes, options);
      if (options.bookSheets) assert.deepEqual(Object.keys(workbook.Sheets || {}), [], "sheet listing must not materialize worksheet cells");
      return workbook;
    },
  };
  try {
    const file = legacyXlsFile();
    assert.deepEqual(await listXlsxSheets(file), ["Устройства", "Другой лист"]);
    assert.equal(readOptions[0].bookSheets, true);
    await assert.rejects(readTable(file, { sheetName: "Неизвестный лист" }), /XLS лист не найден/);
    assert.equal(readOptions.length, 1, "an invalid selected sheet must fail before loading worksheet cells");
    const preview = await readTablePreview(file, { maxRows: 1 });
    assert.equal(readOptions[1].bookSheets, false);
    assert.deepEqual(preview.headers, ["MAC", "IP", "Модель", "Дата"]);
    assert.deepEqual(preview.rows, [["00:11:22:33:44:55", "10.20.0.1", "Камера X", "2026-10-10"]]);
    assert.equal(preview.preview, true);
    assert.equal(preview.rowCount, null);
    assert.deepEqual(fileObservationDate(file), { date: "2026-10-15T00:00:00.000Z", source: "file.lastModified" });

    await listXlsxSheets(file);
    const headers = [];
    const progress = [];
    const batches = [];
    const reader = readTableRowBatches(file, { sheetName: "Устройства", batchSize: 1, onHeaders: (value) => headers.push(value), onProgress: (value) => progress.push(value.rowsRead) });
    while (true) {
      const result = await reader.next();
      if (result.done) {
        assert.equal(result.value, undefined);
        break;
      }
      batches.push(result.value);
    }
    assert.deepEqual(batches, [
      [["00:11:22:33:44:55", "10.20.0.1", "Камера X", "2026-10-10"]],
      [["00:11:22:33:44:66", "10.20.0.2", "Контроллер", "2026-10-11"]],
    ]);
    assert.deepEqual(progress, [1, 2]);
    assert.equal(headers[0].sheet, "Устройства");
    assert.deepEqual(await readTable(file, { sheetName: "Другой лист" }), {
      headers: ["Иное"], rows: [["лист"]], rowCount: 1,
      workbookCreatedAt: "", workbookModifiedAt: "", sheet: "Другой лист",
    });
  } finally {
    if (previousXlsx === undefined) delete globalThis.XLSX;
    else globalThis.XLSX = previousXlsx;
  }
});

test("legacy XLS rejects files above its memory-safe input limit before reading bytes", async () => {
  let read = false;
  const oversized = {
    name: "oversized.xls",
    size: 16 * 1024 * 1024 + 1,
    async arrayBuffer() { read = true; throw new Error("must not read an oversized workbook"); },
  };
  const previousXlsx = globalThis.XLSX;
  globalThis.XLSX = sheetJs;
  try {
    await assert.rejects(readTable(oversized), (error) => error.code === "IMPORT_CAPACITY_LIMIT");
    assert.equal(read, false);
  } finally {
    if (previousXlsx === undefined) delete globalThis.XLSX;
    else globalThis.XLSX = previousXlsx;
  }
});

test("legacy XLS row batches stop between batches when the selected import is aborted", async () => {
  const previousXlsx = globalThis.XLSX;
  globalThis.XLSX = sheetJs;
  try {
    const controller = new globalThis.AbortController();
    const reader = readTableRowBatches(legacyXlsFile(), { batchSize: 1, signal: controller.signal });
    const first = await reader.next();
    assert.equal(first.value.length, 1);
    controller.abort();
    await assert.rejects(reader.next(), { name: "AbortError" });
  } finally {
    if (previousXlsx === undefined) delete globalThis.XLSX;
    else globalThis.XLSX = previousXlsx;
  }
});

test("shared-string table enforces the reference count and memory limits", () => {
  const limits = { sharedStringCount: 3, sharedStringBytes: 16 };
  assert.deepEqual(assertSharedStringCapacity(3, 16, limits), { count: 3, bytes: 16 });
  assert.throws(() => assertSharedStringCapacity(4, 1, limits), /Слишком много общих строк XLSX/);
  assert.throws(() => assertSharedStringCapacity(1, 17, limits), /Слишком большой раздел общих строк XLSX/);
});

test("XLSX reads ZIP members from file slices and inflates entries as streams", async () => {
  const dataRows = Array.from({ length: 1_600 }, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}" t="s"><v>2</v></c><c r="B${index + 2}" t="s"><v>3</v></c></row>`).join("");
  const file = makeCompressedXlsx({
    "docProps/core.xml": '<cp:coreProperties xmlns:cp="cp" xmlns:dcterms="dcterms"><dcterms:created xsi:type="dcterms:W3CDTF">2026-06-17T09:42:00Z</dcterms:created><dcterms:modified>2026-06-18T10:00:00Z</dcterms:modified></cp:coreProperties>',
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>MAC</t></si><si><t>Room</t></si><si><t>00:11:22:33:44:55</t></si><si><t>Conf A</t></si></sst>",
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${dataRows}</sheetData></worksheet>`,
  });
  const table = await readTable(file);
  assert.deepEqual(table.headers, ["MAC", "Room"]);
  assert.deepEqual(table.rows[0], ["00:11:22:33:44:55", "Conf A"]);
  assert.equal(table.rowCount, 1_600);
  assert.equal(table.workbookCreatedAt, "2026-06-17T09:42:00.000Z");
  assert.equal(table.workbookModifiedAt, "2026-06-18T10:00:00.000Z");
  assert.deepEqual(fileObservationDate(file, table.workbookCreatedAt, table.workbookModifiedAt), { date: "2026-06-17T09:42:00.000Z", source: "xlsx.created" });
  assert.deepEqual(table.rows.at(-1), ["00:11:22:33:44:55", "Conf A"]);
  const preview = await readTablePreview(file, { maxRows: 80 });
  assert.equal(preview.preview, true);
  assert.equal(preview.rowCount, null);
  assert.equal(preview.rows.length, 80);
});

test("numeric compact MAC cells from XLSX follow PyQt zero-padding normalization", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MAC</t></is></c><c r="B1" t="inlineStr"><is><t>Room</t></is></c></row><row r="2"><c r="A2"><v>12345678</v></c><c r="B2" t="inlineStr"><is><t>101</t></is></c></row></sheetData></worksheet>',
  });
  const table = await readTable(file, { memoryInfo: null });
  assert.equal(table.rows[0][0], "12345678", "numeric XLSX cells are preserved as source text");
  assert.equal(normalizeDevice({ mac: table.rows[0][0], room: table.rows[0][1] }).mac, "00:00:12:34:56:78");
});

test("Next XLSX export roundtrips through the streaming importer with data descriptors", async () => {
  async function* rows() {
    yield ["00:11:22:33:44:55", "Комната & 1", "Камера"];
    yield ["AA:BB:CC:DD:EE:FF", "Север", "Контроллер"];
  }
  const exported = await new globalThis.Response(createXlsxWorkbookStream([{
    name: "Оборудование",
    headings: ["MAC", "Помещение", "Тип устройства"],
    rows: rows(),
  }])).arrayBuffer();
  const blob = new globalThis.Blob([exported]);
  const file = { name: "next-roundtrip.xlsx", size: blob.size, slice: (...args) => blob.slice(...args) };
  assert.deepEqual(await listXlsxSheets(file), ["Оборудование"]);
  assert.deepEqual(await readTable(file), {
    headers: ["MAC", "Помещение", "Тип устройства"],
    rows: [
      ["00:11:22:33:44:55", "Комната & 1", "Камера"],
      ["AA:BB:CC:DD:EE:FF", "Север", "Контроллер"],
    ],
    rowCount: 2,
    workbookCreatedAt: "",
    workbookModifiedAt: "",
    sheet: "Оборудование",
  });
});

test("invalid XLSX created metadata is ignored in favor of valid modified metadata", async () => {
  const file = makeCompressedXlsx({
    "docProps/core.xml": '<cp:coreProperties xmlns:cp="cp" xmlns:dcterms="dcterms"><dcterms:created>2026-02-30T12:00:00Z</dcterms:created><dcterms:modified>2026-06-18T10:00:00Z</dcterms:modified></cp:coreProperties>',
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>MAC</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  });
  const table = await readTable(file);
  assert.equal(table.workbookCreatedAt, "");
  assert.equal(table.workbookModifiedAt, "2026-06-18T10:00:00.000Z");
  assert.deepEqual(fileObservationDate(file, table.workbookCreatedAt, table.workbookModifiedAt), {
    date: "2026-06-18T10:00:00.000Z",
    source: "xlsx.modified",
  });
});

test("XLSX row batch reader streams fixed-size batches and reports headers and progress", async () => {
  const dataRows = Array.from({ length: 1_600 }, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}" t="s"><v>2</v></c><c r="B${index + 2}" t="s"><v>3</v></c></row>`).join("");
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>MAC</t></si><si><t>Room</t></si><si><t>00:11:22:33:44:55</t></si><si><t>Conf A</t></si></sst>",
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${dataRows}</sheetData></worksheet>`,
  });
  let headerInfo = null;
  let latestProgress = null;
  let rowsRead = 0;
  let maxBatch = 0;
  let batches = 0;
  for await (const batch of readTableRowBatches(file, {
    batchSize: 127,
    onHeaders: (value) => { headerInfo = value; },
    onProgress: (value) => { latestProgress = value; },
  })) {
    batches += 1;
    rowsRead += batch.length;
    maxBatch = Math.max(maxBatch, batch.length);
  }
  assert.deepEqual(headerInfo.headers, ["MAC", "Room"]);
  assert.equal(headerInfo.sheet, "Devices");
  assert.equal(rowsRead, 1_600);
  assert.equal(maxBatch, 127);
  assert.equal(batches, 13);
  assert.equal(latestProgress.rowsRead, 1_600);
  assert.equal(latestProgress.sheet, "Devices");

  const controller = new globalThis.AbortController();
  let canceledRows = 0;
  await assert.rejects(async () => {
    for await (const batch of readTableRowBatches(file, {
      batchSize: 127,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })) canceledRows += batch.length;
  }, { name: "AbortError" });
  assert.equal(canceledRows, 127);
});

test("delimited row reader streams bounded batches across quoted chunk boundaries and CP1251", async () => {
  const longCell = "x".repeat(65_530);
  const asciiSource = `MAC;Comment\r\n00:11:22:33:44:55;"${longCell}\nwith;separator and ""quote"""\r\n00:11:22:33:44:56;`;
  const bytes = Buffer.concat([Buffer.from(asciiSource, "ascii"), Buffer.from([0xce, 0xf4, 0xe8, 0xf1, 0x0d, 0x0a])]);
  const blob = new globalThis.Blob([bytes]);
  let wholeReads = 0;
  const file = { name: "devices.csv", size: blob.size, slice: (...args) => blob.slice(...args), arrayBuffer: () => { wholeReads += 1; return blob.arrayBuffer(); } };
  let headerInfo = null;
  const progress = [];
  const batches = [];
  for await (const batch of readTableRowBatches(file, {
    batchSize: 1,
    onHeaders: (value) => { headerInfo = value; },
    onProgress: ({ rowsRead }) => progress.push(rowsRead),
  })) batches.push(batch);
  assert.equal(wholeReads, 0, "streaming batches must not read the full CSV buffer");
  const streamedRows = batches.flat();
  const expected = await readTable(file);
  assert.deepEqual(headerInfo.headers, expected.headers);
  assert.deepEqual(streamedRows, expected.rows);
  assert.equal(streamedRows[0][1], `${longCell}\nwith;separator and "quote"`);
  assert.equal(streamedRows[1][1], "Офис");
  assert.deepEqual(progress, [1, 2]);
  assert.ok(batches.every((batch) => batch.length === 1));

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("MAC;Помещение\r\n00:11:22:33:44:57;Кабинет 7\r\n", "utf16le")]);
  const utf16Blob = new globalThis.Blob([utf16]);
  const utf16File = { name: "devices.csv", size: utf16Blob.size, slice: (...args) => utf16Blob.slice(...args) };
  const utf16Rows = [];
  for await (const batch of readTableRowBatches(utf16File, { batchSize: 8 })) utf16Rows.push(...batch);
  assert.deepEqual(utf16Rows, [["00:11:22:33:44:57", "Кабинет 7"]]);
});

test("delimited row reader yields the final full batch when the last line has no newline", async () => {
  const source = ["MAC;Device ID", ...Array.from({ length: 1_000 }, (_, index) => `02:10:00:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}:01;DEV-${index}`)].join("\n");
  const file = new globalThis.File([source], "exact-batch.csv", { type: "text/csv" });
  const batches = [];
  for await (const batch of readTableRowBatches(file, { batchSize: 500 })) batches.push(batch);
  assert.deepEqual(batches.map((batch) => batch.length), [500, 500]);
  assert.equal(batches.flat().length, 1_000);
  assert.equal(batches.at(-1).at(-1)[1], "DEV-999");
});

test("portable archive reader streams Final device chunks and store record batches", async () => {
  const devices = Array.from({ length: 1_101 }, (_, index) => ({ id: `d-${index}`, mac: `AA:BB:CC:00:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}` }));
  const archive = {
    format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, exportedAt: "2026-10-15T00:00:00Z",
    snapshots: [{ id: "f1", name: "Final", createdAt: "2026-10-14T00:00:00Z", deviceCount: devices.length, chunkCount: 3, devices }],
    inventory: [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }],
    history: [{ snapshotId: "f1", deviceId: "d-1" }], settings: [], knownModels: [], oui: [],
    switchAddressEvidence: [], mac5Models: [], smartroomRoomMappings: [],
  };
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  let fullReads = 0;
  const file = { size: blob.size, slice: (...args) => blob.slice(...args), arrayBuffer: () => { fullReads += 1; throw new Error("archive reader must use bounded slices"); } };
  const header = await inspectPortableArchiveHeader(file);
  assert.equal(header.format, archive.format);
  assert.equal(header.version, 1);
  const events = [];
  for await (const event of readPortableArchiveEvents(file, { batchSize: 2 })) events.push(event);
  assert.equal(fullReads, 0);
  const chunks = events.filter((event) => event.type === "snapshotChunk");
  assert.deepEqual(chunks.map(({ index, devices: rows }) => [index, rows.length]), [[0, 500], [1, 500], [2, 101]]);
  assert.deepEqual(events.filter((event) => event.type === "records").map(({ collection, records }) => [collection, records.length]), [
    ["inventory", 2], ["inventory", 1], ["history", 1],
  ]);
  assert.deepEqual({ ...events.find((event) => event.type === "snapshot").value }, { id: "f1", name: "Final", createdAt: "2026-10-14T00:00:00Z", deviceCount: 1_101, chunkCount: 3 });
});

test("portable archive reader preserves legacy observations and data-quality reports", async () => {
  const observations = [
    { id: "legacy-observation-1", kind: "mac_history", sourceTable: "mac_history", observedAt: "2026-10-15T10:00:00Z", mac: "00:11:22:33:44:55", payload: { room: "Room 1" } },
  ];
  const reports = [
    { id: "quality-report-1", snapshotId: "final-1", createdAt: "2026-10-15T10:05:00Z", score: 92, grade: "A", report: { issues: [] } },
  ];
  const archive = { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, legacyObservations: observations, dataQualityReports: reports };
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  const file = { name: "portable.madb", size: blob.size, slice: (...args) => blob.slice(...args) };
  const events = [];
  for await (const event of readPortableArchiveEvents(file)) events.push(event);
  assert.deepEqual(events.map(({ type, collection, records }) => [type, collection, JSON.parse(JSON.stringify(records))]), [
    ["records", "legacyObservations", observations],
    ["records", "dataQualityReports", reports],
  ]);
});

test("portable archive header rejects unsupported versions and malformed JSON before import", async () => {
  const makeFile = (source) => {
    const blob = new globalThis.Blob([source]);
    return { size: blob.size, slice: (...args) => blob.slice(...args) };
  };
  await assert.rejects(inspectPortableArchiveHeader(makeFile('{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":2,"snapshots":[]}')), /Неподдерживаемый формат/);
  await assert.rejects(inspectPortableArchiveHeader(makeFile('{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":1,"snapshots":[')), /JSON|не закрыт/);
});

test("streaming JSON parser rejects excessive nesting in parsed rows and skipped archive metadata", async () => {
  const boundary = `${"[".repeat(127)}0${"]".repeat(127)}`;
  const boundaryBlob = new globalThis.Blob([`[{"MAC":"AA:BB:CC:00:00:01","payload":${boundary}}]`]);
  const boundaryFile = { name: "boundary.json", size: boundaryBlob.size, slice: (...args) => boundaryBlob.slice(...args) };
  let boundaryRows = 0;
  for await (const batch of readTableRowBatches(boundaryFile)) boundaryRows += batch.length;
  assert.equal(boundaryRows, 1, "the documented nesting boundary remains supported");

  const nested = `${"[".repeat(129)}0${"]".repeat(129)}`;
  const tableBlob = new globalThis.Blob([`[{"MAC":"AA:BB:CC:00:00:01","payload":${nested}}]`]);
  const tableFile = { name: "deep.json", size: tableBlob.size, slice: (...args) => tableBlob.slice(...args) };
  await assert.rejects(async () => {
    for await (const batch of readTableRowBatches(tableFile)) assert.equal(batch.length, 1);
  }, /глубина вложенности \(128\)/);

  const archiveFile = (source) => {
    const blob = new globalThis.Blob([source]);
    return { size: blob.size, slice: (...args) => blob.slice(...args) };
  };
  await assert.rejects(inspectPortableArchiveHeader(archiveFile(
    `{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":1,"metadata":${nested}}`,
  )), /глубина вложенности \(128\)/);
});

test("reference MAC Analyzer full-json v2 archives stream into normalized Next records", async () => {
  const sourceArchive = {
    format: "mac-analyzer-full-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    analytics: {}, workspace: {
      theme: "dark", dashboardSettings: { status: "all" },
      historyEnrichmentSettings: { enabled: false, priorityHistory: false, useOuiMatch: false, useMac5Match: true },
      ipEnrichmentSettings: { enabled: false, partialMatch: false, overwrite: true },
      visibleColumns: ["macFormatted", "vendor", "oui", "serialNumber"],
      columnOrder: ["macFormatted", "vendor", "oui", "serialNumber"],
      ouiLength: 5,
      files: [{ id: "file-1", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01", fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3, ignored: null }, path: "C:\\private\\Main.csv" }],
      ipMappings: [{ switchIp: "10.0.0.1", address: "Room 101", source: "Reference mapping" }],
      localVendorMappings: { "00:11:22": "Reference vendor rule" },
      localModelMappings: { "0011223344": "Reference model rule" },
    },
    currentDevices: [{ internalDeviceId: "CURRENT-1", mac: "00:11:22:33:44:61", vendor: "Current vendor" }],
    invalidRows: [{ rowNumber: 4, reason: "MAC is empty" }],
    allDevices: [{ internalDeviceId: "DEV-1", mac: "00:11:22:33:44:51", vendor: "Reference vendor" }],
    movementHistory: [{ mac: "00:11:22:33:44:51", type: "Изменено", field: "vendor", before: "Old", after: "Reference vendor", changedAt: "2026-10-14T12:00:00Z" }],
    snapshots: [{ metadata: { id: "reference-final", name: "Reference Final", source: "Main.csv", kind: "Final", fileCreatedAt: "2026-10-14T10:00:00Z", savedAt: "2026-10-14T10:01:00Z", deviceCount: 1, invalidCount: 0 }, devices: [{ internalDeviceId: "DEV-1", mac: "00:11:22:33:44:51", vendor: "Reference vendor", model: "Model A" }] }],
  };
  const blob = new globalThis.Blob([JSON.stringify(sourceArchive)]);
  let wholeReads = 0;
  const file = { name: "reference.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args), text: () => { wholeReads += 1; throw new Error("reference archive must be streamed"); } };
  const header = await inspectPortableArchiveHeader(file);
  assert.equal(header.sourceFormat, "mac-analyzer-full-json");
  const events = [];
  for await (const event of readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat, batchSize: 1 })) events.push(event);
  assert.equal(wholeReads, 0);
  assert.deepEqual(events.filter((event) => event.type === "records").map(({ collection, records }) => [collection, records.length]), [
    ["settings", 1], ["settings", 1], ["settings", 1], ["settings", 1], ["settings", 1], ["oui", 1], ["mac5Models", 1], ["settings", 1], ["settings", 1],
    ["referenceCurrentDevices", 1], ["referenceInvalidRows", 1],
    ["inventory", 1], ["history", 1],
  ]);
  const currentDevice = events.find((event) => event.type === "records" && event.collection === "referenceCurrentDevices").records[0];
  assert.equal(currentDevice.id, "CURRENT-1");
  assert.equal(currentDevice.manufacturer, "Current vendor");
  const invalidRow = events.find((event) => event.type === "records" && event.collection === "referenceInvalidRows").records[0];
  assert.equal(invalidRow.rowNumber, 4);
  assert.equal(invalidRow.reason, "MAC is empty");
  assert.deepEqual(events.find((event) => event.type === "records" && event.collection === "settings" && event.records[0].key === "ipAddressMappings").records[0].value,
    [{ switchIp: "10.0.0.1", address: "Room 101", source: "Reference mapping" }]);
  assert.deepEqual(events.find((event) => event.type === "records" && event.collection === "settings" && event.records[0].key === "historyEnrichmentSettings").records[0].value, {
    enabled: false, priorityHistory: false, useOuiMatch: false, useMac5Match: true,
  });
  assert.deepEqual(events.find((event) => event.type === "records" && event.collection === "settings" && event.records[0].key === "ipEnrichmentSettings").records[0].value, {
    enabled: false, partialMatch: false, overwrite: true, historicalAddress: true,
  });
  const importedColumns = events.find((event) => event.type === "records" && event.collection === "settings" && event.records[0].key === "inventoryColumnConfig").records[0].value;
  assert.deepEqual(importedColumns.columns.filter(({ key }) => ["rowNumber", "mac", "manufacturer", "oui5", "serial"].includes(key)).map(({ key, visible }) => [key, visible]), [
    ["rowNumber", true], ["mac", true], ["manufacturer", true], ["oui5", true], ["serial", true],
  ]);
  assert.deepEqual(events.find((event) => event.type === "records" && event.collection === "settings" && event.records[0].key === "legacyAppSetting:sourceFiles").records[0].value, [{
    id: "file-1", name: "Main.csv", role: "primary", sheet: "Devices", createdAt: "2026-10-01", fileDateSource: "filename", rowCount: 120, mapping: { mac: 0, vendor: 3 },
  }]);
  assert.deepEqual(events.find((event) => event.type === "records" && event.collection === "oui").records[0], {
    prefix: "001122", vendor: "Reference vendor rule", source: "MAC Analyzer Pro",
  });
  const referenceModelRule = events.find((event) => event.type === "records" && event.collection === "mac5Models").records[0];
  assert.equal(referenceModelRule.prefix, "0011223344");
  assert.equal(referenceModelRule.model, "Reference model rule");
  assert.equal(referenceModelRule.source, "MAC Analyzer Pro");
  assert.ok(Date.parse(referenceModelRule.updatedAt));
  assert.deepEqual(events.find((event) => event.type === "referenceCurrentAnalysis"), {
    type: "referenceCurrentAnalysis", id: "reference-current-20261015000000-1-1",
    processedAt: "2026-10-15T00:00:00Z", deviceCount: 1, invalidCount: 1,
  });
  const snapshot = events.find((event) => event.type === "snapshot").value;
  assert.equal(snapshot.id, "reference-final");
  assert.equal(snapshot.createdAt, "2026-10-14T10:00:00Z");
  assert.equal(snapshot.snapshotType, "final");
  const snapshotDevice = events.find((event) => event.type === "snapshotChunk").devices[0];
  assert.equal(snapshotDevice.id, "DEV-1");
  assert.equal(snapshotDevice.manufacturer, "Reference vendor");
  const history = events.find((event) => event.type === "records" && event.collection === "history").records[0];
  assert.equal(history.type, "modified");
  assert.equal(history.macKey, "00:11:22:33:44:51");
  assert.equal(history.oldValue, "Old");
  assert.equal(history.newValue, "Reference vendor");
});

test("reference workspace file mappings reject more than 128 keys, including unmapped keys", async () => {
  const mapping = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, null]));
  const blob = new globalThis.Blob([JSON.stringify({
    format: "mac-analyzer-full-json", version: 2, workspace: {
      files: [{ id: "file-1", name: "Main.csv", role: "primary", rowCount: 1, mapping }],
    },
    currentDevices: [], allDevices: [], invalidRows: [], movementHistory: [], snapshots: [],
  })]);
  const file = { size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  await assert.rejects(async () => {
    for await (const event of readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat })) void event;
  }, /слишком много сопоставлений/);
});

test("reference workspace column arrays reject invalid or oversized preferences", async () => {
  const importEvents = async (workspace) => {
    const blob = new globalThis.Blob([JSON.stringify({ format: "mac-analyzer-full-json", version: 2, workspace, snapshots: [] })]);
    const file = { size: blob.size, slice: (...args) => blob.slice(...args) };
    const header = await inspectPortableArchiveHeader(file);
    const consume = async () => {
      for await (const event of readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat })) {
        if (!event) throw new Error("Архив выдал пустое событие");
      }
    };
    return consume();
  };
  await assert.rejects(importEvents({ visibleColumns: Array.from({ length: 513 }, () => "macFormatted") }), /too many|слишком много/iu);
  await assert.rejects(importEvents({ columnOrder: ["macFormatted"], ouiLength: 7 }), /OUI.*3.*6/iu);
});

test("reference current-device JSON export streams as normalized Inventory rows", async () => {
  const archive = {
    format: "mac-analyzer-devices-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    devices: [{ internalDeviceId: "DEVICE-EXPORT-1", mac: "00:11:22:33:44:71", vendor: "Export vendor" }],
  };
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  const file = { name: "mac-analysis.json", size: blob.size, slice: (...args) => blob.slice(...args) };
  const header = await inspectPortableArchiveHeader(file);
  assert.equal(header.sourceFormat, "mac-analyzer-devices-json");
  const events = [];
  for await (const event of readPortableArchiveEvents(file, { sourceFormat: header.sourceFormat })) events.push(event);
  assert.deepEqual(events.map(({ type, collection, records }) => [type, collection, records?.length]), [["records", "inventory", 1]]);
  assert.equal(events[0].records[0].id, "DEVICE-EXPORT-1");
  assert.equal(events[0].records[0].manufacturer, "Export vendor");
});

test("reference workspace prefix mappings are emitted in bounded rule batches", async () => {
  const localVendorMappings = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [index.toString(16).padStart(6, "0"), `Vendor ${index}`]));
  const archive = { format: "mac-analyzer-full-json", version: 2, workspace: { localVendorMappings } };
  const blob = new globalThis.Blob([JSON.stringify(archive)]);
  const file = { name: "reference-rules.macarchive.json", size: blob.size, slice: (...args) => blob.slice(...args) };
  const events = [];
  for await (const event of readPortableArchiveEvents(file, { sourceFormat: "mac-analyzer-full-json" })) events.push(event);
  const batches = events.filter((event) => event.type === "records" && event.collection === "oui");
  assert.deepEqual(batches.map((event) => event.records.length), [500, 1]);
  assert.equal(batches.reduce((total, event) => total + event.records.length, 0), 501);
});

test("JSON row reader streams object and array tables without reading the whole file", async () => {
  const source = JSON.stringify({
    metadata: { nested: [1, 2, 3] },
    rows: [["Ignored", "By priority"]],
    devices: [
      { MAC: "AA:BB:CC:00:00:01", Room: "101" },
      { Serial: "S-2", MAC: "AA:BB:CC:00:00:02", Room: "102" },
      { MAC: "AA:BB:CC:00:00:03", Room: "103" },
    ],
  });
  const blob = new globalThis.Blob([source]);
  let fullReads = 0;
  const streamingFile = { name: "devices.json", size: blob.size, slice: (...args) => blob.slice(...args), arrayBuffer: () => { fullReads += 1; throw new Error("JSON batch reader must not read the entire file"); } };
  const headerEvents = [];
  const progress = [];
  const rows = [];
  for await (const batch of readTableRowBatches(streamingFile, {
    batchSize: 2,
    onHeaders: (value) => headerEvents.push(value.headers),
    onProgress: (value) => progress.push(value.rowsRead),
  })) rows.push(...batch);
  assert.equal(fullReads, 0);
  assert.deepEqual(headerEvents, [["MAC", "Room", "Serial"]]);
  assert.deepEqual(rows, [
    ["AA:BB:CC:00:00:01", "101", ""],
    ["AA:BB:CC:00:00:02", "102", "S-2"],
    ["AA:BB:CC:00:00:03", "103", ""],
  ]);
  assert.deepEqual(progress, [2, 3]);
  const fullTable = await readTable(streamingFile);
  assert.equal(fullReads, 0, "full JSON table reading must keep consuming file slices");
  assert.deepEqual(fullTable, {
    headers: ["MAC", "Room", "Serial"],
    rows,
    rowCount: 3,
  });
  const preview = await readTablePreview({ ...streamingFile, arrayBuffer: () => { throw new Error("JSON preview must not read the whole file"); } }, { maxRows: 2 });
  assert.equal(preview.preview, true);
  assert.equal(preview.rowCount, 3);
  assert.equal(preview.rows.length, 2);

  const arrayTable = [["MAC", "Room"], ["AA:BB:CC:00:00:04", "201"], ["AA:BB:CC:00:00:05", "202"]];
  const arrayBlob = new globalThis.Blob([JSON.stringify(arrayTable)]);
  const arrayFile = { name: "rows.json", size: arrayBlob.size, slice: (...args) => arrayBlob.slice(...args) };
  const arrayRows = [];
  for await (const batch of readTableRowBatches(arrayFile, { batchSize: 1 })) arrayRows.push(...batch);
  assert.deepEqual(arrayRows, arrayTable.slice(1));

  for (const key of ["rows", "data"]) {
    const wrappedBlob = new globalThis.Blob([JSON.stringify({ [key]: [{ MAC: `AA:BB:CC:00:00:0${key === "rows" ? "6" : "7"}` }] })]);
    const wrappedFile = { name: "wrapped.json", size: wrappedBlob.size, slice: (...args) => wrappedBlob.slice(...args) };
    const wrappedRows = [];
    for await (const batch of readTableRowBatches(wrappedFile, { batchSize: 1 })) wrappedRows.push(...batch);
    assert.equal(wrappedRows[0][0], `AA:BB:CC:00:00:0${key === "rows" ? "6" : "7"}`);
  }

  const fallbackBlob = new globalThis.Blob(['{"devices":false,"rows":[{"MAC":"AA:BB:CC:00:00:08"}]}']);
  const fallbackFile = { name: "fallback.json", size: fallbackBlob.size, slice: (...args) => fallbackBlob.slice(...args) };
  const fallbackRows = [];
  for await (const batch of readTableRowBatches(fallbackFile)) fallbackRows.push(...batch);
  assert.equal(fallbackRows[0][0], "AA:BB:CC:00:00:08");

  const duplicateBlob = new globalThis.Blob(['{"devices":[{"MAC":"AA:BB:CC:00:00:09"}],"devices":[{"MAC":"AA:BB:CC:00:00:0A"}]}']);
  let duplicateFullReads = 0;
  const duplicateFile = {
    name: "duplicate.json",
    size: duplicateBlob.size,
    slice: (...args) => duplicateBlob.slice(...args),
    arrayBuffer: () => { duplicateFullReads += 1; throw new Error("duplicate collection must remain streaming"); },
  };
  const duplicatePreview = await readTablePreview(duplicateFile);
  assert.deepEqual(duplicatePreview.rows, [["AA:BB:CC:00:00:0A"]]);
  const duplicateRows = [];
  for await (const batch of readTableRowBatches(duplicateFile)) duplicateRows.push(...batch);
  assert.equal(duplicateFullReads, 0);
  assert.equal(duplicateRows[0][0], "AA:BB:CC:00:00:0A");

  const invalidBlob = new globalThis.Blob(['{"rows":[{"MAC":"AA:BB:CC:00:00:01"},]}']);
  const invalidFile = { name: "invalid.json", size: invalidBlob.size, slice: (...args) => invalidBlob.slice(...args) };
  await assert.rejects(async () => {
    for await (const batch of readTableRowBatches(invalidFile)) assert.equal(batch.length, 0);
  }, SyntaxError);
});

test("large JSON source import covers every row through bounded 64 KiB reads and fixed batches", async () => {
  const sourceRows = Array.from({ length: 1_205 }, (_, index) => ({
    MAC: `02:20:${String(index >> 24).padStart(2, "0")}:${String(index >> 16 & 255).padStart(2, "0")}:${String(index >> 8 & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
    "Device ID": `DEVICE-${index}`,
    Room: `Room ${index % 37}`,
    Description: `Imported device ${index} · ${"x".repeat(96)}`,
  }));
  const blob = new globalThis.Blob([JSON.stringify({ devices: sourceRows })]);
  let sliceReads = 0;
  let maxSliceBytes = 0;
  let wholeFileReads = 0;
  const file = {
    name: "large-devices.json",
    size: blob.size,
    slice(start, end) {
      sliceReads += 1;
      maxSliceBytes = Math.max(maxSliceBytes, end - start);
      return blob.slice(start, end);
    },
    arrayBuffer() {
      wholeFileReads += 1;
      throw new Error("large JSON source must use bounded File.slice reads");
    },
  };
  const batchSizes = [];
  const headers = [];
  const lastMacs = [];
  let totalRows = 0;
  for await (const batch of readTableRowBatches(file, {
    batchSize: 127,
    onHeaders: ({ headers: value, rowCount }) => headers.push({ value, rowCount }),
  })) {
    batchSizes.push(batch.length);
    totalRows += batch.length;
    lastMacs.push(batch.at(-1)[0]);
  }

  assert.equal(wholeFileReads, 0);
  assert.ok(sliceReads > 4, "inspection and row read should use bounded chunks");
  assert.ok(maxSliceBytes <= 64 * 1024);
  assert.equal(totalRows, sourceRows.length);
  assert.deepEqual(batchSizes, [127, 127, 127, 127, 127, 127, 127, 127, 127, 62]);
  assert.deepEqual(headers, [{ value: ["MAC", "Device ID", "Room", "Description"], rowCount: 1_205 }]);
  assert.equal(lastMacs.at(-1), sourceRows.at(-1).MAC);
});

test("JSON table import rejects valid non-table root values with a clear format error", async () => {
  for (const source of ["null", "true", "42", '"text"']) {
    const blob = new globalThis.Blob([source]);
    const file = {
      name: "invalid-root.json",
      size: blob.size,
      slice: (...args) => blob.slice(...args),
      arrayBuffer: () => blob.arrayBuffer(),
    };
    await assert.rejects(readTable(file), /JSON должен содержать массив строк/);
    await assert.rejects(readTablePreview(file), /JSON должен содержать массив строк/);
    await assert.rejects(async () => {
      for await (const batch of readTableRowBatches(file)) assert.fail(`Unexpected JSON rows: ${batch.length}`);
    }, /JSON должен содержать массив строк/);
  }
});

test("XLSX sheet catalog supports selecting a named worksheet and rejects unknown names", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Inventory &amp; Devices" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/><Relationship Target="worksheets/sheet3.xml" Id="rId2"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>MAC</t></si><si><t>Summary row</t></si><si><t>Inventory row</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet3.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(await listXlsxSheets(file), ["Summary", "Inventory & Devices"]);
  assert.equal((await readTable(file)).rows[0][0], "Summary row");
  const selected = await readTable(file, { sheetName: "Inventory & Devices" });
  assert.equal(selected.sheet, "Inventory & Devices");
  assert.equal(selected.rows[0][0], "Inventory row");
  const preview = await readTablePreview(file, { maxRows: 1, sheetName: "Inventory & Devices" });
  assert.equal(preview.rows[0][0], "Inventory row");
  await assert.rejects(readTable(file, { sheetName: "Missing" }), /XLSX лист не найден/);
});

test("XLSX relationship targets decode percent-encoded worksheet paths", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Реестр" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet%20one.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet one.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MAC</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>00:11:22:33:44:55</t></is></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(await listXlsxSheets(file), ["Реестр"]);
  const table = await readTable(file);
  assert.equal(table.sheet, "Реестр");
  assert.deepEqual(table.headers, ["MAC"]);
  assert.deepEqual(table.rows, [["00:11:22:33:44:55"]]);
});

test("XLSX does not fall back to another worksheet when a referenced relationship is invalid", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Expected" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet%ZZ.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>',
  });
  await assert.rejects(listXlsxSheets(file), /XLSX не содержит читаемых листов/);
});

test("XLSX does not fall back when an explicitly referenced relationship has no target", async () => {
  for (const relationship of ['<Relationship Id="rId1"/>', '<Relationship Target="" Id="rId1"/>']) {
    const file = makeCompressedXlsx({
      "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Expected" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": `<Relationships>${relationship}</Relationships>`,
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>',
    });
    await assert.rejects(listXlsxSheets(file), /XLSX не содержит читаемых листов/);
  }
});

test("XLSX does not fall back when workbook references an undeclared relationship ID", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Expected" sheetId="1" r:id="missingRelationship"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": "<Relationships></Relationships>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>',
  });
  await assert.rejects(listXlsxSheets(file), /XLSX не содержит читаемых листов/);
});

test("XLSX default import does not silently select a later sheet when its first relationship is broken", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Broken first" sheetId="1" r:id="missingRelationship"/><sheet name="Usable second" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml" Id="rId2"/></Relationships>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MAC</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>00:11:22:33:44:55</t></is></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(await listXlsxSheets(file), ["Usable second"]);
  await assert.rejects(readTable(file), /XLSX.*перв.*связ|связ.*перв/i);
  const selected = await readTable(file, { sheetName: "Usable second" });
  assert.deepEqual(selected.rows, [["00:11:22:33:44:55"]]);
});

test("XLSX default import skips a chart sheet and chooses the first worksheet", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Chart" sheetId="1" r:id="rIdChart"/><sheet name="Data" sheetId="2" r:id="rIdData"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/chart1.xml" Id="rIdChart"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml" Id="rIdData"/></Relationships>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MAC</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>00:11:22:33:44:55</t></is></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(await listXlsxSheets(file), ["Data"]);
  const table = await readTable(file);
  assert.equal(table.sheet, "Data");
  assert.deepEqual(table.rows, [["00:11:22:33:44:55"]]);
});

test("XLSX rejects duplicate relationship IDs instead of silently retargeting a sheet", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Expected" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/><Relationship Target="worksheets/sheet2.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>EXPECTED</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG</t></is></c></row></sheetData></worksheet>',
  });
  await assert.rejects(listXlsxSheets(file), /повторяющийся relationship Id rId1/);
  await assert.rejects(readTable(file), /повторяющийся relationship Id rId1/);
});

test("XLSX ignores commented relationship and sheet tags", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><!-- <sheet name="Wrong" sheetId="2" r:id="rId2"/> --><sheet name="Expected" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><!-- <Relationship Target="worksheets/sheet2.xml" Id="rId1"/> --><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MAC</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>EXPECTED</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG</t></is></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(await listXlsxSheets(file), ["Expected"]);
  const table = await readTable(file);
  assert.equal(table.sheet, "Expected");
  assert.deepEqual(table.rows, [["EXPECTED"]]);
});

test("XLSX rejects duplicate worksheet names regardless of case", async () => {
  const file = makeCompressedXlsx({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Devices" sheetId="1" r:id="rId1"/><sheet name="devices" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/><Relationship Target="worksheets/sheet2.xml" Id="rId2"/></Relationships>',
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData></sheetData></worksheet>",
    "xl/worksheets/sheet2.xml": "<worksheet><sheetData></sheetData></worksheet>",
  });
  await assert.rejects(listXlsxSheets(file), /повторяющееся имя листа devices/);
  await assert.rejects(readTable(file), /повторяющееся имя листа devices/);
});

test("observation date prefers the filename, then workbook created metadata, then file time", () => {
  const lastModified = Date.UTC(2026, 0, 9);
  assert.deepEqual(fileObservationDate({ name: "Main_2026-06-17.csv", lastModified }, "2026-06-01T00:00:00Z"), {
    date: "2026-06-17T00:00:00.000Z",
    source: "filename",
  });
  assert.deepEqual(fileObservationDate({ name: "Main_20260617-094205.xlsx", lastModified }, "2026-06-01T00:00:00Z"), {
    date: "2026-06-17T09:42:05.000Z",
    source: "filename",
  });
  assert.deepEqual(fileObservationDate({ name: "export_17062026.xlsx", lastModified }), {
    date: "2026-06-17T00:00:00.000Z",
    source: "filename",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xlsx", lastModified }, "2026-06-17T09:42:00Z"), {
    date: "2026-06-17T09:42:00.000Z",
    source: "xlsx.created",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xls", lastModified }, "2026-06-17T09:42:00Z"), {
    date: "2026-06-17T09:42:00.000Z",
    source: "xls.created",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xlsx", lastModified }, "invalid", "2026-06-18T10:00:00Z"), {
    date: "2026-06-18T10:00:00.000Z",
    source: "xlsx.modified",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xlsx", lastModified }, "2026-02-30T12:00:00Z", "2026-06-18T10:00:00Z"), {
    date: "2026-06-18T10:00:00.000Z",
    source: "xlsx.modified",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xlsx", lastModified }, "2026-02-30T12:00:00Z"), {
    date: new Date(lastModified).toISOString(),
    source: "file.lastModified",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.xlsx", lastModified }, "invalid"), {
    date: new Date(lastModified).toISOString(),
    source: "file.lastModified",
  });
  assert.deepEqual(fileObservationDate({ name: "Main_2026-02-30.csv", lastModified }), {
    date: new Date(lastModified).toISOString(),
    source: "file.lastModified",
  });
  assert.deepEqual(fileObservationDate({ name: "Main.csv", lastModified: 0 }), {
    date: "",
    source: "import-time",
  });
});

test("CSV preview retains only the requested number of rows and marks truncation", async () => {
  const source = ["MAC,Room", ...Array.from({ length: 120 }, (_, index) => `AA:BB:CC:00:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")},${index}`)].join("\n");
  const file = Object.assign(new globalThis.Blob([source]), { name: "many.csv" });
  const defaultPreview = await readTablePreview(file);
  assert.equal(defaultPreview.rows.length, 100, "the default mapping preview matches the PyQt AI detector sample bound");
  const preview = await readTablePreview(file, { maxRows: 12 });
  assert.deepEqual(preview.headers, ["MAC", "Room"]);
  assert.equal(preview.rows.length, 12);
  assert.equal(preview.rowCount, null);
  const small = Object.assign(new globalThis.Blob(["MAC,Room\nAA:BB:CC:00:00:01,101\n"]), { name: "small.csv" });
  assert.equal((await readTablePreview(small, { maxRows: 12 })).rowCount, 1);
});

test("TXT tables use delimited parsing and keep preview bounded", async () => {
  const file = Object.assign(new globalThis.Blob(["MAC;Room\n", ...Array.from({ length: 30 }, (_, index) => `00:11:22:33:44:${String(index).padStart(2, "0")};Room ${index}\n`)]), { name: "devices.txt" });
  const preview = await readTablePreview(file, { maxRows: 5 });
  assert.deepEqual(preview.headers, ["MAC", "Room"]);
  assert.equal(preview.rows.length, 5);
  assert.equal(preview.rowCount, null);
  assert.equal(preview.preview, true);
  assert.equal((await readTable(file)).rowCount, 30);
});

test("text import keeps UTF-8, Windows-1251 and UTF-16 workbook exports readable", () => {
  const utf8 = new globalThis.TextEncoder().encode("Привет");
  const cp1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const utf16le = Uint8Array.from([0xff, 0xfe, 0x1f, 0x04, 0x40, 0x04, 0x38, 0x04, 0x32, 0x04, 0x35, 0x04, 0x42, 0x04]);
  const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x98]);
  assert.equal(decodeTextBuffer(utf8.buffer), "Привет");
  assert.equal(decodeTextBuffer(cp1251.buffer), "Привет");
  assert.equal(decodeTextBuffer(utf16le.buffer), "Привет");
  assert.equal(decodeTextBuffer(latin1.buffer), "café\u0098");
});

test("large Latin-1 decode preserves chunk boundaries without a second parts array", () => {
  const bytes = new Uint8Array(70_001);
  bytes.fill(0xe9, 0, 70_000);
  bytes[70_000] = 0x98;
  assert.equal(decodeTextBuffer(bytes.buffer), "é".repeat(70_000) + "\u0098");
});

test("streamed CSV falls back to exact Latin-1 when the source is not valid CP1251", async () => {
  const longText = "x".repeat(70_000);
  const blob = new globalThis.Blob([Buffer.concat([
    Buffer.from("MAC,Room\n00:11:22:33:44:55,"),
    Buffer.from(longText),
    Buffer.from([0xe9, 0x98]),
    Buffer.from("\n"),
  ])]);
  const file = { name: "latin1.csv", size: blob.size, slice: (...args) => blob.slice(...args), arrayBuffer: () => blob.arrayBuffer() };
  const fullTable = await readTable(file);
  const streamed = [];
  for await (const batch of readTableRowBatches(file, { batchSize: 1 })) streamed.push(...batch);
  assert.deepEqual(fullTable.headers, ["MAC", "Room"]);
  assert.equal(fullTable.rows[0][1], `${longText}é\u0098`);
  assert.deepEqual(streamed, fullTable.rows);
});

