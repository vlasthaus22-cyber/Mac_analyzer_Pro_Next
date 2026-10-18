import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dataDirectoryControlState } from "../src/ui/data-directory-controls.js";

test("application wires the tested data-directory control state to both header buttons", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /import \{ dataDirectoryControlState \} from "\.\/ui\/data-directory-controls\.js"/);
  assert.match(app, /const controls = dataDirectoryControlState\(\{/);
  assert.match(app, /permissionButton\.hidden = controls\.reauthorize\.hidden/);
  assert.match(app, /permissionButton\.textContent = controls\.reauthorize\.text/);
  assert.match(app, /reauthorizeDirectoryHandle\(state\.dataDirectoryHandle,\s*\{/);
  assert.match(app, /\$\("#dataDirectoryButton"\)\.addEventListener\("click", \(\) => reauthorizeDataDirectory\(\)\.catch\(showError\)\)/);
});

test("lost directory permission leaves a single direct reauthorization action", () => {
  const controls = dataDirectoryControlState({
    supported: true,
    permission: "prompt",
    handle: { name: "MAC data" },
  });
  assert.equal(controls.picker.hidden, true);
  assert.equal(controls.reauthorize.hidden, false);
  assert.equal(controls.reauthorize.text, "Повторно разрешить папку");
  assert.match(controls.status, /Браузер сбросил разрешение/);
});

test("write failure offers a replacement folder even if permission still reports granted", () => {
  const controls = dataDirectoryControlState({
    supported: true,
    permission: "granted",
    handle: { name: "Read only" },
    writeFailed: true,
    issue: "Запись архива не выполнена: disk full. Выберите другую папку.",
  });
  assert.equal(controls.picker.hidden, true);
  assert.equal(controls.reauthorize.hidden, false);
  assert.equal(controls.reauthorize.text, "Выбрать другую папку");
  assert.match(controls.status, /disk full/);
});

test("a healthy directory hides reauthorization and leaves folder switching available", () => {
  const controls = dataDirectoryControlState({
    supported: true,
    permission: "granted",
    handle: { name: "MAC data" },
  });
  assert.equal(controls.picker.hidden, false);
  assert.equal(controls.picker.text, "Сменить папку");
  assert.equal(controls.reauthorize.hidden, true);
  assert.match(controls.status, /MAC data/);
});

test("a stale directory handle cannot expose actions when File System Access is unsupported", () => {
  const controls = dataDirectoryControlState({
    supported: false,
    permission: "unavailable",
    handle: { name: "Previously connected folder" },
  });
  assert.equal(controls.picker.hidden, true);
  assert.equal(controls.picker.disabled, true);
  assert.equal(controls.reauthorize.hidden, true);
  assert.match(controls.status, /используйте portable archive/);
});
