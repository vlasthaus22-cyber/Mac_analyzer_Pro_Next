import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectParityRegistry } from "./parity-registry.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown, { exists: (file) => {
  const absolute = path.resolve(process.cwd(), file);
  if (!file.includes("*")) return existsSync(absolute);
  const directory = path.dirname(absolute);
  const pattern = new RegExp(`^${path.basename(file).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
  return existsSync(directory) && readdirSync(directory).some((name) => pattern.test(name));
} });
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);
console.log(`Parity registry validated (${rows.length} unique source requirements)`);
