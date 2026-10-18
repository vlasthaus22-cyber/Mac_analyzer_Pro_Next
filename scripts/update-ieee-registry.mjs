import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IEEE_REGISTRY_SOURCES = Object.freeze({
  "MA-L": "https://standards-oui.ieee.org/oui/oui.csv",
  "MA-M": "https://standards-oui.ieee.org/oui28/mam.csv",
  "MA-S": "https://standards-oui.ieee.org/oui36/oui36.csv",
  IAB: "https://standards-oui.ieee.org/iab/iab.csv",
  CID: "https://standards-oui.ieee.org/cid/cid.csv",
});

const MATCHABLE_REGISTRIES = Object.freeze(["MA-S", "IAB", "MA-M", "MA-L"]);

function parseCsvRecord(line) {
  const columns = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      columns.push(value);
      value = "";
    } else value += character;
  }
  columns.push(value);
  return columns;
}

export function parseIeeeRegistryCsv(input) {
  const lines = String(input).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("IEEE registry CSV is empty or has no data rows");
  const headers = parseCsvRecord(lines[0]);
  const assignmentColumn = headers.indexOf("Assignment");
  const organizationColumn = headers.indexOf("Organization Name");
  if (assignmentColumn < 0 || organizationColumn < 0) throw new Error("IEEE registry CSV is missing Assignment or Organization Name");
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const columns = parseCsvRecord(line);
    const prefix = String(columns[assignmentColumn] || "").toUpperCase().replace(/[^0-9A-F]/g, "");
    const vendor = String(columns[organizationColumn] || "").trim();
    if (prefix && vendor) rows.set(prefix, vendor);
  }
  if (rows.size === 0) throw new Error("IEEE registry CSV contains no valid assignments");
  return [...rows].sort(([left], [right]) => left.localeCompare(right, "en"));
}

async function fetchSource(fetchImpl, registry, url) {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "MAC-Analyzer-Pro-Next IEEE registry updater" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${registry} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const content = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const records = parseIeeeRegistryCsv(content);
  return {
    records,
    info: {
      registry,
      url,
      count: records.length,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export async function createIeeeRegistryPayload(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js version does not provide fetch");
  const records = {};
  const sources = [];
  for (const [registry, url] of Object.entries(IEEE_REGISTRY_SOURCES)) {
    const result = await fetchSource(fetchImpl, registry, url);
    records[registry] = result.records;
    sources.push(result.info);
  }

  const vendors = [...new Set(MATCHABLE_REGISTRIES.flatMap((registry) => records[registry].map(([, vendor]) => vendor)))].sort((left, right) => left.localeCompare(right, "en"));
  const vendorIds = new Map(vendors.map((vendor, index) => [vendor, index]));
  const prefixMaps = { "6": new Map(), "7": new Map(), "9": new Map() };
  for (const registry of MATCHABLE_REGISTRIES) {
    for (const [prefix, vendor] of records[registry]) {
      if (prefixMaps[prefix.length]) prefixMaps[prefix.length].set(prefix, vendorIds.get(vendor));
    }
  }
  const rows = Object.fromEntries(Object.entries(prefixMaps).map(([length, prefixes]) => [
    length,
    [...prefixes].sort(([left], [right]) => left.localeCompare(right, "en")).flatMap(([prefix, vendorId]) => [prefix, vendorId]),
  ]));
  const counts = Object.fromEntries(Object.entries(records).map(([registry, values]) => [registry, values.length]));
  return {
    vendors,
    rows,
    catalog: { CID: records.CID },
    metadata: {
      schemaVersion: 2,
      generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      source: "IEEE Registration Authority",
      sources,
    },
  };
}

export async function updateIeeeRegistry({ fetchImpl = globalThis.fetch, outputPath } = {}) {
  const payload = await createIeeeRegistryPayload(fetchImpl);
  const targetPath = outputPath || join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ieee-vendor-registry.json");
  const serialized = `${JSON.stringify(payload)}\n`;
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, "utf8");
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try { await (await import("node:fs/promises")).unlink(temporaryPath); } catch { /* Keep the original update failure. */ }
    throw error;
  }
  return { targetPath, generatedAt: payload.metadata.generatedAt, counts: payload.metadata.counts, total: payload.metadata.total, bytes: Buffer.byteLength(serialized) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await updateIeeeRegistry();
  console.log(JSON.stringify(result, null, 2));
}
