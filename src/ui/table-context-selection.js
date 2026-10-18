export function selectContextTableRow(row) {
  const table = row?.closest?.("table");
  if (!table) return false;
  for (const selected of table.querySelectorAll("tbody tr.context-row-selected")) {
    if (selected === row) continue;
    selected.classList.remove("context-row-selected");
    selected.setAttribute("aria-selected", "false");
  }
  row.classList.add("context-row-selected");
  row.setAttribute("aria-selected", "true");
  return true;
}
