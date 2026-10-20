import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultInventoryColumnConfig,
  addCustomInventoryColumn,
  customInventoryColumnKey,
  inventoryColumnConfigFromLegacyPreferences,
  inventoryCellText,
  moveInventoryColumn,
  normalizeInventoryColumnConfig,
  optimizeInventoryColumnWidths,
  removeCustomInventoryColumn,
  updateInventoryColumn,
  visibleInventoryColumns,
} from "../src/core/inventory-columns.js";

test("inventory column settings normalize order, labels, visibility and bounded widths", () => {
  const config = normalizeInventoryColumnConfig({ columns: [
    { key: "room", label: "Custom room", visible: true, width: 2500 },
    { key: "unknown", label: "Injected", visible: true, width: 120 },
    { key: "room", label: "Duplicate", visible: false, width: 80 },
  ] });
  assert.equal(config.columns[0].key, "rowNumber");
  assert.equal(config.columns[1].key, "room");
  assert.equal(config.columns[1].label, "Custom room");
  assert.equal(config.columns[1].width, 600);
  assert.equal(visibleInventoryColumns(config)[0].key, "rowNumber");
  assert.equal(visibleInventoryColumns(config)[1].key, "room");
  assert.equal(config.columns.some(({ key }) => key === "unknown"), false);
  assert.equal(config.columns.length, defaultInventoryColumnConfig().columns.length);
});

test("address and source-address columns have distinct labels and migrate the old default label", () => {
  const config = normalizeInventoryColumnConfig({ columns: [
    { key: "address", label: "Физический адрес", visible: true },
    { key: "physicalAddress", label: "Физический адрес", visible: true },
  ] });
  const address = config.columns.find(({ key }) => key === "address");
  const sourceAddress = config.columns.find(({ key }) => key === "physicalAddress");

  assert.equal(address.label, "Физический адрес");
  assert.equal(sourceAddress.label, "Адрес из источника");
  assert.equal(new Set(config.columns.map(({ label }) => label)).size, config.columns.length);
  assert.equal(inventoryCellText({ address: "Офис 1", physicalAddress: "Корпус А" }, "address"), "Офис 1");
  assert.equal(inventoryCellText({ address: "Офис 1", physicalAddress: "Корпус А" }, "physicalAddress"), "Корпус А");

  const customized = normalizeInventoryColumnConfig({ columns: [
    { key: "physicalAddress", label: "Адрес площадки", visible: true },
  ] });
  assert.equal(customized.columns.find(({ key }) => key === "physicalAddress").label, "Адрес площадки");
});

test("custom and renamed columns cannot introduce ambiguous duplicate headers", () => {
  const config = addCustomInventoryColumn(defaultInventoryColumnConfig(), "Физический адрес", "123e4567-e89b-42d3-a456-426614174010");
  const custom = config.columns.find(({ key }) => key === "custom_123e4567-e89b-42d3-a456-426614174010");
  assert.equal(custom.label, "Физический адрес (2)");

  const renamed = updateInventoryColumn(config, "deviceId", { label: "MAC" });
  assert.equal(renamed.columns.find(({ key }) => key === "deviceId").label, "MAC (2)");
  assert.equal(new Set(renamed.columns.map(({ label }) => label.toLowerCase())).size, renamed.columns.length);

  const restored = normalizeInventoryColumnConfig({ columns: [
    { key: "address", label: "Объект", visible: true },
    { key: "physicalAddress", label: "Объект", visible: true },
  ] });
  assert.deepEqual(restored.columns.filter(({ key }) => ["address", "physicalAddress"].includes(key)).map(({ label }) => label), ["Объект", "Объект (2)"]);
});

test("legacy PyQt results-column preferences restore matching Inventory order, visibility and widths", () => {
  const config = inventoryColumnConfigFromLegacyPreferences(JSON.stringify({
    order: ["№", "mac_formatted", "MAC (форматированный)", "ip", "vendor", "room", "deviceId"],
    visible: ["№", "mac_formatted", "vendor", "deviceId"],
    widths: { macFormatted: 220, vendor: 260, deviceId: 180 },
  }));
  assert.equal(config.columns[0].key, "rowNumber");
  assert.equal(config.columns[0].visible, true);
  assert.equal(config.columns[1].key, "macFormatted");
  assert.equal(config.columns[2].key, "ip");
  assert.equal(config.columns[3].key, "manufacturer");
  assert.equal(config.columns[1].width, 220);
  assert.equal(config.columns.find(({ key }) => key === "manufacturer").width, 260);
  assert.deepEqual(visibleInventoryColumns(config).map(({ key }) => key), ["rowNumber", "macFormatted", "manufacturer", "deviceId"]);
  assert.equal(inventoryColumnConfigFromLegacyPreferences("not-json"), null);
});

test("older Next column settings add the new row number first without losing saved choices", () => {
  const config = normalizeInventoryColumnConfig({ columns: [
    { key: "mac", label: "MAC", visible: true, width: 210 },
    { key: "room", label: "Room", visible: false, width: 180 },
  ] });
  assert.deepEqual(config.columns.slice(0, 3).map(({ key }) => key), ["rowNumber", "mac", "room"]);
  assert.equal(config.columns[0].visible, true);
  assert.equal(config.columns[1].width, 210);
  assert.equal(config.columns[2].visible, false);
});

