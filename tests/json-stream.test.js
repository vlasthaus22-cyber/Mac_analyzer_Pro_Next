import test from "node:test";
import assert from "node:assert/strict";
import { streamJsonArray, writePrettyJson } from "../src/core/json-stream.js";

test("pretty JSON writer preserves nested data and emits bounded awaited chunks", async () => {
  const value = {
    title: "Устройства 📡",
    omitted: undefined,
    createdAt: new Date("2026-10-16T12:00:00.000Z"),
    devices: Array.from({ length: 73 }, (_, index) => ({
      id: `device-${index}`,
      mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
      details: { model: `Модель ${index}`, tags: ["Main", undefined, "📡"] },
    })),
  };
  const chunks = [];
  const order = [];
  await writePrettyJson(value, {
    async write(chunk) {
      order.push("start");
      await Promise.resolve();
      chunks.push(chunk);
      order.push("complete");
    },
  }, { chunkChars: 97 });
  const json = chunks.join("");
  const parsed = JSON.parse(json);
  assert.equal(parsed.title, value.title);
  assert.equal(parsed.createdAt, value.createdAt.toISOString());
  assert.equal("omitted" in parsed, false);
  assert.equal(parsed.devices.length, 73);
  assert.deepEqual(parsed.devices.at(-1), {
    id: "device-72",
    mac: "00:11:22:33:00:72",
    details: { model: "Модель 72", tags: ["Main", null, "📡"] },
  });
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 97));
  assert.deepEqual(order, chunks.flatMap(() => ["start", "complete"]));
});

test("pretty JSON writer rejects cycles and propagates write failures", async () => {
  const cyclic = { id: "cycle" };
  cyclic.self = cyclic;
  await assert.rejects(writePrettyJson(cyclic, { write: async () => {} }), /Циклические ссылки/);
  await assert.rejects(writePrettyJson({ id: "device" }, { write: async () => { throw new Error("disk full"); } }), /disk full/);
});

test("pretty JSON writer consumes sync and async array iterables incrementally", async () => {
  let visited = 0;
  async function* rows() {
    for (let index = 0; index < 75; index += 1) {
      visited += 1;
      yield { index, value: `Строка ${index}` };
    }
  }
  const chunks = [];
  await writePrettyJson({ asyncRows: streamJsonArray(rows()), syncRows: streamJsonArray([1, 2, 3]) }, {
    write: async (chunk) => chunks.push(chunk),
  }, { chunkChars: 80 });
  const parsed = JSON.parse(chunks.join(""));
  assert.equal(visited, 75);
  assert.equal(parsed.asyncRows.length, 75);
  assert.deepEqual(parsed.asyncRows.at(-1), { index: 74, value: "Строка 74" });
  assert.deepEqual(parsed.syncRows, [1, 2, 3]);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.throws(() => streamJsonArray(null), /итерируемым/);
});
