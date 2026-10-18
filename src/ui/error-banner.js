export function showErrorBanner(banner, message) {
  const messageNode = banner?.querySelector("span");
  if (!banner || !messageNode) return false;
  messageNode.textContent = String(message ?? "");
  banner.hidden = false;
  return true;
}

export function dismissErrorBanner(banner) {
  if (!banner) return false;
  banner.hidden = true;
  const messageNode = banner.querySelector("span");
  if (messageNode) messageNode.textContent = "";
  return true;
}

export function bindErrorBannerDismiss(banner) {
  const closeButton = banner?.querySelector("[data-error-dismiss]");
  if (!closeButton) return false;
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissErrorBanner(banner);
  });
  return true;
}
