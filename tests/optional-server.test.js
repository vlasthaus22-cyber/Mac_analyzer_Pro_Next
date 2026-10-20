import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("optional local host serves only the portable HTML and a loopback health endpoint", async () => {
  const [server, launcher, dataDocs] = await Promise.all([
    read("server.py"),
    read("scripts/optional_server_launcher.py"),
    read("docs/DATA_STORAGE.md"),
  ]);
  assert.match(server, /ThreadingHTTPServer\(\("127\.0\.0\.1", args\.port\)/);
  assert.match(server, /route == "\/api\/health"/);
  assert.match(server, /"storage": "browser-indexeddb"/);
  assert.match(server, /route not in \{"\/", f"\/\{APP_FILENAME\}"\}/);
  assert.match(server, /do_POST = _method_not_allowed/);
  assert.doesNotMatch(server, /Access-Control-Allow-Origin|sqlite3|device_upload/i);
  assert.match(launcher, /health_is_ours\(port\)/);
  assert.match(launcher, /wait_for_health\(port, process\)/);
  assert.ok(launcher.indexOf("if not wait_for_health(port, process):") < launcher.lastIndexOf("webbrowser.open(url"));
  assert.match(launcher, /local-server-port\.txt/);
  assert.match(launcher, /No alternate port was selected to avoid changing the browser database origin/);
  assert.match(dataDocs, /Опциональный HTTP-host/);
  assert.match(dataDocs, /не предоставляет SQLite API/);
});

test("the existing no-Python file launcher remains the default and optional server files enter release ZIP", async () => {
  const [fileLauncher, serverLauncher, archiveBuilder, archiveChecker] = await Promise.all([
    read("START_MAC_ANALYZER.cmd"),
    read("START_MAC_ANALYZER_SERVER.cmd"),
    read("scripts/build-release-archive.mjs"),
    read("scripts/check-release-archive.mjs"),
  ]);
  assert.match(fileLauncher, /start "" "%APP_HTML%"/);
  assert.doesNotMatch(fileLauncher, /python|server\.py/i);
  assert.match(serverLauncher, /optional_server_launcher\.py/);
  assert.match(serverLauncher, /Use START_MAC_ANALYZER\.cmd for the autonomous file mode/);
  for (const required of ["server.py", "START_MAC_ANALYZER_SERVER.cmd"]) {
    const escaped = required.replaceAll(".", "\\.");
    assert.match(archiveBuilder, new RegExp(`"${escaped}"`));
    assert.match(archiveChecker, new RegExp(`"${escaped}"`));
  }
  assert.match(archiveBuilder, /"__pycache__"/);
  assert.match(archiveBuilder, /"\.pyc"/);
  assert.match(archiveChecker, /__pycache__/);
  assert.match(archiveChecker, /pyc\|pyo/);
});
