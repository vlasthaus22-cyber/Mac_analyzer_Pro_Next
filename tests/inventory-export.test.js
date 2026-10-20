import test from "node:test";
import assert from "node:assert/strict";
import { createInventoryXlsxSheets } from "../src/core/inventory-export.js";

test("Inventory XLSX rows stream through bounded pages and split at the sheet row limit", async () => {
  const devices = Array.from({ length: 5 }, (_, index) => ({
    id: `device-${index}`,
    mac: `00:11:22:33:44:0${index}`,
    authenticationTime: `2026-10-18T12:34:5${index}.000Z`,
    observationCount: index + 1,
    present: index % 2 === 0,
  }));
  const pageSizes = [];
  const progress = [];
  const database = {
    inventoryCount: async () => devices.length,
    inventoryPage: async ({ afterId, limit }) => {
      const start = afterId === null ? 0 : devices.findIndex((device) => device.id === afterId) + 1;
      const rows = devices.slice(start, start + limit);
      pageSizes.push(rows.length);
      return { rows };
    },
  };
  const result = await createInventoryXlsxSheets(database, {
    pageSize: 2,
    maxDataRowsPerSheet: 2,
    onProgress: (current, total) => progress.push([current, total]),
  });
  assert.equal(result.sheets.length, 3);
  assert.deepEqual(result.sheets.map((sheet) => sheet.name), ["Inventory", "Inventory 2", "Inventory 3"]);
  const authenticationColumn = result.sheets[0].headings.indexOf("Время аутентификации");
  assert.ok(authenticationColumn >= 0, "default Inventory XLSX must include the authentication timestamp");
  const rows = [];
  for (const sheet of result.sheets) for await (const row of sheet.rows) rows.push(row);
  assert.deepEqual(rows.map((row) => row[0]), devices.map((device) => device.id));
  assert.deepEqual(rows.map((row) => row[authenticationColumn]), devices.map((device) => device.authenticationTime));
  assert.deepEqual(rows.map((row) => row[17]), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.map((row) => row[18]), ["Да", "Нет", "Да", "Нет", "Да"]);
  assert.ok(pageSizes.every((size) => size <= 2));
  assert.deepEqual(progress, [[2, 5], [4, 5], [5, 5]]);
  assert.equal(result.exported, 5);
});

test("empty Inventory still exports one header-only worksheet", async () => {
  const result = await createInventoryXlsxSheets({ inventoryCount: async () => 0, inventoryPage: async () => { throw new Error("empty export must not read a page"); } });
  assert.equal(result.sheets.length, 1);
  assert.equal(result.sheets[0].headings[0], "ID устройства");
  const rows = [];
  for await (const row of result.sheets[0].rows) rows.push(row);
  assert.deepEqual(rows, []);
  assert.equal(result.exported, 0);
});

test("Inventory XLSX includes declared custom fields while streaming device pages", async () => {
  const database = {
    inventoryCount: async () => 1,
    inventoryPage: async () => ({ rows: [{ id: "device-1", mac: "00:11:22:33:44:55", customFields: { "custom_123e4567-e89b-42d3-a456-426614174000": "Склад" } }] }),
  };
  const custom = { key: "custom_123e4567-e89b-42d3-a456-426614174000", label: "Зона" };
  const result = await createInventoryXlsxSheets(database, { additionalColumns: [custom, { key: "custom_invalid", label: "Не включать" }] });
  assert.equal(result.sheets[0].headings.at(-1), "Зона");
  const rows = [];
  for await (const row of result.sheets[0].rows) rows.push(row);
  assert.equal(rows[0].at(-1), "Склад");
});

test("Inventory XLSX uses the configured visible column order and calculated reference fields", async () => {
  const database = {
    inventoryCount: async () => 1,
    inventoryPage: async () => ({ rows: [{
      id: "device-1", mac: "001122AABBCC", manufacturer: "Example", firstSeenAt: "2026-10-17T08:00:00Z",
      matchDetails: "serial match", sources: ["Main", "SmartRoom"], customFields: { "custom_123e4567-e89b-42d3-a456-426614174000": "Room owner" },
    }] }),
  };
  const columns = [
    { key: "rowNumber", label: "№" }, { key: "oui4", label: "OUI(4)" }, { key: "macFormatted", label: "MAC formatted" },
    { key: "matchDetails", label: "Note" }, { key: "addedAt", label: "Added" },
    { key: "custom_123e4567-e89b-42d3-a456-426614174000", label: "Owner" }, { key: "source", label: "Source" },
  ];
  const result = await createInventoryXlsxSheets(database, { columns });
  assert.deepEqual(result.sheets[0].headings, columns.map(({ label }) => label));
  const rows = [];
  for await (const row of result.sheets[0].rows) rows.push(row);
  assert.deepEqual(rows, [["1", "00:11:22:AA", "00:11:22:AA:BB:CC", "serial match", "2026-10-17T08:00:00Z", "Room owner", "Main, SmartRoom"]]);
});
