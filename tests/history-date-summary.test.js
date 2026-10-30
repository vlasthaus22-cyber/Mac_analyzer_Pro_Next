import test from "node:test";
import assert from "node:assert/strict";
import { historyDateSummaryHtml, openHistoryFromDateSummary } from "../src/ui/history-date-summary.js";

test("date history Top MAC provides a safe, accessible action for MAC history", () => {
  const html = historyDateSummaryHtml([], [
    { value: "aa:bb:cc:00:00:01", count: 4, data: { lastTimestamp: "2026-10-30T10:00:00Z" } },
    { value: "<script>alert(1)</script>", count: 1, data: { lastTimestamp: "<bad>" } },
  ]);

  assert.match(html, /<button class="link-button" type="button" data-open-history-mac="AABBCC000001" aria-label="Открыть историю MAC aa:bb:cc:00:00:01">aa:bb:cc:00:00:01<\/button>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("date history Top MAC action normalizes the address and opens its timeline", async () => {
  const calls = [];
  const macInput = { value: "" };
  const button = { dataset: { openHistoryMac: "aa:bb:cc:00:00:01" } };
  const handled = openHistoryFromDateSummary({ target: { closest: (selector) => selector === "[data-open-history-mac]" ? button : null } }, {
    activateHistory: () => calls.push("activate"),
    macInput,
    openHistory: () => calls.push("open"),
    onError: (error) => calls.push(error),
  });

  assert.equal(handled, true);
  assert.equal(macInput.value, "AABBCC000001");
  assert.deepEqual(calls, ["activate"]);
  await Promise.resolve();
  assert.deepEqual(calls, ["activate", "open"]);
});

test("invalid and unrelated date summary clicks do not open a MAC timeline", async () => {
  let opened = false;
  const options = { openHistory: () => { opened = true; } };
  assert.equal(openHistoryFromDateSummary({ target: { closest: () => null } }, options), false);
  assert.equal(openHistoryFromDateSummary({ target: { closest: () => ({ dataset: { openHistoryMac: "not a MAC" } }) } }, options), false);
  await Promise.resolve();
  assert.equal(opened, false);
});

test("date summary reports MAC history errors through the shared handler", async () => {
  const failure = new Error("timeline failed");
  let received;
  openHistoryFromDateSummary({ target: { closest: () => ({ dataset: { openHistoryMac: "AABBCC000001" } }) } }, {
    macInput: { value: "" },
    openHistory: () => { throw failure; },
    onError: (error) => { received = error; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(received, failure);
});
