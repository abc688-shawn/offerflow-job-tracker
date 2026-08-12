#!/usr/bin/env python3
"""Synchronize administrator-managed OfferFlow accounts from a protected JSON file."""

import argparse
import fcntl
import hmac
import json
import re
import secrets
import stat
import time
from pathlib import Path

import server


MANAGED_KEY_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")


def load_config(path):
    file_mode = stat.S_IMODE(path.stat().st_mode)
    if file_mode & 0o007 or file_mode & 0o110:
        raise ValueError("config must use private file permissions such as chmod 660")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("config.version must be 1")
    entries = payload.get("users")
    if not isinstance(entries, list):
        raise ValueError("config.users must be an array")

    validated = []
    managed_keys = set()
    username_keys = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError("users[%d] must be an object" % index)
        managed_key = entry.get("key")
        if not isinstance(managed_key, str) or not MANAGED_KEY_PATTERN.fullmatch(managed_key):
            raise ValueError("users[%d].key is invalid" % index)
        username, username_key = server.normalize_username(entry.get("username"))
        password = entry.get("password")
        password_hash = entry.get("passwordHash")
        if (password is None) == (password_hash is None):
            raise ValueError("users[%d] must contain exactly one of password or passwordHash" % index)
        if password is not None and (not isinstance(password, str) or not 6 <= len(password) <= 128):
            raise ValueError("users[%d].password must contain 6 to 128 characters" % index)
        if password_hash is not None:
            if isinstance(password_hash, str) and not password_hash.startswith("pbkdf2_sha256$"):
                if not 6 <= len(password_hash) <= 128:
                    raise ValueError(
                        "users[%d].passwordHash is not a hash; use password for the initial password"
                        % index
                    )
                password = password_hash
                password_hash = None
            else:
                try:
                    _, iterations, salt, digest = password_hash.split("$", 3)
                    int(iterations)
                    if not salt or not digest:
                        raise ValueError
                except (AttributeError, ValueError) as error:
                    raise ValueError("users[%d].passwordHash is invalid" % index) from error
        enabled = entry.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("users[%d].enabled must be true or false" % index)
        if managed_key in managed_keys:
            raise ValueError("managed account keys must be unique")
        if username_key in username_keys:
            raise ValueError("managed usernames must be unique")
        managed_keys.add(managed_key)
        username_keys.add(username_key)
        validated.append(
            {
                "key": managed_key,
                "username": username,
                "username_key": username_key,
                "password": password,
                "password_hash": password_hash,
                "enabled": enabled,
            }
        )
    return validated


def sync_users(db_path, entries):
    server.initialize_database(db_path)
    summary = {"created": 0, "updated": 0, "unchanged": 0, "disabled": 0}
    with server.connect(db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for entry in entries:
            row = connection.execute(
                "SELECT id, username, username_key, password_hash, disabled FROM users WHERE managed_key = ?",
                (entry["key"],),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    """
                    SELECT id, username, username_key, password_hash, disabled
                    FROM users WHERE username_key = ? AND managed_key IS NULL
                    """,
                    (entry["username_key"],),
                ).fetchone()
            collision = connection.execute(
                "SELECT id FROM users WHERE username_key = ?",
                (entry["username_key"],),
            ).fetchone()
            if collision and (row is None or collision["id"] != row["id"]):
                raise ValueError("username is already used by another account: %s" % entry["username"])

            desired_password_hash = entry.get("password_hash")
            if desired_password_hash is None:
                desired_password_hash = (
                    row["password_hash"]
                    if row is not None and server.verify_password(entry["password"], row["password_hash"])
                    else server.hash_password(entry["password"])
                )

            if row is None:
                user_id = secrets.token_hex(16)
                connection.execute(
                    """
                    INSERT INTO users(
                        id, username, username_key, password_hash, managed_key, disabled, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        entry["username"],
                        entry["username_key"],
                        desired_password_hash,
                        entry["key"],
                        int(not entry["enabled"]),
                        int(time.time()),
                    ),
                )
                server.initialize_user_state(connection, user_id)
                summary["created"] += 1
                if not entry["enabled"]:
                    summary["disabled"] += 1
                entry["password_hash"] = desired_password_hash
                continue

            password_changed = not hmac.compare_digest(
                desired_password_hash.encode("utf-8"), row["password_hash"].encode("utf-8")
            )
            disabled = int(not entry["enabled"])
            changed = (
                row["username"] != entry["username"]
                or row["username_key"] != entry["username_key"]
                or row["disabled"] != disabled
                or password_changed
            )
            connection.execute(
                """
                UPDATE users
                SET username = ?, username_key = ?, password_hash = ?, managed_key = ?, disabled = ?
                WHERE id = ?
                """,
                (
                    entry["username"],
                    entry["username_key"],
                    desired_password_hash,
                    entry["key"],
                    disabled,
                    row["id"],
                ),
            )
            if password_changed or disabled or row["disabled"] != disabled:
                connection.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
            summary["updated" if changed else "unchanged"] += 1
            if disabled:
                summary["disabled"] += 1
            entry["password_hash"] = desired_password_hash
    return summary


def save_config(path, entries):
    payload = {
        "version": 1,
        "users": [
            {
                "key": entry["key"],
                "username": entry["username"],
                "passwordHash": entry["password_hash"],
                "enabled": entry["enabled"],
            }
            for entry in entries
        ],
    }
    with path.open("r+", encoding="utf-8") as config_file:
        fcntl.flock(config_file.fileno(), fcntl.LOCK_EX)
        server.write_locked_json(config_file, payload)


def main():
    parser = argparse.ArgumentParser(description="Synchronize OfferFlow user accounts")
    parser.add_argument(
        "--config", type=Path, default=Path("/opt/offerflow/offerflow-users.json")
    )
    parser.add_argument("--db", type=Path, default=server.DEFAULT_DB_PATH)
    args = parser.parse_args()
    entries = load_config(args.config.expanduser().resolve())
    summary = sync_users(args.db.expanduser().resolve(), entries)
    save_config(args.config.expanduser().resolve(), entries)
    print(
        "OfferFlow users synchronized: created={created}, updated={updated}, "
        "unchanged={unchanged}, disabled={disabled}".format(**summary)
    )


if __name__ == "__main__":
    main()
