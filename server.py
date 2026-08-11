#!/usr/bin/env python3
"""OfferFlow local server: static files plus a SQLite-backed state API."""

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = APP_DIR / "data" / "offerflow.db"
MAX_BODY_BYTES = 2 * 1024 * 1024


def connect(db_path):
    connection = sqlite3.connect(str(db_path), timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database(db_path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS lists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS applications (
                id TEXT PRIMARY KEY,
                list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
                company TEXT NOT NULL DEFAULT '',
                company_type TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT '',
                application_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                interview_date TEXT,
                interview_time TEXT,
                interview_round TEXT,
                interview_mode TEXT,
                interview_place TEXT,
                position INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS applications_list_position
            ON applications(list_id, position);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def read_state(db_path):
    with connect(db_path) as connection:
        list_rows = connection.execute(
            "SELECT id, name FROM lists ORDER BY position, rowid"
        ).fetchall()
        if not list_rows:
            return {"initialized": False, "state": None}

        active_row = connection.execute(
            "SELECT value FROM settings WHERE key = 'active_list_id'"
        ).fetchone()
        active_list_id = active_row["value"] if active_row else list_rows[0]["id"]
        lists = []

        for list_row in list_rows:
            application_rows = connection.execute(
                """
                SELECT * FROM applications
                WHERE list_id = ?
                ORDER BY position, rowid
                """,
                (list_row["id"],),
            ).fetchall()
            applications = []
            for row in application_rows:
                interview = None
                if row["interview_date"]:
                    interview = {
                        "date": row["interview_date"],
                        "time": row["interview_time"] or "",
                        "round": row["interview_round"] or "",
                        "mode": row["interview_mode"] or "",
                        "place": row["interview_place"] or "",
                    }
                applications.append(
                    {
                        "id": row["id"],
                        "company": row["company"],
                        "type": row["company_type"],
                        "role": row["role"],
                        "date": row["application_date"],
                        "status": row["status"],
                        "notes": row["notes"],
                        "interview": interview,
                    }
                )
            lists.append(
                {
                    "id": list_row["id"],
                    "name": list_row["name"],
                    "applications": applications,
                }
            )

        if active_list_id not in {item["id"] for item in lists}:
            active_list_id = lists[0]["id"]
        return {
            "initialized": True,
            "state": {"activeListId": active_list_id, "lists": lists},
        }


def require_string(value, field_name, max_length=4000):
    if not isinstance(value, str):
        raise ValueError("%s must be a string" % field_name)
    if len(value) > max_length:
        raise ValueError("%s is too long" % field_name)
    return value


def validate_state(payload):
    if not isinstance(payload, dict):
        raise ValueError("state must be an object")
    lists = payload.get("lists")
    active_list_id = payload.get("activeListId")
    if not isinstance(lists, list) or not lists:
        raise ValueError("state must contain at least one list")

    validated_lists = []
    list_ids = set()
    application_ids = set()
    for list_index, item in enumerate(lists):
        if not isinstance(item, dict):
            raise ValueError("list entries must be objects")
        list_id = require_string(item.get("id"), "list.id", 160)
        if not list_id or list_id in list_ids:
            raise ValueError("list ids must be unique and non-empty")
        list_ids.add(list_id)
        name = require_string(item.get("name"), "list.name", 160).strip()
        if not name:
            raise ValueError("list.name cannot be empty")
        applications = item.get("applications")
        if not isinstance(applications, list):
            raise ValueError("list.applications must be an array")

        validated_applications = []
        for application_index, application in enumerate(applications):
            if not isinstance(application, dict):
                raise ValueError("application entries must be objects")
            application_id = require_string(application.get("id"), "application.id", 160)
            if not application_id or application_id in application_ids:
                raise ValueError("application ids must be unique and non-empty")
            application_ids.add(application_id)
            interview = application.get("interview")
            if interview is not None and not isinstance(interview, dict):
                raise ValueError("application.interview must be an object or null")

            validated_applications.append(
                {
                    "id": application_id,
                    "company": require_string(application.get("company", ""), "application.company"),
                    "type": require_string(application.get("type", ""), "application.type", 160),
                    "role": require_string(application.get("role", ""), "application.role"),
                    "date": require_string(application.get("date", ""), "application.date", 32),
                    "status": require_string(application.get("status", ""), "application.status", 160),
                    "notes": require_string(application.get("notes", ""), "application.notes"),
                    "interview": None
                    if interview is None
                    else {
                        "date": require_string(interview.get("date", ""), "interview.date", 32),
                        "time": require_string(interview.get("time", ""), "interview.time", 32),
                        "round": require_string(interview.get("round", ""), "interview.round", 160),
                        "mode": require_string(interview.get("mode", ""), "interview.mode", 160),
                        "place": require_string(interview.get("place", ""), "interview.place"),
                    },
                    "position": application_index,
                }
            )
        validated_lists.append(
            {
                "id": list_id,
                "name": name,
                "position": list_index,
                "applications": validated_applications,
            }
        )

    active_list_id = require_string(active_list_id, "activeListId", 160)
    if active_list_id not in list_ids:
        raise ValueError("activeListId must reference an existing list")
    return {"activeListId": active_list_id, "lists": validated_lists}


def write_state(db_path, payload):
    state = validate_state(payload)
    with connect(db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM applications")
        connection.execute("DELETE FROM lists")
        for item in state["lists"]:
            connection.execute(
                "INSERT INTO lists(id, name, position) VALUES (?, ?, ?)",
                (item["id"], item["name"], item["position"]),
            )
            for application in item["applications"]:
                interview = application["interview"] or {}
                connection.execute(
                    """
                    INSERT INTO applications(
                        id, list_id, company, company_type, role, application_date,
                        status, notes, interview_date, interview_time,
                        interview_round, interview_mode, interview_place, position
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        application["id"],
                        item["id"],
                        application["company"],
                        application["type"],
                        application["role"],
                        application["date"],
                        application["status"],
                        application["notes"],
                        interview.get("date"),
                        interview.get("time"),
                        interview.get("round"),
                        interview.get("mode"),
                        interview.get("place"),
                        application["position"],
                    ),
                )
        connection.execute(
            """
            INSERT INTO settings(key, value) VALUES ('active_list_id', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (state["activeListId"],),
        )
        connection.commit()


class OfferFlowHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    @property
    def db_path(self):
        return self.server.db_path

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"ok": True, "database": "sqlite"})
            return
        if path == "/api/state":
            self.send_json(read_state(self.db_path))
            return
        if path == "/data" or path.startswith("/data/"):
            self.send_error(404)
            return
        super().do_GET()

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != "/api/state":
            self.send_error(404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > MAX_BODY_BYTES:
                raise ValueError("request body size is invalid")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            write_state(self.db_path, payload)
            self.send_json(
                {
                    "ok": True,
                    "savedAt": datetime.now(timezone.utc).isoformat(),
                }
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
        except sqlite3.Error as error:
            self.send_json({"ok": False, "error": "database error: %s" % error}, status=500)

    def log_message(self, message, *args):
        print("[%s] %s" % (self.log_date_time_string(), message % args), flush=True)


class OfferFlowServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address, handler_class, db_path):
        self.db_path = db_path
        super().__init__(server_address, handler_class)


def main():
    parser = argparse.ArgumentParser(description="Run the OfferFlow local app")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    args = parser.parse_args()

    db_path = args.db.expanduser().resolve()
    initialize_database(db_path)
    server = OfferFlowServer((args.host, args.port), OfferFlowHandler, db_path)
    print("OfferFlow running at http://%s:%s" % (args.host, args.port), flush=True)
    print("SQLite database: %s" % db_path, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
