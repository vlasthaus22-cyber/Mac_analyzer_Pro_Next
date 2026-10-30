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
const artifactPaths = ["dist/MAC-Analyzer-Pro-Next.html"];
if (manifest.has("dist/MAC-Analyzer-Pro-Next-Host.exe")) artifactPaths.push("dist/MAC-Analyzer-Pro-Next-Host.exe");
for (const relativePath of artifactPaths) {
  const artifactPath = path.join(getOutputDirectory(), path.basename(relativePath));
  const artifactBytes = await readFile(artifactPath);
  const artifactHash = sha256(artifactBytes);
  if (artifactHash !== manifest.get(relativePath)) throw new Error(`Built artifact SHA-256 does not match the release ZIP manifest: ${relativePath}`);
  const artifactSidecar = (await readFile(`${artifactPath}.sha256`, "utf8")).trim();
  if (artifactSidecar !== `${artifactHash}  ${path.basename(artifactPath)}`) {
    throw new Error(`Built artifact SHA-256 sidecar does not match: ${relativePath}`);
  }
}
for (const archiveEntry of entries.keys()) {
  if (archiveEntry !== manifestPath && !manifest.has(archiveEntry.slice(root.length))) throw new Error(`Release ZIP has an unhashed entry: ${archiveEntry}`);
  if (/(?:^|\/)__pycache__(?:\/|$)|\.(?:db|madb|sqlite|log|zip|pyc|pyo)$/i.test(archiveEntry)) throw new Error(`Release ZIP contains forbidden generated or user data: ${archiveEntry}`);
}
for (const required of [
  "README.md", "server.py", "START_MAC_ANALYZER.cmd", "START_MAC_ANALYZER_SERVER.cmd", "STOP_MAC_ANALYZER_SERVER.cmd", "CHECK_MAC_ANALYZER.ps1", "PARITY_REGISTRY.md", "requirements-windows-packaging.txt", "index.html", "styles.css", "packaging/mac-analyzer-as-invoker.manifest", "licenses/PyInstaller.LICENSE.md", "scripts/packaged_host.py", "scripts/build-windows-backend.mjs", "scripts/check-windows-backend.mjs", "scripts/check-windows-backend.py", "tests/test_packaged_host.py", "src/data/database.js",
  ".agents/README.md", "docs/PROJECT_STRUCTURE.md", "docs/DATA_FORMATS.md", "docs/DATA_STORAGE.md", "assets/ieee-vendor-registry.json",
  "vendor/chart.umd.min.js", "vendor/xlsx.full.min.js", "dist/MAC-Analyzer-Pro-Next.html",
  "backend/services/system/__init__.py", "backend/services/system/storage_paths.py", "backend/services/system/sqlite_store.py", "backend/services/system/backup_store.py", "backend/services/system/diagnostics_service.py", "backend/services/system/engineering_service.py", "backend/services/system/legacy_migration_service.py", "backend/services/system/parity_service.py", "backend/services/integrations/__init__.py", "backend/services/integrations/external_vendor.py",
 "backend/services/integrations/notification_secrets.py", "backend/services/integrations/notifications.py",
  "scripts/build-portable.mjs", "scripts/run-python-tests.mjs", "scripts/optional_server_launcher.py", "scripts/optional_storage_paths.py", "scripts/optional_sqlite_store.py", "scripts/optional_backup_store.py", "scripts/optional_diagnostics.py", "tests/database.test.js",
  "tests/optional-server.test.js", "tests/external-vendor-settings.test.js", "tests/external-vendor-controls.test.js", "tests/test_external_vendor.py", "tests/test_system_services.py", "tests/test_optional_server.py", "tests/test_optional_storage_paths.py", "tests/test_optional_sqlite_store.py", "tests/test_optional_backup_store.py", "tests/test_optional_diagnostics.py", "licenses/Chart.js.LICENSE.md",
 "tests/notification-settings.test.js", "tests/notification-controls.test.js", "tests/test_notifications.py", "tests/test_notification_secrets.py",
]) {
  if (!manifest.has(required)) throw new Error(`Release ZIP is missing required source or reference file: ${required}`);
}
if (process.platform === "win32" && !manifest.has("dist/MAC-Analyzer-Pro-Next-Host.exe")) {
  throw new Error("Windows release ZIP is missing the Python-free asInvoker loopback host executable");
}
console.log(`Release ZIP verified: ${entries.size} entries, ${archive.length.toLocaleString("en-US")} bytes, SHA-256 ${actualHash}`);
