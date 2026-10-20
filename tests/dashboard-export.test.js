import test from "node:test";
import assert from "node:assert/strict";
import { drawDashboardExportChart } from "../src/ui/dashboard-export.js";

function makeContext() {
  const calls = [];
  return {
    calls,
    measureText: (value) => ({ width: String(value).length * 6 }),
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    strokeRect: (...args) => calls.push(["strokeRect", ...args]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: () => calls.push(["stroke"]),
    arc: (...args) => calls.push(["arc", ...args]),
    fill: () => calls.push(["fill"]),
  };
}

const colors = {
  text: "#edf6f7",
  muted: "#a9b9bd",
  grid: "#34464b",
  axis: "#a9b9bd",
  positive: "#43b7c3",
  negative: "#ff8b92",
  blue: "#75d1d9",
};

test("Dashboard PNG renderer draws full line datasets, legends, summary and labels", () => {
  const context = makeContext();
  drawDashboardExportChart(context, {
    type: "line",
    title: "Добавленные и отсутствующие устройства",
    labels: ["Final 1", "Final 2"],
    datasets: [
      { label: "Добавлено", tone: "positive", values: [0, 3] },
      { label: "Отсутствовало", tone: "negative", values: [0, -2] },
    ],
    summary: "Было 10, стало 12 (+20.0%)",
  }, 80, 300, 900, 405, colors);
  const text = context.calls.filter(([name]) => name === "fillText").map(([, value]) => value);
  assert.ok(text.includes("Добавленные и отсутствующие устройства"));
  assert.ok(text.includes("Добавлено"));
  assert.ok(text.includes("Отсутствовало"));
  assert.ok(text.includes("Было 10, стало 12 (+20.0%)"));
  assert.ok(text.includes("Final 1"));
  assert.equal(context.calls.filter(([name]) => name === "arc").length, 4);
  assert.ok(context.calls.filter(([name]) => name === "lineTo").length >= 7);
  assert.deepEqual(context.calls.at(-1), ["restore"]);
});

test("Dashboard PNG renderer keeps temporal and weekly charts as full bar series", () => {
  const context = makeContext();
  drawDashboardExportChart(context, {
    type: "bar",
    title: "Динамика изменения MAC-адресов по неделям",
    items: [{ label: "05.10–11.10.2026", value: 7 }, { label: "12.10–18.10.2026", value: 5 }],
  }, 80, 300, 900, 405, colors);
  assert.equal(context.calls.filter(([name]) => name === "fillRect").length, 2);
  assert.ok(context.calls.some(([name, value]) => name === "fillText" && value === "05.10–11.10.2026"));
  assert.deepEqual(context.calls.at(-1), ["restore"]);
});

test("Dashboard PNG renderer draws large compact MAC-churn rows without spreading the full value set", () => {
  const count = 100_000;
  const items = Array.from({ length: count }, (_, index) => ({ mac: `00:00:00:${String(index).padStart(6, "0")}`, transitions: index % 9 + 1 }));
  let bars = 0;
  const context = {
    measureText: (value) => ({ width: String(value).length * 6 }),
    save() {}, restore() {}, fillText() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect() { bars += 1; },
  };
  assert.doesNotThrow(() => drawDashboardExportChart(context, {
    type: "bar",
    title: "Исчезающие и возвращающиеся MAC",
    items,
    itemLabel: (item) => item.mac,
    itemValue: (item) => item.transitions,
  }, 80, 300, 900, 300, colors));
  assert.equal(bars, count, "each MAC is drawn once without a copied value array");
});
