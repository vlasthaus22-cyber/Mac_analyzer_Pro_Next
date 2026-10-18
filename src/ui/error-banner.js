const dismissedMessages = new WeakMap();
const boundBanners = new WeakSet();
const bannerOrigins = new WeakMap();
const watchedDialogs = new WeakSet();

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

export function showErrorBanner(banner, message, { dialog = null } = {}) {
  const messageNode = banner?.querySelector("span");
  if (!banner || !messageNode) return false;
  const text = String(message ?? "");
  if (banner.hidden && dismissedMessages.get(banner) === text) return true;
  dismissedMessages.delete(banner);
  messageNode.textContent = text;
  banner.hidden = false;
  placeErrorBanner(banner, dialog);
  return true;
}

export function dismissErrorBanner(banner, { suppressRepeat = false } = {}) {
  if (!banner) return false;
  const message = banner.querySelector("span")?.textContent || "";
  if (suppressRepeat && message) dismissedMessages.set(banner, message);
  else dismissedMessages.delete(banner);
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
