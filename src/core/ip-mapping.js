import { csvQuote } from "./csv-cell.js";
import { normalizeIp, text } from "./normalize.js";

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

export function applyIpMapping(device, mappings) {
  const switchIp = normalizeIp(device?.switchIp);
  const mapping = mappings.get(switchIp);
  if (!mapping || text(device.address)) return false;
  device.address = mapping.address;
  device.fieldSources ||= {};
  device.fieldSources.address = mapping.source;
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
