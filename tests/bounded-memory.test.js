import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

test("application IndexedDB getAll queries stay exact-key limited to two rows", () => {
  const calls = sourceFiles(path.resolve("src")).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/([\w.$]+)\.getAll\(([^)]*)\)/g)].map((match) => ({ file, receiver: match[1], args: match[2] }));
  });
  assert.ok(calls.length > 0, "the source audit should review every remaining getAll call");
  for (const call of calls) {
    assert.match(call.receiver, /^(?:index|byMac|byAlternateMac)$/, `${call.file}: getAll must use an exact-key index`);
    const args = call.args.split(",").map((argument) => argument.trim());
    assert.equal(args.length, 2, `${call.file}: getAll must specify both an exact key and a result limit`);
    assert.match(args[1], /^\d+$/);
    assert.ok(Number(args[1]) <= 2, `${call.file}: getAll exceeded the bounded candidate lookup size`);
  }
});
