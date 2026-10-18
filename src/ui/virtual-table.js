const states = new WeakMap();
export const VIRTUAL_TABLE_THRESHOLD = 50;
export const VIRTUAL_TABLE_VISIBLE_ROWS = 20;
const fixedRowHeight = 44;

export function virtualTableWindow(totalRows, scrollTop, rowHeight = fixedRowHeight) {
  const total = Math.max(0, Number(totalRows) || 0);
  const height = Math.max(1, Number(rowHeight) || fixedRowHeight);
  const start = Math.max(0, Math.min(Math.max(0, total - VIRTUAL_TABLE_VISIBLE_ROWS), Math.floor(Math.max(0, Number(scrollTop) || 0) / height)));
  const end = Math.min(total, start + VIRTUAL_TABLE_VISIBLE_ROWS);
  return { start, end, before: start * height, after: Math.max(0, total - end) * height };
}

function wrapperFor(tbody) {
  return tbody.closest(".table-scroll, .table-wrap") || tbody.parentElement;
}

function makeSpacer(height, columns) {
  const row = document.createElement("tr");
  row.dataset.virtualSpacer = "true";
  row.setAttribute("aria-hidden", "true");
  const cell = document.createElement("td");
  cell.colSpan = Math.max(1, columns);
  cell.style.height = `${Math.max(0, height)}px`;
  cell.style.padding = "0";
  cell.style.border = "0";
  row.append(cell);
  return row;
}

function render(tbody) {
  const state = states.get(tbody);
  if (!state) return;
  const total = state.rows.length;
  const window = virtualTableWindow(total, state.wrapper.scrollTop, state.rowHeight);
  const { start, end, before, after } = window;
  if (start === state.start && tbody.childElementCount) return;
  state.start = start;
  state.internal = true;
  const fragment = document.createDocumentFragment();
  fragment.append(makeSpacer(before, state.columns));
  for (let index = start; index < end; index += 1) fragment.append(state.rows[index]);
  fragment.append(makeSpacer(after, state.columns));
  tbody.replaceChildren(fragment);
  state.internal = false;
  tbody.dispatchEvent(new globalThis.CustomEvent("virtual-table-render", { bubbles: true }));
}

function detach(tbody) {
  const state = states.get(tbody);
  if (!state) return;
  if (state.frame) globalThis.cancelAnimationFrame(state.frame);
  state.wrapper.removeEventListener("scroll", state.onScroll);
  state.wrapper.classList.remove("virtual-table-wrap");
  states.delete(tbody);
}

export function refreshVirtualTable(tbody) {
  if (!tbody) return false;
  const existing = states.get(tbody);
  if (existing?.internal) return true;
  if (existing && Array.from(tbody.children).every((row) => row.dataset.virtualSpacer === "true" || existing.rows.includes(row))) return true;
  const rows = Array.from(tbody.children).filter((row) => !row.dataset.virtualSpacer);
  if (rows.length <= VIRTUAL_TABLE_THRESHOLD) {
    if (existing) {
      existing.internal = true;
      tbody.replaceChildren(...rows);
      detach(tbody);
    }
    return false;
  }
  const sample = rows.find((row) => row.getBoundingClientRect().height > 0);
  const rowHeight = Math.max(fixedRowHeight, Math.round(sample?.getBoundingClientRect().height || existing?.rowHeight || fixedRowHeight));
  if (existing) {
    existing.rows = rows;
    existing.rowHeight = rowHeight;
    existing.start = -1;
    existing.wrapper.scrollTop = 0;
    render(tbody);
    return true;
  }
  const wrapper = wrapperFor(tbody);
  if (!wrapper) return false;
  const state = {
    rows,
    wrapper,
    rowHeight,
    columns: tbody.closest("table")?.tHead?.rows?.[0]?.cells?.length || 1,
    start: -1,
    internal: false,
    frame: 0,
    onScroll: null,
  };
  state.onScroll = () => {
    if (state.frame) return;
    state.frame = globalThis.requestAnimationFrame(() => {
      state.frame = 0;
      render(tbody);
    });
  };
  states.set(tbody, state);
  wrapper.classList.add("virtual-table-wrap");
  wrapper.scrollTop = 0;
  wrapper.addEventListener("scroll", state.onScroll, { passive: true });
  render(tbody);
  return true;
}

export function virtualTableRows(tbody) {
  return states.get(tbody)?.rows || Array.from(tbody?.children || []).filter((row) => !row.dataset.virtualSpacer);
}

export function sortVirtualTable(tbody, compare) {
  const state = states.get(tbody);
  if (!state) return false;
  state.rows.sort(compare);
  state.wrapper.scrollTop = 0;
  state.start = -1;
  render(tbody);
  return true;
}

export function initializeVirtualTables(root = document) {
  root.querySelectorAll("table[data-virtual-scroll] tbody").forEach(refreshVirtualTable);
  if (typeof globalThis.MutationObserver !== "undefined") {
    let frame = 0;
    new globalThis.MutationObserver((mutations) => {
      const externalChange = mutations.some((item) => {
        if (!item.addedNodes.length && !item.removedNodes.length) return false;
        const tbody = item.target?.closest?.("tbody");
        const state = states.get(tbody);
        if (!state) return true;
        const managed = (node) => node?.dataset?.virtualSpacer === "true" || state.rows.includes(node);
        return ![...item.addedNodes, ...item.removedNodes].every(managed);
      });
      if (!externalChange || frame) return;
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        root.querySelectorAll("table[data-virtual-scroll] tbody").forEach(refreshVirtualTable);
      });
    }).observe(root.body || root.documentElement, { childList: true, subtree: true });
  }
}
