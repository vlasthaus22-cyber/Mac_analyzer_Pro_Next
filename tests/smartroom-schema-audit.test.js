import test from "node:test";
import assert from "node:assert/strict";
import { detectMappingReport } from "../src/data/importer.js";
import { enrich } from "../src/core/enrichment.js";
import { normalizeDevice } from "../src/core/normalize.js";

const address = "Москва, Кутузовский проспект, 32А, второй этаж, переговорная 204";
const fields = ["mac", "serial", "smartroomId", "deviceId", "address", "model", "manufacturer", "ip", "deviceType"];
const values = ["00:11:22:33:44:55", "SN-123", "ROOM-5", "DEV-9", address, "DX80", "Cisco", "192.168.1.5", "Кодек"];

for (const addressHeader of ["Адрес помещения", "Физический адрес локации помещения", "Физический адрес", "Адрес локации"]) {
  test(`SmartRoom audit: ${addressHeader} survives column detection, permutation and enrichment`, async () => {
    const headers = ["MAC-адрес", "Серийный номер", "ID помещения", "ID устройства", addressHeader, "Модель устройства", "Производитель", "IP-адрес", "Тип устройства"];
    for (const order of [fields.map((_, index) => index), [8, 4, 3, 1, 5, 0, 2, 7, 6]]) {
      const orderedHeaders = order.map((index) => headers[index]);
      const row = order.map((index) => values[index]);
      const { mapping } = detectMappingReport(orderedHeaders, [row], "smartroom");
      for (const field of fields) {
        assert.equal(mapping[field], order.indexOf(fields.indexOf(field)), `${field} must use its own source column`);
      }
      assert.notEqual(mapping.deviceId, mapping.smartroomId);
      assert.notEqual(mapping.mac, mapping.address ?? mapping.physicalAddress);
      const result = await enrich({
        mainRows: [[values[0]]],
        smartroomRows: [row, order.map((index) => index === 0 ? "00:11:22:33:44:66" : index === 1 ? "OTHER-SERIAL" : index === 3 ? "OTHER-DEVICE" : values[index])],
        mappings: { main: { mac: 0 }, smartroom: mapping }, strategy: "NO_EXPANSION",
      });
      assert.equal(result.devices.length, 1, "SmartRoom-only device must not expand Main");
      const device = result.devices[0];
      for (const field of fields) assert.equal(device[field], values[fields.indexOf(field)], field);
      const restored = normalizeDevice(JSON.parse(JSON.stringify(device)));
      assert.equal(restored.address, address, "JSON roundtrip must keep the complete address");
      assert.equal(restored.deviceId, "DEV-9");
      assert.equal(restored.smartroomId, "ROOM-5");
    }
  });
}

test("SmartRoom keeps explicit address and physical-address columns separate when both exist", () => {
  const { mapping, recommendations } = detectMappingReport(
    ["MAC-адрес", "Адрес помещения", "Физический адрес", "ID помещения", "ID устройства"],
    [[values[0], address, "Другая площадка", "ROOM-5", "DEV-9"]], "smartroom",
  );
  assert.equal(mapping.address, 1);
  assert.equal(mapping.physicalAddress, 2);
  assert.equal(recommendations.address, 1);
  assert.equal(recommendations.physicalAddress, 2);
});
