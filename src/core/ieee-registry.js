import { normalizeMac } from "./normalize.js";

const PREFIX_LENGTHS = Object.freeze([10, 9, 8, 7, 6]);

export function normalizeOuiPrefix(value) {
  const prefix = String(value ?? "").trim().replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return /^(?:[0-9A-F]{6}|[0-9A-F]{7}|[0-9A-F]{8}|[0-9A-F]{9}|[0-9A-F]{10})$/.test(prefix) ? prefix : "";
}

export function detectOuiColumns(headers = []) {
  return {
    prefixIndex: headers.findIndex((header) => /prefix|assignment|oui|hex/i.test(String(header || ""))),
    vendorIndex: headers.findIndex((header) => /vendor|organization|manufacturer|company/i.test(String(header || ""))),
  };
}

export function buildIeeeRegistryIndex(registry = {}) {
  const vendors = Array.isArray(registry.vendors) ? registry.vendors : [];
  const rows = registry.rows && typeof registry.rows === "object" ? registry.rows : {};
  const index = new Map();
  for (const length of PREFIX_LENGTHS) {
    const entries = rows[String(length)];
    if (!Array.isArray(entries)) continue;
    for (let offset = 0; offset + 1 < entries.length; offset += 2) {
      const prefix = String(entries[offset] || "").toUpperCase();
      const vendor = vendors[entries[offset + 1]];
      if (prefix.length !== length || !/^[0-9A-F]+$/.test(prefix) || typeof vendor !== "string" || !vendor.trim()) continue;
      if (!index.has(prefix)) index.set(prefix, vendor.trim());
    }
  }
  return index;
}

export function mergeOuiIndexes(ieeeIndex = new Map(), customIndex = new Map()) {
  return new Map([...ieeeIndex, ...customIndex]);
}

export function lookupOuiVendor(mac, ouiIndex = new Map()) {
  const compactMac = normalizeMac(mac).replaceAll(":", "");
  if (compactMac.length !== 12) return "";
  for (const length of PREFIX_LENGTHS) {
    const vendor = ouiIndex.get(compactMac.slice(0, length));
    if (vendor) return vendor;
  }
  return "";
}

export function ieeeRegistryStatus(registry = {}) {
  const metadata = registry.metadata || {};
  return {
    source: String(metadata.source || ""),
    generatedAt: String(metadata.generatedAt || ""),
    counts: { ...(metadata.counts || {}) },
    total: Number(metadata.total || 0),
  };
}
