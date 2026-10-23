import { readFileSync } from "node:fs";
import { inspectParityRegistry } from "./parity-registry.js";
import { categorizePendingParityRows, formatReleaseReadinessSummary, inspectProgressCheckpoint, inspectReleaseReadiness } from "./release-readiness.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown);
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);

const readiness = inspectReleaseReadiness(rows);
const checkpoint = inspectProgressCheckpoint(markdown, readiness);
if (!checkpoint.valid) throw new Error(checkpoint.issue);
if (!readiness.ready) {
  const labels = {
    runtimeVerification: "browser smoke/E2E",
    backendUnavailable: "backend/REST parity items still open",
    externalIntegration: "external integrations not implemented",
    implementation: "implementation or verification work",
  };
  const breakdown = Object.entries(categorizePendingParityRows(readiness.pending))
    .filter(([, rowsInCategory]) => rowsInCategory.length)
    .map(([category, rowsInCategory]) => `${labels[category]}: ${rowsInCategory.length} (${rowsInCategory.map(({ id }) => `#${id}`).join(", ")})`)
    .join("; ");
  throw new Error(`${formatReleaseReadinessSummary(readiness, checkpoint)} Breakdown: ${breakdown}. Resolve each category and update PARITY_REGISTRY.md before publishing.`);
}
console.log(formatReleaseReadinessSummary(readiness, checkpoint));
