export function openInventoryColumnManagerDialog(dialog, focusTarget, trigger) {
  if (!dialog || typeof dialog.showModal !== "function") return false;
  if (!dialog.open) dialog.showModal();
  trigger?.setAttribute?.("aria-expanded", "true");
  focusTarget?.focus?.();
  return Boolean(dialog.open);
}
