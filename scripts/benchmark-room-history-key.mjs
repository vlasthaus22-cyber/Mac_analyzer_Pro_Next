import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { keyText, text } from "../src/core/normalize.js";
import { roomHistoryFallbackKey } from "../src/core/room-history.js";

const fields = ["businessUnit", "city", "site", "floor", "room", "address"];
const rows = Array.from({ length: 200 }, (_, index) => ({
  businessUnit: "Enterprise",
  city: index % 3 ? "Moscow" : "Санкт-Петербург",
  site: `Site ${index % 11}`,
  floor: index % 22,
  room: `Room ${index}`,
  address: "Main street",
}));
rows.push(
  { businessUnit: null, city: "Moscow", site: false, floor: 0, room: "  101 ", address: "Main St" },
  { businessUnit: "HQ", city: "Moscow", room: " " },
  { room: "101" },
  { city: "Moscow" },
);

function previousRoomHistoryFallbackKey(device = {}) {
  if (!text(device.room)) return "";
  return `fallback:${fields.map((field) => keyText(device[field])).join("|")}`;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const loops = positiveInteger(process.argv[2], 500_000, 5_000_000);
const rounds = positiveInteger(process.argv[3], 7, 31);
const warmups = 3;
for (const row of rows) {
  assert.equal(roomHistoryFallbackKey(row), previousRoomHistoryFallbackKey(row), "optimized key must preserve the previous normalized key");
}

function measure(operation) {
  let checksum = 0;
  const startedAt = performance.now();
  for (let index = 0; index < loops; index += 1) checksum += operation(rows[index % rows.length]).length;
  return { milliseconds: performance.now() - startedAt, checksum };
}

for (let index = 0; index < warmups; index += 1) {
  measure(previousRoomHistoryFallbackKey);
  measure(roomHistoryFallbackKey);
}

const previousTimes = [];
const optimizedTimes = [];
for (let round = 0; round < rounds; round += 1) {
  const previous = measure(round % 2 ? roomHistoryFallbackKey : previousRoomHistoryFallbackKey);
  const optimized = measure(round % 2 ? previousRoomHistoryFallbackKey : roomHistoryFallbackKey);
  const previousMs = round % 2 ? optimized.milliseconds : previous.milliseconds;
  const optimizedMs = round % 2 ? previous.milliseconds : optimized.milliseconds;
  assert.equal(previous.checksum, optimized.checksum);
  previousTimes.push(previousMs);
  optimizedTimes.push(optimizedMs);
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const previousMedianMs = median(previousTimes);
const optimizedMedianMs = median(optimizedTimes);
console.log(JSON.stringify({
  fixtureRows: rows.length,
  callsPerRound: loops,
  rounds,
  warmups,
  previousMedianMs: Number(previousMedianMs.toFixed(1)),
  optimizedMedianMs: Number(optimizedMedianMs.toFixed(1)),
  speedupPercent: Number(((previousMedianMs / optimizedMedianMs - 1) * 100).toFixed(1)),
  previousRoundsMs: previousTimes.map((value) => Number(value.toFixed(1))),
  optimizedRoundsMs: optimizedTimes.map((value) => Number(value.toFixed(1))),
}, null, 2));