test("Inventory supports every reference result column for MAC, OUI, notes and observation date", () => {
  const config = defaultInventoryColumnConfig();
  const optionalKeys = ["macFormatted", "oui3", "oui4", "oui5", "oui6", "matchDetails", "addedAt"];
  for (const key of optionalKeys) assert.ok(config.columns.some((column) => column.key === key), `missing ${key}`);
  assert.equal(config.columns[0].key, "rowNumber");
  assert.equal(config.columns[0].visible, true);
  const device = {
    mac: "—",
    macFormatted: "001122AABBCC",
    matchDetails: "Совпадение по серийному номеру",
    firstSeenAt: "2026-10-16T12:34:56.000Z",
  };
  assert.equal(inventoryCellText(device, "macFormatted"), "00:11:22:AA:BB:CC");
  assert.equal(inventoryCellText(device, "oui3"), "00:11:22");
  assert.equal(inventoryCellText(device, "oui4"), "00:11:22:AA");
  assert.equal(inventoryCellText(device, "oui5"), "00:11:22:AA:BB");
  assert.equal(inventoryCellText(device, "oui6"), "00:11:22:AA:BB:CC");
  assert.equal(inventoryCellText(device, "matchDetails"), "Совпадение по серийному номеру");
  assert.equal(inventoryCellText(device, "addedAt"), device.firstSeenAt);
  assert.equal(inventoryCellText(device, "rowNumber", 12), "12");
  assert.equal(inventoryCellText({ mac: "bad" }, "oui3"), "");
});

test("inventory columns can be reordered and optional supported fields enabled", () => {
  const config = defaultInventoryColumnConfig();
  const moved = moveInventoryColumn(config, "ip", 1);
  assert.equal(moved.columns[0].key, "rowNumber");
  assert.equal(moved.columns[1].key, "mac");
  assert.equal(moved.columns[2].key, "manufacturer");
  assert.equal(moved.columns[3].key, "model");
  assert.equal(moved.columns[4].key, "address");
  assert.equal(moved.columns[5].key, "ip");
  const shown = updateInventoryColumn(moved, "deviceId", { visible: true, label: "Внутренний ID" });
  assert.ok(visibleInventoryColumns(shown).some(({ key, label }) => key === "deviceId" && label === "Внутренний ID"));
});

test("new Inventory configuration starts with the same visible columns and order as PyQt", () => {
  const config = defaultInventoryColumnConfig();
  assert.deepEqual(visibleInventoryColumns(config).map(({ key }) => key), [
    "rowNumber", "mac", "manufacturer", "model", "ip", "address", "room", "switchIp", "switchPort", "authenticationTime", "matchDetails",
  ]);
  assert.deepEqual(visibleInventoryColumns(config).map(({ label }) => label), [
    "№", "MAC", "Производитель", "Модель", "IP-адрес", "Физический адрес", "Помещение", "IP коммутатора", "Порт подключения", "Время аутентификации", "Примечание",
  ]);
  assert.equal(config.columns.find(({ key }) => key === "deviceType").visible, false);
  assert.equal(config.columns.find(({ key }) => key === "hostname").visible, false);
});

test("Inventory offers the Web reference source column and renders normalized source provenance", () => {
  const config = defaultInventoryColumnConfig();
  const sourceColumn = config.columns.find(({ key }) => key === "source");

  assert.deepEqual(sourceColumn, { key: "source", label: "Источник", visible: false, width: 150 });
  assert.equal(inventoryCellText({ source: "Main · SmartRoom" }, "source"), "Main · SmartRoom");
  assert.equal(inventoryCellText({ sources: ["Main", "SmartRoom"] }, "source"), "Main, SmartRoom");
  assert.equal(inventoryCellText({ source: "", sources: ["Main"] }, "source"), "Main");
});

test("inventory column optimization streams all records and calculates capped widths", async () => {
  const config = defaultInventoryColumnConfig();
  let visits = 0;
  const optimized = await optimizeInventoryColumnWidths(config, async (visit) => {
    for (const row of [{ mac: "AA:BB", room: "A" }, { mac: "CC:DD", room: "A very long conference room name" }]) {
      visits += 1;
      visit(row);
    }
  });
  assert.equal(visits, 2);
  assert.ok(optimized.columns.find(({ key }) => key === "room").width > 150);
  assert.equal(inventoryCellText({ alternateMacs: ["AA", "BB"] }, "alternateMacs"), "AA, BB");
});

test("custom Inventory fields can be added, edited through their data keys, and removed", () => {
  const added = addCustomInventoryColumn(defaultInventoryColumnConfig(), "Кабинет ответственного", "123e4567-e89b-42d3-a456-426614174000");
  const column = added.columns.at(-1);
  assert.equal(column.key, "custom_123e4567-e89b-42d3-a456-426614174000");
  assert.equal(column.custom, true);
  assert.equal(inventoryCellText({ customFields: { [column.key]: "Иван Петров" } }, column.key), "Иван Петров");
  assert.equal(removeCustomInventoryColumn(added, column.key).columns.some(({ key }) => key === column.key), false);
  assert.throws(() => addCustomInventoryColumn(added, " ", "123e4567-e89b-42d3-a456-426614174001"), /название/);
});

test("custom Inventory keys are stable across casing and whitespace for legacy data transfer", () => {
  assert.equal(customInventoryColumnKey(" Площадь "), customInventoryColumnKey("площадь"));
  assert.match(customInventoryColumnKey("Площадь"), /^custom_[0-9a-f-]{36}$/);
  const config = addCustomInventoryColumn(defaultInventoryColumnConfig(), "Площадь");
  assert.equal(config.columns.at(-1).key, customInventoryColumnKey("Площадь"));
});
