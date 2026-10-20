import { csvQuote } from "./csv-cell.js";
import { normalizeIp, text } from "./normalize.js";

export const DEFAULT_IP_ENRICHMENT_SETTINGS = Object.freeze({
  enabled: true,
  partialMatch: true,
  overwrite: false,
  historicalAddress: true,
});

export function normalizeIpEnrichmentSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_IP_ENRICHMENT_SETTINGS.enabled,
    partialMatch: typeof (source.partialMatch ?? source.partial_match) === "boolean"
      ? source.partialMatch ?? source.partial_match : DEFAULT_IP_ENRICHMENT_SETTINGS.partialMatch,
    overwrite: typeof (source.overwrite ?? source.overwriteExisting ?? source.overwrite_existing) === "boolean"
      ? source.overwrite ?? source.overwriteExisting ?? source.overwrite_existing : DEFAULT_IP_ENRICHMENT_SETTINGS.overwrite,
    historicalAddress: typeof (source.historicalAddress ?? source.auto_detect_address_by_ip) === "boolean"
      ? source.historicalAddress ?? source.auto_detect_address_by_ip : DEFAULT_IP_ENRICHMENT_SETTINGS.historicalAddress,
  };
}

export function detectIpMappingColumns(headers = []) {
  return {
    switchIndex: headers.findIndex((header) => /switch|nas.?ip|ip коммутатора/i.test(String(header || ""))),
    addressIndex: headers.findIndex((header) => /address|адрес|location|место/i.test(String(header || ""))),
  };
}

export function createIpMappingAccumulator() {
  const byIp = new Map();
  function accept(record) {
    const switchIp = normalizeIp(record?.switchIp);
    const address = text(record?.address);
    if (!switchIp || !address || /^(unknown|none|не указано)$/i.test(address)) return false;
    byIp.set(switchIp, { switchIp, address, source: text(record.source) || "Ручное правило" });
    return true;
  }
  function acceptMany(records = []) {
    for (const record of records) accept(record);
  }
  function finish() {
    const normalized = [...byIp.values()];
    byIp.clear();
    return normalized;
  }
  return Object.freeze({ accept, acceptMany, finish });
}

export function normalizeIpMappings(records = []) {
  const accumulator = createIpMappingAccumulator();
  accumulator.acceptMany(records);
  return accumulator.finish();
}

export function createIpMappingIndex(records = [], { partialMatch = false } = {}) {
  const exact = new Map(normalizeIpMappings(records).map((item) => [item.switchIp, item]));
  const subnetCandidates = new Map();
  if (partialMatch) {
    for (const item of exact.values()) {
      if (item.switchIp.split(".").length !== 4) continue;
      const subnet = item.switchIp.split(".").slice(0, 3).join(".");
      if (!subnetCandidates.has(subnet)) subnetCandidates.set(subnet, new Map());
      const byAddress = subnetCandidates.get(subnet);
      if (!byAddress.has(item.address)) byAddress.set(item.address, item);
    }
  }
  const partial = new Map([...subnetCandidates]
    .filter(([, addresses]) => addresses.size === 1)
    .map(([subnet, addresses]) => [subnet, addresses.values().next().value]));
  return Object.freeze({ exact, partial });
}

export function applyIpMapping(device, mappings, settings = { enabled: true, partialMatch: false, overwrite: false }) {
  const normalizedSettings = normalizeIpEnrichmentSettings(settings);
  if (!normalizedSettings.enabled) return false;
  const switchIp = normalizeIp(device?.switchIp);
  if (!switchIp) return false;
  const index = mappings?.exact instanceof Map ? mappings : null;
  const exactMatch = index ? index.exact.has(switchIp) : mappings?.has(switchIp) === true;
  const mapping = index
    ? index.exact.get(switchIp) || (normalizedSettings.partialMatch ? index.partial.get(switchIp.split(".").slice(0, 3).join(".")) : null)
    : mappings?.get(switchIp);
  if (!mapping || text(device.address) && !normalizedSettings.overwrite) return false;
  device.address = mapping.address;
  device.fieldSources ||= {};
  device.fieldSources.address = mapping.source || "IP mapping";
  if (!exactMatch) device.fieldSources.address += " (частичное совпадение /24)";
  return true;
}

export function createIpMappingDetector(existing = []) {
  const known = new Map(normalizeIpMappings(existing).map((item) => [item.switchIp, item]));
  const candidates = new Map();
  function accept(devices = []) {
    for (const device of Array.isArray(devices) ? devices : []) {
      const switchIp = normalizeIp(device?.switchIp);
      const address = text(device?.address);
      if (!switchIp || !address || /^(unknown|none|не указано)$/i.test(address)) continue;
      if (!candidates.has(switchIp)) candidates.set(switchIp, new Set());
      candidates.get(switchIp).add(address);
    }
  }
  function finish() {
    const detected = [];
    for (const [switchIp, addresses] of candidates) {
      if (known.has(switchIp) || addresses.size !== 1) continue;
      detected.push({ switchIp, address: [...addresses][0], source: "Автоопределение из активного Final" });
    }
    return detected;
  }
  return Object.freeze({ accept, finish });
}

export function detectIpMappingsFromDevices(devices = [], existing = []) {
  const detector = createIpMappingDetector(existing);
  detector.accept(devices);
  return detector.finish();
}

export function ipMappingsCsv(records = []) {
  return `\uFEFF${["switchIp", "address", "source"].map(csvQuote).join(",")}\r\n${normalizeIpMappings(records).map((item) => [item.switchIp, item.address, item.source].map(csvQuote).join(",")).join("\r\n")}`;
}
