import test from "node:test";
import assert from "node:assert/strict";
import { buildIdentityIndex, conflictingStrongFields, findIdentityMatch, identityTokens, stableId } from "../src/core/identity.js";

test("strongest stable identifier wins deterministically and reports conflicting weaker aliases", () => {
  const devices = [
    { id: "a", deviceId: "DEVICE-1", mac: "00:11:22:33:44:55" },
    { id: "b", deviceId: "DEVICE-2", mac: "AA:BB:CC:DD:EE:FF" },
  ];
  const result = findIdentityMatch({ deviceId: "DEVICE-1", mac: "AA:BB:CC:DD:EE:FF" }, buildIdentityIndex(devices));
  assert.equal(result.status, "matched");
  assert.equal(result.match, devices[0]);
  assert.equal(result.identityConflicts.length, 1);
  assert.equal(result.identityConflicts[0].alternative, devices[1]);
});

test("weak-only match is diagnostic, not an automatic merge", () => {
  const result = findIdentityMatch({ hostname: "ROOM-PC" }, buildIdentityIndex([{ id: "a", hostname: "room-pc" }]));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.ambiguousTokenKeys, ["hostname:room-pc"]);
  const unmatched = findIdentityMatch({ hostname: "unmatched-host" }, buildIdentityIndex([]));
  assert.equal(unmatched.status, "ambiguous");
  assert.deepEqual(unmatched.candidates, []);
});

test("IP identity tokens are normalized and invalid IP values cannot become weak match evidence", () => {
  const row = { id: "known", ip: "192.168.1.10" };
  const result = findIdentityMatch({ ip: " 192.168.001.010 " }, buildIdentityIndex([row]));
  assert.equal(result.status, "ambiguous", "a normalized IP is weak diagnostic evidence, never an automatic identity match");
  assert.deepEqual(result.ambiguousTokenKeys, ["ip:192.168.1.10"]);
  assert.equal(identityTokens({ ip: "999.1.1.1" }).some((token) => token.type === "ip"), false);
  assert.equal(identityTokens({ ip: "00:11:22:33:44:55" }).some((token) => token.type === "ip"), false);
  const ipv6 = findIdentityMatch(
    { ip: "2001:0db8:0:0:0:0:0:1" },
    buildIdentityIndex([{ ip: "2001:db8::1" }]),
  );
  assert.equal(ipv6.status, "ambiguous");
  assert.deepEqual(ipv6.ambiguousTokenKeys, ["ip:2001:db8::1"]);
});

test("a new strong identity is not blocked by a shared weak room token", () => {
  const result = findIdentityMatch(
    { id: "new-device", mac: "00:11:22:33:44:99", smartroomId: "SR-1" },
    buildIdentityIndex([{ id: "existing-a", mac: "00:11:22:33:44:01", smartroomId: "SR-1" }, { id: "existing-b", mac: "00:11:22:33:44:02", smartroomId: "SR-1" }]),
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.strongIdentityUnmatched, true);
  assert.equal(result.match, null);
});

test("overflowing weak Smartroom IDs do not become strong identity conflicts", () => {
  const room = "room:shared";
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `device-${index}`, smartroomId: room, mac: `00:11:22:33:44:0${index}` }));
  const result = findIdentityMatch({ id: "device-3", smartroomId: room, mac: "00:11:22:33:44:03" }, buildIdentityIndex(rows));
  assert.equal(result.status, "matched");
  assert.equal(result.match.id, "device-3");
  assert.deepEqual(result.identityConflicts, []);
});

test("legacy web identity field names resolve to the same canonical strong identity", () => {
  const canonical = {
    id: "persistent-1", deviceId: "ASSET-1", serial: "SN-001", mac: "00:11:22:33:44:55",
    alternateMacs: ["AA:BB:CC:DD:EE:FF"], hostname: "device-1",
  };
  const legacy = {
    internal_device_id: "persistent-1", asset_id: "ASSET-1", serial_number: "SN-001",
    macFormatted: "0011.2233.4455", secondary_mac: "aa-bb-cc-dd-ee-ff", host_name: "device-1",
  };
  const match = findIdentityMatch(legacy, buildIdentityIndex([canonical]));
  assert.equal(match.status, "matched");
  assert.equal(match.match, canonical);
  assert.equal(stableId(legacy), "persistent-1");
  assert.deepEqual(conflictingStrongFields(canonical, { ...legacy, device_id: "ASSET-2" }), ["deviceId"]);
  assert.equal(identityTokens({ mac: canonical.mac, secondaryMac: canonical.mac }).filter((item) => item.type === "alternateMac").length, 0);
  assert.equal(findIdentityMatch({ mac: "malformed", macFormatted: canonical.mac }, buildIdentityIndex([canonical])).status, "matched");
});

test("multi-entry identity lookup keeps two hits and marks larger duplicate groups as overflow", () => {
  const mac = "00:11:22:33:44:55";
  const devices = Array.from({ length: 500 }, (_, index) => ({ id: `device-${index}`, mac }));
  const index = buildIdentityIndex(devices);
  const token = index.tokens.get(`mac:${mac}`);
  assert.equal(token.positions.length, 2);
  assert.equal(token.total, 500);
  const result = findIdentityMatch({ id: "new-device", mac }, index);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.ambiguousTokenKeys, [`mac:${mac}`]);
});

test("structured JSON values cannot create identity tokens or automatic matches", () => {
  const malformed = {
    id: { value: "persistent-1" }, deviceId: ["ASSET-1"], serial: { value: "SN-1" },
    mac: ["00:11:22:33:44:55"], hostname: { value: "endpoint" }, ip: ["192.0.2.10"],
  };
  assert.deepEqual(identityTokens(malformed), []);
  const target = { id: "[object Object]", deviceId: "ASSET-1", mac: "00:11:22:33:44:55" };
  assert.equal(findIdentityMatch(malformed, buildIdentityIndex([target])).status, "none");
});

