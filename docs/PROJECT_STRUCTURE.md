# Project structure

MAC Analyzer Pro Next is a browser-only application. The autonomous build runs
from one HTML file; the source modules are kept separately for maintenance and
tests. It has no Python, SQLite, or HTTP backend to start or stop.

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Application shell and presentation |
| `src/app.js`, `src/ui/` | User flows and rendered interface |
| `src/core/` | Identity, merge, comparison, analytics, scheduling, and export rules |
| `src/data/` | File readers and IndexedDB/archive persistence |
| `assets/`, `vendor/`, `licenses/` | Local reference data, browser libraries, and their notices |
| `tests/` | Unit and disposable IndexedDB integration tests |
| `tools/` | Browser-smoke harness; run only where browser automation is allowed |
| `scripts/` | Portable build, parity checks, and release archive tools |
| `docs/`, `PARITY_REGISTRY.md` | Specifications, storage guidance, and source-parity evidence |
| `.agents/`, `AGENTS.md` | Agent context and repository engineering rules |

On Windows, `START_MAC_ANALYZER.cmd` opens `dist/MAC-Analyzer-Pro-Next.html` in
the default browser. Build the HTML with `pnpm build`. Run all code checks and
rebuild/verify the portable package with `CHECK_MAC_ANALYZER.ps1` or `pnpm check`.
The PowerShell check wrapper returns the `pnpm check` exit code unchanged.

Persistent data belongs to the browser profile's IndexedDB. Transfer between
profiles uses an explicit portable archive export and import. The project does
not create backend folders, a server process, or local SQLite databases.
