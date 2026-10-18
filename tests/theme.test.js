import test from "node:test";
import assert from "node:assert/strict";
import { isThemeChoice, legacyThemeChoice, resolveThemeChoice, THEME_CHOICES } from "../src/core/theme.js";

test("theme restoration prefers the database, then the local preference, then the system", () => {
  assert.equal(resolveThemeChoice("dark", "light", false), "dark");
  assert.equal(resolveThemeChoice("invalid", "dark", false), "dark");
  assert.equal(resolveThemeChoice("invalid", "invalid", true), "dark");
  assert.equal(resolveThemeChoice("", "", false), "light");
});

test("theme choices are limited to the supported light and dark modes", () => {
  assert.deepEqual(THEME_CHOICES, ["light", "dark"]);
  assert.equal(isThemeChoice("light"), true);
  assert.equal(isThemeChoice("dark"), true);
  assert.equal(isThemeChoice("system"), false);
});

test("legacy SQLite theme values decode JSON and reject unsupported choices", () => {
  assert.equal(legacyThemeChoice('"dark"'), "dark");
  assert.equal(legacyThemeChoice("light"), "light");
  assert.equal(legacyThemeChoice('"system"'), "");
  assert.equal(legacyThemeChoice("not-json"), "");
  assert.equal(legacyThemeChoice(null), "");
});
