import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("optional local host serves portable HTML, bounded device APIs, diagnostics, and backups", async () => {
  const [server, launcher, storagePaths, sqliteStore, backupStore, diagnostics, dataDocs, legacyMigration] = await Promise.all([
    read("server.py"),
    read("scripts/optional_server_launcher.py"),
    read("backend/services/system/storage_paths.py"),
    read("backend/services/system/sqlite_store.py"),
    read("backend/services/system/backup_store.py"),
    read("backend/services/system/diagnostics_service.py"),
    read("docs/DATA_STORAGE.md"),
    read("backend/services/system/legacy_migration_service.py"),
  ]);
  assert.match(server, /ThreadingHTTPServer\(\("127\.0\.0\.1", args\.port\)/);
  assert.match(server, /route == "\/api\/health"/);
  assert.match(server, /route == "\/api\/storage\/structure"/);
  assert.match(server, /route == "\/api\/database\/summary"/);
  assert.match(server, /route == "\/api\/system\/diagnostics"/);
  assert.match(server, /run_optional_host_diagnostics\(/);
  assert.match(diagnostics, /PRAGMA quick_check/);
  assert.match(diagnostics, /mode=ro/);
  assert.match(diagnostics, /REQUIRED_TABLES/);
  assert.match(diagnostics, /REQUIRED_OPTIONAL_HOST_FILES/);
  assert.match(diagnostics, /host-backend-files/);
  assert.match(diagnostics, /HTTPConnection\("127\.0\.0\.1", port/);
  assert.match(diagnostics, /MAX_DIAGNOSTIC_API_RESPONSE_BYTES = 1024 \* 1024/);
  assert.match(diagnostics, /host-api-health/);
  assert.match(diagnostics, /host-api-storage/);
  assert.match(diagnostics, /host-api-database/);
  assert.match(server, /route == "\/api\/database\/export"/);
  assert.match(server, /backup_sqlite_database\(database_path, backup_directory\)/);
  assert.match(server, /source\.read\(64 \* 1024\)/);
  assert.match(server, /route == "\/api\/settings"/);
  assert.match(server, /route == "\/api\/devices"/);
  assert.match(server, /route == "\/api\/history"/);
  assert.match(server, /route == "\/api\/snapshots"/);
  assert.match(server, /snapshot_upload_id is not None/);
  assert.match(server, /MAX_SNAPSHOT_UPLOAD_BYTES = 256 \* 1024 \* 1024/);
  assert.match(server, /route not in \{"\/api\/settings", "\/api\/devices", "\/api\/history", "\/api\/database\/restore"\} and snapshot_upload_id is None/);
  assert.match(server, /route in \{"\/api\/backup\/export", "\/api\/backup\/restore"\}/);
  assert.match(server, /length > MAX_SETTINGS_BODY_BYTES/);
  assert.match(server, /initialize_system_storage\(args\.root\.resolve\(\)\)/);
  assert.match(legacyMigration, /initialize_storage\(root\)/);
  assert.match(legacyMigration, /initialize_database\(database_path, backup_path\)/);
  assert.match(sqliteStore, /CREATE TABLE IF NOT EXISTS device_inventory/);
  assert.match(sqliteStore, /def _backfill_inventory/);
  assert.match(sqliteStore, /def _backfill_resolved_inventory/);
  assert.match(sqliteStore, /def save_resolved_history/);
  assert.match(sqliteStore, /def list_resolved_history/);
  assert.match(sqliteStore, /def list_snapshots/);
  assert.match(sqliteStore, /def list_snapshot_devices/);
  assert.match(sqliteStore, /def save_snapshot_stream/);
  assert.match(backupStore, /def export_app_backup/);
  assert.match(backupStore, /def restore_app_backup/);
  assert.match(backupStore, /validate=True/);
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
  assert.match(launcher, /wait_for_health\(port, process, timeout=20\.0\)/);
  assert.ok(launcher.indexOf("if not wait_for_health(port, process, timeout=20.0):") < launcher.lastIndexOf("webbrowser.open(url"));
  assert.match(launcher, /local-server-port\.txt/);
  assert.match(launcher, /No alternate port was selected to avoid changing the browser database origin/);
  assert.match(dataDocs, /Опциональный HTTP-host/);
  assert.match(dataDocs, /совместимая схема из 23 таблиц/);
  assert.match(dataDocs, /`GET \/api\/database\/export`/);
  assert.match(dataDocs, /`GET \/api\/system\/diagnostics`/);
  assert.match(dataDocs, /read-only/);
  assert.match(dataDocs, /не\s+загружает весь файл в память/);
  assert.match(dataDocs, /Скачанный `\.db` можно выбрать в приложении/);
  assert.match(dataDocs, /без удаления существующих записей/);
  assert.match(dataDocs, /`POST \/api\/backup\/export`/);
  assert.match(dataDocs, /`POST \/api\/backup\/restore`/);
  assert.match(dataDocs, /`GET \/api\/devices\?after=…&limit=…`/);
  assert.match(dataDocs, /`PUT \/api\/history`/);
  assert.match(dataDocs, /`PUT \/api\/snapshots\/\{id\}`/);
  assert.match(dataDocs, /не заменяется/);
  assert.match(dataDocs, /автоматической общей синхронизации IndexedDB и SQLite нет/);
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
  const [server, launcher, archiveChecker] = await Promise.all([
    read("server.py"),
    read("scripts/optional_server_launcher.py"),
    read("scripts/check-release-archive.mjs"),
  ]);
  const engineeringService = await read("backend/services/system/engineering_service.py");
  assert.match(server, /authorize_loopback_shutdown\(self\.client_address\[0\], supplied_token, expected_token\)/);
  assert.match(engineeringService, /hmac\.compare_digest/);
  assert.match(engineeringService, /remote_address != "127\.0\.0\.1"/);
  assert.match(server, /route != "\/api\/shutdown"/);
  assert.match(launcher, /secrets\.token_urlsafe\(32\)/);
  assert.match(launcher, /local-server-stop-token\.txt/);
  assert.match(launcher, /POST/);
  assert.match(launcher, /stop_server\(state_path\)/);
  assert.match(archiveChecker, /scripts\/optional_diagnostics\.py/);
  assert.match(archiveChecker, /tests\/test_optional_diagnostics\.py/);
  assert.ok(launcher.indexOf("if args.stop:") < launcher.indexOf("if not app_file.is_file():"));
});
