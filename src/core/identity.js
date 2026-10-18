import { firstMac, keyText, normalizeIp, normalizeMac, text } from "./normalize.js";

export const IDENTITY_WEIGHTS = Object.freeze({
  id: 110,
  deviceId: 100,
  serial: 95,
  mac: 90,
  alternateMac: 85,
  hostname: 35,
  smartroomId: 20,
  ip: 15,
});
const MAX_IDENTITY_HITS = 2;
const STRONG_IDENTITY_PRIORITY = Object.freeze({ id: 0, deviceId: 1, serial: 2, mac: 3, alternateMac: 4 });

function fieldKey(value, normalizer = keyText) {
  const normalized = normalizer(value);
  return normalized || "";
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
}

function alternateMacValues(device) {
  const primaryMac = firstMac(device.mac, device.macFormatted, device.mac_formatted, device.CallingStationID);
  return [...new Set([
    ...(Array.isArray(device.alternateMacs) ? device.alternateMacs : []),
    device.secondaryMac, device.secondary_mac, device.mac2, device.additionalMac, device.additional_mac,
  ].map(normalizeMac).filter((mac) => mac && mac !== primaryMac))];
}

export function identityTokens(device = {}) {
  const result = [];
  const add = (type, value, weight, strong = false, priority = Number.MAX_SAFE_INTEGER) => {
    if (value) result.push({ type, value, key: `${type}:${value}`, weight, strong, priority });
  };
  add("id", fieldKey(firstText(device.id, device.internalDeviceId, device.internal_device_id)), IDENTITY_WEIGHTS.id, true, STRONG_IDENTITY_PRIORITY.id);
  add("deviceId", fieldKey(firstText(device.deviceId, device.device_id, device.asset_id)), IDENTITY_WEIGHTS.deviceId, true, STRONG_IDENTITY_PRIORITY.deviceId);
  add("serial", fieldKey(firstText(device.serial, device.serialNumber, device.serial_number)), IDENTITY_WEIGHTS.serial, true, STRONG_IDENTITY_PRIORITY.serial);
  add("mac", firstMac(device.mac, device.macFormatted, device.mac_formatted, device.CallingStationID), IDENTITY_WEIGHTS.mac, true, STRONG_IDENTITY_PRIORITY.mac);
  for (const mac of alternateMacValues(device)) {
    add("alternateMac", fieldKey(mac, normalizeMac), IDENTITY_WEIGHTS.alternateMac, true, STRONG_IDENTITY_PRIORITY.alternateMac);
  }
  add("hostname", fieldKey(firstText(device.hostname, device.host, device.host_name)), IDENTITY_WEIGHTS.hostname);
  add("smartroomId", fieldKey(firstText(device.smartroomId, device.smartroom_id)), IDENTITY_WEIGHTS.smartroomId);
  add("ip", normalizeIp(device.ip) || normalizeIp(device.deviceIp) || normalizeIp(device.device_ip), IDENTITY_WEIGHTS.ip);
  return result;
}

export function conflictingStrongFields(left = {}, right = {}) {
  const fields = {
    id: ["id", "internalDeviceId", "internal_device_id"],
    deviceId: ["deviceId", "device_id", "asset_id"],
    serial: ["serial", "serialNumber", "serial_number"],
    mac: ["mac", "macFormatted", "mac_formatted", "CallingStationID"],
  };
  return Object.entries(fields).flatMap(([field, aliases]) => {
    const normalize = field === "mac" ? normalizeMac : keyText;
    const before = field === "mac" ? firstMac(...aliases.map((alias) => left[alias])) : normalize(firstText(...aliases.map((alias) => left[alias])));
    const after = field === "mac" ? firstMac(...aliases.map((alias) => right[alias])) : normalize(firstText(...aliases.map((alias) => right[alias])));
    return before && after && before !== after ? [field] : [];
  });
}

export function buildIdentityIndex(devices = []) {
  const tokens = new Map();
  devices.forEach((device, index) => {
    for (const token of identityTokens(device)) {
      addPosition(tokens, token.key, index);
    }
  });
  return { devices, tokens };
}

function addPosition(tokens, key, position) {
  let entry = tokens.get(key);
  if (!entry) {
    tokens.set(key, [1, position, -1]);
    return;
  }
  if (entry[1] === position || entry[2] === position) return;
  entry[0] += 1;
  if (entry[0] <= MAX_IDENTITY_HITS) entry[entry[0]] = position;
}

export function addIdentityToIndex(index, device, position = index.devices.indexOf(device)) {
  if (position < 0) throw new Error("Устройство отсутствует в identity index");
  for (const token of identityTokens(device)) {
    addPosition(index.tokens, token.key, position);
  }
  return index;
}

