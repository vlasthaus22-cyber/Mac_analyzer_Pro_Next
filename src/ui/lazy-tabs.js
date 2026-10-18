const entries = new Map();
let initialized = false;
let activeName = "";

function viewName(panel) {
  return String(panel?.id || "").replace(/View$/, "");
}

function detach(entry) {
  if (!entry || entry.detached || entry.name === activeName) return;
  while (entry.panel.firstChild) entry.fragment.append(entry.panel.firstChild);
  entry.detached = true;
  entry.panel.dataset.lazyDetached = "true";
}

function attach(entry) {
  if (!entry || !entry.detached) return;
  entry.panel.append(entry.fragment);
  entry.detached = false;
  delete entry.panel.dataset.lazyDetached;
}

export function initializeLazyTabs(panels, initialName) {
  if (initialized) return;
  for (const panel of Array.from(panels || [])) {
    const name = viewName(panel);
    if (!name) continue;
    entries.set(name, { name, panel, fragment: document.createDocumentFragment(), detached: false });
  }
  activeName = entries.has(initialName) ? initialName : entries.keys().next().value || "";
  for (const entry of entries.values()) if (entry.name !== activeName) detach(entry);
  initialized = true;
}

export function activateLazyTab(name) {
  activeName = String(name || "");
  if (!initialized) return;
  attach(entries.get(activeName));
  for (const entry of entries.values()) if (entry.name !== activeName) detach(entry);
}

export function queryLazyTab(selector) {
  for (const entry of entries.values()) {
    if (!entry.detached) continue;
    const found = entry.fragment.querySelector(selector);
    if (found) return found;
  }
  return null;
}

export function queryAllLazyTabs(selector) {
  const rows = [];
  for (const entry of entries.values()) if (entry.detached) rows.push(...entry.fragment.querySelectorAll(selector));
  return rows;
}
