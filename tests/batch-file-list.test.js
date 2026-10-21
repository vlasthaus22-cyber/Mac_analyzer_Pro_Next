import test from "node:test";
import assert from "node:assert/strict";
import { BATCH_FILE_LIST_PAGE_SIZE, batchFileListPage, removeBatchFileAt } from "../src/ui/batch-file-list.js";

test("batch source file list pages the complete selection with bounded rows and exact removable indexes", () => {
  const files = Array.from({ length: 2_003 }, (_, index) => ({ name: `source-${index}.csv` }));

  const first = batchFileListPage(files, 1);
  assert.equal(BATCH_FILE_LIST_PAGE_SIZE, 25);
  assert.equal(first.total, 2_003);
  assert.equal(first.pages, 81);
  assert.equal(first.first, 1);
  assert.equal(first.last, 25);
  assert.equal(first.items.length, 25);
  assert.equal(first.items[24].index, 24);

  const last = batchFileListPage(files, 100);
  assert.equal(last.page, 81);
  assert.equal(last.first, 2_001);
  assert.equal(last.last, 2_003);
  assert.deepEqual(last.items.map(({ index }) => index), [2_000, 2_001, 2_002]);
  assert.deepEqual(last.items.map(({ file }) => file.name), ["source-2000.csv", "source-2001.csv", "source-2002.csv"]);
});

test("batch source file list normalizes empty selections and clamps page size and current page", () => {
  assert.deepEqual(batchFileListPage([], 5), {
    items: [], page: 1, pageSize: 25, pages: 1, total: 0, first: 0, last: 0,
  });
  const files = Array.from({ length: 101 }, (_, index) => index);
  const page = batchFileListPage(files, Number.POSITIVE_INFINITY, 500);
  assert.equal(page.pageSize, 100);
  assert.equal(page.page, 1);
  assert.equal(page.pages, 2);
  assert.equal(batchFileListPage(files, 99, 25).page, 5);
});

test("batch source list removes exactly the selected global index and tolerates stale controls", () => {
  const files = Array.from({ length: 52 }, (_, index) => ({ name: `source-${index}.csv` }));
  const remaining = removeBatchFileAt(files, 50);
  assert.equal(remaining.length, 51);
  assert.equal(remaining[49].name, "source-49.csv");
  assert.equal(remaining[50].name, "source-51.csv");
  assert.equal(files.length, 52);
  assert.equal(removeBatchFileAt(files, -1), files);
  assert.equal(removeBatchFileAt(files, 52), files);
});
