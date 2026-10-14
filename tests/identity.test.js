import test from "node:test";
import assert from "node:assert/strict";
import { buildIdentityIndex, findIdentityMatch } from "../src/core/identity.js";

test("conflicting strong identifiers never select a random device", () => {
  const devices = [
    { id: "a", deviceId: "DEVICE-1", mac: "00:11:22:33:44:55" },
    { id: "b", deviceId: "DEVICE-2", mac: "AA:BB:CC:DD:EE:FF" },
  ];
  const result = findIdentityMatch({ deviceId: "DEVICE-1", mac: "AA:BB:CC:DD:EE:FF" }, buildIdentityIndex(devices));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.match, null);
});

test("weak-only match is diagnostic, not an automatic merge", () => {
  const result = findIdentityMatch({ hostname: "ROOM-PC" }, buildIdentityIndex([{ id: "a", hostname: "room-pc" }]));
  assert.equal(result.status, "ambiguous");
});

