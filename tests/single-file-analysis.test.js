import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSingleFile, analyzeSingleFileBatches, compareSingleFileTables, detectSingleFileMapping, hasSingleFileMappingConflicts, singleFileDevicesCsv } from "../src/core/single-file-analysis.js";

test("single-file mapping requires review when any field has ambiguous candidates", () => {
  assert.equal(hasSingleFileMappingConflicts({ details: { mac: { conflict: true } } }), true);
  assert.equal(hasSingleFileMappingConflicts({ details: { model: { conflict: false }, mac: { conflict: false } } }), false);
  assert.equal(hasSingleFileMappingConflicts(null), false);
});

test("single file analysis detects columns, deduplicates strong identity, and reports invalid rows", () => {
  const table = {
    headers: ["MAC Address", "Vendor", "Model", "Room", "IP Address"],
    rows: [
      ["AA:BB:CC:00:00:01", "Acme", "Board X", "101", "10.0.0.1"],
      ["aa-bb-cc-00-00-01", "Acme", "Board X", "101", "10.0.0.1"],
      ["not a mac", "Bad", "", "102", "10.0.0.2"],
      ["", "", "", "", ""],
    ],
  };
  const mapping = detectSingleFileMapping(table.headers, table.rows);
  const result = analyzeSingleFile(table, { mapping, source: "inventory.csv" });
  assert.equal(mapping.mac, 0);
  assert.equal(mapping.manufacturer, 1);
  assert.equal(mapping.room, 3);
  assert.equal(result.summary.rows, 4);
  assert.equal(result.summary.nonEmptyRows, 3);
  assert.equal(result.summary.valid, 1);
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.invalidMacs, 1);
  assert.equal(result.summary.duplicateRows, 1);
  assert.equal(result.devices[0].mac, "AA:BB:CC:00:00:01");
  assert.deepEqual(result.devices[0].sourceRows, [2, 3]);
  assert.equal(result.invalidPreview[0].row, 4);
  assert.equal(result.invalidPreview[0].rawMac, "not a mac");
  assert.match(result.invalidPreview[0].recommendation, /Исправьте MAC/);
  assert.equal(result.invalidMacPreview[0].value, "not a mac");
});

test("single-file summary counts exact unique MAC and populated fields across deduplicated devices", () => {
  const result = analyzeSingleFile({
    headers: ["MAC", "Vendor", "Model", "Room"],
    rows: [
      ["AA:BB:CC:00:00:01", "Acme", "Board A", "101"],
      ["aa-bb-cc-00-00-01", "Acme", "Board A", "101"],
      ["AA:BB:CC:00:00:02", "", "Board B", ""],
      ["AA:BB:CC:00:00:03", "Acme", "", "103"],
    ],
  }, { mapping: { mac: 0, manufacturer: 1, model: 2, room: 3 } });

  assert.equal(result.summary.valid, 3);
  assert.equal(result.summary.uniqueMacs, 3);
  assert.equal(result.summary.withManufacturer, 2);
  assert.equal(result.summary.withModel, 2);
  assert.equal(result.summary.withRoom, 2);
  assert.deepEqual(result.summary.manufacturers, [{ label: "Acme", value: 2 }, { label: "Не указано", value: 1 }]);
  assert.deepEqual(result.summary.models, [{ label: "Не указано", value: 1 }, { label: "Board A", value: 1 }, { label: "Board B", value: 1 }]);
  assert.deepEqual(result.summary.rooms, [{ label: "101", value: 1 }, { label: "103", value: 1 }, { label: "Не указано", value: 1 }]);
});

test("single-file duplicate source rows append once in source order without replacing earlier row numbers", () => {
  const rows = Array.from({ length: 1_500 }, () => ["AA:BB:CC:00:00:01"]);
  const result = analyzeSingleFile({ headers: ["MAC"], rows }, { mapping: { mac: 0 } });

  assert.equal(result.summary.valid, 1);
  assert.equal(result.summary.duplicateRows, rows.length - 1);
  assert.equal(result.devices[0].sourceRows.length, rows.length);
  assert.equal(result.devices[0].sourceRows[0], 2);
  assert.equal(result.devices[0].sourceRows.at(-1), rows.length + 1);
  for (let index = 0; index < rows.length; index += 1) assert.equal(result.devices[0].sourceRows[index], index + 2);
});

