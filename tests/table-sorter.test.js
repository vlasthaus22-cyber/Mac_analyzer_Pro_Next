import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareTableValues, sortTableRows } from "../src/ui/table-sorter.js";

test("table sorting compares numeric values numerically and preserves empty values last", () => {
  assert.ok(compareTableValues("2", "10") < 0);
  assert.ok(compareTableValues("", "1") > 0);
  assert.equal(compareTableValues("", " "), 0);
});

test("table sorting compares localized dates and Russian text", () => {
  assert.ok(compareTableValues("01.02.2026", "15.02.2026") < 0);
  assert.ok(compareTableValues("Адаптер 2", "Адаптер 10") < 0);
  assert.equal(compareTableValues("Модель", "модель"), 0);
});

test("table sorting orders the full 250-row virtual source and leaves summary rows last", () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({
    id: index,
    dataset: {},
    cells: [{ textContent: String(250 - index) }],
    querySelector: () => null,
  }));
  const fixed = { id: "summary", dataset: {}, cells: [{ textContent: "" }], querySelector: () => ({}) };
  rows.splice(4, 0, fixed);
  const sorted = sortTableRows(rows, 0, "asc");
  assert.equal(sorted.length, 251);
  assert.equal(sorted[0].id, 249);
  assert.equal(sorted[249].id, 0);
  assert.equal(sorted.at(-1), fixed);
});

test("table sorting is installed globally and routes virtual rows through the complete row set", () => {
  const source = readFileSync("src/app.js", "utf8");
  const config = readFileSync("scripts/build-config.js", "utf8");
  const sorter = readFileSync("src/ui/table-sorter.js", "utf8");
  assert.match(source, /installTableSorter\(document\)/);
  assert.match(config, /"src\/ui\/table-sorter\.js"/);
  assert.match(sorter, /sortVirtualTable\(body,/);
  assert.match(sorter, /virtualTableRows\(body\)/);
  assert.match(sorter, /event\.key !== "Enter" && event\.key !== " "/);
});
