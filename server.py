#!/usr/bin/env python3
"""OfferFlow server: static files, account sessions, and isolated SQLite state."""

import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = APP_DIR / "data" / "offerflow.db"
MAX_BODY_BYTES = 2 * 1024 * 1024
STATIC_PATHS = {"/", "/index.html", "/styles.css", "/auth-react.js", "/app.js"}
SESSION_COOKIE = "offerflow_session"
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_MAX_FAILURES = 8


class StateConflictError(Exception):
    def __init__(self, current_revision):
        super().__init__("state was changed by another device")
        self.current_revision = current_revision


class RegistrationError(ValueError):
    pass


class PasswordChangeError(ValueError):
    pass


def connect(db_path):
    connection = sqlite3.connect(str(db_path), timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def table_exists(connection, table_name):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)
    ).fetchone() is not None


def table_columns(connection, table_name):
    return {row["name"] for row in connection.execute("PRAGMA table_info(%s)" % table_name)}


def normalize_username(username):
    if not isinstance(username, str):
        raise RegistrationError("用户名格式不正确")
    display = unicodedata.normalize("NFKC", username).strip()
    if not 3 <= len(display) <= 32:
        raise RegistrationError("用户名需为 3 至 32 个字符")
    if not all(character.isalnum() or character in "_.-" for character in display):
        raise RegistrationError("用户名只能包含文字、数字、点、下划线或连字符")
    return display, display.casefold()


def validate_password(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise RegistrationError("密码需为 10 至 128 个字符")
    return password


def hash_password(password):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return "pbkdf2_sha256$%d$%s$%s" % (
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password, encoded):
    if not encoded:
        return False
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_text.encode("ascii"))
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iterations)
        )
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError, UnicodeEncodeError):
        return False


def create_current_schema(connection):
    statements = (
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            managed_key TEXT UNIQUE,
            disabled INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id)",
        "CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at)",
        """
        CREATE TABLE IF NOT EXISTS lists (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY(user_id, id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS applications (
            user_id TEXT NOT NULL,
            id TEXT NOT NULL,
            list_id TEXT NOT NULL,
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
            position INTEGER NOT NULL,
            PRIMARY KEY(user_id, id),
            FOREIGN KEY(user_id, list_id) REFERENCES lists(user_id, id) ON DELETE CASCADE
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS applications_list_position
        ON applications(user_id, list_id, position)
        """,
        """
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(user_id, key)
        )
        """,
    )
    for statement in statements:
        connection.execute(statement)


def migrate_legacy_database(connection, bootstrap_username, bootstrap_password):
    username, username_key = normalize_username(bootstrap_username)
    user_id = secrets.token_hex(16)
    password_hash = hash_password(bootstrap_password) if bootstrap_password else None
    now = int(time.time())

    connection.execute("ALTER TABLE applications RENAME TO legacy_applications")
    connection.execute("ALTER TABLE lists RENAME TO legacy_lists")
    connection.execute("ALTER TABLE settings RENAME TO legacy_settings")
    connection.execute("DROP INDEX IF EXISTS applications_list_position")
    create_current_schema(connection)
    connection.execute(
        "INSERT INTO users(id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, username, username_key, password_hash, now),
    )
    connection.execute(
        "INSERT INTO lists(user_id, id, name, position) SELECT ?, id, name, position FROM legacy_lists",
        (user_id,),
    )
    connection.execute(
        """
        INSERT INTO applications(
            user_id, id, list_id, company, company_type, role, application_date,
            status, notes, interview_date, interview_time, interview_round,
            interview_mode, interview_place, position
        )
        SELECT ?, id, list_id, company, company_type, role, application_date,
               status, notes, interview_date, interview_time, interview_round,
               interview_mode, interview_place, position
        FROM legacy_applications
        """,
        (user_id,),
    )
    connection.execute(
        "INSERT INTO user_settings(user_id, key, value) SELECT ?, key, value FROM legacy_settings",
        (user_id,),
    )
    connection.execute("DROP TABLE legacy_applications")
    connection.execute("DROP TABLE legacy_lists")
    connection.execute("DROP TABLE legacy_settings")


