import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindErrorBannerDismiss, dismissErrorBanner, showErrorBanner } from "../src/ui/error-banner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

function createParent() {
  return {
    children: [],
    insertBefore(node, before) {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      const index = before ? this.children.indexOf(before) : -1;
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
      node.parentNode = this;
      this.children.forEach((child, childIndex) => { child.nextSibling = this.children[childIndex + 1] || null; });
    },
    prepend(node) { this.insertBefore(node, this.children[0] || null); },
  };
}

function createBanner(parent) {
  const message = { textContent: "" };
  const closeHandlers = [];
  const closeButton = { addEventListener: (type, handler) => { if (type === "click") closeHandlers.push(handler); } };
  const banner = {
    hidden: true,
    parentNode: null,
    nextSibling: null,
    querySelector: (selector) => selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null,
  };
  parent.insertBefore(banner, null);
  return { banner, message, closeHandlers };
}

test("error banner hidden state overrides its flex layout and the close action clears it", async () => {
  const [html, css, app] = await Promise.all([read("index.html"), read("styles.css"), read("src/app.js")]);
  assert.match(html, /id="errorBanner"[^>]*role="alert"[^>]*hidden/);
  assert.match(html, /data-error-dismiss aria-label="Закрыть сообщение об ошибке"/);
  assert.match(css, /\.error-banner\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(css, /\.details-dialog\s*>\s*\.error-banner\s*\{[^}]*z-index:\s*6/);
  const errorLayer = Number(css.match(/\.error-banner\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  const progressLayer = Number(css.match(/\.progress-panel\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  assert.ok(errorLayer > progressLayer, "the error close button must remain above the floating progress panel");
  assert.match(app, /function clearError\(\)\s*\{\s*dismissErrorBanner\(\$\("#errorBanner"\)\);/);
  assert.match(app, /showErrorBanner\(banner, error instanceof Error \? error\.message : String\(error\), \{ dialog: document\.querySelector\("dialog\[open\]"\), occurrence \}\)/);
  assert.match(app, /const occurrence = error && \(typeof error === "object" \|\| typeof error === "function"\) \? error : String\(error\);/);
  assert.match(app, /bindErrorBannerDismiss\(\$\("#errorBanner"\)\)/);
  assert.match(app, /function bindEvents\(\)\s*\{\s*\/\/ Keep error recovery available even if a later UI binding fails during bootstrap\.\s*bindErrorBannerDismiss\(\$\("#errorBanner"\)\);/);
  assert.match(app, /async function bootstrap\(\)\s*\{\s*bindEvents\(\);/);
  assert.match(app, /target === "error"\) dismissErrorBanner\(\$\("#errorBanner"\), \{ suppressRepeat: true \}\)/);
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

test("errors raised inside a native dialog move above its backdrop and dismiss back to the page", () => {
  const page = createParent();
  const progressPanel = { parentNode: null, nextSibling: null };
  page.insertBefore(progressPanel, null);
  const { banner, message, closeHandlers } = createBanner(page);
  page.insertBefore(banner, progressPanel);
  const closeHandlersByType = new Map();
  const dialog = {
    open: true,
    children: [],
    addEventListener: (type, handler) => closeHandlersByType.set(type, handler),
    prepend(node) {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      this.children.unshift(node);
      node.parentNode = this;
    },
  };
  showErrorBanner(banner, "Ошибка импорта", { dialog });
  bindErrorBannerDismiss(banner);
  assert.equal(banner.parentNode, dialog);
  assert.equal(message.textContent, "Ошибка импорта");
  closeHandlers[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(banner.hidden, true);
  assert.equal(banner.parentNode, page);
  assert.equal(page.children[0], banner);
  assert.equal(page.children[1], progressPanel);
});

test("closing a native dialog restores a still-visible error to the global page banner", () => {
  const page = createParent();
  const { banner } = createBanner(page);
  let onClose;
  const dialog = {
    open: true,
    children: [],
    addEventListener: (type, handler) => { if (type === "close") onClose = handler; },
    prepend(node) {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      this.children.unshift(node);
      node.parentNode = this;
    },
  };
  showErrorBanner(banner, "Ошибка базы", { dialog });
  assert.equal(banner.parentNode, dialog);
  onClose();
  assert.equal(banner.parentNode, page);
  assert.equal(banner.hidden, false);
});

test("closing an older dialog does not pull the banner out of a newer open dialog", () => {
  const page = createParent();
  const { banner } = createBanner(page);
  const makeDialog = () => {
    let onClose;
    return {
      dialog: {
        open: true,
        children: [],
        addEventListener: (type, handler) => { if (type === "close") onClose = handler; },
        prepend(node) {
          if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
          this.children.unshift(node);
          node.parentNode = this;
        },
      },
      close: () => onClose(),
    };
  };
  const first = makeDialog();
  const second = makeDialog();
  showErrorBanner(banner, "Первая ошибка", { dialog: first.dialog });
  showErrorBanner(banner, "Вторая ошибка", { dialog: second.dialog });
  first.close();
  assert.equal(banner.parentNode, second.dialog);
  second.close();
  assert.equal(banner.parentNode, page);
});

test("dismissing an error suppresses immediate recurrences with the same message", () => {
  const message = { textContent: "" };
  let clickHandler;
  const closeButton = { addEventListener: (type, handler) => { if (type === "click") clickHandler = handler; } };
  const banner = {
    hidden: true,
    querySelector: (selector) => selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null,
  };

  const firstError = new Error("Ошибка импорта");
  showErrorBanner(banner, firstError.message, { occurrence: firstError });
  bindErrorBannerDismiss(banner);
  clickHandler({ preventDefault() {}, stopPropagation() {} });
  showErrorBanner(banner, firstError.message, { occurrence: new Error(firstError.message) });
  assert.equal(banner.hidden, true);

  const nextError = new Error("Ошибка базы данных");
  showErrorBanner(banner, nextError.message, { occurrence: nextError });
  assert.equal(banner.hidden, false);
  dismissErrorBanner(banner);
  const laterError = new Error("Ошибка импорта");
  showErrorBanner(banner, laterError.message, { occurrence: laterError });
  assert.equal(banner.hidden, false);
});

test("dismissing a persistent string error suppresses repeated status reports", () => {
  const message = { textContent: "" };
  let clickHandler;
  const closeButton = { addEventListener: (type, handler) => { if (type === "click") clickHandler = handler; } };
  const banner = {
    hidden: true,
    querySelector: (selector) => selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null,
  };
  const error = "Ошибка расписания";

  showErrorBanner(banner, error, { occurrence: String(error) });
  bindErrorBannerDismiss(banner);
  clickHandler({ preventDefault() {}, stopPropagation() {} });
  showErrorBanner(banner, error, { occurrence: String(error) });

  assert.equal(banner.hidden, true);
  assert.equal(message.textContent, "");
});

test("binding the close action more than once cannot cancel dismissal suppression", () => {
  const message = { textContent: "" };
  const handlers = [];
  const closeButton = { addEventListener: (type, handler) => { if (type === "click") handlers.push(handler); } };
  const banner = {
    hidden: true,
    querySelector: (selector) => selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null,
  };

  const error = new Error("Ошибка импорта");
  showErrorBanner(banner, error.message, { occurrence: error });
  assert.equal(bindErrorBannerDismiss(banner), true);
  assert.equal(bindErrorBannerDismiss(banner), false);
  assert.equal(handlers.length, 1);
  handlers[0]({ preventDefault() {}, stopPropagation() {} });
  showErrorBanner(banner, error.message, { occurrence: error });
  assert.equal(banner.hidden, true);
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
