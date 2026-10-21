import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createZip, crc32, readZipEntries, sha256 } from "../scripts/release-archive.js";

test("release ZIP builder writes deterministic UTF-8 entries with valid CRC and SHA-256", () => {
  const entries = [
    { name: "MAC-Analyzer-Pro-Next/README.md", data: Buffer.from("offline package", "utf8") },
    { name: "MAC-Analyzer-Pro-Next/документация.md", data: Buffer.from("проверка", "utf8") },
  ];
  const first = createZip(entries);
  const second = createZip(entries);
  assert.deepEqual(first, second);
  const decoded = readZipEntries(first);
  assert.equal(decoded.get(entries[0].name).toString("utf8"), "offline package");
  assert.equal(decoded.get(entries[1].name).toString("utf8"), "проверка");
  assert.equal(crc32(decoded.get(entries[0].name)), crc32(entries[0].data));
  assert.match(sha256(first), /^[a-f0-9]{64}$/);
});

test("release ZIP builder and verifier reject traversal and corrupted payloads", () => {
  assert.throws(() => createZip([{ name: "MAC-Analyzer-Pro-Next/../outside.txt", data: "unsafe" }]), /Unsafe release ZIP path/);
  const zip = createZip([{ name: "MAC-Analyzer-Pro-Next/file.txt", data: "payload" }]);
  const corrupt = Buffer.from(zip);
  const nameLength = corrupt.readUInt16LE(26);
  const contentOffset = 30 + nameLength;
  corrupt[contentOffset] ^= 0xff;
  assert.throws(() => readZipEntries(corrupt), /CRC mismatch/);
});

test("release archive requires the runner for Python integration tests", () => {
  const checker = readFileSync("scripts/check-release-archive.mjs", "utf8");
  assert.match(checker, /scripts\/run-python-tests\.mjs/);
});
