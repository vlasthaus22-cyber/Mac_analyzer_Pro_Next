import { readFileSync } from "node:fs";
import { inspectParityRegistry } from "./parity-registry.js";
import { categorizePendingParityRows, inspectReleaseReadiness } from "./release-readiness.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown);
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);

const readiness = inspectReleaseReadiness(rows);
if (!readiness.ready) {
  const labels = {
    runtimeVerification: "browser smoke/E2E",
    backendUnavailable: "backend/REST unavailable in this browser-only build",
    externalIntegration: "external integrations not implemented",
    implementation: "implementation or verification work",
  };
  const breakdown = Object.entries(categorizePendingParityRows(readiness.pending))
    .filter(([, rowsInCategory]) => rowsInCategory.length)
    .map(([category, rowsInCategory]) => `${labels[category]}: ${rowsInCategory.length} (${rowsInCategory.map(({ id }) => `#${id}`).join(", ")})`)
    .join("; ");
  throw new Error(`Release blocked: ${readiness.percent}% verified (${readiness.completed}/${readiness.total} parity requirements); ${readiness.pending.length} remain open or partial. Breakdown: ${breakdown}. Resolve each category and update PARITY_REGISTRY.md before publishing.`);
}
console.log(`Release readiness passed: 100% verified (${readiness.completed}/${readiness.total} parity requirements are complete).`);
