import test from "node:test";
import assert from "node:assert/strict";
import { bindSourceFileDrop } from "../src/ui/file-drop.js";

function targetMock() {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset: {},
    classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, { types = ["Files"], files = [], dropEffect = "none" } = {}) {
      let prevented = false;
      const dataTransfer = { types, files, dropEffect };
      listeners.get(type)?.({ dataTransfer, preventDefault() { prevented = true; } });
      return { prevented, dropEffect: dataTransfer.dropEffect };
    },
  };
}

test("source file drop accepts one supported file and clears the drag highlight", () => {
  const target = targetMock();
  const status = { textContent: "Не выбран" };
  const selected = [];
  assert.equal(bindSourceFileDrop(target, status, (file) => selected.push(file)), true);
  assert.equal(target.dispatch("dragenter").prevented, true);
  assert.equal(target.classList.contains("file-drop-active"), true);
  assert.equal(target.dispatch("dragover").dropEffect, "copy");
  const file = { name: "Main.XLSX" };
  const result = target.dispatch("drop", { files: [file] });
  assert.equal(result.prevented, true);
  assert.deepEqual(selected, [file]);
  assert.equal(target.classList.contains("file-drop-active"), false);
  assert.equal(status.textContent, "Не выбран");
});

test("source file drop leaves non-file drags untouched and rejects multiple or unsupported files", () => {
  const target = targetMock();
  const status = { textContent: "Не выбран" };
  const selected = [];
  bindSourceFileDrop(target, status, (file) => selected.push(file));
  assert.equal(target.dispatch("dragover", { types: ["text/plain"] }).prevented, false);
  assert.equal(target.dispatch("drop", { types: ["text/plain"], files: [{ name: "notes.txt" }] }).prevented, false);
  target.dispatch("drop", { files: [{ name: "main.csv" }, { name: "room.xlsx" }] });
  assert.match(status.textContent, /один файл/);
  target.dispatch("drop", { files: [{ name: "main.exe" }] });
  assert.match(status.textContent, /не поддерживается/);
  assert.deepEqual(selected, []);
});

test("source drag highlight clears only after leaving nested card content", () => {
  const target = targetMock();
  bindSourceFileDrop(target, null, () => {});
  target.dispatch("dragenter");
  target.dispatch("dragenter");
  target.dispatch("dragleave");
  assert.equal(target.classList.contains("file-drop-active"), true);
  target.dispatch("dragleave");
  assert.equal(target.classList.contains("file-drop-active"), false);
});

test("source file drop binds once per card", () => {
  const target = targetMock();
  assert.equal(bindSourceFileDrop(target, null, () => {}), true);
  assert.equal(bindSourceFileDrop(target, null, () => {}), false);
});
