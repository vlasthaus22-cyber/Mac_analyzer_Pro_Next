import { conflictingStrongFields } from "./identity.js";
import { normalizeIp, normalizeMac, text } from "./normalize.js";

export const COMPARISON_FIELD_WEIGHTS = Object.freeze({
  mac: 100,
  oui: 100,
  vendor: 50,
  model: 50,
  ip: 50,
  address: 50,
  room: 50,
  switchIp: 50,
  switchPort: 50,
});

export const DEFAULT_COMPARISON_SETTINGS = Object.freeze({
  fields: Object.freeze({
    mac: true,
    oui: true,
    vendor: false,
    model: false,
    ip: false,
    address: false,
    room: false,
    switchIp: false,
    switchPort: false,
  }),
  threshold: 70,
});

const FIELD_ALIASES = Object.freeze({
  mac: ["mac", "compare_mac"],
  oui: ["oui", "compare_oui"],
  vendor: ["vendor", "compare_vendor"],
  model: ["model", "compare_model"],
  ip: ["ip", "compare_ip"],
  address: ["address", "compare_address"],
  room: ["room", "compare_room"],
  switchIp: ["switchIp", "switch_ip", "compare_switch_ip"],
  switchPort: ["switchPort", "switch_port", "compare_switch_port"],
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeComparisonSettings(value) {
  const source = object(value);
  const fieldsSource = object(source.fields || source.comparison_fields || source);
  const fields = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const selected = aliases.find((alias) => typeof fieldsSource[alias] === "boolean");
    fields[field] = selected ? fieldsSource[selected] : DEFAULT_COMPARISON_SETTINGS.fields[field];
  }
  const rawThreshold = source.threshold ?? source.comparison_threshold ?? fieldsSource.threshold;
  const threshold = Number.isFinite(Number(rawThreshold))
    ? Math.max(0, Math.min(100, Math.round(Number(rawThreshold))))
    : DEFAULT_COMPARISON_SETTINGS.threshold;
  return { fields, threshold };
}

function comparisonValue(device, field) {
  switch (field) {
    case "mac": return normalizeMac(device?.mac || device?.macFormatted || device?.mac_formatted);
    case "oui": return text(device?.oui).slice(0, 6);
    case "vendor": return text(device?.vendor || device?.manufacturer);
    case "model": return text(device?.model);
    case "ip": return normalizeIp(device?.ip || device?.deviceIp || device?.device_ip);
    case "address": return text(device?.address);
    case "room": return text(device?.room);
    case "switchIp": return normalizeIp(device?.switchIp || device?.switch_ip);
    case "switchPort": return text(device?.switchPort || device?.switch_port);
    default: return "";
  }
}

export function scoreConfiguredComparison(left, right, settings = DEFAULT_COMPARISON_SETTINGS) {
  const normalized = normalizeComparisonSettings(settings);
  let score = 0;
  let total = 0;
  const matchedFields = [];
  for (const [field, weight] of Object.entries(COMPARISON_FIELD_WEIGHTS)) {
    if (!normalized.fields[field]) continue;
    total += weight;
    const leftValue = comparisonValue(left, field);
    const rightValue = comparisonValue(right, field);
    if (leftValue && rightValue && leftValue === rightValue) {
      score += weight;
      matchedFields.push(field);
    }
  }
  return { score: total ? (score / total) * 100 : 0, scorePoints: score, totalPoints: total, matchedFields };
}

/**
 * Resolve only the bounded weak-identity candidates already surfaced by the
 * canonical identity index. Never scan a Final or choose a tied/overflow row.
 */
export function resolveConfiguredComparison(candidate, candidates, settings = DEFAULT_COMPARISON_SETTINGS, { candidateOverflow = false } = {}) {
  const normalized = normalizeComparisonSettings(settings);
  if (candidateOverflow) return { status: "unresolved", reason: "candidate-overflow", candidates: [] };
  const ranked = [];
  const conflicts = [];
  for (const entry of candidates || []) {
    const device = entry?.device || entry;
    if (!device || typeof device !== "object") continue;
    const conflictingFields = conflictingStrongFields(candidate, device);
    if (conflictingFields.length) {
      conflicts.push({ position: entry?.position, device, fields: conflictingFields });
      continue;
    }
    const comparison = scoreConfiguredComparison(candidate, device, normalized);
    const independentMatches = comparison.matchedFields.filter((field) => !["ip", "oui", "mac"].includes(field));
    if (comparison.totalPoints > 0
      && comparison.score >= normalized.threshold
      && independentMatches.length >= 2) {
      ranked.push({ ...entry, device, ...comparison });
    }
  }
  ranked.sort((left, right) => right.score - left.score || left.position - right.position);
  if (!ranked.length) return { status: "unresolved", reason: conflicts.length ? "strong-identity-conflict" : "below-threshold", candidates: [], conflicts };
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    return { status: "ambiguous", reason: "score-tie", candidates: ranked.slice(0, 2), conflicts };
  }
  return { status: "matched", match: ranked[0].device, position: ranked[0].position, score: ranked[0].score, candidates: ranked, conflicts };
}
