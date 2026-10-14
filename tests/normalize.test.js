import test from "node:test";
import assert from "node:assert/strict";
import { locationKey, normalizeDate, normalizeIp, normalizeMac, text } from "../src/core/normalize.js";

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
  assert.equal(text(" Unknown "), "");
  assert.match(normalizeDate("01.02.2026 03:04:05"), /^2026-02-01T03:04:05/);
});

test("room key requires room when Smartroom ID is missing", () => {
  assert.equal(locationKey({ address: "Москва" }), "");
  assert.equal(locationKey({ room: "Переговорная 1", city: "Москва" }), "location:|москва|||переговорная 1|");
  assert.equal(locationKey({ smartroomId: "SR-1" }), "sr:sr-1");
});