def initialize_database(db_path, bootstrap_username="offerflow", bootstrap_password=None):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("BEGIN IMMEDIATE")
        if table_exists(connection, "lists") and "user_id" not in table_columns(connection, "lists"):
            migrate_legacy_database(connection, bootstrap_username, bootstrap_password)
        else:
            create_current_schema(connection)
            user_columns = table_columns(connection, "users")
            if "managed_key" not in user_columns:
                connection.execute("ALTER TABLE users ADD COLUMN managed_key TEXT")
                connection.execute("CREATE UNIQUE INDEX users_managed_key ON users(managed_key)")
            if "disabled" not in user_columns:
                connection.execute("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")
            if bootstrap_password and not connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                username, username_key = normalize_username(bootstrap_username)
                user_id = secrets.token_hex(16)
                connection.execute(
                    "INSERT INTO users(id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user_id, username, username_key, hash_password(bootstrap_password), int(time.time())),
                )
                initialize_user_state(connection, user_id)


def get_user_by_username(db_path, username):
    try:
        _, username_key = normalize_username(username)
    except RegistrationError:
        return None
    with connect(db_path) as connection:
        return connection.execute(
            "SELECT id, username, username_key, password_hash, disabled FROM users WHERE username_key = ?",
            (username_key,),
        ).fetchone()


def setup_required(db_path):
    with connect(db_path) as connection:
        return connection.execute(
            "SELECT 1 FROM users WHERE password_hash IS NULL LIMIT 1"
        ).fetchone() is not None


def password_change_enabled(db_path, user, users_config_path):
    if not user or not users_config_path:
        return False
    with connect(db_path) as connection:
        return connection.execute(
            "SELECT 1 FROM users WHERE id = ? AND managed_key IS NOT NULL",
            (user["id"],),
        ).fetchone() is not None


def initialize_user_state(connection, user_id):
    list_id = "list-" + secrets.token_hex(8)
    connection.execute(
        "INSERT INTO lists(user_id, id, name, position) VALUES (?, ?, ?, 0)",
        (user_id, list_id, "我的求职记录"),
    )
    connection.executemany(
        "INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?)",
        ((user_id, "active_list_id", list_id), (user_id, "revision", "0")),
    )


def register_user(db_path, username, password, supplied_code=None, required_code=None):
    username, username_key = normalize_username(username)
    password = validate_password(password)
    with connect(db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        pending = connection.execute(
            "SELECT id FROM users WHERE password_hash IS NULL ORDER BY created_at LIMIT 1"
        ).fetchone()
        existing = connection.execute(
            "SELECT id FROM users WHERE username_key = ?", (username_key,)
        ).fetchone()
        if existing and (not pending or existing["id"] != pending["id"]):
            raise RegistrationError("该用户名已被使用")
        if pending:
            user_id = pending["id"]
            connection.execute(
                "UPDATE users SET username = ?, username_key = ?, password_hash = ? WHERE id = ?",
                (username, username_key, hash_password(password), user_id),
            )
        else:
            if required_code and not hmac.compare_digest(
                str(supplied_code or "").encode("utf-8"), required_code.encode("utf-8")
            ):
                raise RegistrationError("邀请码不正确")
            user_id = secrets.token_hex(16)
            connection.execute(
                "INSERT INTO users(id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, username, username_key, hash_password(password), int(time.time())),
            )
            initialize_user_state(connection, user_id)
    return {"id": user_id, "username": username}


def authenticate_user(db_path, username, password):
    user = get_user_by_username(db_path, username)
    if not user or user["disabled"] or not isinstance(password, str) or not verify_password(password, user["password_hash"]):
        return None
    return {"id": user["id"], "username": user["username"]}


def session_token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def create_session(db_path, user_id):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with connect(db_path) as connection:
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        connection.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (session_token_hash(token), user_id, now + SESSION_TTL_SECONDS, now),
        )
    return token


