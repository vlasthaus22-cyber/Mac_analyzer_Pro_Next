import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const node = process.execPath;
const checks = [
  ["JavaScript syntax", ["--check", "src/app.js"]],
  ["enrichment syntax", ["--check", "src/core/enrichment.js"]],
  ["analytics syntax", ["--check", "src/core/analytics-detail.js"]],
  ["import limits syntax", ["--check", "src/core/import-limits.js"]],
  ["room history syntax", ["--check", "src/core/room-history.js"]],
  ["history enrichment syntax", ["--check", "src/core/history-enrichment.js"]],
  ["history export syntax", ["--check", "src/core/history-export.js"]],
  ["IndexedDB syntax", ["--check", "src/data/database.js"]],
  ["XLSX export syntax", ["--check", "src/core/xlsx-export.js"]],
  ["Inventory export syntax", ["--check", "src/core/inventory-export.js"]],
  ["ESLint", ["node_modules/eslint/bin/eslint.js", "src", "tests", "scripts"]],
  ["parity registry", ["scripts/check-parity-registry.mjs"]],
  ["portable build", ["scripts/build-portable.mjs"]],
  ["portable artifact syntax", ["scripts/check-portable-artifact.mjs"]],
  ["full release archive build", ["scripts/build-release-archive.mjs"]],
  ["full release archive verification", ["scripts/check-release-archive.mjs"]],
  ["tests", ["--test", ...readdirSync("tests").filter((name) => name.endsWith(".test.js")).map((name) => `tests/${name}`)]],
  ["Python optional-host integration tests", ["scripts/run-python-tests.mjs"]],
];

for (const [name, args] of checks) {
  console.log(`\n> ${name}`);
  const result = spawnSync(node, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
