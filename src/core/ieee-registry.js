import { normalizeMac } from "./normalize.js";

const PREFIX_LENGTHS = Object.freeze([10, 9, 8, 7, 6]);
const IEEE_SOURCE_REGISTRIES = Object.freeze(["MA-L", "MA-M", "MA-S", "IAB", "CID"]);

export function validateIeeeRegistry(registry = {}) {
  const metadata = registry?.metadata;
  const generatedAt = String(metadata?.generatedAt || "");
  const parsedGeneratedAt = new Date(generatedAt);
  const normalizedGeneratedAt = Number.isNaN(parsedGeneratedAt.getTime()) ? "" : parsedGeneratedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (metadata?.schemaVersion !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(generatedAt) || normalizedGeneratedAt !== generatedAt) {
    throw new Error("Встроенный IEEE справочник имеет неверную версию или дату");
  }
  if (!Array.isArray(registry.vendors) || registry.vendors.some((vendor) => typeof vendor !== "string" || !vendor.trim())) {
    throw new Error("Встроенный IEEE справочник содержит некорректный список производителей");
  }
  if (!registry.rows || typeof registry.rows !== "object" || Array.isArray(registry.rows)
    || Object.keys(registry.rows).sort().join(",") !== "6,7,9") {
    throw new Error("Встроенный IEEE справочник содержит некорректные префиксы");
  }
  const counts = metadata.counts;
  if (!counts || IEEE_SOURCE_REGISTRIES.some((name) => !Number.isSafeInteger(counts[name]) || counts[name] < 0)) {
    throw new Error("Встроенный IEEE справочник содержит некорректные количества назначений");
  }
  const expectedRows = { "6": counts["MA-L"], "7": counts["MA-M"], "9": counts["MA-S"] + counts.IAB };
  for (const [length, expected] of Object.entries(expectedRows)) {
    const entries = registry.rows[length];
    if (!Array.isArray(entries) || entries.length !== expected * 2) {
      throw new Error(`Встроенный IEEE справочник неполон: префиксы длины ${length}`);
    }
    const seen = new Set();
    for (let offset = 0; offset < entries.length; offset += 2) {
      const prefix = entries[offset];
      const vendorId = entries[offset + 1];
      if (typeof prefix !== "string" || !new RegExp(`^[0-9A-F]{${length}}$`).test(prefix)
        || seen.has(prefix) || !Number.isSafeInteger(vendorId) || vendorId < 0 || vendorId >= registry.vendors.length) {
        throw new Error(`Встроенный IEEE справочник содержит некорректную запись префикса ${length}`);
      }
      seen.add(prefix);
    }
  }
  const cid = registry.catalog?.CID;
  if (!Array.isArray(cid) || cid.length !== counts.CID
    || cid.some((record) => !Array.isArray(record) || record.length !== 2 || !/^[0-9A-F]{6}$/.test(record[0]) || typeof record[1] !== "string" || !record[1].trim())) {
    throw new Error("Встроенный IEEE справочник содержит неполный каталог CID");
  }
  const total = IEEE_SOURCE_REGISTRIES.reduce((sum, name) => sum + counts[name], 0);
  if (metadata.total !== total) throw new Error("Встроенный IEEE справочник содержит неверное общее количество");
  if (!Array.isArray(metadata.sources) || metadata.sources.length !== IEEE_SOURCE_REGISTRIES.length) {
    throw new Error("Встроенный IEEE справочник не содержит полный список исходных реестров");
  }
  for (const name of IEEE_SOURCE_REGISTRIES) {
    const source = metadata.sources.find((item) => item?.registry === name);
    if (!source || source.count !== counts[name] || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || !/^[0-9a-f]{64}$/i.test(source.sha256)) {
      throw new Error(`Встроенный IEEE справочник содержит некорректные метаданные ${name}`);
    }
  }
  return true;
}

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

export function* ieeeOuiRecordBatches(registry = {}, { batchSize = 500, source = "Встроенный IEEE OUI" } = {}) {
  const vendors = Array.isArray(registry.vendors) ? registry.vendors : [];
  const entries = registry.rows?.["6"];
  if (!Array.isArray(entries)) return;
  const limit = Math.max(1, Math.floor(Number(batchSize) || 500));
  let batch = [];
  for (let offset = 0; offset + 1 < entries.length; offset += 2) {
    const prefix = String(entries[offset] || "").toUpperCase();
    const vendor = vendors[entries[offset + 1]];
    if (!/^[0-9A-F]{6}$/.test(prefix) || typeof vendor !== "string" || !vendor.trim()) continue;
    batch.push({ prefix, vendor: vendor.trim(), source });
    if (batch.length === limit) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export function createOuiIndexOverlay(ieeeIndex = new Map(), customIndex = new Map()) {
  return Object.freeze({
    get(prefix) {
      return customIndex.has(prefix) ? customIndex.get(prefix) : ieeeIndex.get(prefix);
    },
  });
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

export function ieeeCidCatalogPage(registry = {}, { query = "", page = 1, pageSize = 20 } = {}) {
  const rows = Array.isArray(registry?.catalog?.CID) ? registry.catalog.CID : [];
  const term = String(query || "").trim().toLocaleLowerCase("en");
  const rawQuery = String(query || "").trim();
  const compactPrefix = /^[0-9A-F:.\s-]+$/i.test(rawQuery) ? rawQuery.toUpperCase().replace(/[^0-9A-F]/g, "") : "";
  const filtered = term ? rows.filter((record) => {
    const prefix = String(record?.[0] || "").toUpperCase();
    const organization = String(record?.[1] || "").toLocaleLowerCase("en");
    return organization.includes(term) || (compactPrefix && prefix.includes(compactPrefix));
  }) : rows;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 20)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / limit));
  const selectedPage = Math.max(1, Math.min(pageCount, Math.floor(Number(page) || 1)));
  const start = (selectedPage - 1) * limit;
  return { rows: filtered.slice(start, start + limit), total: filtered.length, page: selectedPage, pageCount };
}
