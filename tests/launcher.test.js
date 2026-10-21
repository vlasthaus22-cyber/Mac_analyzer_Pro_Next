import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const launcher = await readFile(path.join(testDirectory, "../START_MAC_ANALYZER.cmd"), "utf8");
const packageBuilder = await readFile(path.join(testDirectory, "../scripts/build-release-archive.mjs"), "utf8");
const packageChecker = await readFile(path.join(testDirectory, "../scripts/check-release-archive.mjs"), "utf8");
const serverLauncher = await readFile(path.join(testDirectory, "../START_MAC_ANALYZER_SERVER.cmd"), "utf8");
const serverStopper = await readFile(path.join(testDirectory, "../STOP_MAC_ANALYZER_SERVER.cmd"), "utf8");
const backendBuilder = await readFile(path.join(testDirectory, "../scripts/build-windows-backend.mjs"), "utf8");
const manifest = await readFile(path.join(testDirectory, "../packaging/mac-analyzer-as-invoker.manifest"), "utf8");

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

test("Windows launchers prefer the bundled asInvoker host and retain the standalone fallback", () => {
  assert.match(launcher, /if exist "%HOST_EXE%" goto use_packaged_host/);
  assert.match(launcher, /start "" \/wait "%HOST_EXE%" --root "%~dp0\."/);
  assert.match(launcher, /start "" "%APP_HTML%"/);
  assert.match(serverLauncher, /MAC-Analyzer-Pro-Next-Host\.exe" --root "%~dp0\."/);
  assert.match(serverStopper, /MAC-Analyzer-Pro-Next-Host\.exe" --root "%~dp0\." --stop/);
  assert.match(backendBuilder, /"--onefile", "--console"[\s\S]*?"--manifest", manifest/);
  assert.match(manifest, /requestedExecutionLevel level="asInvoker" uiAccess="false"/);
  assert.doesNotMatch(manifest, /requireAdministrator/);
  assert.match(packageBuilder, /MAC-Analyzer-Pro-Next-Host\.exe/);
  assert.match(packageChecker, /MAC-Analyzer-Pro-Next-Host\.exe/);
});
