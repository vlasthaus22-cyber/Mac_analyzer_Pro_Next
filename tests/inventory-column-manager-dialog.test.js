import test from "node:test";
import assert from "node:assert/strict";
import { openInventoryColumnManagerDialog } from "../src/ui/inventory-column-manager-dialog.js";

test("opening the Inventory column manager presents one modal and focuses its first control", () => {
  let openCount = 0;
  let focusCount = 0;
  let expanded = "false";
  const dialog = {
    open: false,
    showModal() { openCount += 1; this.open = true; },
  };
  const focusTarget = { focus() { focusCount += 1; } };
  const trigger = { setAttribute(name, value) { if (name === "aria-expanded") expanded = value; } };

  assert.equal(openInventoryColumnManagerDialog(dialog, focusTarget, trigger), true);
  assert.equal(openInventoryColumnManagerDialog(dialog, focusTarget, trigger), true);
  assert.equal(openCount, 1);
  assert.equal(focusCount, 2);
  assert.equal(expanded, "true");
});

test("the column manager opener safely rejects unavailable dialogs", () => {
  assert.equal(openInventoryColumnManagerDialog(null), false);
  assert.equal(openInventoryColumnManagerDialog({ open: false }), false);
});
