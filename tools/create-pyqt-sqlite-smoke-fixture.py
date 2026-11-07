"""Create a tiny synthetic SQLite database matching all eight PyQt tables."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error(f"refusing to overwrite existing file: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(output) as connection:
        connection.executescript(
            """
            CREATE TABLE mac_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, mac_formatted TEXT,
              oui_3byte TEXT, mac_5byte TEXT, timestamp TIMESTAMP, source_file TEXT,
              vendor TEXT, vendor_confidence REAL, vendor_source TEXT, model TEXT,
              model_confidence REAL, model_source TEXT, ip TEXT, address TEXT, room TEXT,
              switch_ip TEXT, switch_port TEXT, match_details TEXT
            );
            INSERT INTO mac_history (mac, timestamp, source_file, vendor, model, ip, room)
              VALUES ('00:11:22:33:44:51', '2026-10-01T10:00:00Z', 'pyqt-smoke-history.csv',
                      'PyQt Smoke Vendor', 'PyQt Smoke Model', '192.0.2.51', 'Smoke Room');

            CREATE TABLE mac_movements (
              id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, from_value TEXT,
              to_value TEXT, field_name TEXT, timestamp TIMESTAMP, source_file TEXT
            );
            INSERT INTO mac_movements (mac, from_value, to_value, field_name, timestamp, source_file)
              VALUES ('00:11:22:33:44:52', 'Gi1/0/1', 'Gi1/0/2', 'switch_port',
                      '2026-10-01T10:01:00Z', 'pyqt-smoke-movements.csv');

            CREATE TABLE oui_vendor_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT, oui_3byte TEXT NOT NULL UNIQUE,
              vendor TEXT NOT NULL, occurrences INTEGER DEFAULT 1, first_seen TIMESTAMP,
              last_seen TIMESTAMP
            );
            INSERT INTO oui_vendor_history (oui_3byte, vendor, occurrences, first_seen, last_seen)
              VALUES ('A1B2C3', 'PyQt Smoke OUI Vendor', 2,
                      '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');

            CREATE TABLE mac5_model_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT, mac_5byte TEXT NOT NULL UNIQUE,
              model TEXT NOT NULL, occurrences INTEGER DEFAULT 1, first_seen TIMESTAMP,
              last_seen TIMESTAMP
            );
            INSERT INTO mac5_model_history (mac_5byte, model, occurrences, first_seen, last_seen)
              VALUES ('A1B2C3D4E5', 'PyQt Smoke Prefix Model', 3,
                      '2026-09-02T00:00:00Z', '2026-10-02T00:00:00Z');

            CREATE TABLE history_loads (
              id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, load_date TIMESTAMP,
              devices_count INTEGER, new_vendors_added INTEGER, new_models_added INTEGER,
              enriched_from_history INTEGER
            );
            INSERT INTO history_loads (filename, load_date, devices_count)
              VALUES ('pyqt-smoke-load.csv', '2026-10-01T10:02:00Z', 2);

            CREATE TABLE daily_stats (
              id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, total_devices INTEGER,
              new_devices INTEGER, vendors_count INTEGER, rooms_count INTEGER,
              devices_with_address INTEGER, devices_with_room INTEGER
            );
            INSERT INTO daily_stats (date, total_devices, new_devices)
              VALUES ('2026-10-01', 2, 1);

            CREATE TABLE analysis_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, filename TEXT,
              devices_count INTEGER, strategy TEXT, processing_time REAL
            );
            INSERT INTO analysis_history (timestamp, filename, devices_count, strategy)
              VALUES ('2026-10-01T10:03:00Z', 'pyqt-smoke-analysis.csv', 2, 'union');

            CREATE TABLE performance_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT, timestamp TEXT,
              duration_seconds REAL, details TEXT
            );
            INSERT INTO performance_metrics (operation, timestamp, duration_seconds, details)
              VALUES ('pyqt_smoke_performance', '2026-10-01T10:04:00Z', 0.25, 'synthetic fixture');
            """
        )
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        tables = connection.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
    if integrity != "ok" or tables != 8:
        output.unlink(missing_ok=True)
        raise RuntimeError(f"fixture validation failed: integrity={integrity!r}, tables={tables}")
    print(f"Synthetic PyQt SQLite fixture: {output} ({tables} tables, integrity={integrity})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
