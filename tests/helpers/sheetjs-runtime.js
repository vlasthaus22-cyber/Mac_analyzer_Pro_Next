import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Buffer } from "node:buffer";

const sheetJsModule = { exports: {} };
runInNewContext(readFileSync(new globalThis.URL("../../vendor/xlsx.full.min.js", import.meta.url), "utf8"), {
  module: sheetJsModule,
  exports: sheetJsModule.exports,
  Buffer,
  process: globalThis.process,
  console: globalThis.console,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  ArrayBuffer,
  DataView,
  Date,
  Math,
  JSON,
  Object,
  Number,
  String,
  Boolean,
  RegExp,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Error,
  TypeError,
  RangeError,
  Promise,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
});

export const sheetJs = sheetJsModule.exports;

export function legacyXlsFile(name = "legacy-devices.xls") {
  const bytes = readFileSync(new globalThis.URL("../fixtures/legacy-devices.xls", import.meta.url));
  return Object.assign(new globalThis.Blob([bytes]), { name, lastModified: Date.UTC(2026, 9, 15) });
}
