# MAC Analyzer Pro Next engineering guide

## Product and parity

MAC Analyzer Pro Next is a browser-only mirror of MAC Analyzer Pro. The PyQt
source and its Web project are the behavior reference. A feature is not at parity
because a label, placeholder, static marker, or partial implementation exists.
Every source capability must map to a Next module, a test, and a status in
`PARITY_REGISTRY.md`. Leave unsupported or untested items open. Do not publish a
release while required parity items or release checks are open.

## Architecture and data flow

- `index.html`, `styles.css`, and `src/ui/` define the user interface.
- `src/app.js` coordinates user flows and must not implement domain rules.
- `src/core/` owns parsing-independent business rules: normalization, identity,
  source priority, merge strategies, comparison, analytics, batch planning, and
  historical inference.
- `src/data/` owns file decoding and IndexedDB schema, migrations, transactions,
  archives, indexes, and persistence. Importers must not persist or mutate device
  identity.
- Browser-only IndexedDB is the primary runtime. The optional loopback Python
  host has a source-compatible local SQLite schema and settings API, but does
  not yet persist device data or provide shared database sync. Keep this host
  optional and document each added API.
- Data flows from Main/SmartRoom/DDIO through normalization and identity
  resolution, strategy-specific merge, validation, comparison, and one IndexedDB
  transaction. Analytics reads complete stored Final data, never a UI preview.

## Identity and source priority

- Normalize MAC, IP, dates, empty markers, and room keys before comparison.
- Strong identity priority: persistent internal ID, Device ID, serial, primary
  MAC, then alternate MAC. Hostname may support a match but must not decide an
  ambiguous identity by itself. Smartroom ID and IP are weak evidence only.
- Conflicting strong identifiers create a diagnostic; never select a random
  device or silently combine records.
- Main establishes the current Final set. SmartRoom enriches matched records and
  may add a record only in `ALLOW_EXPANSION` with strong identity. `NO_EXPANSION`
  never adds SmartRoom-only rows.
- Previous Final fills blank, non-conflicting attributes; it never restores an
  absent device into the current Final.
- DDIO is an attribute overlay. Reservation and lease MAC/IP pairs are separate.
  A unique exact MAC match may fill a blank device IP. It never matches by
  switch IP, never replaces a known IP, and never creates a Final row.
- OUI and learned-model records fill only missing values. Keep the source for
  every inferred or imported field.
- Historical switch-IP-to-room-address inference uses successful Final evidence
  only. It must report confidence and supporting snapshots/MAC samples, require
  repeated agreement, preserve current non-empty values, and leave conflicting
  evidence unresolved. Device IP and switch IP remain distinct fields.

## Final, Inventory, and History rules

- Final is the exact current successful run. Inventory is the accumulated device
  catalogue. History records actual changes, appearances, and absences.
- A repeated identical run may create an explicitly dated snapshot, but must not
  fabricate field changes or duplicate identity rows in Inventory.
- Compare devices using the same strong-identity resolver as enrichment.
  A field change requires two known, different values. Empty-to-known is not a
  change event.
- History and evidence records must name their source Final and observation time.
- A failed parse, validation, comparison, quota check, or database write must not
  replace the active successful Final.

## Atomicity, migrations, and preservation

- Each Final commits metadata, all chunks, Inventory updates, History, learned
  evidence, and active snapshot pointer in one IndexedDB transaction.
- Schema changes increment `DB_VERSION`; upgrade code preserves existing stores
  and records. Add a migration test from the preceding schema.
- Archive import merges by stable ID and never deletes existing user records.
  Validate the archive format/version before opening a write transaction.
- Never clear, truncate, replace, or migrate a user's database destructively.
  Tests use a unique disposable database name and never open the default database.
- Keep archive and restoration behavior backward-compatible or provide an
  explicit, tested migration.

## Bounded-memory requirements

- Do not call `getAll()` for full Final chunks, Inventory, History, or archives
  on a large dataset. Use IndexedDB cursors/ranges and fixed-size chunks.
- Do not hold Main, SmartRoom, DDIO, Previous Final, Inventory, and output as
  duplicate full arrays at once. Parse/merge in bounded batches and release
  temporary buffers promptly.
- XLSX readers must avoid a full workbook copy when streaming is available; CSV
  preview must be bounded and must not masquerade as the full import.
- Search and analytics indexes must be compact aggregates with schema versions.
  Never cap analytics at 50 preview rows or silently cap full results.
- Batch cycles run serially. Each cycle is its own atomic Final; report pair,
  file, stage, and error. Continue or stop according to an explicit queue policy.

## Analytics and interface

- KPI, selected-Final comparison, date-range comparison, weekly/monthly trend,
  vendor/model/room summaries, room change coverage, full room equipment,
  codecs, MAC churn, and switch-IP deviations must use the full selected data.
- Added, absent, modified, and unchanged counts and details must share one exact
  comparison result. Device identity changes must not create synthetic add/remove.
- Switch-IP deviation requires at least three devices with known switch IP and
  a strict majority. Display the full room roster and make detail rows usable.
- Exported counts and rows must use the same filters as the visible analytics.
- Keep navigation grouped and collapsible. Use the user-facing terms
  “Объединение данных” and “Массовое объединение данных”.

## Browser storage and portability

- IndexedDB belongs to one browser profile on one computer. Opening the HTML on
  another computer does not expose the first computer's database.
- The supported transfer path is a downloaded portable database archive and an
  explicit import. Do not claim that a browser can read a local path without a
  user-granted File System Access handle.
- If adding File System Access, request the permission through a direct user
  gesture, check permission on later starts, explain reauthorization, and never
  overwrite a newer database with an older archive.
- A shared SQLite mode requires a separately documented and optional server;
  do not imply that this repository currently provides one.

## Security and privacy

- Process imported files locally. Do not upload equipment or network data.
- Treat spreadsheet contents, filenames, archive metadata, and imported HTML as
  untrusted. Escape values in HTML and validate archive structures and sizes.
- Never log passwords, API tokens, workbook contents, or full device records.
- Keep generated release archives, customer databases, logs, and imported data
  out of Git. Do not change the original PyQt reference file.

## Tests and release

- Add a focused unit test for each domain rule and a regression test for every
  user-facing defect. Add integration tests for successive runs, idempotence,
  database restart/migration, archive transfer, and atomic failures.
- Run lint, syntax/type checks where configured, all unit/integration tests, a
  real browser smoke/E2E against the generated autonomous HTML, and the portable
  build. Inspect the actual artifact after building it.
- Generated files under `dist/` are build output and must never be hand-edited.
- Before release, update the parity matrix, release notes, version, and full ZIP
  contents. The full ZIP must include autonomous HTML, source, documentation,
  migrations/reference data, and instructions. Verify the ZIP and artifact hashes.
- Do not publish a GitHub Release unless every required matrix item and all
  configured release checks pass. Never include or overwrite a user's database.

