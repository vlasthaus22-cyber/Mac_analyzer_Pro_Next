import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE,
  createCustomSourceFieldMapping,
  normalizeSourceMappingPreferences,
  rememberSourceMapping,
  restoreSourceMapping,
  upsertSourceMappingPreference,
} from "../src/core/source-mapping-preferences.js";
import { customInventoryColumnKey, defaultInventoryColumnConfig } from "../src/core/inventory-columns.js";

test("manual source mapping restores only for an exact normalized header sequence", () => {
  const first = rememberSourceMapping(["Device ID", "MAC", "Room"], { id: 0, mac: 1, room: 2 });
  const preferences = upsertSourceMappingPreference([], first);
  assert.deepEqual(restoreSourceMapping([" device   id ", "mac", "ROOM"], preferences, { id: 2 }), { id: 0, mac: 1, room: 2 });
  assert.deepEqual(restoreSourceMapping(["MAC", "Device ID", "Room"], preferences, { id: 1, mac: 0 }), { id: 1, mac: 0 });
  assert.deepEqual(restoreSourceMapping(["Device ID", "MAC", "Location"], preferences, { id: 0 }), { id: 0 });
});

test("custom inventory field mappings persist only against the exact source header schema", () => {
  const customKey = customInventoryColumnKey("Кабинет ответственного");
  const preference = rememberSourceMapping(["MAC", "Кабинет"], { mac: 0, [customKey]: 1 });
  assert.equal(preference.mapping[customKey], 1);
  assert.deepEqual(restoreSourceMapping(["MAC", "Кабинет"], [preference]), { mac: 0, [customKey]: 1 });
  assert.deepEqual(restoreSourceMapping(["MAC", "Другое поле"], [preference]), {});
});

test("source mapping creates a custom Inventory field and assigns its selected column", () => {
  const initial = defaultInventoryColumnConfig();
  const result = createCustomSourceFieldMapping(initial, { mac: 0 }, "Ответственный", "1", 3);
  assert.equal(result.field.label, "Ответственный");
  assert.equal(result.field.custom, true);
  assert.equal(result.field.visible, false);
  assert.deepEqual(result.mapping, { mac: 0, [result.field.key]: 1 });
  assert.equal(initial.columns.some(({ key }) => key === result.field.key), false);
  const preference = rememberSourceMapping(["MAC", "Ответственный", "Комната"], result.mapping);
  assert.deepEqual(restoreSourceMapping(["MAC", "Ответственный", "Комната"], [preference]), result.mapping);
  assert.throws(() => createCustomSourceFieldMapping(initial, { mac: 0 }, "Дубль", "0", 3), /уже назначена/);
  assert.throws(() => createCustomSourceFieldMapping(initial, {}, "Вне диапазона", "3", 3), /существующую колонку/);
  assert.throws(() => createCustomSourceFieldMapping(initial, {}, " ", "", 3), /название/);
});

test("manual mapping preference updates by schema, bounds retained schemas, and preserves explicit clearing", () => {
  let preferences = [];
  for (let index = 0; index < MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE + 2; index += 1) {
    preferences = upsertSourceMappingPreference(preferences, rememberSourceMapping([`ID ${index}`, "MAC"], { id: 0, mac: 1 }));
  }
  assert.equal(preferences.length, MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE);
  assert.deepEqual(restoreSourceMapping(["ID 0", "MAC"], preferences), {});
  const updated = upsertSourceMappingPreference(preferences, rememberSourceMapping(["ID 13", "MAC"], {}));
  assert.deepEqual(restoreSourceMapping(["ID 13", "MAC"], updated, { id: 0 }), {});
});

test("stored mapping preferences reject invalid roles, fields, indices and oversized header lists", () => {
  const normalized = normalizeSourceMappingPreferences({
    main: [{ headers: ["MAC", "Room"], mapping: { mac: 0, room: 1, badField: 0, outOfRange: 2, "bad field": 1 } }],
    unknown: [{ headers: ["MAC"], mapping: { mac: 0 } }],
    ddio: [{ headers: Array(513).fill("X"), mapping: { reservationMac: 0 } }],
  });
  assert.deepEqual(normalized.main, [{ headers: ["mac", "room"], mapping: { mac: 0, room: 1, badField: 0 } }]);
  assert.deepEqual(normalized.smartroom, []);
  assert.deepEqual(normalized.ddio, []);
  assert.equal(rememberSourceMapping(["X".repeat(513), "MAC"], { mac: 1 }), null);
  assert.deepEqual(restoreSourceMapping(["X".repeat(513), "MAC"], normalized.main, { mac: 1 }), { mac: 1 });
});
