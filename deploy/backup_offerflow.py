#!/usr/bin/env python3
"""Create a consistent SQLite backup and prune backups older than 14 days."""

import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


DATABASE = Path("/opt/offerflow/data/offerflow.db")
BACKUP_DIR = Path("/opt/offerflow/backups")
RETENTION = timedelta(days=14)


def main():
    if not DATABASE.exists():
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = BACKUP_DIR / ("offerflow-%s.db" % timestamp)
    temporary = destination.with_suffix(".tmp")

    with sqlite3.connect(str(DATABASE)) as source:
        with sqlite3.connect(str(temporary)) as backup:
            source.backup(backup)
            integrity = backup.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError("backup integrity check failed: %s" % integrity)
    temporary.replace(destination)
    for suffix in ("-shm", "-wal"):
        temporary.with_name(temporary.name + suffix).unlink(missing_ok=True)

    cutoff = time.time() - RETENTION.total_seconds()
    for path in BACKUP_DIR.glob("offerflow-*.db"):
        if path.stat().st_mtime < cutoff:
            path.unlink()


if __name__ == "__main__":
    main()
