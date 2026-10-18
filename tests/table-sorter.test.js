import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareTableValues, installTableSorter, sortTable, sortTableRows } from "../src/ui/table-sorter.js";

function withSorterDom(callback) {
  const previous = {
    document: globalThis.document,
    CustomEvent: globalThis.CustomEvent,
    MutationObserver: globalThis.MutationObserver,
  };
  globalThis.document = {
    createDocumentFragment: () => ({ children: [], append(node) { this.children.push(node); } }),
    createElement: (tag) => ({ tagName: tag.toUpperCase(), classList: { add() {} }, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } }),
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; this.bubbles = options.bubbles; }
  };
  globalThis.MutationObserver = undefined;
  try { callback(); } finally {
    globalThis.document = previous.document;
    globalThis.CustomEvent = previous.CustomEvent;
    globalThis.MutationObserver = previous.MutationObserver;
  }
}

function createSortableTable({ remoteSort = false, sortField = "" } = {}) {
  const events = [];
  const table = {
    id: "inventoryTable",
    dataset: { remoteSort: remoteSort ? "true" : "false", sortDisabled: "false" },
    events,
    dispatchEvent(event) { events.push(event); },
    querySelectorAll() { return headers.filter((header) => header.attributes.has("aria-sort")); },
  };
  const makeHeader = (field = "") => {
    const header = {
      dataset: { sortDirection: "", sortField: field, sortDisabled: "false" },
      attributes: new Map(),
      parentElement: null,
      indicator: null,
      classList: { values: new Set(), add(value) { this.values.add(value); } },
      querySelector(selector) {
        if (selector === ".sort-indicator") return this.indicator;
        return selector.includes("input") && this.containsControl ? {} : null;
      },
      setAttribute(name, value) { this.attributes.set(name, value); },
      hasAttribute(name) { return this.attributes.has(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      append(node) { this.indicator = node; },
      closest(selector) { return selector === "table" ? table : null; },
    };
    header.setAttribute("aria-sort", "none");
    header.indicator = { textContent: "↕" };
    return header;
  };
  const headers = [makeHeader(sortField), makeHeader()];
  const headerRow = { children: headers };
  headers.forEach((header) => { header.parentElement = headerRow; });
  return { table, headers };
}

function sortableRow(value) {
  return { cells: [{ textContent: value, dataset: {} }], dataset: {}, querySelector: () => null };
}

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

test("local table sorting updates direction and stably reorders DOM rows with blanks last", () => {
  withSorterDom(() => {
    const { table, headers } = createSortableTable();
    const rows = [sortableRow("10"), sortableRow(""), sortableRow("2")];
    const body = { children: rows, append(fragment) { this.children = [...fragment.children]; } };
    table.tBodies = [body];
    assert.equal(sortTable(table, headers[0]), true);
    assert.deepEqual(body.children.map((row) => row.cells[0].textContent), ["2", "10", ""]);
    assert.equal(headers[0].dataset.sortDirection, "asc");
    assert.equal(headers[0].attributes.get("aria-sort"), "ascending");
    assert.equal(headers[0].indicator.textContent, "▲");
    assert.equal(sortTable(table, headers[0]), true);
    assert.deepEqual(body.children.map((row) => row.cells[0].textContent), ["10", "2", ""]);
    assert.equal(headers[0].attributes.get("aria-sort"), "descending");
    assert.equal(headers[0].indicator.textContent, "▼");
  });
});

test("remote table sorting dispatches field details and rejects unsupported headers", () => {
  withSorterDom(() => {
    const { table, headers } = createSortableTable({ remoteSort: true, sortField: "lastSeen" });
    assert.equal(sortTable(table, headers[0]), true);
    assert.deepEqual(table.events[0].detail, { field: "lastSeen", index: 0, direction: "asc" });
    assert.equal(sortTable({ ...table, id: "enhancedMovementTable" }, headers[0]), false);
    const controlled = headers[1];
    controlled.containsControl = true;
    assert.equal(sortTable(table, controlled), false);
    table.dataset.sortDisabled = "true";
    assert.equal(sortTable(table, headers[0]), false);
  });
});

test("global sorter decorates headers once and handles click, Enter, Space, and resize targets", () => {
  withSorterDom(() => {
    const { table, headers } = createSortableTable({ remoteSort: true, sortField: "mac" });
    const listeners = new Map();
    const scope = {
      documentElement: { dataset: {} },
      querySelectorAll: () => headers,
      addEventListener(type, listener) { listeners.set(type, listener); },
    };
    installTableSorter(scope);
    installTableSorter(scope);
    assert.equal(listeners.size, 2);
    assert.equal(scope.documentElement.dataset.tableSorter, "ready");
    assert.ok(headers[0].classList.values.has("sortable-column"));
    assert.equal(headers[0].getAttribute("role"), "button");
    assert.equal(headers[0].tabIndex, 0);
    assert.equal(headers[0].indicator.textContent, "↕");
    const target = { closest: (selector) => selector === "th" ? headers[0] : null };
    listeners.get("click")({ target });
    assert.equal(table.events.length, 1);
    let prevented = false;
    listeners.get("keydown")({ key: "Enter", target, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(table.events.length, 2);
    prevented = false;
    listeners.get("keydown")({ key: " ", target, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(table.events.length, 3);
    listeners.get("keydown")({ key: "ArrowDown", target, preventDefault() { throw new Error("unhandled keys must not be intercepted"); } });
    const resizeTarget = { closest: (selector) => selector === "th" ? headers[0] : selector === ".column-resize-handle" ? {} : null };
    listeners.get("click")({ target: resizeTarget });
    assert.equal(table.events.length, 3);
  });
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
