import test from "node:test";
import assert from "node:assert/strict";
import { legacyWorkspaceSourceRole, restoreLegacyWorkspaceMapping } from "../src/core/legacy-workspace-recovery.js";

test("legacy workspace roles map only to supported Next source roles", () => {
  assert.equal(legacyWorkspaceSourceRole("primary"), "main");
  assert.equal(legacyWorkspaceSourceRole("additional"), "");
  assert.equal(legacyWorkspaceSourceRole("smartroom"), "smartroom");
  assert.equal(legacyWorkspaceSourceRole("ddio"), "ddio");
  assert.equal(legacyWorkspaceSourceRole("unknown"), "");
});

test("legacy column mapping restores supported fields within selected file bounds", () => {
  const result = restoreLegacyWorkspaceMapping({ mapping: {
    macFormatted: 0, vendor: 1, model: 2, invalid: 3, room: 10,
  } }, ["MAC", "Vendor", "Model"], ["mac", "manufacturer", "model", "room"], { ip: 2 });
  assert.deepEqual(result, { mac: 0, manufacturer: 1, model: 2 });
});

test("legacy mapping rejects duplicate columns and preserves safe detected fallbacks", () => {
  const result = restoreLegacyWorkspaceMapping({ mapping: { mac: 0, deviceId: 0, hostname: 8 } }, ["MAC", "Name"],
    ["mac", "deviceId", "hostname", "ip"], { ip: 1, deviceId: 1 });
  assert.deepEqual(result, { mac: 0, ip: 1 });
});

test("legacy mapping rejects blank and non-decimal column indices instead of coercing them to zero", () => {
  const result = restoreLegacyWorkspaceMapping({ mapping: { mac: " ", vendor: "0x1", model: "2" } },
    ["MAC", "Vendor", "Model"], ["mac", "manufacturer", "model"]);
  assert.deepEqual(result, { model: 2 });
});

test("missing mapping summary leaves in-range fallback intact", () => {
  assert.deepEqual(restoreLegacyWorkspaceMapping(null, ["MAC"], ["mac"], { mac: 0, ip: 2 }), { mac: 0 });
});
