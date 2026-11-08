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

The fixed provider identifiers are `macvendors`, `maclookup`, `mac2vendor`, and
`macadress`. `macadress` uses the keyless plain-text endpoint
`https://api.macadress.com/v1/vendor/{normalized-mac}`. It is an additional
working alternative; the legacy `mac2vendor` endpoint is retained for imported
settings and currently responds with HTTP 404.
MACLookup requests use the documented canonical path
`https://api.maclookup.app/v2/macs/{normalized-mac}` without a trailing slash;
the provider's `success:false` and `found:false` response markers are treated as
an unsuccessful lookup.

| Method and route | Result |
| --- | --- |
| GET /api/external-vendor/settings | Opt-in state, provider selection, cache TTL, and per-run request limit. |
| GET /api/external-vendor/cache/summary | Count of local vendor cache entries. |
| GET /api/notifications/settings | Sanitized channel settings and booleans indicating whether secrets are configured; secret values are never returned. |

| Method and route | Result |
| --- | --- |
| `GET /api/health` | Host readiness and storage mode. |
| `GET /api/storage/structure` | Resolved data and backup locations. |
| `GET /api/system/diagnostics` | Read-only application, storage, SQLite, and API checks, including sanitized vendor and notification settings endpoints. |
| `GET /api/database/summary` | SQLite integrity and stored collection counts. |
| `GET /api/reference/oui?after=001122&limit=500` | Bounded page of host SQLite `builtin`/`reference` OUI rules only; user-defined host mappings are excluded. The OUI panel can explicitly copy these pages into the current browser profile's IndexedDB. |
| `GET /api/database/search?query=codec&limit=100` | Bounded search across the explicitly copied Inventory/History plus local vendor-model and IP-mapping records. The optional-host screen exposes this route only on its same-computer loopback origin. Results contain a compact escaped-data projection, at most 500 rows and 1 MiB; the default query is the latest device records. |
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
| `POST /api/backup/export` | JSON `{ "state": { ... } }`; writes a versioned JSON backup under `data/backups` and returns its content. The loopback UI exposes this from “Рабочее состояние” for the current view, search, page, page size, and sorting; it also downloads the JSON file. Device data is transferred with the portable Next archive. |
| `POST /api/backup/restore` | JSON `{ "contentBase64": "..." }`; validates and stores a backup copy without replacing SQLite or IndexedDB. The loopback UI accepts a selected JSON state backup, asks the host to validate and retain it, then normalizes and applies only workspace settings to the current IndexedDB profile. |
| `PUT /api/settings` | JSON `{ "settings": { ... } }`. |
| `PUT /api/devices` | JSON `{ "devices": [ ... ] }`, up to 500 records; explicit copy of resolved Inventory. The browser adapter transfers normalized identity, MAC aliases and truncation flags, vendor/model confidence and provenance, OUI, device/location fields, possible-IP evidence and truncation, custom-field sources, field sources, conflicts, and observation counts. Alternate MAC and possible-IP arrays are each bounded to the browser limit of 100 entries; additive host merges preserve first-seen order and carry truncation forward. Strong-identity aliases match the browser resolver: internal ID `id`/`internalDeviceId`/`internal_device_id`, Device ID `deviceId`/`device_id`/`asset_id`, serial `serial`/`serialNumber`/`serial_number`, primary MAC `mac`/`macAddress`/`mac_address`/`macFormatted`/`mac_formatted`/`CallingStationID`, plus `alternateMacs`. The host derives canonical fields for indexed matching while retaining supplied aliases in the payload and indexing every supplied strong alias. Startup backfill adds any missing alias indexes and source-attributed diagnostics to existing rows without replacing device data. Conflicting aliases within a record are retained as at most 100 `conflicts` diagnostics with `conflictsTruncated` when needed; additive merges also cap the combined history at 100. A later record matching only a contradictory alias is rejected as a strong-identity conflict rather than merged. Different known primary MACs are always reported even if an alternate overlaps. If a unique higher-priority ID matches, the row is retained, the conflicting incoming MAC is kept only as an alternate, and the conflict is returned; if matching relies on the alternate MAC against a different known primary, the merge is rejected. An incoming primary MAC may fill an existing blank primary. `customFieldSources` is preserved along with `customFields`; a blank custom field takes its incoming source, while a different known value is kept as a `customField` conflict with key, selected/incoming values, and source, matching browser `mergeDevice`. |
| `PUT /api/history` | JSON `{ "events": [ ... ] }`; explicit copy of resolved History. Modified events require two known, different values: whitespace and non-breaking spaces are normalized, comparisons are case-insensitive, and the browser's empty markers (including unknown vendor/model and Russian placeholders) are rejected as changes. |
| `PUT /api/snapshots/{snapshot_id}` | Uploads a bounded `application/x-ndjson` stream for an explicitly copied Final; a committed snapshot cannot be replaced. |
| `DELETE /api/snapshots/{snapshot_id}` | Deletes one copied Final and its linked History; Inventory is retained. |
| `PUT /api/database/restore` | Validates and stores an uploaded SQLite copy; it does not replace the active database. |
| `POST /api/shutdown` | Stops only the launched loopback host and requires its one-launch authorization token. |

The host exposes JSON errors with an HTTP error status for invalid, oversized,
missing, or unavailable resources. It does not automatically synchronize
SQLite with IndexedDB. Full profile/computer transfer uses the portable Next
archive and explicit import.
