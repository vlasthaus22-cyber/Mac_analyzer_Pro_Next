import test from "node:test";
import assert from "node:assert/strict";
import { hasStrongIdentity, locationKey, normalizeDate, normalizeDevice, normalizeIp, normalizeMac, text } from "../src/core/normalize.js";

test("MAC normalization supports common and embedded formats", () => {
  assert.equal(normalizeMac("00-11-22-33-44-55"), "00:11:22:33:44:55");
  assert.equal(normalizeMac("0011.2233.4455"), "00:11:22:33:44:55");
  assert.equal(normalizeMac("Calling-Station-ID=00:11:22:33:44:55@radius"), "00:11:22:33:44:55");
  assert.equal(normalizeMac("invalid"), "");
});

test("IP, empty values and dates are normalized", () => {
  assert.equal(normalizeIp(" 192.168.001.010 "), "192.168.1.10");
  assert.equal(normalizeIp("999.1.1.1"), "");
  assert.equal(normalizeIp("00:11:22:33:44:55"), "");
  assert.equal(normalizeIp("[2001:0DB8:0000:0000:0000:0000:0000:0001]"), "2001:db8::1");
  assert.equal(normalizeIp("2001:db8::1"), normalizeIp("2001:0db8:0:0:0:0:0:1"));
  assert.equal(normalizeIp("::ffff:192.0.2.1"), "::ffff:c000:201");
  for (const malformed of ["192.0.2.1 trailing", "999.1.1.1", "2001:db8:1", "1:2:3:4:5:6:7:8:9", "2001:::1", "[2001:db8::1"]) {
    assert.equal(normalizeIp(malformed), "", `expected malformed IP to be rejected: ${malformed}`);
  }
  assert.equal(text(" Unknown "), "");
  for (const marker of ["not found", "NOT AVAILABLE", "не определено", "Неизвестный вендор", "не указана"]) assert.equal(text(marker), "");
  const fallbackVendor = normalizeDevice({ manufacturer: "Unknown", vendor: "Known vendor", model: "не определено" });
  assert.equal(fallbackVendor.manufacturer, "Known vendor");
  assert.equal(fallbackVendor.model, "");
  assert.match(normalizeDate("01.02.2026 03:04:05"), /^2026-02-01T03:04:05/);
  assert.equal(normalizeDate(46000), "2025-12-09T00:00:00.000Z");
  assert.equal(normalizeDate("46000.5"), "2025-12-09T12:00:00.000Z");
  assert.equal(normalizeDate("2958466"), "");
  assert.equal(normalizeDevice({ authenticationTime: "46000.25" }).authenticationTime, "2025-12-09T06:00:00.000Z");
  assert.equal(normalizeDate(new Date("2026-10-15T10:30:00.000Z")), "2026-10-15T10:30:00.000Z");
});

test("room key requires room when Smartroom ID is missing", () => {
  assert.equal(locationKey({ address: "Москва" }), "");
  assert.equal(locationKey({ room: "Переговорная 1", city: "Москва" }), "location:|москва|||переговорная 1");
  assert.equal(locationKey({ room: "Переговорная 1", city: "Москва", address: "Адрес 1" }), locationKey({ room: "Переговорная 1", city: "Москва", address: "Адрес 2" }));
  assert.equal(locationKey({ room: "Переговорная 1", address: "Адрес 1" }), "location:адрес 1|переговорная 1");
  assert.equal(locationKey({ smartroomId: "SR-1" }), "sr:sr-1");
});

test("device normalization bounds alternative and conflict arrays and marks truncation", () => {
  const device = normalizeDevice({
    mac: "00:11:22:33:44:55",
    alternateMacs: Array.from({ length: 150 }, (_, index) => (0x001122000000 + index).toString(16).padStart(12, "0")),
    possibleIps: Array.from({ length: 150 }, (_, index) => `10.0.0.${index + 1}`),
    conflicts: Array.from({ length: 150 }, (_, index) => ({ field: "ip", value: String(index) })),
  });
  assert.equal(device.alternateMacs.length, 100);
  assert.equal(device.alternateMacsTruncated, true);
  assert.equal(device.possibleIps.length, 100);
  assert.equal(device.possibleIpsTruncated, true);
  assert.equal(device.conflicts.length, 100);
  assert.equal(device.conflictsTruncated, true);
});

test("device normalization skips placeholder aliases in favor of later valid values", () => {
  const device = normalizeDevice({
    mac: "not found", macAddress: "00:11:22:33:44:55",
    ip: "unknown", deviceIp: "192.0.2.10",
    switchIp: "не определено", nasIp: "192.0.2.1",
    switchPort: "unknown", nasPortId: "Gi1/0/10",
    hostname: "not available", host: "codec-01",
    serial: "не указана", serialNumber: "SERIAL-1",
    deviceType: "unknown model", type: "Codec",
    deviceName: "not found", name: "Boardroom codec",
    authenticationTime: "not found", receiptTime: "2026-10-15T10:30:00Z",
  });
  assert.deepEqual({
    mac: device.mac, ip: device.ip, switchIp: device.switchIp, switchPort: device.switchPort,
    hostname: device.hostname, serial: device.serial, deviceType: device.deviceType,
    deviceName: device.deviceName, authenticationTime: device.authenticationTime,
  }, {
    mac: "00:11:22:33:44:55", ip: "192.0.2.10", switchIp: "192.0.2.1", switchPort: "Gi1/0/10",
    hostname: "codec-01", serial: "SERIAL-1", deviceType: "Codec",
    deviceName: "Boardroom codec", authenticationTime: "2026-10-15T10:30:00.000Z",
  });
});

