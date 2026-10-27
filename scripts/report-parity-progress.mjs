import { readFileSync } from "node:fs";
import { inspectParityRegistry } from "./parity-registry.js";
import { summarizeParityProgress } from "./release-readiness.js";

const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
const { rows, issues } = inspectParityRegistry(markdown);
if (issues.length) throw new Error(`Parity registry validation failed:\n${issues.join("\n")}`);

const report = summarizeParityProgress(rows);
const verbose = process.argv.includes("--verbose");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Полностью подтверждено: ${report.fullyVerified.count}/${report.fullyVerified.total} (${report.fullyVerified.percent}%).`);
  console.log(`Код и автотесты: ${report.codeAndTests.count}/${report.codeAndTests.total} (${report.codeAndTests.percent}%).`);
  console.log(`Открыто/частично: ${report.openOrPartial}.`);
  for (const blocker of report.blockers.filter(({ count }) => count)) {
    const ids = verbose ? ` [${blocker.ids.map((id) => `#${id}`).join(", ")}]` : "";
    console.log(`- ${blocker.label}: ${blocker.count}${ids}`);
  }
  console.log(`Релиз: ${report.releaseReady ? "ГОТОВ" : "ЗАБЛОКИРОВАН"}.`);
}