export function findIdentityMatch(candidate, index) {
  const strongCandidates = new Map();
  const weakCandidates = new Map();
  const overflow = [];
  const collect = (target, token, entry, priority) => {
    const positionCount = Math.min(entry[0], MAX_IDENTITY_HITS);
    for (let offset = 1; offset <= positionCount; offset += 1) {
      const position = entry[offset];
      if (!target.has(position) && target.size >= MAX_IDENTITY_HITS) continue;
      const current = target.get(position) || { position, priority, score: 0, strong: 0, device: index.devices[position], evidence: [] };
      current.score += token.weight;
      if (token.strong) current.strong += 1;
      current.priority = Math.min(current.priority, priority);
      current.evidence.push({ key: token.key, type: token.type, priority });
      target.set(position, current);
    }
    if (entry[0] > positionCount) overflow.push({ key: token.key, priority, strong: token.strong, firstPosition: entry[1], secondPosition: entry[2] });
  };
  for (const token of identityTokens(candidate)) {
    const lookups = token.type === "mac"
      ? [{ key: token.key, priority: STRONG_IDENTITY_PRIORITY.mac }, { key: `alternateMac:${token.value}`, priority: STRONG_IDENTITY_PRIORITY.alternateMac }]
      : token.type === "alternateMac"
        ? [{ key: `mac:${token.value}`, priority: STRONG_IDENTITY_PRIORITY.alternateMac }, { key: token.key, priority: STRONG_IDENTITY_PRIORITY.alternateMac }]
        : [{ key: token.key, priority: token.priority }];
    for (const lookup of lookups) {
      const entry = index.tokens.get(lookup.key);
      if (!entry) continue;
      if (token.strong) collect(strongCandidates, token, entry, lookup.priority);
      else collect(weakCandidates, token, entry, token.priority);
    }
  }
  const rankedStrong = [...strongCandidates.values()].sort((left, right) => left.priority - right.priority || right.score - left.score || left.position - right.position);
  const rankedWeak = [...weakCandidates.values()].sort((left, right) => right.score - left.score || left.position - right.position);
  if (!rankedStrong.length) {
    const candidateTokens = identityTokens(candidate);
    if (!candidateTokens.length) return { status: "none", match: null, candidates: [] };
    const hasStrongIdentity = candidateTokens.some((token) => token.strong);
    if (hasStrongIdentity && !rankedWeak.length) return { status: "none", match: null, candidates: [], ambiguousTokenKeys: [] };
    const ambiguousTokenKeys = [...new Set([
      ...candidateTokens.filter((token) => !token.strong && index.tokens.has(token.key)).map((token) => token.key),
      ...overflow.filter((entry) => !entry.strong).map((entry) => entry.key),
    ])];
    return {
      status: "ambiguous",
      match: null,
      candidates: rankedWeak.slice(0, MAX_IDENTITY_HITS).map(({ position, device }) => ({ position, device })),
      ambiguousTokenKeys,
      ...(hasStrongIdentity ? { strongIdentityUnmatched: true } : {}),
    };
  }
  const best = rankedStrong[0];
  const strongest = rankedStrong.filter((item) => item.priority === best.priority);
  const strongestOverflow = overflow.filter((item) => item.strong && item.priority === best.priority);
  if (strongest.length > 1 || strongestOverflow.length) {
    const ambiguousTokenKeys = [...new Set([...strongest.flatMap((item) => item.evidence.map((entry) => entry.key)), ...strongestOverflow.map((item) => item.key)])];
    return { status: "ambiguous", match: null, candidates: strongest.slice(0, MAX_IDENTITY_HITS), ambiguousTokenKeys };
  }
  const identityConflicts = rankedStrong.filter((item) => item.position !== best.position).map((item) => ({
    selected: best.device,
    alternative: item.device,
    position: item.position,
    selectedEvidence: best.evidence,
    alternativeEvidence: item.evidence,
  }));
  for (const item of overflow.filter((entry) => entry.strong && entry.priority > best.priority)) {
    for (const position of [item.firstPosition, item.secondPosition]) {
      if (!Number.isInteger(position) || position < 0) continue;
      if (position === best.position) continue;
      const alternative = index.devices[position];
      if (identityConflicts.some((conflict) => conflict.alternative === alternative)) continue;
      identityConflicts.push({
        selected: best.device,
        alternative,
        position,
        selectedEvidence: best.evidence,
        alternativeEvidence: [{ key: item.key, type: item.key.split(":", 1)[0], priority: item.priority }],
        overflow: true,
      });
    }
  }
  return { status: "matched", match: best.device, position: best.position, score: best.score, matchPriority: best.priority, candidates: [best], ambiguousTokenKeys: [], identityConflicts };
}

export function stableIdentity(device = {}) {
  const token = identityTokens(device).find((item) => item.strong);
  return token?.key || "";
}

export function stableId(device = {}, namespace = "device") {
  const existingId = firstText(device.id, device.internalDeviceId, device.internal_device_id);
  if (existingId) return existingId;
  const source = stableIdentity(device) || identityTokens(device)[0]?.key || JSON.stringify(device);
  let hash = 2166136261;
  for (const char of `${namespace}:${source}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${namespace}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

