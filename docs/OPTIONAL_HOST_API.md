# Optional loopback host API

The Python host is an optional, same-computer service bound to `127.0.0.1`.
It is not a shared server and does not replace browser IndexedDB. Browser data
is copied to the host only after an explicit user action. Requests from
non-loopback hosts or unapproved origins are rejected. External vendor lookups
are disabled by default and require an explicit setting in the application;
they send only normalized MAC addresses to one of the fixed HTTPS providers.
Full device rows, imported files, IPs, hostnames, and room details are never
sent to vendor providers.

Email, Telegram, and Slack delivery are disabled by default. Each channel
requires an explicit enabled setting, and the UI offers a separate test-send
action. Automatic messages are sent only after a completed analysis and contain
source filenames, device count, counts of devices with address and room fields,
processing duration, and timestamp. Final counts are read from bounded IndexedDB
chunks; individual device addresses and rows are not included. SMTP supports
certificate-verified STARTTLS and implicit SSL/TLS; Telegram uses the fixed
api.telegram.org HTTPS endpoint; Slack
webhooks are restricted to hooks.slack.com and redirects are rejected.
Notification passwords, bot tokens, and Slack webhook URLs are encrypted with
the current Windows user's DPAPI key in the local config directory. They are
not returned by APIs and are excluded from SQLite, JSON, and portable archive
backups. Unsupported systems fail closed when a secret must be stored.

## Read operations

External vendor API routes are loopback-only. A settings read returns no MAC
addresses. The cache summary contains only a count. Vendor requests use the
selected fixed HTTPS provider and reject all redirects so a MAC cannot be
forwarded to another host.

| Method and route | Result |
| --- | --- |
| GET /api/external-vendor/settings | Opt-in state, provider selection, cache TTL, and per-run request limit. |
| GET /api/external-vendor/cache/summary | Count of local vendor cache entries. |
| GET /api/notifications/settings | Sanitized channel settings and booleans indicating whether secrets are configured; secret values are never returned. |

| Method and route | Result |
| --- | --- |
| `GET /api/health` | Host readiness and storage mode. |
| `GET /api/storage/structure` | Resolved data and backup locations. |
| `GET /api/system/diagnostics` | Read-only application, storage, SQLite, and API checks. |
| `GET /api/database/summary` | SQLite integrity and stored collection counts. |
| `POST /api/database/maintenance` | JSON `{ "integrity": true, "optimize": true, "vacuum": false }`; checks SQLite integrity, runs `PRAGMA optimize`, and runs `VACUUM` only when explicitly requested. VACUUM always requires a successful integrity check. The operation affects only the optional-host SQLite copy; IndexedDB and the active Final are untouched. Results include bounded counts and before/after database sizes. |
| `GET`, `HEAD /api/database/export` | Verified SQLite backup stream; `HEAD` reports availability without retaining a temporary export. |
| `GET /api/settings?key=theme,columns` | Settings; selected keys may be requested when the full response exceeds its bound. |
| `GET /api/devices?limit=100&after=0` | Bounded resolved Inventory page. |
| `GET /api/history?limit=100&after=0` | Bounded resolved History page. |
| `GET /api/snapshots?limit=100&after=0` | Bounded Final snapshot metadata page. |
| `GET /api/snapshots/{snapshot_id}/devices?limit=100&after=0` | Bounded devices from one copied Final. |

## Explicit writes

| Method and route | Request or behavior |
| --- | --- |
| PUT /api/external-vendor/settings | JSON settings; disabled by default, fixed provider, 1–500 request limit, and 1–365 day cache TTL. |
| POST /api/external-vendor/test | JSON { "mac": "001122334455", "forceLive": false }; sends one MAC only when enabled and not served from a fresh cache. |
| POST /api/external-vendor/lookup | JSON { "macs": ["001122334455"] }; at most 500 MAC values with a configured per-run live request limit and local cache. |
| POST /api/external-vendor/cache/clear | JSON { "provider": "macvendors" }; clears only the selected provider cache. |
| PUT /api/notifications/settings | JSON { "channel": "telegram", "settings": { "enabled": false, "chatId": "…" }, "secret": { "botToken": "…" }, "clearSecret": false }; validates the channel and keeps secrets out of SQLite. |
| POST /api/notifications/test | JSON { "channel": "email" }; sends a data-free test message through the enabled channel. |
| POST /api/notifications/deliver | JSON { "type": "analysis", "summary": { "title": "…", "message": "…", "timestamp": "…" } }; loopback delivery endpoint after analysis. Other event types are rejected. |

| Method and route | Request or behavior |
| --- | --- |
| `POST /api/batch/folders/scan` | JSON `{ "paths": { ... } }`; returns bounded local file metadata for batch planning. |
| `POST /api/backup/export` | JSON `{ "state": { ... } }`; writes a versioned JSON backup under `data/backups`. |
| `POST /api/backup/restore` | JSON `{ "contentBase64": "..." }`; validates and stores a backup copy without replacing SQLite or IndexedDB. |
| `PUT /api/settings` | JSON `{ "settings": { ... } }`. |
| `PUT /api/devices` | JSON `{ "devices": [ ... ] }`; explicit copy of resolved Inventory. |
| `PUT /api/history` | JSON `{ "events": [ ... ] }`; explicit copy of resolved History. |
| `PUT /api/snapshots/{snapshot_id}` | Uploads a bounded `application/x-ndjson` stream for an explicitly copied Final; a committed snapshot cannot be replaced. |
| `DELETE /api/snapshots/{snapshot_id}` | Deletes one copied Final and its linked History; Inventory is retained. |
| `PUT /api/database/restore` | Validates and stores an uploaded SQLite copy; it does not replace the active database. |
| `POST /api/shutdown` | Stops only the launched loopback host and requires its one-launch authorization token. |

The host exposes JSON errors with an HTTP error status for invalid, oversized,
missing, or unavailable resources. It does not automatically synchronize
SQLite with IndexedDB. Full profile/computer transfer uses the portable Next
archive and explicit import.
