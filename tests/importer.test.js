import test from "node:test";
import assert from "node:assert/strict";
import { detectDelimiter, detectMapping, parseDelimited } from "../src/data/importer.js";

test("CSV parser handles quoted delimiters and line breaks", () => {
  const rows = parseDelimited('MAC;Room\n"00:11:22:33:44:55";"Room; A"\n', ";");
  assert.deepEqual(rows, [["MAC", "Room"], ["00:11:22:33:44:55", "Room; A"]]);
  assert.equal(detectDelimiter("A;B\n1;2", "test.csv"), ";");
});

test("Main, SmartRoom and DDIO mappings use documented aliases", () => {
  assert.deepEqual(detectMapping(["CallingStationID", "NasIP", "NasPortID", "B_ReceiptTime"], [], "main"), { mac: 0, switchIp: 1, switchPort: 2, authenticationTime: 3 });
  const smartroom = detectMapping(["MAC", "IP адрес", "Производитель", "Модель", "Тип модели", "Smartroom ID локации", "Название комнаты"], [], "smartroom");
  assert.equal(smartroom.mac, 0);
  assert.equal(smartroom.ip, 1);
  assert.equal(smartroom.deviceType, 4);
  assert.equal(smartroom.smartroomId, 5);
  const ddio = detectMapping(["Column1", "Column2", "Column3", "Column9", "Column10"], [], "ddio");
  assert.deepEqual(ddio, { reservationMac: 2, reservationIp: 1, leaseMac: 4, leaseIp: 3 });
});

test("sample profiling never maps NasIP to both device IP and switch IP", () => {
  const mapping = detectMapping(
    ["CallingStationID", "NasIP"],
    [["00:11:22:33:44:55", "10.0.0.1"], ["00:11:22:33:44:56", "10.0.0.2"]],
    "main",
  );
  assert.deepEqual(mapping, { mac: 0, switchIp: 1 });
});

