import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createZip, sha256 } from "./release-archive.js";
import { getOutputDirectory } from "./output-directory.js";

const packageRoot = process.cwd();
const releaseRoot = "MAC-Analyzer-Pro-Next";
const outputDirectory = getOutputDirectory(packageRoot);
const outputPath = path.join(outputDirectory, "MAC-Analyzer-Pro-Next-full.zip");
const sidecarPath = `${outputPath}.sha256`;
const roots = [".agents", "src", "docs", "assets", "vendor", "licenses", "scripts", "tests", "tools"];
const rootFiles = ["AGENTS.md", "CHECK_MAC_ANALYZER.ps1", "CHANGELOG.md", "eslint.config.js", "index.html", "package.json", "PARITY_REGISTRY.md", "pnpm-lock.yaml", "README.md", "START_MAC_ANALYZER.cmd", "styles.css"];
const forbiddenExtensions = new Set([".db", ".madb", ".sqlite", ".log", ".zip"]);

async function collectFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".pnpm-store", "dist", "coverage"].includes(entry.name) || entry.name.startsWith(".env")) continue;
    const fullPath = path.join(directory, entry.name);
    const relPath = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release package refuses a symbolic link: ${relPath}`);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, relPath));
    else if (entry.isFile() && !forbiddenExtensions.has(path.extname(entry.name).toLowerCase())
      && !/\.(?:madb(?:\.json)?|sqlite(?:-(?:wal|shm))?)$/i.test(entry.name)) {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Release package refuses a symbolic link: ${relPath}`);
      files.push({ fullPath, relPath });
    }
  }
  return files;
}

const files = [];
for (const root of roots) files.push(...await collectFiles(path.join(packageRoot, root), root));
const releaseNotes = (await readdir(packageRoot)).filter((name) => /^RELEASE_NOTES_v.*\.md$/i.test(name));
for (const relPath of [...rootFiles, ...releaseNotes]) files.push({ fullPath: path.join(packageRoot, relPath), relPath });
files.push({ fullPath: path.join(outputDirectory, "MAC-Analyzer-Pro-Next.html"), relPath: "dist/MAC-Analyzer-Pro-Next.html" });
files.sort((left, right) => left.relPath.localeCompare(right.relPath, "en"));
const names = new Set();
const entries = [];
const sums = [];
for (const file of files) {
  const archivePath = `${releaseRoot}/${file.relPath.replaceAll("\\", "/")}`;
  if (names.has(archivePath)) throw new Error(`Duplicate release path: ${archivePath}`);
  names.add(archivePath);
  const data = await readFile(file.fullPath);
  const hash = createHash("sha256").update(data).digest("hex");
  entries.push({ name: archivePath, data });
  sums.push(`${hash}  ${file.relPath.replaceAll("\\", "/")}`);
}
const manifest = Buffer.from(`${sums.join("\n")}\n`, "utf8");
entries.push({ name: `${releaseRoot}/SHA256SUMS.txt`, data: manifest });
const archive = createZip(entries);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, archive);
const archiveHash = sha256(archive);
await writeFile(sidecarPath, `${archiveHash}  ${path.basename(outputPath)}\n`, "utf8");
console.log(JSON.stringify({ archive: outputPath, bytes: archive.length, files: entries.length, sha256: archiveHash }));
