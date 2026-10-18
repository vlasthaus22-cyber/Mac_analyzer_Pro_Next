const dismissedOccurrences = new WeakMap();
const currentOccurrences = new WeakMap();
const boundBanners = new WeakSet();
const bannerOrigins = new WeakMap();
const watchedDialogs = new WeakSet();
const REPEAT_SUPPRESSION_MS = 2_000;

function restoreErrorBanner(banner) {
  const origin = bannerOrigins.get(banner);
  if (!origin?.parent || !banner.parentNode) return false;
  const before = origin.nextSibling?.parentNode === origin.parent ? origin.nextSibling : null;
  origin.parent.insertBefore(banner, before);
  bannerOrigins.delete(banner);
  return true;
}

function placeErrorBanner(banner, dialog) {
  if (!dialog?.open || typeof dialog.prepend !== "function") {
    restoreErrorBanner(banner);
    return;
  }
  if (banner.parentNode === dialog) return;
  if (!bannerOrigins.has(banner)) bannerOrigins.set(banner, { parent: banner.parentNode, nextSibling: banner.nextSibling });
  dialog.prepend(banner);
  if (!watchedDialogs.has(dialog)) {
    watchedDialogs.add(dialog);
    dialog.addEventListener("close", () => {
      if (banner.parentNode === dialog) restoreErrorBanner(banner);
    });
  }
}

export function showErrorBanner(banner, message, { dialog = null, occurrence = null } = {}) {
  const messageNode = banner?.querySelector("span");
  if (!banner || !messageNode) return false;
  const text = String(message ?? "");
  const errorOccurrence = occurrence ?? text;
  const dismissed = dismissedOccurrences.get(banner);
  const sameOccurrence = dismissed?.occurrence === errorOccurrence;
  const repeatedImmediately = Date.now() - (dismissed?.dismissedAt ?? 0) < REPEAT_SUPPRESSION_MS;
  if (banner.hidden && dismissed?.text === text && (sameOccurrence || repeatedImmediately)) return true;
  dismissedOccurrences.delete(banner);
  currentOccurrences.set(banner, { text, occurrence: errorOccurrence });
  messageNode.textContent = text;
  banner.hidden = false;
  placeErrorBanner(banner, dialog);
  return true;
}

export function dismissErrorBanner(banner, { suppressRepeat = false } = {}) {
  if (!banner) return false;
  const message = banner.querySelector("span")?.textContent || "";
  const current = currentOccurrences.get(banner);
  if (suppressRepeat && message && current?.text === message) dismissedOccurrences.set(banner, { ...current, dismissedAt: Date.now() });
  else dismissedOccurrences.delete(banner);
  currentOccurrences.delete(banner);
  banner.hidden = true;
  const messageNode = banner.querySelector("span");
  if (messageNode) messageNode.textContent = "";
  restoreErrorBanner(banner);
  return true;
}

export function bindErrorBannerDismiss(banner) {
  const closeButton = banner?.querySelector("[data-error-dismiss]");
  if (!closeButton || boundBanners.has(banner)) return false;
  boundBanners.add(banner);
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissErrorBanner(banner, { suppressRepeat: true });
  });
  return true;
}
