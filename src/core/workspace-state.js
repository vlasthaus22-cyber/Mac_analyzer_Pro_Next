export const WORKSPACE_STATE_VERSION = 1;

export function normalizeWorkspaceState(value, {
  views = [],
  sortFields = [],
  pageSizes = [],
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowedViews = new Set(views);
  const allowedSortFields = new Set(sortFields);
  const allowedPageSizes = new Set(pageSizes.map(Number));
  const pageSize = Number(source.pageSize);
  const requestedPage = Number(source.page);
  const direction = Number(source.sort?.direction);
  return {
    version: WORKSPACE_STATE_VERSION,
    view: allowedViews.has(source.view) ? source.view : "search",
    search: typeof source.search === "string" ? source.search.slice(0, 1_000) : "",
    page: Math.max(1, Math.min(1_000_000, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1))),
    pageSize: allowedPageSizes.has(pageSize) ? pageSize : 50,
    sort: {
      field: allowedSortFields.has(source.sort?.field) ? source.sort.field : "mac",
      direction: direction === -1 ? -1 : 1,
    },
  };
}

export function captureWorkspaceState(state, views, sortFields, pageSizes) {
  return normalizeWorkspaceState({
    view: state.view,
    search: state.search,
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort,
  }, { views, sortFields, pageSizes });
}

export function readWorkspaceState(queue, database) {
  return queue.enqueue(() => database.getSetting("workspaceState", null));
}

export function deleteWorkspaceState(queue, database) {
  return queue.enqueue(() => database.deleteSetting("workspaceState"));
}
