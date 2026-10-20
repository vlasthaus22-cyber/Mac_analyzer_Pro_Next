# Project structure

MAC Analyzer Pro Next uses browser IndexedDB as its primary storage. The
autonomous build runs from one HTML file; source modules are kept separately for
maintenance and tests. An optional Python loopback host serves the same built
HTML and `/api/health`; it does not provide SQLite or shared storage.

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Application shell and presentation |
| `src/app.js`, `src/ui/` | User flows and rendered interface |
| `src/core/` | Identity, merge, comparison, analytics, scheduling, and export rules |
| `src/data/` | File readers and IndexedDB/archive persistence |
| `server.py`, `scripts/optional_server_launcher.py` | Optional loopback HTML host, health check, and token-protected stop command; no device-data API |
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
The PowerShell check wrapper returns the `pnpm check` exit code unchanged.

Persistent data belongs to the browser profile and origin's IndexedDB. The
optional HTTP origin is distinct from `file:` and retains its selected port under
`%LOCALAPPDATA%`. Transfer between profiles uses an explicit portable archive
export and import. The project does not yet provide a SQLite service or shared
database.
