const QUALITY_FIELDS = Object.freeze([
  { key: "vendor", aliases: ["manufacturer"], label: "Производитель" },
  { key: "model", aliases: [], label: "Модель" },
  { key: "address", aliases: [], label: "Адрес" },
  { key: "ip", aliases: [], label: "IP устройства" },
  { key: "room", aliases: [], label: "Помещение" },
  { key: "switchIp", aliases: ["switch_ip"], label: "IP коммутатора" },
  { key: "switchPort", aliases: ["switch_port"], label: "Порт" },
]);
const MAC_RE = /^[0-9A-F]{12}$/;
const EMPTY_QUALITY_VALUES = new Set(["", "unknown", "не указано", "не определено", "неизвестно", "n/a", "na", "none", "null", "not found", "not available"]);

function valueOf(device, names) {
  for (const name of names) {
    const value = device[name];
    if (value !== null && value !== undefined) {
      const normalized = String(value).trim();
      if (normalized && !EMPTY_QUALITY_VALUES.has(normalized.toLocaleLowerCase("ru-RU"))) return normalized;
    }
  }
  return "";
}

function normalizedMac(device) {
  return String(device.mac || device.macFormatted || "").trim().replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function validIp(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return true;
  const ipv4 = candidate.split(".");
  const validIpv4 = (parts) => parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
  if (validIpv4(ipv4)) return true;
  if (!candidate.includes(":")) return false;
  let address = candidate;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const tail = address.slice(lastColon + 1).split(".");
    if (!validIpv4(tail)) return false;
    const high = (Number(tail[0]) * 256 + Number(tail[1])).toString(16);
    const low = (Number(tail[2]) * 256 + Number(tail[3])).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }
  if (address.startsWith(":") && !address.startsWith("::")) return false;
  if (address.endsWith(":") && !address.endsWith("::")) return false;
  if (!/^[0-9a-f:]+$/i.test(address) || address.includes(":::") || (address.match(/::/g) || []).length > 1) return false;
  const groups = address.split(":").filter(Boolean);
  if (!groups.every((group) => group.length <= 4)) return false;
  return address.includes("::") ? groups.length < 8 : groups.length === 8;
}

function unknownVendor(value) {
  return ["", "unknown", "not found", "n/a", "не определено", "неизвестно"].includes(String(value ?? "").trim().toLocaleLowerCase("ru-RU"));
}

function issue(id, title, count, severity, recommendation) {
  return { id, title, count, severity, recommendation };
}

