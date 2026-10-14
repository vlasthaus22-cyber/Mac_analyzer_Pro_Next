import { keyText, normalizeMac, text } from "./normalize.js";

export const IDENTITY_WEIGHTS = Object.freeze({
  deviceId: 100,
  serial: 95,
  mac: 90,
  alternateMac: 85,
  hostname: 35,
  smartroomId: 20,
  ip: 15,
});

function fieldKey(value, normalizer = keyText) {
  const normalized = normalizer(value);
  return normalized || "";
}

export function identityTokens(device = {}) {
  const result = [];
  const add = (type, value, weight, strong = false) => {
    if (value) result.push({ type, value, key: `${type}:${value}`, weight, strong });
  };
  add("deviceId", fieldKey(device.deviceId), IDENTITY_WEIGHTS.deviceId, true);
  add("serial", fieldKey(device.serial), IDENTITY_WEIGHTS.serial, true);
  add("mac", fieldKey(device.mac, normalizeMac), IDENTITY_WEIGHTS.mac, true);
  for (const mac of device.alternateMacs || []) add("mac", fieldKey(mac, normalizeMac), IDENTITY_WEIGHTS.alternateMac, true);
  add("hostname", fieldKey(device.hostname), IDENTITY_WEIGHTS.hostname);
  add("smartroomId", fieldKey(device.smartroomId), IDENTITY_WEIGHTS.smartroomId);
  add("ip", text(device.ip), IDENTITY_WEIGHTS.ip);
  return result;
}

export function buildIdentityIndex(devices = []) {
  const tokens = new Map();
  devices.forEach((device, index) => {
    for (const token of identityTokens(device)) {
      if (!tokens.has(token.key)) tokens.set(token.key, new Set());
      tokens.get(token.key).add(index);
    }
  });
  return { devices, tokens };
}

export function addIdentityToIndex(index, device, position = index.devices.indexOf(device)) {
  if (position < 0) throw new Error("Устройство отсутствует в identity index");
  for (const token of identityTokens(device)) {
    if (!index.tokens.has(token.key)) index.tokens.set(token.key, new Set());
    index.tokens.get(token.key).add(position);
  }
  return index;
}

export function findIdentityMatch(candidate, index) {
  const scores = new Map();
  const strong = new Map();
  const strongPositions = new Set();
  for (const token of identityTokens(candidate)) {
    for (const position of index.tokens.get(token.key) || []) {
      scores.set(position, (scores.get(position) || 0) + token.weight);
      if (token.strong) {
        strong.set(position, (strong.get(position) || 0) + 1);
        strongPositions.add(position);
      }
    }
  }
  const ranked = [...scores.entries()]
    .map(([position, score]) => ({ position, score, strong: strong.get(position) || 0, device: index.devices[position] }))
    .sort((left, right) => right.strong - left.strong || right.score - left.score || left.position - right.position);
  if (!ranked.length) return { status: "none", match: null, candidates: [] };
  const best = ranked[0];
  const tied = ranked.filter((item) => item.strong === best.strong && item.score === best.score);
  if (!best.strong || tied.length > 1 || strongPositions.size > 1) return { status: "ambiguous", match: null, candidates: ranked.filter((item) => strongPositions.has(item.position)) };
  return { status: "matched", match: best.device, position: best.position, score: best.score, candidates: ranked };
}

export function stableIdentity(device = {}) {
  const token = identityTokens(device).find((item) => item.strong);
  return token?.key || "";
}

export function stableId(device = {}, namespace = "device") {
  const source = stableIdentity(device) || identityTokens(device)[0]?.key || JSON.stringify(device);
  let hash = 2166136261;
  for (const char of `${namespace}:${source}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${namespace}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

