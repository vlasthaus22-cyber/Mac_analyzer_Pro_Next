const dismissedMessages = new WeakMap();
const boundBanners = new WeakSet();

export function showErrorBanner(banner, message) {
  const messageNode = banner?.querySelector("span");
  if (!banner || !messageNode) return false;
  const text = String(message ?? "");
  if (banner.hidden && dismissedMessages.get(banner) === text) return true;
  dismissedMessages.delete(banner);
  messageNode.textContent = text;
  banner.hidden = false;
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
