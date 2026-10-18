import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OUI_FORMATS, normalizeOuiFormats, ouiBytesForMac } from "../src/core/oui-formats.js";

test("OUI display preferences preserve the PyQt defaults and accept only boolean byte lengths", () => {
  assert.deepEqual(normalizeOuiFormats(null), DEFAULT_OUI_FORMATS);
  assert.deepEqual(normalizeOuiFormats({ 3: false, 4: true, 5: 1, 6: true, 7: true }), {
    3: false, 4: true, 5: false, 6: true,
  });
});

test("OUI display values format each selected byte prefix without changing identity", () => {
  const mac = "00:1A:11:22:33:44";
  assert.equal(ouiBytesForMac(mac, 3), "00:1A:11");
  assert.equal(ouiBytesForMac(mac, 4), "00:1A:11:22");
  assert.equal(ouiBytesForMac(mac, 5), "00:1A:11:22:33");
  assert.equal(ouiBytesForMac(mac, 6), mac);
  assert.equal(ouiBytesForMac("bad", 3), "");
  assert.equal(ouiBytesForMac(mac, 2), "");
});
