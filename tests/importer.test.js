import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { assertBrowserHeapCapacity, assertSharedStringCapacity, assertSourceFileCapacity, assertTableCapacity, assertZipDirectoryCapacity, assertZipDirectoryHeaderCapacity, IMPORT_LIMITS } from "../src/core/import-limits.js";
import { decodeTextBuffer, detectDelimiter, detectMapping, detectMappingReport, fileObservationDate, inspectPortableArchiveHeader, listXlsxSheets, parseDelimited, readPortableArchiveEvents, readTable, readTablePreview, readTableRowBatches } from "../src/data/importer.js";
import { legacyXlsFile, sheetJs } from "./helpers/sheetjs-runtime.js";

function makeCompressedXlsx(entries, { diskNumber = 0, directoryDisk = 0, entriesOnDisk = null, reportedEntries = null } = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const entryList = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [name, value] of entryList) {
    const nameBytes = Buffer.from(name);
    const uncompressed = Buffer.from(value);
    const compressed = deflateRawSync(uncompressed);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
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
  const blob = new globalThis.Blob([...localParts, centralDirectory, end]);
  return {
    name: "streamed.xlsx",
    size: blob.size,
    slice: (...args) => blob.slice(...args),
    arrayBuffer() { throw new Error("the whole XLSX file must not be read into one ArrayBuffer"); },
  };
}

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

test("legacy XLS reads selected sheets and bounds preview and streamed batches", async () => {
  const previousXlsx = globalThis.XLSX;
  globalThis.XLSX = sheetJs;
  try {
    const file = legacyXlsFile();
    assert.deepEqual(await listXlsxSheets(file), ["Устройства", "Другой лист"]);
    const preview = await readTablePreview(file, { maxRows: 1 });
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

test("portable archive header rejects unsupported versions and malformed JSON before import", async () => {
  const makeFile = (source) => {
    const blob = new globalThis.Blob([source]);
    return { size: blob.size, slice: (...args) => blob.slice(...args) };
  };
  await assert.rejects(inspectPortableArchiveHeader(makeFile('{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":2,"snapshots":[]}')), /Неподдерживаемый формат/);
  await assert.rejects(inspectPortableArchiveHeader(makeFile('{"format":"MAC_ANALYZER_NEXT_ARCHIVE","version":1,"snapshots":[')), /JSON|не закрыт/);
});

test("reference MAC Analyzer full-json v2 archives stream into normalized Next records", async () => {
  const sourceArchive = {
    format: "mac-analyzer-full-json", version: 2, exportedAt: "2026-10-15T00:00:00Z",
    analytics: {}, workspace: { theme: "dark", dashboardSettings: { status: "all" } }, currentDevices: [], invalidRows: [],
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
  assert.deepEqual(events.filter((event) => event.type === "records").map(({ collection, records }) => [collection, records.length]), [["settings", 1], ["settings", 1], ["inventory", 1], ["history", 1]]);
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

