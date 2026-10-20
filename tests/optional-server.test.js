import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("optional local host serves portable HTML plus loopback-only diagnostics and settings", async () => {
  const [server, launcher, storagePaths, sqliteStore, dataDocs] = await Promise.all([
    read("server.py"),
    read("scripts/optional_server_launcher.py"),
    read("scripts/optional_storage_paths.py"),
    read("scripts/optional_sqlite_store.py"),
    read("docs/DATA_STORAGE.md"),
  ]);
  assert.match(server, /ThreadingHTTPServer\(\("127\.0\.0\.1", args\.port\)/);
  assert.match(server, /route == "\/api\/health"/);
  assert.match(server, /route == "\/api\/storage\/structure"/);
  assert.match(server, /route == "\/api\/database\/summary"/);
  assert.match(server, /route == "\/api\/settings"/);
  assert.match(server, /length > MAX_SETTINGS_BODY_BYTES/);
  assert.match(server, /initialize_storage\(args\.root\.resolve\(\)\)/);
  assert.match(server, /initialize_database\(database_path\)/);
  assert.match(sqliteStore, /CREATE TABLE IF NOT EXISTS device_inventory/);
  assert.match(sqliteStore, /def _backfill_inventory/);
  assert.match(sqliteStore, /def _backfill_resolved_inventory/);
  assert.match(storagePaths, /def migrate_known_root_files/);
  assert.match(storagePaths, /if destination\.exists\(\):/);
  assert.match(server, /"storage": "browser-indexeddb"/);
  assert.match(server, /route not in \{"\/", f"\/\{APP_FILENAME\}"\}/);
  assert.match(server, /def do_POST\(self\)/);
  assert.match(server, /route != "\/api\/shutdown"/);
  assert.match(server, /HTTPStatus\.FORBIDDEN/);
  assert.doesNotMatch(server, /Access-Control-Allow-Origin|device_upload/i);
  assert.doesNotMatch(server, /\/api\/database\/import/i);
  assert.match(launcher, /health_is_ours\(port\)/);
  assert.match(launcher, /wait_for_health\(port, process\)/);
  assert.ok(launcher.indexOf("if not wait_for_health(port, process):") < launcher.lastIndexOf("webbrowser.open(url"));
  assert.match(launcher, /local-server-port\.txt/);
  assert.match(launcher, /No alternate port was selected to avoid changing the browser database origin/);
  assert.match(dataDocs, /Опциональный HTTP-host/);
  assert.match(dataDocs, /совместимая схема из 22 таблиц/);
  assert.match(dataDocs, /импорта\/записи device records/);
});

test("the existing no-Python file launcher remains the default and optional server files enter release ZIP", async () => {
  const [fileLauncher, serverLauncher, stopLauncher, archiveBuilder, archiveChecker] = await Promise.all([
    read("START_MAC_ANALYZER.cmd"),
    read("START_MAC_ANALYZER_SERVER.cmd"),
    read("STOP_MAC_ANALYZER_SERVER.cmd"),
    read("scripts/build-release-archive.mjs"),
    read("scripts/check-release-archive.mjs"),
  ]);
  assert.match(fileLauncher, /start "" "%APP_HTML%"/);
  assert.doesNotMatch(fileLauncher, /python|server\.py/i);
  assert.match(serverLauncher, /optional_server_launcher\.py/);
  assert.match(stopLauncher, /optional_server_launcher\.py.*--root/s);
  assert.match(stopLauncher, /--stop/);
  assert.match(serverLauncher, /Use START_MAC_ANALYZER\.cmd for the autonomous file mode/);
  for (const required of ["server.py", "START_MAC_ANALYZER_SERVER.cmd", "STOP_MAC_ANALYZER_SERVER.cmd"]) {
    const escaped = required.replaceAll(".", "\\.");
    assert.match(archiveBuilder, new RegExp(`"${escaped}"`));
    assert.match(archiveChecker, new RegExp(`"${escaped}"`));
  }
  assert.match(archiveBuilder, /"__pycache__"/);
  assert.match(archiveBuilder, /"\.pyc"/);
  assert.match(archiveChecker, /__pycache__/);
  assert.match(archiveChecker, /pyc\|pyo/);
  assert.match(archiveBuilder, /"scripts"/);
  assert.match(archiveBuilder, /"tests"/);
  assert.match(archiveChecker, /scripts\/optional_sqlite_store\.py/);
  assert.match(archiveChecker, /tests\/test_optional_sqlite_store\.py/);
});

test("the optional host protects shutdown with the per-launch bearer token", async () => {
  const [server, launcher] = await Promise.all([
    read("server.py"),
    read("scripts/optional_server_launcher.py"),
  ]);
  assert.match(server, /hmac\.compare_digest/);
  assert.match(server, /self\.client_address\[0\] != "127\.0\.0\.1"/);
  assert.match(server, /route != "\/api\/shutdown"/);
  assert.match(launcher, /secrets\.token_urlsafe\(32\)/);
  assert.match(launcher, /local-server-stop-token\.txt/);
  assert.match(launcher, /POST/);
  assert.match(launcher, /stop_server\(state_path\)/);
  assert.ok(launcher.indexOf("if args.stop:") < launcher.indexOf("if not app_file.is_file():"));
});
