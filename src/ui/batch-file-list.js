export const BATCH_FILE_LIST_PAGE_SIZE = 25;

export function removeBatchFileAt(files, index) {
  if (!Array.isArray(files) || !Number.isInteger(index) || index < 0 || index >= files.length) return Array.isArray(files) ? files : [];
  return [...files.slice(0, index), ...files.slice(index + 1)];
}

export function batchFileListPage(files, requestedPage = 1, pageSize = BATCH_FILE_LIST_PAGE_SIZE) {
  const list = Array.isArray(files) ? files : [];
  const size = Number.isInteger(pageSize) ? Math.min(100, Math.max(1, pageSize)) : BATCH_FILE_LIST_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(list.length / size));
  const page = Number.isFinite(requestedPage)
    ? Math.min(pages, Math.max(1, Math.trunc(requestedPage)))
    : 1;
  const startIndex = (page - 1) * size;
  const items = list.slice(startIndex, startIndex + size).map((file, offset) => ({ file, index: startIndex + offset }));
  return {
    items,
    page,
    pageSize: size,
    pages,
    total: list.length,
    first: list.length ? startIndex + 1 : 0,
    last: Math.min(list.length, startIndex + items.length),
  };
}
