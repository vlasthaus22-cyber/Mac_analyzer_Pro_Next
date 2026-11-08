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
| `GET /api/database/search?query=codec&limit=100` | Bounded search across the explicitly copied Inventory/History plus local vendor-model and IP-mapping records. Resolved devices use the browser's explicit searchable fields and custom-column names/values; unrelated JSON metadata is ignored. Text matching uses browser-compatible NFKC and Unicode lowercase semantics; `%` and `_` are literal characters, not SQL wildcards. The optional-host screen exposes this route only on its same-computer loopback origin. Results contain a compact escaped-data projection, at most 500 rows and 1 MiB; the default query is the latest device records. |
| `POST /api/database/maintenance` | JSON `{ "integrity": true, "optimize": true, "vacuum": false }`; checks SQLite integrity, runs `PRAGMA optimize`, and runs `VACUUM` only when explicitly requested. VACUUM always requires a successful integrity check. The operation affects only the optional-host SQLite copy; IndexedDB and the active Final are untouched. Results include bounded counts and before/after database sizes. |
| `GET`, `HEAD /api/database/export` | Verified SQLite backup stream; `HEAD` reports availability without retaining a temporary export. |
| `GET /api/settings?key=theme,columns` | Settings; selected keys may be requested when the full response exceeds its bound. |
| `GET /api/devices?limit=100&after=0` | Bounded resolved Inventory page. |
| `GET /api/history?limit=100&after=0` | Bounded resolved History page; each event includes its stable increasing SQLite `id`, also used by the exclusive `after` cursor. |
| `GET /api/snapshots?limit=100&after=0` | Bounded Final snapshot metadata page. |
| `GET /api/snapshots/{snapshot_id}/devices?limit=100&after=0` | Bounded devices from one copied Final. |
| `GET /api/workspace-cache/files` | Compact metadata for source files stored in the local workspace cache; no paths or file bytes. |
| `GET`, `HEAD /api/workspace-cache/files/{token}` | Stream a cached source file by opaque token. |

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
| `PUT /api/devices` | JSON `{ "devices": [ ... ] }`, up to 500 records; explicit copy of resolved Inventory. The browser adapter transfers normalized identity, MAC aliases and truncation flags, vendor/model confidence and provenance, OUI, device/location fields, possible-IP evidence and truncation, custom-field sources, field sources, conflicts, observation counts, and Inventory observation state (`firstSeen`, `lastSeen`, `lastMissing`, `present`, `snapshotId`). Alternate MAC and possible-IP arrays are each bounded to the browser limit of 100 entries; additive host merges preserve first-seen order and carry truncation forward. Possible IPs are normalized by the browser IP rule on initial insert and merge; invalid markers, invalid addresses, and normalized duplicates are discarded. Earlier `firstSeen` is retained, later `lastSeen`/`lastMissing` advance, and a stale copy cannot roll back `present` or the latest-present `snapshotId`. Strong-identity aliases match the browser resolver: internal ID `id`/`internalDeviceId`/`internal_device_id`, Device ID `deviceId`/`device_id`/`asset_id`, serial `serial`/`serialNumber`/`serial_number`, primary MAC `mac`/`macAddress`/`mac_address`/`macFormatted`/`mac_formatted`/`CallingStationID`, plus `alternateMacs`. The host derives canonical fields for indexed matching while retaining supplied aliases in the payload and indexing every supplied strong alias. Startup backfill adds any missing alias indexes and source-attributed diagnostics to existing rows without replacing device data. Conflicting aliases within a record are retained as at most 100 `conflicts` diagnostics with `conflictsTruncated` when needed; additive merges also cap the combined history at 100. A later record matching only a contradictory alias is rejected as a strong-identity conflict rather than merged. Different known primary MACs are always reported even if an alternate overlaps. If a unique higher-priority ID matches, the row is retained, the conflicting incoming MAC is kept only as an alternate, and the conflict is returned; if matching relies on the alternate MAC against a different known primary, the merge is rejected. An incoming primary MAC may fill an existing blank primary. `customFieldSources` is preserved along with `customFields`; a blank custom field takes its incoming source, while a different known value is kept as a `customField` conflict with key, selected/incoming values, and source, matching browser `mergeDevice`. |
| `PUT /api/history` | JSON `{ "events": [ ... ] }`; explicit copy of resolved History. Modified events require two known, different values: whitespace and non-breaking spaces are normalized, comparisons are case-insensitive, and the browser's empty markers (including unknown vendor/model and Russian placeholders) are rejected as changes. |
| `PUT /api/snapshots/{snapshot_id}` | Uploads a bounded `application/x-ndjson` stream for an explicitly copied Final; the browser generates frames up to 64 KiB and lets fetch backpressure advance the IndexedDB iterator without building a second full-size Blob; a committed snapshot cannot be replaced. |
| `PUT /api/workspace-cache/files?name=Main.xlsx&role=main&type=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet&lastModified=0` | Streams one explicitly selected CSV/TSV/TXT/JSON/XLS/XLSX/XLSM file as `application/octet-stream` into `data/imports/workspace-cache`. Each file is limited to 512 MiB; the cache is limited to 100 files/2 GiB. Only a sanitized name, role, MIME hint, last-modified time, size, SHA-256, and opaque token are stored as metadata. Upload uses a local temporary file and never a whole-file buffer or Base64 encoding. |
| `DELETE /api/workspace-cache/files/{token}` | Deletes only the cached file identified by its opaque token. |
| `DELETE /api/snapshots/{snapshot_id}` | Deletes one copied Final and its linked History; Inventory is retained. |
| `PUT /api/database/restore` | Validates and stores an uploaded SQLite copy; it does not replace the active database. |
| `POST /api/shutdown` | Stops only the launched loopback host and requires its one-launch authorization token. |

