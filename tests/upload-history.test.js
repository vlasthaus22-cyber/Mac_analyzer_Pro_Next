import test from "node:test";
import assert from "node:assert/strict";
import { countUploadHistorySnapshotCandidates, filterUploadHistorySnapshots, selectUploadHistoryPage, snapshotDeviceMatchesFilters, snapshotDeviceMatchesQuery, snapshotSourceNames, uploadHistorySnapshotCandidates } from "../src/core/upload-history.js";

const snapshots = [
  { id: "a", name: "Первый Final", createdAt: "2026-01-01T10:00:00.000Z", sourceFiles: [{ name: "main.csv" }, { name: "room.xlsx" }], deviceCount: 4 },
  { id: "b", name: "Второй Final", createdAt: "2026-01-02T10:00:00.000Z", sourceFiles: ["main-2.csv"], deviceCount: 5 },
  { id: "c", name: "Третий Final", createdAt: "2026-01-03T10:00:00.000Z", sourceFiles: [{ fileName: "ddio.txt" }], deviceCount: 6 },
];

test("upload history normalizes source file metadata and pages newest successful Finals first", () => {
  assert.deepEqual(snapshotSourceNames(snapshots[0]), ["main.csv", "room.xlsx"]);
  const result = selectUploadHistoryPage(snapshots, { page: 2, limit: 1 });
  assert.deepEqual(result.rows.map(({ id }) => id), ["b"]);
  assert.equal(result.total, 3);
  assert.equal(result.pageCount, 3);
  assert.equal(result.hasPrevious, true);
  assert.equal(result.hasNext, true);
});

test("upload history searches filenames and filters inclusive calendar dates", () => {
  const result = selectUploadHistoryPage(snapshots, { query: "ROOM.XLSX", from: "2026-01-01", to: "2026-01-02" });
  assert.deepEqual(result.rows.map(({ id }) => id), ["a"]);
  assert.equal(result.total, 1);
  assert.throws(() => selectUploadHistoryPage(snapshots, { from: "2026-01-03", to: "2026-01-01" }), /Начальная дата позже конечной/);
});

test("upload history clamps pages and returns an empty page for no matches", () => {
  const page = selectUploadHistoryPage(snapshots, { page: 99, limit: 500 });
  assert.equal(page.page, 1);
  assert.equal(page.rows.length, 3);
  const empty = selectUploadHistoryPage(snapshots, { query: "missing-file.csv" });
  assert.equal(empty.total, 0);
  assert.equal(empty.hasNext, false);
});

test("legacy upload-history filtering does not clone the complete source catalog", () => {
  const source = Object.freeze([
    { id: "older", name: "Older", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "newer", name: "Newer", createdAt: "2026-01-02T00:00:00.000Z" },
  ]);
  const guarded = new Proxy(source, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error("source catalog must not be spread into a second full array");
      return Reflect.get(target, property, receiver);
    },
  });

  assert.deepEqual(filterUploadHistorySnapshots(guarded).map(({ id }) => id), ["newer", "older"]);
  assert.deepEqual(source.map(({ id }) => id), ["older", "newer"], "sorting the filtered result must not mutate source order");
});

