import test from "node:test";
import assert from "node:assert/strict";
import { addIdentityToIndex, buildIdentityIndex, buildPositionedIdentityIndex, conflictingStrongFields, createPositionedIdentityIndex, findIdentityMatch, identityTokens, normalizeAlternateMacValues, packAlternateMacsInPlace, stableId } from "../src/core/identity.js";

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

test("alternate MAC normalization deduplicates in one pass and preserves alias order", () => {
  const aliases = ["aa-bb-cc-dd-ee-ff", "AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"];
  const device = {
    mac: "00:11:22:33:44:55",
    alternateMacs: aliases,
    secondary_mac: "11-22-33-44-55-66",
    mac2: "66:55:44:33:22:11",
    additionalMac: "00-11-22-33-44-55",
  };
  assert.deepEqual(normalizeAlternateMacValues(aliases), ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"]);
  assert.deepEqual(
    identityTokens(device).filter(({ type }) => type === "alternateMac").map(({ value }) => value),
    ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66", "66:55:44:33:22:11"],
  );
  assert.deepEqual(device.alternateMacs, aliases, "token generation must not mutate the source aliases");
});

test("derived stable IDs distinguish MACs that collide in the former 32-bit hash", () => {
  const first = { mac: "00:00:00:00:4F:D9" };
  const second = { mac: "00:00:00:06:61:22" };
  assert.notEqual(stableId(first), stableId(second));
  assert.equal(stableId(first), stableId({ mac: first.mac }));
  assert.match(stableId(first), /^device-[0-9a-f]{16}$/);
});

test("packed Dashboard alternate MAC values preserve strong identity tokens", () => {
  const baseline = [{ id: "device-1", mac: "00:11:22:33:44:55", alternateMacs: ["aa-bb-cc-dd-ee-ff", "AABB.CCDD.EEFF"] }];
  const before = identityTokens(baseline[0]).map(({ key, priority }) => [key, priority]);
  packAlternateMacsInPlace(baseline);
  assert.equal(baseline[0].alternateMacs, "AA:BB:CC:DD:EE:FF");
  assert.deepEqual(identityTokens(baseline[0]).map(({ key, priority }) => [key, priority]), before);
  const match = findIdentityMatch({ mac: "AA:BB:CC:DD:EE:FF" }, buildIdentityIndex(baseline));
  assert.equal(match.status, "matched");
  assert.equal(match.match, baseline[0]);
});

test("multi-entry identity lookup keeps two hits and marks larger duplicate groups as overflow", () => {
  const mac = "00:11:22:33:44:55";
  const devices = Array.from({ length: 500 }, (_, index) => ({ id: `device-${index}`, mac }));
  const index = buildIdentityIndex(devices);
  const token = index.tokens.get(`mac:${mac}`);
  assert.deepEqual(token, [500, 0, 1]);
  const result = findIdentityMatch({ id: "new-device", mac }, index);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.ambiguousTokenKeys, [`mac:${mac}`]);
});

test("identity index stores a unique token as one numeric position and upgrades collisions", () => {
  const unique = buildIdentityIndex([{ id: "device-a", mac: "00:11:22:33:44:01" }]);
  assert.equal(unique.tokens.get("id:device-a"), 0);
  assert.equal(unique.tokens.get("mac:00:11:22:33:44:01"), 0);
  assert.equal(findIdentityMatch({ id: "device-a" }, unique).status, "matched");

  const otherUnique = buildIdentityIndex([{ id: "device-a" }, { id: "device-b" }, { id: "device-c" }]);
  assert.equal(otherUnique.tokens.get("id:device-a"), 0);
  assert.equal(otherUnique.tokens.get("id:device-c"), 2);
  const duplicate = buildIdentityIndex([{ mac: "00:11:22:33:44:55" }, { mac: "00:11:22:33:44:55" }]);
  assert.deepEqual(duplicate.tokens.get("mac:00:11:22:33:44:55"), [2, 0, 1]);
  assert.equal(findIdentityMatch({ mac: "00:11:22:33:44:55" }, duplicate).status, "ambiguous");
});