`PUT /api/devices` returns exact `savedCount`, `rejectedCount`, and diagnostic `conflictCount` separately. `conflicts` is a response sample capped at 100 entries and 512 KiB; `conflictsTruncated` is true when the sample omits diagnostics. The browser validates the response stream up to 2 MiB and reports both rejected records and diagnostic totals without implying that the sample is complete.

Workspace-cache writes are restricted to the same loopback origin. The host does
not log filenames or contents. This API persists files on the same computer; it
does not replace IndexedDB or process files on a remote server. The Enrichment
cards provide explicit save/restore/delete controls; see the workspace source
cache section below. The full browser smoke required to confirm item #547 is
still open.

Alternate MAC evidence follows browser `normalizeMac()`/`mergeAlternateMacs()` when copied to or merged by the host: accepted aliases are canonical uppercase colon-delimited values, duplicates and the primary MAC are omitted after every union, and invalid entries are discarded. The 100-entry cap is applied before primary-MAC filtering, matching the browser's truncation behavior at the boundary. This also normalizes legacy payload aliases when a later additive copy is merged.

The resolved Inventory `mac` field is stored in browser `normalizeMac()` form even if the input used lower-case, hyphen, dotted, or compact notation. If it is invalid, the first valid supported primary-MAC alias supplies the canonical field; the original supplied alias fields remain in the payload.

For display compatibility, the host separately applies browser `normalizeMacField()` semantics after searching all MAC aliases for a valid identity value. If none is valid, placeholders become an empty field and displayable all-zero/broadcast values remain normalized in the payload without becoming identity tokens.

`PUT /api/devices` accepts the browser aliases `deviceIp`/`device_ip`, `ipSwitch`/`ip_switch`/`nasIp`, `port`/`nasPortId`, `smartroom_id`, `host`/`host_name`, `name`, and `type`; it chooses the first valid IP alias in browser order, canonicalizes device and switch IP separately, and normalizes the selected port, SmartRoom ID, hostname, display name, and type before merging.

