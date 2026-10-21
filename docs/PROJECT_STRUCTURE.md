# Project structure

MAC Analyzer Pro Next uses browser IndexedDB as its primary device-data store.
The autonomous build runs from one HTML file; source modules are kept separately
for maintenance and tests. An optional Python loopback host serves the same
build, stores compatible application settings in SQLite, exposes local
diagnostics and storage summaries, and supports explicit database/JSON backup
and restore. Through explicit loopback APIs it can store and page resolved
Inventory, History, and Final snapshots. The browser UI can copy one active Final
to SQLite after a direct user action. IndexedDB remains the primary browser
store; there is no automatic shared database sync. Versioned application JSON
backups are kept under `data/backups`; restore validates and stores a copy
without replacing the working SQLite database or IndexedDB.

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Application shell and presentation |
| `src/app.js`, `src/ui/` | User flows and rendered interface |
| `src/core/` | Identity, merge, comparison, analytics, scheduling, and export rules |
| `src/data/` | File readers and IndexedDB/archive persistence |
| `server.py`, `scripts/optional_server_launcher.py`, `scripts/optional_storage_paths.py`, `scripts/optional_sqlite_store.py`, `scripts/optional_backup_store.py` | Optional loopback host, health-checked start/stop, bounded Inventory/History/Final APIs, SQLite settings and diagnostics, local database/JSON backup/restore, and non-destructive legacy-file layout migration |
| `assets/`, `vendor/`, `licenses/` | Local reference data, browser libraries, and their notices |
| `tests/` | Unit and disposable IndexedDB integration tests |
| `tools/` | Browser-smoke harness; run only where browser automation is allowed |
| `scripts/` | Portable build, parity checks, and release archive tools |
| `docs/`, `PARITY_REGISTRY.md` | Specifications, storage guidance, and source-parity evidence |
| `.agents/`, `AGENTS.md` | Agent context and repository engineering rules |

On Windows, the full package contains `dist/MAC-Analyzer-Pro-Next-Host.exe`, a
PyInstaller `asInvoker` executable with the autonomous HTML embedded. The
primary `START_MAC_ANALYZER.cmd` prefers that Python-free local host; if the
executable is absent, it falls back to opening `dist/MAC-Analyzer-Pro-Next.html`
directly. `START_MAC_ANALYZER_SERVER.cmd` starts the loopback host and checks
`/api/health` before opening the browser. `STOP_MAC_ANALYZER_SERVER.cmd` stops
it with its per-launch token. The host writes its SQLite data beside the
application in structured local folders and does not access external services.
Build the HTML with `pnpm build`. On Windows, install the pinned packaging tools
from `requirements-windows-packaging.txt`; `pnpm check` then builds and runs an
API smoke of the packaged executable using a disposable Unicode path. Run all
code checks and rebuild/verify the portable package with `CHECK_MAC_ANALYZER.ps1` or `pnpm check`.
The PowerShell check wrapper returns the `pnpm check` exit code unchanged. `pnpm
check` requires Python 3.10+ in addition to Node/pnpm so it can run all optional
host integration tests; set `PYTHON` to an executable path when Python is not
on `PATH`. Building the browser-only HTML with `pnpm build` does not require
Python.

Persistent data belongs to the browser profile and origin's IndexedDB. The
optional HTTP origin is distinct from `file:` and retains its selected port under
`%LOCALAPPDATA%`. Transfer between profiles uses an explicit portable archive
export and import. The optional host's SQLite database stores settings, backup
copies, and explicit same-machine Inventory, History, and Final copies through
bounded loopback APIs. The UI can explicitly copy Inventory and the active Final
with its linked History from IndexedDB. Those copies do not create shared sync across computers;
use portable archive export and import between browser profiles or computers.
