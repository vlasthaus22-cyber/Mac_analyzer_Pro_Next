import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindErrorBannerDismiss, dismissErrorBanner, showErrorBanner } from "../src/ui/error-banner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("error banner hidden state overrides its flex layout and the close action clears it", async () => {
  const [html, css, app] = await Promise.all([read("index.html"), read("styles.css"), read("src/app.js")]);
  assert.match(html, /id="errorBanner"[^>]*role="alert"[^>]*hidden/);
  assert.match(html, /data-error-dismiss aria-label="Закрыть сообщение об ошибке"/);
  assert.match(css, /\.error-banner\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(app, /function clearError\(\)\s*\{\s*dismissErrorBanner\(\$\("#errorBanner"\)\);/);
  assert.match(app, /showErrorBanner\(banner, error instanceof Error \? error\.message : String\(error\)\)/);
  assert.match(app, /bindErrorBannerDismiss\(\$\("#errorBanner"\)\)/);
});

test("the close button click dismisses the current message and cannot trigger its parent action", () => {
  const message = { textContent: "Ошибка импорта" };
  let clickHandler;
  const closeButton = { addEventListener: (type, handler) => { if (type === "click") clickHandler = handler; } };
  const banner = {
    hidden: false,
    querySelector: (selector) => selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null,
  };
  assert.equal(bindErrorBannerDismiss(banner), true);
  let prevented = false;
  let stopped = false;
  clickHandler({ preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(banner.hidden, true);
  assert.equal(message.textContent, "");
});

test("error banner show and dismiss helpers update visibility and message", () => {
  const message = { textContent: "" };
  const banner = { hidden: true, querySelector: (selector) => selector === "span" ? message : null };
  assert.equal(showErrorBanner(banner, "Ошибка импорта"), true);
  assert.equal(banner.hidden, false);
  assert.equal(message.textContent, "Ошибка импорта");
  assert.equal(dismissErrorBanner(banner), true);
  assert.equal(banner.hidden, true);
  assert.equal(message.textContent, "");
});