The same route normalizes `authenticationTime` with `receiptTime` as a fallback. It accepts the browser-supported Excel date serials, day-first dates, ISO dates, and timezone-bearing ISO timestamps, and stores a canonical UTC timestamp; impossible dates become empty.

Location hierarchy is inferred from the first parseable value in browser order: `locationPath`, `location`, `room`, then `address`. Five comma-separated components are required; blank components keep their positions. Explicit room/address fields are preserved when another field supplied the hierarchy path.

Custom Inventory fields follow browser `normalizeDevice()` validation: only `custom_<UUID>` keys with scalar, non-empty values are retained. `customFieldSources` is retained only for a value that survived the same normalization, so arbitrary keys and orphan provenance are ignored before an additive write.

Inventory source labels follow browser `normalize.unique(..., text)`: whitespace and empty markers are normalized, labels deduplicate case-insensitively while preserving first-seen order, and the current `source` is included in the merged `sources` list.

When an empty manufacturer or model is filled, the host refreshes its corresponding confidence and provenance as browser `mergeDevice()` does. Finite confidence values are clamped to 0–1, including a valid zero; stale confidence or source metadata does not outlive the newly assigned field value.

The resolved Inventory `ip` and `switchIp` fields use the browser IP canonicalizer on insert and merge. Device IP and switch IP remain separate; invalid values are treated as empty, equivalent addresses do not create conflicts, and legacy values are canonicalized when touched by a later additive merge.

Inventory merge diagnostics use the browser conflict identity: identity conflicts deduplicate by identifier and selected/alternative values, custom-field conflicts by key and incoming value, and other field conflicts by field, source, and incoming value. A repeated diagnostic keeps its first stored detail; a distinct incoming value remains visible.

For identity matching, `/api/devices` also accepts the browser's legacy alternate-MAC fields `secondaryMac`, `secondary_mac`, `mac2`, `additionalMac`, and `additional_mac`; these are retained in the record and indexed as alternate strong MAC aliases.

Textual Inventory and `customFields` writes and merges use the browser normalization contract: scalar values become text, whitespace is collapsed, shared empty markers and nested custom-field values are discarded, an incoming known value fills a legacy placeholder, and field/custom-field provenance is retained. When both existing and incoming known values disagree, the existing value is preserved and a new diagnostic (`field`, `selected`, `value`, `source`, plus custom-field `key`) is returned and stored, matching `mergeDevice`; equivalent text and repeated identical conflicts are deduplicated.

The host exposes JSON errors with an HTTP error status for invalid, oversized,
missing, or unavailable resources. It does not automatically synchronize
SQLite with IndexedDB. Full profile/computer transfer uses the portable Next
archive and explicit import.

### Workspace source-file cache

The Enrichment source cards expose an explicit **Save copy on this computer**
action when the optional host is open on its loopback HTTP origin. The user can
list, restore, and delete a cached source independently for Main, SmartRoom, or
DDIO. Nothing is uploaded automatically when a source is selected. Restored
files return to the matching role, are re-read by the normal local importer,
and their SHA-256 is checked against the cache metadata before the import.

- `GET /api/workspace-cache/files` returns at most 100 compact metadata rows.
- `PUT /api/workspace-cache/files?name=...&role=...&type=...&lastModified=...`
  streams one binary file to the cache. `role` must be `main`, `smartroom`, or
  `ddio`; supported extensions are CSV, TSV, TXT, JSON, XLS, XLSX, and XLSM.
- `GET /api/workspace-cache/files/{token}` streams the selected file back; the
  opaque 192-bit token is the only path component accepted.
- `DELETE /api/workspace-cache/files/{token}` removes only that cached file.

Files are stored under `data/imports/workspace-cache` with random filenames and
separate metadata; source paths are discarded. Each file is limited to 512 MiB,
and the cache to 100 files / 2 GiB. Uploads are streamed in 64 KiB blocks while
calculating SHA-256. All mutations require same-origin requests and every route
is available only to the local optional host. These source copies are local
working copies, not part of portable archives or Git releases.
