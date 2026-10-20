import { readFile } from "node:fs/promises";
import path from "node:path";
import { readZipEntries, sha256 } from "./release-archive.js";
import { getOutputDirectory } from "./output-directory.js";

const archivePath = path.join(getOutputDirectory(), "MAC-Analyzer-Pro-Next-full.zip");
const archive = await readFile(archivePath);
const sidecar = (await readFile(`${archivePath}.sha256`, "utf8")).trim();
const actualHash = sha256(archive);
if (sidecar !== `${actualHash}  ${path.basename(archivePath)}`) throw new Error("Release ZIP SHA-256 sidecar does not match the archive");
const entries = readZipEntries(archive);
const root = "MAC-Analyzer-Pro-Next/";
const manifestPath = `${root}SHA256SUMS.txt`;
const manifestBytes = entries.get(manifestPath);
if (!manifestBytes) throw new Error("Release ZIP is missing SHA256SUMS.txt");
const manifest = new Map();
for (const line of manifestBytes.toString("utf8").split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})  ([^\r\n]+)$/);
  if (!match || manifest.has(match[2])) throw new Error("Release ZIP contains an invalid or duplicate file hash entry");
  manifest.set(match[2], match[1]);
}
for (const [relativePath, expectedHash] of manifest) {
  const data = entries.get(`${root}${relativePath}`);
  if (!data) throw new Error(`Release ZIP is missing ${relativePath}`);
  if (sha256(data) !== expectedHash) throw new Error(`Release ZIP file SHA-256 mismatch: ${relativePath}`);
}
for (const archiveEntry of entries.keys()) {
  if (archiveEntry !== manifestPath && !manifest.has(archiveEntry.slice(root.length))) throw new Error(`Release ZIP has an unhashed entry: ${archiveEntry}`);
  if (/(?:^|\/)__pycache__(?:\/|$)|\.(?:db|madb|sqlite|log|zip|pyc|pyo)$/i.test(archiveEntry)) throw new Error(`Release ZIP contains forbidden generated or user data: ${archiveEntry}`);
}
for (const required of [
  "README.md", "server.py", "START_MAC_ANALYZER.cmd", "START_MAC_ANALYZER_SERVER.cmd", "STOP_MAC_ANALYZER_SERVER.cmd", "CHECK_MAC_ANALYZER.ps1", "PARITY_REGISTRY.md", "index.html", "styles.css", "src/data/database.js",
  ".agents/README.md", "docs/PROJECT_STRUCTURE.md", "docs/DATA_FORMATS.md", "docs/DATA_STORAGE.md", "assets/ieee-vendor-registry.json",
  "vendor/chart.umd.min.js", "vendor/xlsx.full.min.js", "dist/MAC-Analyzer-Pro-Next.html",
  "scripts/build-portable.mjs", "scripts/optional_server_launcher.py", "scripts/optional_storage_paths.py", "tests/database.test.js",
  "tests/optional-server.test.js", "tests/test_optional_server.py", "tests/test_optional_storage_paths.py", "licenses/Chart.js.LICENSE.md",
]) {
  if (!manifest.has(required)) throw new Error(`Release ZIP is missing required source or reference file: ${required}`);
}
console.log(`Release ZIP verified: ${entries.size} entries, ${archive.length.toLocaleString("en-US")} bytes, SHA-256 ${actualHash}`);
