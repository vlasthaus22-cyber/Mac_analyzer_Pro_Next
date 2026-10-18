import test from "node:test";
import assert from "node:assert/strict";
import { selectContextTableRow } from "../src/ui/table-context-selection.js";

function rowStub() {
  const classes = new Set();
  const attributes = new Map();
  return {
    classes,
    attributes,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

test("context selection is visible, accessible, and limited to one row per table", () => {
  const previous = rowStub();
  const next = rowStub();
  const otherTableRow = rowStub();
  const rows = [previous, next];
  const table = { querySelectorAll: () => rows };
  for (const row of rows) row.closest = (selector) => selector === "table" ? table : null;
  otherTableRow.closest = () => ({ querySelectorAll: () => [otherTableRow] });

  assert.equal(selectContextTableRow(previous), true);
  assert.equal(selectContextTableRow(next), true);
  assert.equal(previous.classes.has("context-row-selected"), false);
  assert.equal(previous.attributes.get("aria-selected"), "false");
  assert.equal(next.classes.has("context-row-selected"), true);
  assert.equal(next.attributes.get("aria-selected"), "true");
  assert.equal(selectContextTableRow(otherTableRow), true);
  assert.equal(next.classes.has("context-row-selected"), true, "selection in another table stays independent");
  assert.equal(selectContextTableRow({ closest: () => null }), false);
});