test("ascending canonical upload history selects only one page without filter/sort copies", () => {
  const many = Array.from({ length: 1_205 }, (_, index) => ({
    id: `run-${String(index).padStart(4, "0")}`,
    name: index % 3 === 0 ? `Target ${index}` : `Run ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 120_000).toISOString(),
    sourceFiles: [{ name: `source-${index}.csv` }],
    deviceCount: index,
  }));
  const options = { query: "target", page: 13, limit: 25 };
  const reference = selectUploadHistoryPage(many, options);
  const paged = selectUploadHistoryPage(many, { ...options, snapshotsAscending: true });
  assert.deepEqual(paged, reference);
  assert.equal(paged.rows.length, 25);
  assert.deepEqual(paged.rows, many.filter(({ name }) => name.startsWith("Target ")).reverse().slice(300, 325));
  assert.equal(many.length, 1_205, "selection preserves the full ascending metadata source");
  const dateOptions = { from: "2026-01-01", to: "2026-01-02", page: 4, limit: 25 };
  assert.deepEqual(
    selectUploadHistoryPage(many, { ...dateOptions, snapshotsAscending: true }),
    selectUploadHistoryPage(many, dateOptions),
  );
  assert.deepEqual(
    selectUploadHistoryPage(many, { ...dateOptions, snapshotsAscending: true, snapshotsCanonical: true }),
    selectUploadHistoryPage(many, dateOptions),
  );
});

test("ascending upload history falls back to canonical sorting for legacy timestamps", () => {
  const legacy = [
    { id: "local-offset", name: "Offset", createdAt: "2026-01-01T02:00:00+02:00" },
    { id: "utc", name: "UTC", createdAt: "2026-01-01T00:30:00.000Z" },
  ];
  assert.deepEqual(
    selectUploadHistoryPage(legacy, { snapshotsAscending: true }).rows,
    selectUploadHistoryPage(legacy).rows,
  );
});

test("ascending upload history preserves locale-based ID tie ordering", () => {
  const sameTimestamp = [
    { id: "A", name: "Upper", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "a", name: "Lower", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(
    selectUploadHistoryPage(sameTimestamp, { snapshotsAscending: true }).rows,
    selectUploadHistoryPage(sameTimestamp).rows,
  );
});

test("descending upload-history search results remain on bounded pages", () => {
  const searched = Array.from({ length: 1_205 }, (_, index) => ({
    id: `match-${String(1_204 - index).padStart(4, "0")}`,
    name: `Match ${1_204 - index}`,
    createdAt: new Date(Date.UTC(2026, 0, 2) - index * 1_000).toISOString(),
  }));
  const options = { page: 12, limit: 25, snapshotsDescending: true };
  const page = selectUploadHistoryPage(searched, options);
  assert.equal(page.total, 1_205);
  assert.deepEqual(page.rows, searched.slice(275, 300));
  const clamped = selectUploadHistoryPage(searched, { ...options, page: 999 });
  assert.equal(clamped.page, 49);
  assert.deepEqual(clamped.rows, searched.slice(1_200));
});

test("upload history candidates stream newest-first without materializing the canonical catalog", () => {
  const many = Array.from({ length: 1_205 }, (_, index) => ({
    id: `candidate-${String(index).padStart(4, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 120_000).toISOString(),
    name: `Run ${index}`,
  }));
  const filters = { from: "2026-01-01", to: "2026-01-01", snapshotsAscending: true };
  const candidates = uploadHistorySnapshotCandidates(many, filters);
  assert.equal(countUploadHistorySnapshotCandidates(many, filters), 720);
  const first = candidates.next();
  assert.equal(first.value, many[719], "the iterator yields the original metadata reference newest-first");
  const expected = filterUploadHistorySnapshots(many, filters);
  assert.deepEqual(Array.from(uploadHistorySnapshotCandidates(many, filters)), expected);
});

test("canonical upload-history date ranges count by binary bounds and visit only matching metadata", () => {
  const many = Array.from({ length: 100_000 }, (_, index) => ({
    id: `bounded-${String(index).padStart(6, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }));
  let indexedReads = 0;
  const tracked = new Proxy(many, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const filters = { from: "2026-01-02", to: "2026-01-02", snapshotsAscending: true, snapshotsCanonical: true };
  assert.equal(countUploadHistorySnapshotCandidates(tracked, filters), 1_440);
  assert.ok(indexedReads < 40, `count should use binary bounds, got ${indexedReads} indexed reads`);
  indexedReads = 0;
  const rows = Array.from(uploadHistorySnapshotCandidates(tracked, filters));
  assert.equal(rows.length, 1_440);
  assert.ok(indexedReads >= 1_440 && indexedReads <= 1_480, `iterator should read the date range plus two binary searches, got ${indexedReads}`);
  assert.equal(rows[0], many[2_879]);
  assert.equal(rows.at(-1), many[1_440]);
});

test("upload history searches all supported device fields and applies date filters to catalog candidates", () => {
  assert.equal(snapshotDeviceMatchesQuery({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X", room: "Room 4" }, "board x"), true);
  assert.equal(snapshotDeviceMatchesQuery({ mac: "00:11:22:33:44:55", ip: "10.0.0.1" }, "10.0.0.1"), true);
  assert.equal(snapshotDeviceMatchesQuery({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X", room: "Room 4" }, "10.0.0.1"), false);
  assert.deepEqual(filterUploadHistorySnapshots([
    { id: "old", name: "Old", createdAt: "2026-01-01T00:00:00Z" },
    { id: "new", name: "New", createdAt: "2026-01-02T00:00:00Z" },
  ], { from: "2026-01-02", to: "2026-01-02" }).map(({ id }) => id), ["new"]);
});

test("upload history structured vendor, model and room filters use device aliases", () => {
  const device = { vendor: "Acme Networks", model: "Board X", physicalAddress: "Building A, Room 4" };
  assert.equal(snapshotDeviceMatchesFilters(device, { vendor: "ACME", model: "board", room: "room 4" }), true);
  assert.equal(snapshotDeviceMatchesFilters(device, { vendor: "Other", model: "board", room: "room 4" }), false);
  assert.equal(snapshotDeviceMatchesFilters(device, {}), true);
});
