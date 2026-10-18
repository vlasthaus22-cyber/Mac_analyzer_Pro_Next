import { readFileSync } from "node:fs";
import { inspectParityRegistry } from "./parity-registry.js";
import { inspectReleaseReadiness } from "./release-readiness.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown);
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);

const readiness = inspectReleaseReadiness(rows);
if (!readiness.ready) {
  const pendingIds = readiness.pending.map(({ id }) => `#${id}`).join(", ");
  throw new Error(`Release blocked: ${readiness.pending.length} of ${readiness.total} parity requirements are open. Resolve the listed rows in PARITY_REGISTRY.md before publishing: ${pendingIds}`);
}
console.log(`Release readiness passed: all ${readiness.total} parity requirements are complete.`);