test("single-file invalid MAC diagnostics scan primary then alternate MAC without per-row field arrays", () => {
  const result = analyzeSingleFile({
    headers: ["Primary MAC", "Alternate MAC", "Serial"],
    rows: [
      ["invalid primary", "invalid alternate", "SERIAL-1"],
      ["", "invalid alternate only", "SERIAL-2"],
    ],
  }, { mapping: { mac: 0, mac2: 1, serial: 2 } });

  assert.equal(result.summary.valid, 2);
  assert.deepEqual(result.invalidMacPreview.map(({ row, value }) => [row, value]), [
    [2, "invalid primary"],
    [3, "invalid alternate only"],
  ]);
});

test("single-file auto mapping covers every field and uses semantic column detection", () => {
  const mapping = detectSingleFileMapping(
    ["Device ID", "Host", "Switch", "Iface", "Place"],
    [
      ["DEV-101", "192.168.10.11", "10.0.0.1", "Gi1/0/1", "Rack A"],
      ["DEV-102", "192.168.10.12", "10.0.0.1", "Gi1/0/2", "Rack B"],
    ],
  );
  assert.equal(mapping.deviceId, 0);
  assert.equal(mapping.ip, 1);
  assert.equal(mapping.switchIp, 2);
  assert.equal(mapping.switchPort, 3);
  assert.equal(mapping.address, 4);
});

test("invalid MAC diagnostics retain source row and raw value without discarding another strong identity", () => {
  const result = analyzeSingleFile({
    headers: ["MAC", "Serial", "Model"],
    rows: [
      ["bad mac value", "SERIAL-1", "Kept device"],
      ["   ", "", ""],
      ["", "", ""],
    ],
  }, { mapping: { mac: 0, serial: 1, model: 2 } });
  assert.equal(result.summary.rows, 3);
  assert.equal(result.summary.nonEmptyRows, 1);
  assert.equal(result.summary.valid, 1);
  assert.equal(result.summary.invalid, 0);
  assert.deepEqual(result.invalidMacPreview.map(({ row, value }) => [row, value]), [[2, "bad mac value"]]);
  assert.match(result.invalidMacPreview[0].recommendation, /12 шестнадцатеричных цифр/);
});

test("single file analysis uses serial priority and diagnoses a conflicting MAC alias", () => {
  const table = {
    headers: ["A", "B", "C", "D"],
    rows: [
      ["AA:BB:CC:00:00:01", "SERIAL-1", "Acme", "101"],
      ["AA:BB:CC:00:00:02", "SERIAL-2", "Other", "102"],
      ["AA:BB:CC:00:00:01", "SERIAL-2", "Conflict", "103"],
    ],
  };
  const result = analyzeSingleFile(table, { mapping: { mac: 0, serial: 1, manufacturer: 2, room: 3 } });
  assert.equal(result.devices.length, 2);
  assert.equal(result.diagnostics.ambiguous.length, 0);
  assert.equal(result.diagnostics.identityConflictCount, 1);
  assert.equal(result.diagnostics.identityConflicts[0].row, 4);
  assert.equal(result.ambiguousPreview.length, 0);
  assert.equal(result.summary.withRoom, 2);
  assert.match(singleFileDevicesCsv(result.devices), /"MAC";"IP устройства"/);
  assert.match(singleFileDevicesCsv(result.devices), /AA:BB:CC:00:00:01/);
});

test("single file analysis reports stale secondary identity without creating a false row", () => {
  const table = {
    headers: ["Internal ID", "MAC", "Model"],
    rows: [
      ["stable-a", "00:11:22:33:44:55", "A"],
      ["stable-b", "AA:BB:CC:DD:EE:FF", "B"],
      ["stable-a", "AA:BB:CC:DD:EE:FF", "A"],
    ],
  };
  const result = analyzeSingleFile(table, { mapping: { id: 0, mac: 1, model: 2 } });
  assert.equal(result.summary.valid, 2);
  assert.equal(result.summary.duplicateRows, 1);
  assert.equal(result.summary.identityConflicts, 1);
  assert.equal(result.devices[0].id, "stable-a");
  assert.equal(result.identityConflictPreview[0].alternative, "stable-b");
});

test("single-file weak-match ambiguity is reported without automatic merging", () => {
  const result = analyzeSingleFile({
    headers: ["MAC", "Hostname", "Manufacturer"],
    rows: [
      ["00:11:22:33:44:55", "shared-host", "Vendor A"],
      ["00:11:22:33:44:66", "shared-host", "Incoming Vendor"],
    ],
  }, { mapping: { mac: 0, hostname: 1, manufacturer: 2 } });

  assert.equal(result.summary.ambiguous, 1);
  assert.equal(result.ambiguousPreview[0].candidates.length, 1);
  assert.equal(result.ambiguousPreview[0].candidates[0].mac, "00:11:22:33:44:55");
  assert.equal(result.summary.valid, 1);
  assert.equal(result.devices[0].manufacturer, "Vendor A");
});

