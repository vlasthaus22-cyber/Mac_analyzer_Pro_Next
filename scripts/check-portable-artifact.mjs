import { readFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { getOutputDirectory } from "./output-directory.js";

const html = await readFile(path.join(getOutputDirectory(), "MAC-Analyzer-Pro-Next.html"), "utf8");
const shell = html.slice(0, html.indexOf("<script>"));
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const application = scripts.map((match) => match[1]).find((source) => source.includes("__MAC_ANALYZER_IEEE_REGISTRY__"));
if (!application) throw new Error("Portable HTML does not contain the embedded application and IEEE registry");
if (!application.includes("Chart.js Contributors") || !application.includes("Chart.js v4.5.1")) {
  throw new Error("Portable HTML is missing the licensed Chart.js 4.5.1 runtime");
}
if (!application.includes("xlsx.js (C) 2013-present SheetJS") || !application.includes("Apache License")) {
  throw new Error("Portable HTML is missing the locally bundled, licensed SheetJS XLS/XLSX parser");
}
if (!application.includes("subframe7536") || !application.includes("__MAC_ANALYZER_SQLITE_RUNTIME__")
  || !application.includes("data:application/wasm;base64,")) {
  throw new Error("Portable HTML is missing the licensed SQLite-WASM runtime or embedded WASM binary");
}
if (!application.includes("Version 4.2.1") || !application.includes("__MAC_ANALYZER_PDF_FONT_BASE64__")
  || !application.includes("Noto Sans Regular font;")) {
  throw new Error("Portable HTML is missing the licensed PDF runtime or embedded Cyrillic font");
}
for (const marker of ["chart:presence-churn", "MAC churn", "charts.length > 4 ? 1_520 : 1_200"]) {
  if (!application.includes(marker)) throw new Error(`Portable HTML is missing Dashboard presence-churn export behavior: ${marker}`);
}
if (html.includes("node_modules/jspdf/dist/jspdf.umd.min.js")) throw new Error("Portable HTML contains a non-autonomous jsPDF script reference");
const workerAssignment = application.match(/globalThis\.__MAC_ANALYZER_HISTORY_WORKER_SOURCE__=("(?:\\.|[^"\\])*");/);
if (!workerAssignment) throw new Error("Portable HTML is missing the embedded analytics Web Worker");
if (scripts.length !== 1) throw new Error(`Expected one self-contained application script, found ${scripts.length}`);
if (!html.includes("<style>") || html.includes('<link rel="stylesheet" href="styles.css">')) {
  throw new Error("Portable HTML is missing embedded styles");
}
const shellIds = [...shell.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(shellIds).size !== shellIds.length) throw new Error("Portable HTML contains duplicate static element IDs");
const shellIdSet = new Set(shellIds);
for (const attribute of ["for", "aria-controls", "aria-labelledby"]) {
  const unresolved = [...shell.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, "g"))]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((id) => id && !shellIdSet.has(id));
  if (unresolved.length) throw new Error(`Portable HTML has unresolved ${attribute} references: ${unresolved.join(", ")}`);
}
if (!/\.error-banner\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(html)
  || !application.includes('banner?.querySelector("[data-error-dismiss]")')
  || !application.includes('bindErrorBannerDismiss($("#errorBanner"))')) {
  throw new Error("Portable HTML is missing the error banner's visible dismissal behavior");
}
if (!application.includes("function guardEngineeringClick(event,")
  || !application.includes("guardEngineeringClick(event, {")
  || !application.includes('targetMatchesAny(target, ["[data-error-dismiss]"])) return false')) {
  throw new Error("Portable HTML engineering guard may prevent the error close action in a restricted view");
}
if (!application.includes("const MutationObserverRef = globalThis.MutationObserver;")
  || !application.includes('observer.observe(documentRef.documentElement, { attributes: true, attributeFilter: ["open"], childList: true, subtree: true })')
  || !application.includes('dialog.addEventListener("close", () => {')) {
  throw new Error("Portable HTML is missing error-banner recovery when a dialog opens after the error");
}
const zIndex = (selector) => Number(shell.match(new RegExp(`\\.${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`))?.[1]);
if (!(zIndex("error-banner") > zIndex("progress-panel"))) {
  throw new Error("Portable HTML error banner can be covered by the floating progress panel");
}
new Script(application);
const workerSource = JSON.parse(workerAssignment[1]);
new Script(workerSource);
console.log(`Portable application and analytics worker compile (${Buffer.byteLength(application).toLocaleString("en-US")} + ${Buffer.byteLength(workerSource).toLocaleString("en-US")} bytes)`);