test("device normalization canonicalizes legacy web snapshot identity fields", () => {
  const device = normalizeDevice({
    internal_device_id: "persisted-1", mac_formatted: "0011.2233.4455",
    secondary_mac: "AA-BB-CC-DD-EE-FF", additional_mac: "AA:BB:CC:DD:EE:FF",
    device_id: "DEVICE-1", serial_number: "SN-001", host_name: "codec-1",
    smartroom_id: "SR-10", device_ip: "192.0.2.10", ip_switch: "192.0.2.1",
  });
  assert.deepEqual({
    id: device.id, mac: device.mac, alternateMacs: device.alternateMacs,
    deviceId: device.deviceId, serial: device.serial, hostname: device.hostname,
    smartroomId: device.smartroomId, ip: device.ip, switchIp: device.switchIp,
  }, {
    id: "persisted-1", mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"],
    deviceId: "DEVICE-1", serial: "SN-001", hostname: "codec-1",
    smartroomId: "SR-10", ip: "192.0.2.10", switchIp: "192.0.2.1",
  });
});

test("device normalization keeps deterministic strong-identity alias conflicts as diagnostics", () => {
  const device = normalizeDevice({
    id: "persistent-a", internal_device_id: "persistent-b",
    deviceId: "asset-a", asset_id: "asset-b",
    serial: "serial-a", serial_number: "serial-b",
    mac: "00:11:22:33:44:55", mac_formatted: "AA:BB:CC:DD:EE:FF",
  }, "Main.csv");
  assert.equal(device.id, "persistent-a");
  assert.equal(device.deviceId, "asset-a");
  assert.equal(device.serial, "serial-a");
  assert.equal(device.mac, "00:11:22:33:44:55");
  assert.deepEqual(device.conflicts.filter((item) => item.field === "identity").map(({ identifier, selected, alternative }) => ({
    identifier, selected, alternative,
  })), [
    { identifier: "id", selected: "persistent-a", alternative: "persistent-b" },
    { identifier: "deviceId", selected: "asset-a", alternative: "asset-b" },
    { identifier: "serial", selected: "serial-a", alternative: "serial-b" },
    { identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" },
  ]);
  assert.ok(device.conflicts.every((item) => item.source === "Main.csv"));
});

test("structured values cannot become normalized strong identifiers or MAC addresses", () => {
  const device = normalizeDevice({
    id: { id: "persistent-1" }, deviceId: ["DEVICE-1"], serial: { value: "SN-1" },
    mac: ["00:11:22:33:44:55"], macFormatted: { value: "AA:BB:CC:DD:EE:FF" },
  });
  assert.equal(device.id, "");
  assert.equal(device.deviceId, "");
  assert.equal(device.serial, "");
  assert.equal(device.mac, "");
  assert.equal(hasStrongIdentity(device), false);
  assert.equal(normalizeMac(["00:11:22:33:44:55"]), "");
  assert.equal(device.conflicts.some((item) => item.field === "identity"), false);
});

test("structured JSON values cannot become IPs, dates, or room keys", () => {
  const device = normalizeDevice({
    smartroomId: { value: "SR-1" }, ip: ["192.0.2.10"], switchIp: { value: "192.0.2.1" },
    authenticationTime: { value: "2026-10-15T10:30:00Z" }, room: ["Переговорная 1"],
    city: { value: "Москва" }, manufacturer: { value: "Acme" }, model: ["Codec"],
  });
  assert.equal(device.smartroomId, "");
  assert.equal(device.ip, "");
  assert.equal(device.switchIp, "");
  assert.equal(device.authenticationTime, "");
  assert.equal(device.room, "");
  assert.equal(device.city, "");
  assert.equal(device.manufacturer, "");
  assert.equal(device.model, "");
  assert.equal(locationKey(device), "");
  assert.equal(normalizeIp(["192.0.2.10"]), "");
  assert.equal(normalizeDate({ value: "2026-10-15T10:30:00Z" }), "");
});

test("location hierarchy parses paths from room, locationPath or address and preserves empty positions", () => {
  const fromRoom = normalizeDevice({ room: "Банк, , Площадка, , Комната 3, Москва, улица 1" });
  assert.equal(fromRoom.businessUnit, "Банк");
  assert.equal(fromRoom.city, "");
  assert.equal(fromRoom.site, "Площадка");
  assert.equal(fromRoom.floor, "");
  assert.equal(fromRoom.room, "Комната 3");
  assert.equal(fromRoom.address, "Москва, улица 1");

  const fromPath = normalizeDevice({ locationPath: "Банк, Москва, Площадка, 4, Комната 5", room: "Комната вручную" });
  assert.equal(fromPath.room, "Комната вручную");
  assert.equal(fromPath.businessUnit, "Банк");
  const fromAddress = normalizeDevice({ address: "Банк, Москва, Площадка, 4, Комната 5, Москва, ул. Ленина" });
  assert.equal(fromAddress.room, "Комната 5");
  assert.equal(fromAddress.address, "Москва, ул. Ленина");
});

