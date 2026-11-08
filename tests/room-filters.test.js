import test from "node:test";
import assert from "node:assert/strict";
import { addRoomCatalogDevices, cachedRoomCatalogLoad, matchesRoomFilters, publishRoomCatalogForRevision, roomFilterOptions, roomFilterSignature, uniqueRoomFilterSelection } from "../src/core/room-filters.js";

test("room filter view signatures stay stable for equivalent selections and change with catalogue revision", () => {
  const filters = { businessUnit: " ЦА ", city: "Москва", site: "Офис А", floor: "3", room: "301" };
  assert.equal(roomFilterSignature(4, filters), roomFilterSignature(4, { ...filters, businessUnit: "ца" }));
  assert.notEqual(roomFilterSignature(4, filters), roomFilterSignature(5, filters));
  assert.notEqual(roomFilterSignature(4, filters), roomFilterSignature(4, { ...filters, room: "302" }));
});

test("stale room catalogue results cannot replace a newer revision", () => {
  const original = [{ key: "sr:current", room: "101" }];
  const state = { roomCatalogRevision: 8, roomCatalog: original };
  assert.equal(publishRoomCatalogForRevision(state, 7, [{ key: "sr:stale", room: "000" }]), false);
  assert.equal(state.roomCatalog, original);
  const latest = [{ key: "sr:latest", room: "202" }];
  assert.equal(publishRoomCatalogForRevision(state, 8, latest), true);
  assert.equal(state.roomCatalog, latest);
  assert.equal(publishRoomCatalogForRevision(state, 8, null), false);
  assert.equal(state.roomCatalog, latest);
});

test("room catalogue load retries after failure without clearing a newer concurrent load", async () => {
  const state = { roomCatalogPromise: null };
  let calls = 0;
  await assert.rejects(cachedRoomCatalogLoad(state, async () => {
    calls += 1;
    throw new Error("temporary IndexedDB read error");
  }), /temporary IndexedDB read error/);
  assert.equal(state.roomCatalogPromise, null);

  const rooms = [{ key: "sr:one", room: "101" }];
  assert.deepEqual(await cachedRoomCatalogLoad(state, async () => {
    calls += 1;
    return rooms;
  }), rooms);
  assert.equal(calls, 2);

  const staleFailure = Promise.reject(new Error("stale catalogue load"));
  state.roomCatalogPromise = staleFailure;
  const replacement = Promise.resolve([{ key: "sr:new", room: "202" }]);
  const staleWait = cachedRoomCatalogLoad(state, async () => []);
  state.roomCatalogPromise = replacement;
  await assert.rejects(staleWait, /stale catalogue load/);
  assert.equal(state.roomCatalogPromise, replacement);
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

test("room filter options accept a one-pass iterable without an intermediate filtered roster", () => {
  const values = [
    { businessUnit: "ЦА", city: "Москва", site: "Офис 10" },
    { businessUnit: "ЦА", city: "Москва", site: "Офис 2" },
    { businessUnit: "Склад", city: "Тула", site: "Офис 1" },
  ];
  let visited = 0;
  function* devices() {
    for (const device of values) {
      visited += 1;
      yield device;
    }
  }
  assert.deepEqual(roomFilterOptions(devices(), "site", { businessUnit: "ЦА", city: "Москва" }, ["businessUnit", "city"]), ["Офис 2", "Офис 10"]);
  assert.equal(visited, values.length);
});

test("all five room hierarchy filters cascade through a single normalized branch", () => {
  const devices = [
    { businessUnit: "ТБ-1", city: "Москва", site: "Сокол", floor: "2", room: "201" },
    { businessUnit: "ТБ-1", city: "Москва", site: "Сокол", floor: "3", room: "301" },
    { businessUnit: "ТБ-1", city: "Москва", site: "Арбат", floor: "2", room: "201" },
    { businessUnit: "ТБ-2", city: "Москва", site: "Сокол", floor: "2", room: "201" },
    { businessUnit: "ТБ-1", city: "Казань", site: "Сокол", floor: "2", room: "201" },
  ];
  const order = ["businessUnit", "city", "site", "floor", "room"];
  const selected = { businessUnit: "тб-1", city: " МОСКВА ", site: "сокол", floor: "2" };
  const expected = [
    ["businessUnit", [], ["ТБ-1", "ТБ-2"]],
    ["city", ["businessUnit"], ["Казань", "Москва"]],
    ["site", ["businessUnit", "city"], ["Арбат", "Сокол"]],
    ["floor", ["businessUnit", "city", "site"], ["2", "3"]],
    ["room", ["businessUnit", "city", "site", "floor"], ["201"]],
  ];
  for (const [field, ancestors, options] of expected) {
    assert.deepEqual(roomFilterOptions(devices, field, selected, ancestors), options, `${field} options use only their ancestors`);
  }
  assert.equal(matchesRoomFilters(devices[0], selected, order.slice(0, 4)), true);
  assert.equal(matchesRoomFilters(devices[1], selected, order.slice(0, 4)), false);
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
