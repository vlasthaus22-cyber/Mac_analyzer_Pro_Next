import { sortVirtualTable, virtualTableRows } from "./virtual-table.js";

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

function dateValue(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && /\d{4}/.test(text) ? parsed : null;
}

function numericValue(value) {
  const text = String(value || "").trim().replace(/\s+/g, "").replace(",", ".").replace(/%$/, "");
  return /^[-+]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

export function compareTableValues(left, right) {
  const a = String(left ?? "").trim();
  const b = String(right ?? "").trim();
  if (!a || !b) return !a && !b ? 0 : (!a ? 1 : -1);
  const numberA = numericValue(a);
  const numberB = numericValue(b);
  if (numberA !== null && numberB !== null) return numberA - numberB;
  const dateA = dateValue(a);
  const dateB = dateValue(b);
  if (dateA !== null && dateB !== null) return dateA - dateB;
  return collator.compare(a, b);
}

function updateHeader(table, header, direction) {
  table.querySelectorAll("thead th[aria-sort]").forEach((cell) => {
    if (cell === header) return;
    cell.setAttribute("aria-sort", "none");
    cell.dataset.sortDirection = "";
    const marker = cell.querySelector(".sort-indicator");
    if (marker) marker.textContent = "↕";
  });
  header.setAttribute("aria-sort", direction === "desc" ? "descending" : "ascending");
  header.dataset.sortDirection = direction;
  const marker = header.querySelector(".sort-indicator");
  if (marker) marker.textContent = direction === "desc" ? "▼" : "▲";
}

function compareRows(left, right, index, direction, leftOrder, rightOrder) {
  const a = left.cells[index]?.dataset?.sortValue ?? left.cells[index]?.textContent ?? "";
  const b = right.cells[index]?.dataset?.sortValue ?? right.cells[index]?.textContent ?? "";
  const emptyA = !String(a ?? "").trim();
  const emptyB = !String(b ?? "").trim();
  if (emptyA !== emptyB) return emptyA ? 1 : -1;
  return (direction === "desc" ? -compareTableValues(a, b) : compareTableValues(a, b)) || leftOrder - rightOrder;
}

export function sortTableRows(rows = [], index = 0, direction = "asc") {
  const sortable = Array.from(rows).filter((row) => row.cells.length > index && !row.querySelector("td[colspan]") && row.dataset.sortDisabled !== "true");
  const sortableSet = new Set(sortable);
  const fixed = Array.from(rows).filter((row) => !sortableSet.has(row));
  sortable.forEach((row, order) => { row.__tableSortOrder = order; });
  sortable.sort((left, right) => compareRows(left, right, index, direction, left.__tableSortOrder, right.__tableSortOrder));
  sortable.forEach((row) => { delete row.__tableSortOrder; });
  return [...sortable, ...fixed];
}

export function sortTable(table, header, forcedDirection = "") {
  if (!table || !header || table.id === "enhancedMovementTable" || table.dataset.sortDisabled === "true") return false;
  const index = Array.from(header.parentElement?.children || []).indexOf(header);
  if (index < 0 || header.querySelector("input, select, button") || header.dataset.sortDisabled === "true") return false;
  const direction = forcedDirection || (header.dataset.sortDirection === "asc" ? "desc" : "asc");
  updateHeader(table, header, direction);
  const field = header.dataset.sortField || "";
  if (table.dataset.remoteSort === "true" || field) {
    table.dispatchEvent(new globalThis.CustomEvent("table-sort-change", { bubbles: true, detail: { field, index, direction } }));
    return true;
  }
  const body = table.tBodies?.[0];
  if (!body) return false;
  const rows = virtualTableRows(body);
  const ordered = sortTableRows(rows, index, direction);
  const position = new Map(ordered.map((row, rowOrder) => [row, rowOrder]));
  if (sortVirtualTable(body, (left, right) => position.get(left) - position.get(right))) {
    return true;
  }
  const fragment = document.createDocumentFragment();
  ordered.forEach((row) => {
    delete row.__tableSortOrder;
    fragment.append(row);
  });
  body.append(fragment);
  return true;
}

function headerFromEvent(event) {
  const header = event.target?.closest?.("th");
  if (!header || !header.closest("table") || event.target.closest(".column-resize-handle")) return null;
  return header;
}

function decorate(scope) {
  scope.querySelectorAll?.("table:not(#enhancedMovementTable):not([data-sort-disabled='true']) thead th").forEach((header) => {
    if (header.querySelector("input, select, button") || header.dataset.sortDisabled === "true") return;
    header.classList.add("sortable-column");
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    if (!header.hasAttribute("aria-sort")) header.setAttribute("aria-sort", "none");
    if (!header.querySelector(".sort-indicator")) {
      const indicator = document.createElement("span");
      indicator.className = "sort-indicator";
      indicator.setAttribute("aria-hidden", "true");
      indicator.textContent = "↕";
      header.append(indicator);
    }
  });
}

export function installTableSorter(scope = document) {
  if (!scope?.addEventListener || scope.documentElement?.dataset?.tableSorter === "ready") return;
  if (scope.documentElement) scope.documentElement.dataset.tableSorter = "ready";
  decorate(scope);
  scope.addEventListener("click", (event) => {
    const header = headerFromEvent(event);
    if (header) sortTable(header.closest("table"), header);
  });
  scope.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const header = headerFromEvent(event);
    if (!header) return;
    event.preventDefault();
    sortTable(header.closest("table"), header);
  });
  if (typeof globalThis.MutationObserver === "undefined") return;
  let frame = 0;
  new globalThis.MutationObserver((mutations) => {
    if (!mutations.some((item) => item.addedNodes.length)) return;
    if (frame) return;
    const schedule = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 0));
    frame = schedule(() => {
      frame = 0;
      decorate(scope);
    });
  }).observe(scope.body || scope.documentElement, { childList: true, subtree: true });
}
