import test from "node:test";
import assert from "node:assert/strict";
import {
  isEngineeringOnlyActionTarget,
  isEngineeringOnlyInputTarget,
  isRestrictedEngineeringViewTarget,
  requiresEngineeringAccessForClick,
  guardEngineeringClick,
} from "../src/ui/engineering-access.js";
import { bindErrorBannerDismiss, showErrorBanner } from "../src/ui/error-banner.js";

function targetWith({ action = "", input = "", viewId = "", errorDismiss = false } = {}) {
  return {
    closest(selector) {
      const selectors = selector.split(",").map((value) => value.trim());
      if (errorDismiss && selectors.includes("[data-error-dismiss]")) return { selector: "[data-error-dismiss]" };
      if (action && selectors.includes(action)) return { selector: action };
      if (input && selectors.includes(input)) return { selector: input };
      if (viewId && selectors.includes(".view")) return { id: viewId };
      return null;
    },
  };
}

test("legacy automation actions require engineering access", () => {
  for (const action of [
    "[data-run-legacy-task]",
    "[data-toggle-legacy-task]",
    "[data-add-legacy-task-files]",
    "[data-download-legacy-task-file]",
  ]) {
    assert.equal(isEngineeringOnlyActionTarget(targetWith({ action })), true, action);
  }
  assert.equal(isEngineeringOnlyActionTarget(targetWith()), false);
});

test("history and analytics view targets follow the configured role policy", () => {
  const allowedPublicViews = new Set(["search", "history", "analytics"]);
  const canAccessView = (view, engineer) => engineer || allowedPublicViews.has(view);
  assert.equal(isRestrictedEngineeringViewTarget(targetWith({ viewId: "historyView" }), canAccessView), false);
  assert.equal(isRestrictedEngineeringViewTarget(targetWith({ viewId: "batchView" }), canAccessView), true);
  assert.equal(isRestrictedEngineeringViewTarget(targetWith(), canAccessView), false);
});

test("queue picker and analytics settings input events are restricted", () => {
  assert.equal(isEngineeringOnlyInputTarget(targetWith({ input: "#legacyTaskQueueFilePicker" })), true);
  assert.equal(isEngineeringOnlyInputTarget(targetWith({ input: "#analyticsDashboardSettingsDialog" })), true);
  assert.equal(isEngineeringOnlyInputTarget(targetWith()), false);
});

test("error dismissal stays available inside restricted dialogs and views", () => {
  const canAccessView = (view, engineer) => engineer || view === "search";
  const errorButtonInAnalyticsDialog = targetWith({ action: "#analyticsDashboardSettingsDialog", errorDismiss: true });
  const actionButtonInAnalyticsDialog = targetWith({ action: "#analyticsDashboardSettingsDialog" });
  const errorButtonInRestrictedView = targetWith({ viewId: "batchView", errorDismiss: true });

  assert.equal(requiresEngineeringAccessForClick(errorButtonInAnalyticsDialog, canAccessView), false);
  assert.equal(requiresEngineeringAccessForClick(actionButtonInAnalyticsDialog, canAccessView), true);
  assert.equal(requiresEngineeringAccessForClick(errorButtonInRestrictedView, canAccessView), false);
});

test("capture-phase engineering guard lets the error close handler run in a restricted dialog", () => {
  const canAccessView = (view, engineer) => engineer || view === "search";
  const target = targetWith({ viewId: "batchView", errorDismiss: true });
  const message = { textContent: "" };
  const closeHandlers = [];
  const closeButton = { addEventListener(type, handler) { if (type === "click") closeHandlers.push(handler); } };
  const banner = {
    hidden: true,
    querySelector(selector) { return selector === "span" ? message : selector === "[data-error-dismiss]" ? closeButton : null; },
  };
  showErrorBanner(banner, "Ошибка импорта");
  bindErrorBannerDismiss(banner);
  let expired = 0;
  let prevented = false;
  let stopped = false;
  const event = {
    target,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  };

  const blocked = guardEngineeringClick(event, {
    expireSession() { expired += 1; },
    isEngineerActive: () => false,
    canAccessView,
  });
  if (!blocked) closeHandlers[0]({ preventDefault() {}, stopPropagation() {} });

  assert.equal(expired, 1);
  assert.equal(blocked, false);
  assert.equal(banner.hidden, true);
  assert.equal(message.textContent, "");
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test("capture-phase engineering guard still blocks restricted actions in that dialog", () => {
  const target = targetWith({ action: "#analyticsDashboardSettingsDialog" });
  let prevented = false;
  let stopped = false;
  const blocked = guardEngineeringClick({
    target,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  }, {
    expireSession() {},
    isEngineerActive: () => false,
    canAccessView: () => false,
  });

  assert.equal(blocked, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});
