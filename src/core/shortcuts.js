const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
const USER_MODE_SHORTCUTS = new Set(["ctrl+a", "ctrl+h", "ctrl+f", "f1", "escape"]);

export function isShortcutAllowedWithoutEngineer(shortcut) {
  return USER_MODE_SHORTCUTS.has(String(shortcut || ""));
}

export function abortActiveControllers(controllers = []) {
  let aborted = false;
  for (const controller of new Set(controllers)) {
    if (!controller?.signal || controller.signal.aborted) continue;
    controller.abort();
    aborted = true;
  }
  return aborted;
}

export function escapeActionTarget({ contextMenuOpen = false, dialogOpen = false, errorVisible = false, processVisible = false } = {}) {
  if (contextMenuOpen) return "context-menu";
  if (dialogOpen) return "native-dialog";
  if (errorVisible) return "error";
  if (processVisible) return "process";
  return "";
}

export function identifyShortcut(event) {
  if (!event || event.altKey || event.metaKey) return "";
  const key = String(event.key || "").toLowerCase();
  if (key === "escape") return "escape";
  const ctrl = Boolean(event.ctrlKey);
  if (ctrl) {
    if (event.shiftKey) return key === "c" ? "ctrl+shift+c" : "";
    const target = event.target;
    const editable = target?.matches?.(EDITABLE_SELECTOR) || target?.isContentEditable;
    if (editable && key !== "f") return "";
    if (key === "o" || key === "s" || key === "e" || key === "a" || key === "h" || key === "f") return `ctrl+${key}`;
    return "";
  }
  if (["f1", "f5", "f6", "f7", "f8", "f9"].includes(key)) return key;
  return "";
}