test("single-file error diagnostics retain bounded samples with exact counts", () => {
  const rows = Array.from({ length: 1_205 }, (_, index) => [`not-a-mac-${index}`, `source-row-${index}`]);
  const result = analyzeSingleFile({ headers: ["MAC", "Source data"], rows }, { mapping: { mac: 0 }, source: "large.csv" });
  assert.equal(result.summary.invalid, 1_205);
  assert.equal(result.summary.invalidMacs, 1_205);
  assert.equal(result.diagnostics.invalid.length, 1_000);
  assert.equal(result.diagnostics.invalidMacs.length, 1_000);
  assert.equal(result.diagnostics.invalidTruncated, 205);
  assert.equal(result.diagnostics.invalidMacsTruncated, 205);
  assert.equal(result.invalidPreview.length, 20);
  assert.equal(result.invalidPreview.at(-1).row, 21);
});

test("single-file ambiguous identity diagnostics remain bounded without choosing a candidate", () => {
  const incoming = Array.from({ length: 1_005 }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(6, "0").match(/.{2}/g).join(":");
    return [`AA:BB:CC:${suffix}`, "shared-host"];
  });
  const result = analyzeSingleFile({
    headers: ["MAC", "Hostname", "Device ID"],
    rows: [["00:11:22:33:44:55", "shared-host", "device-a"], ["AA:11:22:33:44:55", "shared-host", "device-b"], ...incoming.map(([mac, hostname]) => [mac, hostname, ""])],
  }, { mapping: { mac: 0, hostname: 1, deviceId: 2 }, source: "ambiguous.csv" });
  assert.equal(result.summary.ambiguous, 1_006);
  assert.equal(result.diagnostics.ambiguous.length, 1_000);
  assert.equal(result.diagnostics.ambiguousTruncated, 6);
  assert.equal(result.devices.length, 1);
  assert.equal(result.ambiguousPreview.length, 20);
});

test("mapping rejects out-of-range and non-integer column selections", () => {
  const result = analyzeSingleFile({ headers: ["MAC"], rows: [["AA:BB:CC:00:00:01"]] }, { mapping: { mac: 4, room: "0" } });
  assert.deepEqual(result.mapping, { room: 0 });
  assert.equal(result.summary.valid, 0);
  assert.equal(result.summary.invalid, 1);
});

test("single file batch analysis matches array analysis across chunk boundaries", async () => {
  const table = {
    headers: ["MAC", "Serial", "Vendor", "Room"],
    rows: [
      ["AA:BB:CC:00:00:01", "SERIAL-1", "Acme", "101"],
      ["not-a-mac", "", "Other", "102"],
      ["aa-bb-cc-00-00-01", "SERIAL-1", "Acme", "101"],
      ["AA:BB:CC:00:00:02", "SERIAL-2", "Acme", "103"],
    ],
  };
  const mapping = { mac: 0, serial: 1, manufacturer: 2, room: 3 };
  const expected = analyzeSingleFile(table, { mapping, source: "inventory.xlsx" });
  async function* batches() {
    yield table.rows.slice(0, 2);
    yield table.rows.slice(2, 3);
    yield table.rows.slice(3);
  }
  const progress = [];
  const streamed = await analyzeSingleFileBatches(table.headers, batches(), {
    mapping, source: "inventory.xlsx", onProgress: (value) => progress.push(value.rowsRead),
  });
  assert.deepEqual(streamed, expected);
  assert.deepEqual(progress, [2, 3, 4]);
});

test("two independently mapped files report added, absent, and modified devices", () => {
  const before = { headers: ["MAC", "Room"], rows: [["AA:BB:CC:00:00:01", "101"], ["AA:BB:CC:00:00:02", "102"]] };
  const after = { headers: ["Room name", "MAC address"], rows: [["201", "AA:BB:CC:00:00:01"], ["103", "AA:BB:CC:00:00:03"]] };
  const result = compareSingleFileTables(before, after, {
    beforeMapping: { mac: 0, room: 1 },
    afterMapping: { room: 0, mac: 1 },
    beforeSource: "before.csv",
    afterSource: "after.csv",
  });
  assert.equal(result.comparison.added.length, 1);
  assert.equal(result.comparison.absent.length, 1);
  assert.equal(result.comparison.modified.length, 1);
  assert.equal(result.comparison.modified[0].changes[0].field, "room");
});
