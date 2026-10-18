import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const launcher = await readFile(path.join(testDirectory, "../START_MAC_ANALYZER.cmd"), "utf8");
const packageBuilder = await readFile(path.join(testDirectory, "../scripts/build-release-archive.mjs"), "utf8");
const packageChecker = await readFile(path.join(testDirectory, "../scripts/check-release-archive.mjs"), "utf8");

test("Windows launcher opens the autonomous build through the default browser with quoted paths", () => {
  assert.match(launcher, /^@echo off\s+setlocal/m);
  assert.match(launcher, /set "APP_HTML=%~dp0dist\\MAC-Analyzer-Pro-Next\.html"/);
  assert.match(launcher, /if not exist "%APP_HTML%"/);
  assert.match(launcher, /start "" "%APP_HTML%"/);
  assert.doesNotMatch(launcher, /powershell|python(?:\.exe)?|server\.py|runas/i);
});

test("release archive packages and requires the Windows launcher", () => {
  assert.match(packageBuilder, /"START_MAC_ANALYZER\.cmd"/);
  assert.match(packageChecker, /"START_MAC_ANALYZER\.cmd"/);
});
