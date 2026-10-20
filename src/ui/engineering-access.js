const ENGINEERING_ONLY_ACTIONS = Object.freeze([
  "[data-delete-device-history]",
  "[data-delete-local-archive]",
  "[data-delete-ip-mapping]",
  "[data-delete-mac5]",
  "[data-run-legacy-task]",
  "[data-toggle-legacy-task]",
  "[data-add-legacy-task-files]",
  "[data-download-legacy-task-file]",
  "#deleteHistoryEventsButton",
  "#deleteFilteredHistoryEventsButton",
  "#deleteLegacyObservationsButton",
  "#deleteFilteredLegacyObservationsButton",
  "#legacyTaskQueueFilePicker",
  "#analyticsSettingsButton",
  "#analyticsDashboardSettingsDialog",
]);

const ENGINEERING_ONLY_INPUTS = Object.freeze([
  "#legacyTaskQueueFilePicker",
  "#analyticsDashboardSettingsDialog",
]);

function targetMatchesAny(target, selectors) {
  return Boolean(target?.closest?.(selectors.join(", ")));
}

export function isEngineeringOnlyActionTarget(target) {
  return targetMatchesAny(target, ENGINEERING_ONLY_ACTIONS);
}

export function isEngineeringOnlyInputTarget(target) {
  return targetMatchesAny(target, ENGINEERING_ONLY_INPUTS);
}

export function isRestrictedEngineeringViewTarget(target, canAccessView) {
  const view = target?.closest?.(".view");
  const viewName = view?.id.replace(/View$/, "");
  return Boolean(viewName && !canAccessView(viewName, false));
}

export function requiresEngineeringAccessForClick(target, canAccessView) {
  if (targetMatchesAny(target, ["[data-error-dismiss]"])) return false;
  return isEngineeringOnlyActionTarget(target) || isRestrictedEngineeringViewTarget(target, canAccessView);
}

export function guardEngineeringClick(event, { expireSession, isEngineerActive, canAccessView }) {
  expireSession();
  if (isEngineerActive()) return false;
  if (!requiresEngineeringAccessForClick(event.target, canAccessView)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}
