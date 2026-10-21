# Project structure

MAC Analyzer Pro Next uses browser IndexedDB as its primary device-data store.
The autonomous build runs from one HTML file; source modules are kept separately
for maintenance and tests. An optional Python loopback host serves the same
build, stores compatible application settings in SQLite, exposes database/
storage summaries, bounded Inventory and snapshot reads, insert-only streaming
snapshot writes, and provenance-validated History reads/writes. History events record their
source Final and observation time. Versioned application JSON backups are kept
under `data/backups`. Backup restore
validates and stores the JSON but does not replace the working SQLite database
or IndexedDB. Browser device data is not synchronized to optional SQLite.

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Application shell and presentation |
| `src/app.js`, `src/ui/` | User flows and rendered interface |
| `src/core/` | Identity, merge, comparison, analytics, scheduling, and export rules |
| `src/data/` | File readers and IndexedDB/archive persistence |
| `server.py`, `scripts/optional_server_launcher.py`, `scripts/optional_storage_paths.py`, `scripts/optional_sqlite_store.py`, `scripts/optional_backup_store.py` | Optional loopback host, health-checked start/stop, additive SQLite schema/settings/resolved Inventory/History/snapshot APIs, local JSON backup/restore, and non-destructive legacy-file layout migration |
| `assets/`, `vendor/`, `licenses/` | Local reference data, browser libraries, and their notices |
| `tests/` | Unit and disposable IndexedDB integration tests |
| `tools/` | Browser-smoke harness; run only where browser automation is allowed |
| `scripts/` | Portable build, parity checks, and release archive tools |
| `docs/`, `PARITY_REGISTRY.md` | Specifications, storage guidance, and source-parity evidence |
| `.agents/`, `AGENTS.md` | Agent context and repository engineering rules |

On Windows, `START_MAC_ANALYZER.cmd` opens `dist/MAC-Analyzer-Pro-Next.html` in
the default browser without Python. `START_MAC_ANALYZER_SERVER.cmd` is optional;
it starts the loopback host in a separate console, verifies `/api/health`, then
opens the same standalone build. `STOP_MAC_ANALYZER_SERVER.cmd` stops that host
with its per-launch token. Build the HTML with `pnpm build`. Run all code
checks and rebuild/verify the portable package with `CHECK_MAC_ANALYZER.ps1` or `pnpm check`.
The PowerShell check wrapper returns the `pnpm check` exit code unchanged. `pnpm
check` requires Python 3.10+ in addition to Node/pnpm so it can run all optional
host integration tests; set `PYTHON` to an executable path when Python is not
on `PATH`. Building the browser-only HTML with `pnpm build` does not require
Python.

Persistent data belongs to the browser profile and origin's IndexedDB. The
optional HTTP origin is distinct from `file:` and retains its selected port under
`%LOCALAPPDATA%`. Transfer between profiles uses an explicit portable archive
export and import. The optional host's SQLite database stores settings and
resolved Inventory, and exposes a bounded local inventory API. The browser UI
does not use that API or synchronize it with IndexedDB; the loopback host does
not provide a shared database across computers.
