import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvQuote, csvQuoteMinimal, tsvQuote } from "../src/core/csv-cell.js";
import { csv } from "../src/ui/render.js";
import { clustersCsv } from "../src/core/analytics-detail.js";
import { singleFileDevicesCsv } from "../src/core/single-file-analysis.js";
import { tableRowsTsv } from "../src/core/table-actions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("spreadsheet cell encoders preserve ordinary values and neutralize formula-leading text", () => {
  for (const input of ["=1+1", "+SUM(A1:A2)", "-1+2", "@SUM(A1)", " \t=1+1", "\r\n=1+1"]) {
    assert.equal(csvQuote(input), `"'${input.replaceAll('"', '""')}"`);
    const csvSafeText = `'${input}`;
    assert.equal(csvQuoteMinimal(input), /[",\r\n;]/.test(csvSafeText) ? `"${csvSafeText.replaceAll('"', '""')}"` : csvSafeText);
    const tsvSafeText = `'${input}`;
    assert.equal(tsvQuote(input), /[\t\r\n"]/.test(tsvSafeText) ? `"${tsvSafeText.replaceAll('"', '""')}"` : tsvSafeText);
  }
  assert.equal(csvQuote("a;\"b"), '"a;""b"');
  assert.equal(csvQuoteMinimal("a;b"), '"a;b"');
  assert.equal(csvQuoteMinimal("plain"), "plain");
  assert.equal(tsvQuote("a\tb"), '"a\tb"');
  assert.equal(csvQuote(-12), '"-12"', "numeric values remain numeric-looking and are not prefixed");
});

test("spreadsheet formula defense reaches CSV and TSV exports with imported device values", () => {
  assert.equal(csv([{ model: "=1+1" }], [{ key: "model", label: "Модель" }]), '"Модель"\r\n"\'=1+1"');
  const clusterCsv = clustersCsv({ clusters: {
    fields: ["manufacturer"],
    items: [{ fields: { manufacturer: "@SUM(A1)" }, count: 1 }],
  } });
  assert.match(clusterCsv, /'@SUM\(A1\);1/);
  assert.match(singleFileDevicesCsv([{ manufacturer: "-cmd|' /C calc'!A0" }]), /"'-cmd\|' \/C calc'!A0"/);
  assert.equal(tableRowsTsv([{ model: "\t=1+1" }], [{ key: "model", label: "Модель" }]), "Модель\r\n\"'\t=1+1\"");
});

test("every runtime CSV and TSV writer uses the shared spreadsheet-safe encoder", async () => {
  const encodersByModule = new Map([
    ["src/app.js", ["tsvQuote"]],
    ["src/core/analytics-detail.js", ["csvQuoteMinimal"]],
    ["src/core/file-comparison-export.js", ["csvQuote"]],
    ["src/core/ip-mapping.js", ["csvQuote"]],
    ["src/core/multi-file-comparison.js", ["csvQuote"]],
    ["src/core/single-file-analysis.js", ["csvQuote"]],
    ["src/core/snapshot-export.js", ["csvQuote"]],
    ["src/core/table-actions.js", ["csvQuote", "tsvQuote"]],
    ["src/core/temporal-statistics.js", ["csvQuote"]],
    ["src/core/vendor-model-history.js", ["csvQuote"]],
    ["src/ui/render.js", ["csvQuote"]],
  ]);
  for (const [module, encoders] of encodersByModule) {
    const source = await readFile(path.join(root, module), "utf8");
    for (const encoder of encoders) assert.match(source, new RegExp(`\\b${encoder}\\b`), `${module} must use ${encoder}`);
  }
});
