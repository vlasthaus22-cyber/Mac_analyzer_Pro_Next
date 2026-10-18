import test from "node:test";
import assert from "node:assert/strict";
import { addRoomCatalogDevices, matchesRoomFilters, roomFilterOptions, roomFilterSignature, uniqueRoomFilterSelection } from "../src/core/room-filters.js";

test("room filter view signatures stay stable for equivalent selections and change with catalogue revision", () => {
  const filters = { businessUnit: " ЦА ", city: "Москва", site: "Офис А", floor: "3", room: "301" };
  assert.equal(roomFilterSignature(4, filters), roomFilterSignature(4, { ...filters, businessUnit: "ца" }));
  assert.notEqual(roomFilterSignature(4, filters), roomFilterSignature(5, filters));
  assert.notEqual(roomFilterSignature(4, filters), roomFilterSignature(4, { ...filters, room: "302" }));
});

test("room filter options are scoped to the selected branch and normalized", () => {
  const devices = [
    { businessUnit: " ЦА ", city: "Москва", site: "Офис А", room: "Комната 1" },
    { businessUnit: "ца", city: " МОСКВА ", site: "офис   а", room: "КОМНАТА 1" },
    { businessUnit: "ЦА", city: "Санкт-Петербург", site: "Офис Б", room: "Комната 2" },
  ];
  const filters = { businessUnit: "ца", city: "Москва" };
  assert.equal(matchesRoomFilters(devices[0], filters, ["businessUnit", "city"]), true);
  assert.equal(matchesRoomFilters(devices[2], filters, ["businessUnit", "city"]), false);
  assert.deepEqual(roomFilterOptions(devices, "site", filters, ["businessUnit", "city"]), ["Офис А"]);
  assert.deepEqual(roomFilterOptions(devices, "room", { ...filters, site: "офис а" }, ["businessUnit", "city", "site"]), ["Комната 1"]);
});

test("room catalog merges every snapshot by normalized location and keeps the latest descriptor", () => {
  const catalog = new Map();
  addRoomCatalogDevices(catalog, [
    { smartroomId: " SR-1 ", businessUnit: "ЦА", city: "Москва", site: "Офис А", floor: "3", room: "301", address: "Старая" },
    { businessUnit: "ЦА", city: "Москва", site: "Офис Б", floor: "1", room: "101", address: "Адрес Б" },
  ]);
  addRoomCatalogDevices(catalog, [
    { smartroomId: "sr-1", businessUnit: "ЦА", city: "МОСКВА", site: "Офис А", floor: "3", room: "301", address: "Новая" },
  ]);
  assert.equal(catalog.size, 2);
  assert.deepEqual(roomFilterOptions([...catalog.values()], "room", { businessUnit: "ЦА", city: "Москва" }, ["businessUnit", "city"]), ["101", "301"]);
  assert.equal(catalog.get("sr:sr-1").address, "Новая");
});

test("room filter auto-selects a sole option and preserves an explicit selection", () => {
  assert.equal(uniqueRoomFilterSelection(["Офис А"]), "Офис А");
  assert.equal(uniqueRoomFilterSelection(["Офис А", "Офис Б"]), "");
  assert.equal(uniqueRoomFilterSelection(["Офис А", "Офис Б"], "Офис Б"), "Офис Б");
});