export function createDataQualityAccumulator({ invalidRows = 0 } = {}) {
  let devices = 0;
  const macCounts = new Map();
  const sources = new Map();
  const missing = Object.fromEntries(["missingMac", "malformedMac", "unknownVendor", "missingModel", "missingAddress", "missingIp", "malformedIp", "missingSwitch", "malformedSwitch", "missingRoom", "missingPort"].map((key) => [key, 0]));
  const filled = new Map(QUALITY_FIELDS.map(({ key }) => [key, 0]));

  return Object.freeze({
    accept(rows = []) {
      for (const device of rows) {
        if (!device || typeof device !== "object" || Array.isArray(device)) continue;
        devices += 1;
        const mac = normalizedMac(device);
        if (!mac) missing.missingMac += 1;
        else {
          macCounts.set(mac, (macCounts.get(mac) || 0) + 1);
          if (!MAC_RE.test(mac)) missing.malformedMac += 1;
        }
        const vendor = valueOf(device, ["vendor", "manufacturer"]);
        if (unknownVendor(vendor)) missing.unknownVendor += 1;
        if (!valueOf(device, ["model"])) missing.missingModel += 1;
        if (!valueOf(device, ["address"])) missing.missingAddress += 1;
        const ip = valueOf(device, ["ip"]);
        if (!ip) missing.missingIp += 1;
        else if (!validIp(ip)) missing.malformedIp += 1;
        const switchIp = valueOf(device, ["switchIp", "switch_ip"]);
        if (!switchIp) missing.missingSwitch += 1;
        else if (!validIp(switchIp)) missing.malformedSwitch += 1;
        if (!valueOf(device, ["room"])) missing.missingRoom += 1;
        if (!valueOf(device, ["switchPort", "switch_port"])) missing.missingPort += 1;
        const source = valueOf(device, ["source"]) || "unknown";
        sources.set(source, (sources.get(source) || 0) + 1);
        for (const field of QUALITY_FIELDS) {
          const value = valueOf(device, [field.key, ...field.aliases]);
          if (value && !(field.key === "vendor" && unknownVendor(value))) filled.set(field.key, filled.get(field.key) + 1);
        }
      }
    },
    finish() {
      const duplicateMacs = [...macCounts.values()].filter((count) => count > 1).length;
      const duplicateDevices = [...macCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const issues = [
        issue("invalid_rows", "Invalid source rows", Number(invalidRows) || 0, "high", "Review rejected rows and column mapping before saving history."),
        issue("duplicate_macs", "Duplicate MAC addresses", duplicateMacs, "high", "Merge duplicate records or keep the newest switch/port observation."),
        issue("malformed_macs", "Malformed MAC values", missing.malformedMac + missing.missingMac, "high", "Normalize MAC format and verify the MAC column detector."),
        issue("unknown_vendors", "Unknown vendors", missing.unknownVendor, "medium", "Use the local IEEE vendor registry or add a local vendor mapping."),
        issue("missing_models", "Missing models", missing.missingModel, "medium", "Learn model prefixes from history or add model mappings."),
        issue("missing_addresses", "Missing physical addresses", devices && filled.get("address") / devices < 0.5 ? missing.missingAddress : 0, "low", "Configure IP-to-address mapping for automatic physical address completion."),
        issue("missing_ips", "Missing IP addresses", missing.missingIp, "medium", "Import IP data or enable additional enrichment columns."),
        issue("malformed_ips", "Malformed IP addresses", missing.malformedIp, "high", "Correct IP columns and remove non-IP text values."),
        issue("missing_switches", "Missing switch IP", missing.missingSwitch, "medium", "Map switch columns and import switch inventory data."),
        issue("malformed_switches", "Malformed switch IP", missing.malformedSwitch, "medium", "Check switch IP mapping and source column selection."),
        issue("missing_rooms", "Missing rooms", missing.missingRoom, "low", "Use IP-to-address mapping or room columns to improve location analytics."),
        issue("missing_ports", "Missing switch ports", missing.missingPort, "low", "Map switch port columns for topology and movement tracking."),
      ].filter((item) => item.count > 0);
      const completenessFields = QUALITY_FIELDS.map(({ key }) => key);
      const completeness = devices ? Number((completenessFields.reduce((sum, key) => sum + (filled.get(key) || 0), 0) / (devices * completenessFields.length) * 100).toFixed(2)) : 0;
      const weights = { high: 10, medium: 6, low: 3 };
      const penalty = issues.reduce((sum, item) => sum + Math.min(weights[item.severity] * 3, weights[item.severity] * item.count / Math.max(1, devices) * 10), 0);
      const score = devices ? Math.max(0, Math.min(100, Number((100 - penalty).toFixed(2)))) : 0;
      const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
      const recommendations = [...issues].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]).slice(0, 6).map((item) => item.recommendation);
      const dominant = [...sources.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
      if (dominant[1] === devices && devices > 25) recommendations.push("Compare this upload with another source to catch hidden column or inventory drift.");
      const fieldCoverage = Object.fromEntries(QUALITY_FIELDS.map(({ key }) => [key, { filled: filled.get(key) || 0, total: devices, percent: devices ? (filled.get(key) || 0) / devices * 100 : 0 }]));
      return {
        devices, duplicateMacs,
        score, grade, summary: { devices, invalidRows: Number(invalidRows) || 0, uniqueMacs: macCounts.size, duplicates: duplicateDevices, completeness, sources: sources.size },
        issues, recommendations, dominantSource: { name: dominant[0], devices: dominant[1] }, fieldCoverage,
      };
    },
  });
}
