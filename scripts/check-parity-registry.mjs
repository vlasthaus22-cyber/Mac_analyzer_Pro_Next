import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectParityRegistry } from "./parity-registry.js";
import { inspectProgressCheckpoint, inspectReleaseReadiness } from "./release-readiness.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown, { exists: (file) => {
  const absolute = path.resolve(process.cwd(), file);
  if (!file.includes("*")) return existsSync(absolute);
  const directory = path.dirname(absolute);
  const pattern = new RegExp(`^${path.basename(file).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
  return existsSync(directory) && readdirSync(directory).some((name) => pattern.test(name));
} });
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);
const checkpoint = inspectProgressCheckpoint(markdown, inspectReleaseReadiness(rows));
if (!checkpoint.valid) throw new Error(checkpoint.issue);
console.log(`Parity registry validated (${rows.length} unique source requirements)`);
