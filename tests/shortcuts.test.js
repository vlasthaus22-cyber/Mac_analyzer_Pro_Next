import test from "node:test";
import assert from "node:assert/strict";
import { identifyShortcut, isShortcutAllowedWithoutEngineer } from "../src/core/shortcuts.js";

const keyEvent = (key, overrides = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...overrides });

test("reference global Ctrl and function-key shortcuts are recognized", () => {
  for (const key of ["o", "s", "e", "a", "h", "f"]) assert.equal(identifyShortcut(keyEvent(key, { ctrlKey: true })), `ctrl+${key}`);
  for (const key of ["F1", "F5", "F6", "F7", "F8", "F9"]) assert.equal(identifyShortcut(keyEvent(key)), key.toLowerCase());
  assert.equal(identifyShortcut(keyEvent("Escape")), "escape");
});

test("shortcuts leave native text editing keys alone and reject extra modifiers", () => {
  const input = { matches: (selector) => selector.includes("input") };
  assert.equal(identifyShortcut(keyEvent("a", { ctrlKey: true, target: input })), "");
  assert.equal(identifyShortcut(keyEvent("f", { ctrlKey: true, target: input })), "ctrl+f");
  assert.equal(identifyShortcut(keyEvent("c", { ctrlKey: true, shiftKey: true, target: input })), "ctrl+shift+c");
  assert.equal(identifyShortcut(keyEvent("o", { ctrlKey: true, shiftKey: true })), "");
  assert.equal(identifyShortcut(keyEvent("c", { ctrlKey: true, shiftKey: true, altKey: true })), "");
  assert.equal(identifyShortcut(keyEvent("o", { ctrlKey: true, altKey: true })), "");
  assert.equal(identifyShortcut(keyEvent("F2")), "");
});

test("public help, analytics, history, search, and cancel shortcuts work without engineer mode", () => {
  for (const shortcut of ["f1", "ctrl+a", "ctrl+h", "ctrl+f", "escape"]) {
    assert.equal(isShortcutAllowedWithoutEngineer(shortcut), true, `${shortcut} should be available to users`);
  }
  for (const shortcut of ["ctrl+o", "ctrl+s", "ctrl+e", "ctrl+shift+c", "f5", "f6", "f7", "f8", "f9", "unknown"]) {
    assert.equal(isShortcutAllowedWithoutEngineer(shortcut), false, `${shortcut} should require engineer mode`);
  }
});