def find_session_user(db_path, token):
    if not token:
        return None
    try:
        token_hash = session_token_hash(token)
    except (AttributeError, UnicodeEncodeError):
        return None
    now = int(time.time())
    with connect(db_path) as connection:
        row = connection.execute(
            """
            SELECT users.id, users.username
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.disabled = 0
            """,
            (token_hash, now),
        ).fetchone()
    return {"id": row["id"], "username": row["username"]} if row else None


def delete_session(db_path, token):
    if not token:
        return
    try:
        token_hash = session_token_hash(token)
    except (AttributeError, UnicodeEncodeError):
        return
    with connect(db_path) as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def write_locked_json(file_handle, payload):
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    file_handle.seek(0)
    file_handle.write(serialized)
    file_handle.truncate()
    file_handle.flush()
    os.fsync(file_handle.fileno())


def change_password(db_path, users_config_path, user_id, current_password, new_password, session_token):
    if not isinstance(current_password, str):
        raise PasswordChangeError("当前密码不正确")
    try:
        new_password = validate_password(new_password)
    except RegistrationError as error:
        raise PasswordChangeError(str(error)) from error
    if current_password == new_password:
        raise PasswordChangeError("新密码不能与当前密码相同")
    if not users_config_path:
        raise PasswordChangeError("该账号暂不支持自助修改密码")

    new_password_hash = hash_password(new_password)
    current_token_hash = session_token_hash(session_token) if session_token else None
    with connect(db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        user = connection.execute(
            "SELECT password_hash, managed_key FROM users WHERE id = ? AND disabled = 0",
            (user_id,),
        ).fetchone()
        if not user or not verify_password(current_password, user["password_hash"]):
            raise PasswordChangeError("当前密码不正确")
        if not user["managed_key"]:
            raise PasswordChangeError("该账号未纳入服务器账号配置")

        try:
            with users_config_path.open("r+", encoding="utf-8") as config_file:
                fcntl.flock(config_file.fileno(), fcntl.LOCK_EX)
                original = config_file.read()
                config = json.loads(original)
                entries = config.get("users") if isinstance(config, dict) else None
                if not isinstance(entries, list):
                    raise PasswordChangeError("服务器账号配置格式不正确")
                managed_entry = next(
                    (
                        entry
                        for entry in entries
                        if isinstance(entry, dict) and entry.get("key") == user["managed_key"]
                    ),
                    None,
                )
                if managed_entry is None:
                    raise PasswordChangeError("服务器账号配置中未找到该账号")
                managed_entry.pop("password", None)
                managed_entry["passwordHash"] = new_password_hash
                try:
                    write_locked_json(config_file, config)
                    connection.execute(
                        "UPDATE users SET password_hash = ? WHERE id = ?",
                        (new_password_hash, user_id),
                    )
                    if current_token_hash:
                        connection.execute(
                            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                            (user_id, current_token_hash),
                        )
                    else:
                        connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                    connection.commit()
                except Exception:
                    write_locked_json(config_file, json.loads(original))
                    raise
        except FileNotFoundError as error:
            raise PasswordChangeError("服务器账号配置文件不存在") from error
        except PermissionError as error:
            raise PasswordChangeError("服务器账号配置文件不可写") from error
        except json.JSONDecodeError as error:
            raise PasswordChangeError("服务器账号配置格式不正确") from error


def read_state(db_path, user_id):
    with connect(db_path) as connection:
        connection.execute("BEGIN")
        revision_row = connection.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = 'revision'",
            (user_id,),
        ).fetchone()
        revision = int(revision_row["value"]) if revision_row else 0
        list_rows = connection.execute(
            "SELECT id, name FROM lists WHERE user_id = ? ORDER BY position, rowid",
            (user_id,),
        ).fetchall()
        if not list_rows:
            return {"initialized": False, "revision": revision, "state": None}

        active_row = connection.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = 'active_list_id'",
            (user_id,),
        ).fetchone()
        active_list_id = active_row["value"] if active_row else list_rows[0]["id"]
        lists = []
        for list_row in list_rows:
            application_rows = connection.execute(
                """
                SELECT * FROM applications
                WHERE user_id = ? AND list_id = ?
                ORDER BY position, rowid
                """,
                (user_id, list_row["id"]),
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
            lists.append({"id": list_row["id"], "name": list_row["name"], "applications": applications})

        if active_list_id not in {item["id"] for item in lists}:
            active_list_id = lists[0]["id"]
        return {
            "initialized": True,
            "revision": revision,
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
                    "interview": None if interview is None else {
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
            {"id": list_id, "name": name, "position": list_index, "applications": validated_applications}
        )

    active_list_id = require_string(active_list_id, "activeListId", 160)
    if active_list_id not in list_ids:
        raise ValueError("activeListId must reference an existing list")
    return {"activeListId": active_list_id, "lists": validated_lists}


def write_state(db_path, user_id, payload, expected_revision=None):
    state = validate_state(payload)
    with connect(db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        revision_row = connection.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = 'revision'", (user_id,)
        ).fetchone()
        current_revision = int(revision_row["value"]) if revision_row else 0
        if expected_revision is not None and expected_revision != current_revision:
            raise StateConflictError(current_revision)

        connection.execute("DELETE FROM applications WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM lists WHERE user_id = ?", (user_id,))
        for item in state["lists"]:
            connection.execute(
                "INSERT INTO lists(user_id, id, name, position) VALUES (?, ?, ?, ?)",
                (user_id, item["id"], item["name"], item["position"]),
            )
            for application in item["applications"]:
                interview = application["interview"] or {}
                connection.execute(
                    """
                    INSERT INTO applications(
                        user_id, id, list_id, company, company_type, role, application_date,
                        status, notes, interview_date, interview_time, interview_round,
                        interview_mode, interview_place, position
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id, application["id"], item["id"], application["company"],
                        application["type"], application["role"], application["date"],
                        application["status"], application["notes"], interview.get("date"),
                        interview.get("time"), interview.get("round"), interview.get("mode"),
                        interview.get("place"), application["position"],
                    ),
                )
        connection.execute(
            """
            INSERT INTO user_settings(user_id, key, value) VALUES (?, 'active_list_id', ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
            """,
            (user_id, state["activeListId"]),
        )
        next_revision = current_revision + 1
        connection.execute(
            """
            INSERT INTO user_settings(user_id, key, value) VALUES (?, 'revision', ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
            """,
            (user_id, str(next_revision)),
        )
    return next_revision


class OfferFlowHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    @property
    def db_path(self):
        return self.server.db_path

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        super().end_headers()

    def send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("request body size is invalid") from error
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ValueError("request body size is invalid")
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def csrf_allowed(self):
        if self.headers.get("X-OfferFlow-CSRF") == "1":
            return True
        self.send_json({"ok": False, "error": "请求校验失败，请刷新页面后重试"}, status=403)
        return False

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = cookie.get(SESSION_COOKIE)
            return morsel.value if morsel else None
        except Exception:
            return None

    def current_user(self):
        return find_session_user(self.db_path, self.session_token())

    def require_user(self):
        user = self.current_user()
        if user:
            return user
        self.send_json({"ok": False, "error": "请先登录", "code": "authentication_required"}, status=401)
        return None

    def auth_payload(self, user=None):
        return {
            "authenticated": bool(user),
            "user": user,
            "registration": {
                "enabled": self.server.registration_enabled,
                "inviteRequired": bool(self.server.registration_code),
            },
            "passwordChangeEnabled": password_change_enabled(
                self.db_path, user, self.server.users_config_path
            ),
            "setupRequired": setup_required(self.db_path),
        }

    def cookie_header(self, token, clear=False):
        if clear:
            value = "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % SESSION_COOKIE
        else:
            value = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
                SESSION_COOKIE, token, SESSION_TTL_SECONDS
            )
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip()
        if forwarded_proto == "https" or self.server.secure_cookies:
            value += "; Secure"
        return value

    def client_ip(self):
        peer = self.client_address[0]
        if peer in {"127.0.0.1", "::1"}:
            return self.headers.get("X-Real-IP", peer)
        return peer

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            try:
                with connect(self.db_path) as connection:
                    connection.execute("SELECT 1").fetchone()
                self.send_json({"ok": True, "database": "sqlite"})
            except sqlite3.Error:
                self.send_json({"ok": False, "error": "database unavailable"}, status=503)
            return
        if path == "/api/auth/session":
            self.send_json(self.auth_payload(self.current_user()))
            return
        if path == "/api/state":
            user = self.require_user()
            if user:
                self.send_json(read_state(self.db_path, user["id"]))
            return
        if path not in STATIC_PATHS:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path not in STATIC_PATHS:
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in {
            "/api/auth/login",
            "/api/auth/register",
            "/api/auth/logout",
            "/api/auth/password",
        }:
            self.send_error(404)
            return
        if not self.csrf_allowed():
            return
        try:
            if path == "/api/auth/logout":
                delete_session(self.db_path, self.session_token())
                self.send_json(
                    {"ok": True}, headers={"Set-Cookie": self.cookie_header("", clear=True)}
                )
                return

            if path == "/api/auth/password":
                user = self.require_user()
                if not user:
                    return
                payload = self.read_json_body()
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                change_password(
                    self.db_path,
                    self.server.users_config_path,
                    user["id"],
                    payload.get("currentPassword"),
                    payload.get("newPassword"),
                    self.session_token(),
                )
                self.send_json({"ok": True})
                return

            payload = self.read_json_body()
            if not isinstance(payload, dict):
                raise ValueError("request body must be an object")
            if path == "/api/auth/register":
                if not self.server.registration_enabled and not setup_required(self.db_path):
                    self.send_json({"ok": False, "error": "当前不开放自助注册"}, status=403)
                    return
                user = register_user(
                    self.db_path,
                    payload.get("username"),
                    payload.get("password"),
                    payload.get("inviteCode"),
                    self.server.registration_code,
                )
                token = create_session(self.db_path, user["id"])
                self.send_json(
                    {"ok": True, **self.auth_payload(user)},
                    status=201,
                    headers={"Set-Cookie": self.cookie_header(token)},
                )
                return

            client_ip = self.client_ip()
            if self.server.login_rate_limited(client_ip):
                self.send_json(
                    {"ok": False, "error": "登录尝试过多，请稍后再试"},
                    status=429,
                    headers={"Retry-After": str(LOGIN_WINDOW_SECONDS)},
                )
                return
            user = authenticate_user(self.db_path, payload.get("username"), payload.get("password"))
            if not user:
                self.server.record_login_failure(client_ip)
                self.send_json({"ok": False, "error": "用户名或密码不正确"}, status=401)
                return
            self.server.clear_login_failures(client_ip)
            token = create_session(self.db_path, user["id"])
            self.send_json(
                {"ok": True, **self.auth_payload(user)},
                headers={"Set-Cookie": self.cookie_header(token)},
            )
        except RegistrationError as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
        except PasswordChangeError as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
        except sqlite3.IntegrityError:
            self.send_json({"ok": False, "error": "该用户名已被使用"}, status=409)
        except sqlite3.Error:
            self.send_json({"ok": False, "error": "数据库暂时不可用"}, status=500)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != "/api/state":
            self.send_error(404)
            return
        if not self.csrf_allowed():
            return
        user = self.require_user()
        if not user:
            return
        try:
            payload = self.read_json_body()
            expected_revision_header = self.headers.get("If-Match")
            if expected_revision_header is None:
                raise ValueError("If-Match header is required")
            try:
                expected_revision = int(expected_revision_header.strip().strip('"'))
            except ValueError as error:
                raise ValueError("If-Match must contain a revision number") from error
            revision = write_state(self.db_path, user["id"], payload, expected_revision)
            self.send_json(
                {"ok": True, "revision": revision, "savedAt": datetime.now(timezone.utc).isoformat()}
            )
        except StateConflictError as error:
            latest = read_state(self.db_path, user["id"])
            self.send_json(
                {"ok": False, "error": str(error), "revision": error.current_revision, "latest": latest},
                status=409,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
        except sqlite3.Error:
            self.send_json({"ok": False, "error": "数据库暂时不可用"}, status=500)

    def log_message(self, message, *args):
        print("[%s] %s" % (self.log_date_time_string(), message % args), flush=True)


class OfferFlowServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(
        self,
        server_address,
        handler_class,
        db_path,
        registration_code=None,
        registration_enabled=True,
        users_config_path=None,
        secure_cookies=False,
    ):
        self.db_path = db_path
        self.registration_code = registration_code
        self.registration_enabled = registration_enabled
        self.users_config_path = users_config_path
        self.secure_cookies = secure_cookies
        self.auth_failures = {}
        self.auth_failure_lock = threading.Lock()
        super().__init__(server_address, handler_class)

    def login_rate_limited(self, client_ip):
        threshold = time.time() - LOGIN_WINDOW_SECONDS
        with self.auth_failure_lock:
            recent = [value for value in self.auth_failures.get(client_ip, []) if value > threshold]
            self.auth_failures[client_ip] = recent
            return len(recent) >= LOGIN_MAX_FAILURES

    def record_login_failure(self, client_ip):
        with self.auth_failure_lock:
            self.auth_failures.setdefault(client_ip, []).append(time.time())

    def clear_login_failures(self, client_ip):
        with self.auth_failure_lock:
            self.auth_failures.pop(client_ip, None)


def main():
    parser = argparse.ArgumentParser(description="Run the OfferFlow app")
    parser.add_argument("--host", default=os.environ.get("OFFERFLOW_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "4173")))
    parser.add_argument(
        "--db", type=Path, default=Path(os.environ.get("OFFERFLOW_DB", str(DEFAULT_DB_PATH)))
    )
    args = parser.parse_args()

    bootstrap_username = os.environ.get("OFFERFLOW_USERNAME", "offerflow")
    bootstrap_password = os.environ.get("OFFERFLOW_PASSWORD")
    registration_code = os.environ.get("OFFERFLOW_REGISTRATION_CODE")
    registration_enabled = os.environ.get("OFFERFLOW_ALLOW_REGISTRATION", "true").lower() in {
        "1", "true", "yes"
    }
    secure_cookies = os.environ.get("OFFERFLOW_SECURE_COOKIES", "").lower() in {"1", "true", "yes"}
    users_config_value = os.environ.get("OFFERFLOW_USERS_CONFIG")
    users_config_path = Path(users_config_value).resolve() if users_config_value else None

    db_path = args.db.expanduser().resolve()
    initialize_database(db_path, bootstrap_username, bootstrap_password)
    app_server = OfferFlowServer(
        (args.host, args.port),
        OfferFlowHandler,
        db_path,
        registration_code=registration_code,
        registration_enabled=registration_enabled,
        users_config_path=users_config_path,
        secure_cookies=secure_cookies,
    )
    print("OfferFlow running at http://%s:%s" % (args.host, args.port), flush=True)
    print("SQLite database: %s" % db_path, flush=True)
    print("Authentication: application accounts", flush=True)
    print(
        "Self-registration: %s" % ("enabled" if registration_enabled else "disabled"),
        flush=True,
    )
    try:
        app_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app_server.server_close()


if __name__ == "__main__":
    main()
