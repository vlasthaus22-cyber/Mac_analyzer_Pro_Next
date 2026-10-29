# Optional loopback host API

The Python host is an optional, same-computer service bound to `127.0.0.1`.
It is not a shared server and does not replace browser IndexedDB. Browser data
is copied to the host only after an explicit user action. Requests from
non-loopback hosts or unapproved origins are rejected; equipment records and
credentials must not be sent to external services.

## Read operations

| Method and route | Result |
| --- | --- |
| `GET /api/health` | Host readiness and storage mode. |
| `GET /api/storage/structure` | Resolved data and backup locations. |
| `GET /api/system/diagnostics` | Read-only application, storage, SQLite, and API checks. |
| `GET /api/database/summary` | SQLite integrity and stored collection counts. |
| `GET`, `HEAD /api/database/export` | Verified SQLite backup stream; `HEAD` reports availability without retaining a temporary export. |
| `GET /api/settings?key=theme,columns` | Settings; selected keys may be requested when the full response exceeds its bound. |
| `GET /api/devices?limit=100&after=0` | Bounded resolved Inventory page. |
| `GET /api/history?limit=100&after=0` | Bounded resolved History page. |
| `GET /api/snapshots?limit=100&after=0` | Bounded Final snapshot metadata page. |
| `GET /api/snapshots/{snapshot_id}/devices?limit=100&after=0` | Bounded devices from one copied Final. |

## Explicit writes

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