test("precomputed strong tokens can be reused when matching and indexing a newly assigned stable ID", () => {
  const candidate = { mac: "00:11:22:33:44:77" };
  const tokens = identityTokens(candidate);
  const index = buildIdentityIndex([]);
  assert.equal(findIdentityMatch(candidate, index, tokens).status, "none");
  candidate.id = "device-persisted-after-resolution";
  index.devices.push(candidate);
  addIdentityToIndex(index, candidate, 0, tokens);
  assert.equal(index.tokens.get("mac:00:11:22:33:44:77"), 0);
  assert.equal(index.tokens.get("id:device-persisted-after-resolution"), 0);
  assert.equal(findIdentityMatch({ id: candidate.id }, index).match, candidate);
});

test("positioned identity index preserves global positions without a full baseline array", () => {
  const rows = [
    { position: 41_000_000, device: { id: "device-a", mac: "00:11:22:33:44:01", hostname: "duplicate" } },
    { position: 41_000_002, device: { id: "device-b", mac: "00:11:22:33:44:02", hostname: "duplicate" } },
    { position: 41_000_004, device: { id: "device-c", mac: "00:11:22:33:44:03", hostname: "duplicate" } },
  ];
  const index = buildPositionedIdentityIndex(rows, 41_000_005);
  assert.equal(index.devices.length, 41_000_005);
  const exact = findIdentityMatch({ id: "device-b", mac: "00:11:22:33:44:FF" }, index);
  assert.equal(exact.status, "matched");
  assert.equal(exact.position, 41_000_002);
  assert.equal(exact.match.id, "device-b");
  const ambiguous = findIdentityMatch({ hostname: "duplicate" }, index);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map(({ position }) => position), [41_000_000, 41_000_002]);
  assert.equal(index.devices[41_000_004].id, "device-c");
  assert.equal(index.devices[41_000_001], undefined);
});

test("incremental positioned identity index deduplicates candidates without a staging array", () => {
  const index = createPositionedIdentityIndex(100_000_000);
  assert.deepEqual(Object.keys(index).sort(), ["devices", "tokens"]);
  assert.throws(() => createPositionedIdentityIndex(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => createPositionedIdentityIndex(-1), RangeError);
  const device = { id: "device-a", mac: "00:11:22:33:44:55", hostname: "shared" };
  assert.equal(index.addCandidate(50_000_001, device), true);
  assert.equal(index.addCandidate(50_000_001, { id: "duplicate-position", mac: "AA:BB:CC:DD:EE:FF" }), false);
  assert.equal(index.addCandidate(100_000_000, { id: "out-of-range" }), false);
  assert.equal(index.devices.length, 100_000_000);
  assert.equal(index.devices[50_000_001], device);
  assert.equal(index.devices[50_000_000], undefined);
  assert.equal(index.tokens.get("id:device-a"), 50_000_001);
  assert.equal(index.tokens.has("id:duplicate-position"), false);
  assert.equal(findIdentityMatch({ id: "device-a" }, index).match, device);
});

test("large unique identity indexes avoid per-token collision arrays", () => {
  const devices = Array.from({ length: 10_000 }, (_, index) => ({ id: `device-${index}` }));
  const identityIndex = buildIdentityIndex(devices);
  assert.equal(identityIndex.tokens.size, devices.length);
  for (const position of identityIndex.tokens.values()) assert.equal(typeof position, "number");
  const NativeMap = globalThis.Map;
  try {
    globalThis.Map = class UnexpectedCandidateMap {
      constructor() { throw new Error("unmatched strong identity must not allocate candidate maps"); }
    };
    for (let index = 0; index < 1_000; index += 1) {
      assert.equal(findIdentityMatch({ id: `not-in-index-${index}` }, identityIndex).status, "none");
    }
  } finally {
    globalThis.Map = NativeMap;
  }
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

