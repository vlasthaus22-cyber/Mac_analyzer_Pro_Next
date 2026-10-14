import test from "node:test";
import assert from "node:assert/strict";
import { enrich, STRATEGIES } from "../src/core/enrichment.js";

const mappings = {
  main: { mac: 0, switchIp: 1 },
  smartroom: { mac: 0, ip: 1, room: 2, model: 3 },
  ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3 },
};

test("NO_EXPANSION keeps Main count and DDIO fills blank IP by MAC", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    smartroomRows: [
      ["00:11:22:33:44:55", "", "Room A", "Model A"],
      ["AA:BB:CC:DD:EE:FF", "10.9.9.9", "Room B", "Model B"],
    ],
    ddioRows: [["192.168.10.20", "00-11-22-33-44-55", "", ""]],
    mappings,
    strategy: STRATEGIES.NO_EXPANSION,
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].ip, "192.168.10.20");
  assert.equal(result.devices[0].fieldSources.ip, "DDIO");
  assert.equal(result.devices[0].switchIp, "10.0.0.1");
  assert.equal(result.diagnostics.unmatched.length, 1);
});

test("ALLOW_EXPANSION lets SmartRoom create, but DDIO never creates", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    smartroomRows: [["AA:BB:CC:DD:EE:FF", "10.9.9.9", "Room B", "Model B"]],
    ddioRows: [
      ["192.168.10.20", "00:11:22:33:44:55", "", ""],
      ["192.168.10.99", "12:34:56:78:90:AB", "", ""],
    ],
    mappings,
    strategy: STRATEGIES.ALLOW_EXPANSION,
  });
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices.some((item) => item.mac === "12:34:56:78:90:AB"), false);
});

test("multiple DDIO IP values stay alternatives and are not chosen randomly", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    ddioRows: [
      ["192.168.10.20", "00:11:22:33:44:55", "", ""],
      ["192.168.10.21", "00:11:22:33:44:55", "", ""],
    ],
    mappings,
  });
  assert.equal(result.devices[0].ip, "");
  assert.deepEqual(result.devices[0].possibleIps, ["192.168.10.20", "192.168.10.21"]);
  assert.equal(result.devices[0].conflicts.some((item) => item.reason === "multiple-exact-mac-ips"), true);
});

test("previous Final restores blanks but does not add absent devices", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    mappings,
    previousFinal: [
      { id: "old-a", mac: "00:11:22:33:44:55", manufacturer: "Vendor", model: "Model" },
      { id: "old-b", mac: "AA:BB:CC:DD:EE:FF", manufacturer: "Other" },
    ],
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].manufacturer, "Vendor");
  assert.equal(result.devices[0].model, "Model");
});

test("repeated enrichment is stable", async () => {
  const input = { mainRows: [["00:11:22:33:44:55", "10.0.0.1"]], mappings };
  const first = await enrich(input);
  const second = await enrich({ ...input, previousFinal: first.devices });
  assert.equal(second.devices.length, first.devices.length);
  assert.equal(second.devices[0].id, first.devices[0].id);
});

test("10,000 Main rows remain linear and keep exact count", async () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const suffix = index.toString(16).padStart(8, "0").match(/../g).join(":");
    return [`02:00:${suffix}`, `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`];
  });
  const started = performance.now();
  const result = await enrich({ mainRows: rows, mappings });
  const elapsed = performance.now() - started;
  assert.equal(result.devices.length, 10_000);
  assert.ok(elapsed < 2_500, `10,000 rows took ${elapsed.toFixed(1)} ms`);
});

