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

export function normalizeAlternateMacValues(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map(normalizeMac).filter(Boolean))];
}

export function packAlternateMacsInPlace(devices = []) {
  for (const device of devices) {
    if (Array.isArray(device.alternateMacs)) device.alternateMacs = normalizeAlternateMacValues(device.alternateMacs).join(",");
  }
  return devices;
}

function alternateMacValues(device) {
  const primaryMac = firstMac(device.mac, device.macFormatted, device.mac_formatted, device.CallingStationID);
  return [...new Set([
    ...normalizeAlternateMacValues(device.alternateMacs),
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

/** Token keys whose stored candidate rows can affect findIdentityMatch(). */
export function identityLookupKeys(device = {}) {
  const keys = new Set();
  for (const token of identityTokens(device)) {
    keys.add(token.key);
    if (token.type === "mac") keys.add(`alternateMac:${token.value}`);
    else if (token.type === "alternateMac") keys.add(`mac:${token.value}`);
  }
  return [...keys];
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

/** Create an identity index that retains only requested positions in a larger baseline. */
export function createPositionedIdentityIndex(deviceCount = 0) {
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 0) throw new RangeError("Размер позиционного identity index должен быть безопасным неотрицательным целым числом");
  const records = new Map();
  const devices = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "length") return deviceCount;
      if (typeof property !== "string" || !/^\d+$/.test(property)) return undefined;
      return records.get(Number(property));
    },
  });
  const index = { devices, tokens: new Map() };
  Object.defineProperty(index, "addCandidate", {
    value(position, device) {
      if (!Number.isInteger(position) || position < 0 || position >= deviceCount || !device || records.has(position)) return false;
      records.set(position, device);
      addIdentityToIndex(index, device, position);
      return true;
    },
  });
  return index;
}

/** Build a bounded identity index from positioned candidates without an array sized to the full baseline. */
export function buildPositionedIdentityIndex(candidates = [], deviceCount = 0) {
  const index = createPositionedIdentityIndex(deviceCount);
  const orderedCandidates = [...candidates].sort((left, right) => Number(left?.position) - Number(right?.position));
  for (const candidate of orderedCandidates) {
    const position = Number(candidate?.position);
    index.addCandidate(position, candidate?.device);
  }
  return index;
}

function addPosition(tokens, key, position) {
  let entry = tokens.get(key);
  if (entry === undefined) {
    // Most identity tokens resolve to one device. Store that position inline
    // instead of allocating a three-slot collision array for every token.
    tokens.set(key, position);
    return;
  }
  if (typeof entry === "number") {
    if (entry === position) return;
    tokens.set(key, [2, entry, position]);
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
  const candidateTokens = identityTokens(candidate);
  // The common no-match path for a new unique device should not allocate candidate maps.
  let strongCandidates = null;
  let weakCandidates = null;
  let overflow = null;
  const collect = (token, entry, priority) => {
    const target = token.strong
      ? (strongCandidates ||= new Map())
      : (weakCandidates ||= new Map());
    const count = typeof entry === "number" ? 1 : entry[0];
    const positionCount = Math.min(count, MAX_IDENTITY_HITS);
    for (let offset = 1; offset <= positionCount; offset += 1) {
      const position = typeof entry === "number" ? entry : entry[offset];
      if (!target.has(position) && target.size >= MAX_IDENTITY_HITS) continue;
      const current = target.get(position) || { position, priority, score: 0, strong: 0, device: index.devices[position], evidence: [] };
      current.score += token.weight;
      if (token.strong) current.strong += 1;
      current.priority = Math.min(current.priority, priority);
      current.evidence.push({ key: token.key, type: token.type, priority });
      target.set(position, current);
    }
    if (count > positionCount) {
      overflow ||= [];
      overflow.push({ key: token.key, priority, strong: token.strong, firstPosition: entry[1], secondPosition: entry[2] });
    }
  };
  const inspect = (token, key, priority) => {
    const entry = index.tokens.get(key);
    if (entry !== undefined) collect(token, entry, priority);
  };
  for (const token of candidateTokens) {
    if (token.type === "mac") {
      inspect(token, token.key, STRONG_IDENTITY_PRIORITY.mac);
      inspect(token, `alternateMac:${token.value}`, STRONG_IDENTITY_PRIORITY.alternateMac);
    } else if (token.type === "alternateMac") {
      inspect(token, `mac:${token.value}`, STRONG_IDENTITY_PRIORITY.alternateMac);
      inspect(token, token.key, STRONG_IDENTITY_PRIORITY.alternateMac);
    } else {
      inspect(token, token.key, token.priority);
    }
  }
  const rankedStrong = [...(strongCandidates?.values() || [])].sort((left, right) => left.priority - right.priority || right.score - left.score || left.position - right.position);
  const rankedWeak = [...(weakCandidates?.values() || [])].sort((left, right) => right.score - left.score || left.position - right.position);
  if (!rankedStrong.length) {
    if (!candidateTokens.length) return { status: "none", match: null, candidates: [] };
    const hasStrongIdentity = candidateTokens.some((token) => token.strong);
    if (hasStrongIdentity && !rankedWeak.length) return { status: "none", match: null, candidates: [], ambiguousTokenKeys: [] };
    const ambiguousTokenKeys = [...new Set([
      ...candidateTokens.filter((token) => !token.strong && index.tokens.has(token.key)).map((token) => token.key),
      ...(overflow || []).filter((entry) => !entry.strong).map((entry) => entry.key),
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
  const strongestOverflow = (overflow || []).filter((item) => item.strong && item.priority === best.priority);
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
  for (const item of (overflow || []).filter((entry) => entry.strong && entry.priority > best.priority)) {
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

