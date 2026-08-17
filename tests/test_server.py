import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

import server
import manage_users


def example_state(name="测试列表", application_id="application-1"):
    return {
        "activeListId": "shared-list-id",
        "lists": [
            {
                "id": "shared-list-id",
                "name": name,
                "applications": [
                    {
                        "id": application_id,
                        "company": "示例公司",
                        "type": "私企",
                        "role": "后端工程师",
                        "date": "2026-08-11",
                        "status": "一面",
                        "notes": "官网投递",
                        "interview": {
                            "date": "2026-08-14",
                            "time": "10:00",
                            "round": "一面",
                            "mode": "线上",
                            "place": "视频会议",
                        },
                    }
                ],
            }
        ],
    }


class StateDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "offerflow.db"
        server.initialize_database(self.db_path)
        self.user = server.register_user(self.db_path, "first-user", "first-password")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_new_user_gets_an_empty_initialized_workspace(self):
        payload = server.read_state(self.db_path, self.user["id"])
        self.assertTrue(payload["initialized"])
        self.assertEqual(payload["revision"], 0)
        self.assertEqual(len(payload["state"]["lists"]), 1)
        self.assertEqual(payload["state"]["lists"][0]["applications"], [])

    def test_state_round_trip_preserves_interview(self):
        state = example_state()
        revision = server.write_state(self.db_path, self.user["id"], state, 0)
        self.assertEqual(revision, 1)
        self.assertEqual(
            server.read_state(self.db_path, self.user["id"]),
            {"initialized": True, "revision": 1, "state": state},
        )

    def test_users_are_isolated_even_when_client_ids_match(self):
        second_user = server.register_user(self.db_path, "second-user", "second-password")
        first_state = example_state("用户一")
        second_state = example_state("用户二")
        server.write_state(self.db_path, self.user["id"], first_state, 0)
        server.write_state(self.db_path, second_user["id"], second_state, 0)

        self.assertEqual(server.read_state(self.db_path, self.user["id"])["state"], first_state)
        self.assertEqual(server.read_state(self.db_path, second_user["id"])["state"], second_state)

    def test_rejects_stale_revision_without_overwriting_state(self):
        initial_state = example_state("初始列表")
        updated_state = example_state("已更新列表")
        self.assertEqual(server.write_state(self.db_path, self.user["id"], initial_state, 0), 1)
        with self.assertRaisesRegex(server.StateConflictError, "another device"):
            server.write_state(self.db_path, self.user["id"], updated_state, 0)
        self.assertEqual(server.read_state(self.db_path, self.user["id"])["state"], initial_state)

    def test_rejects_unknown_active_list(self):
        with self.assertRaisesRegex(ValueError, "activeListId"):
            server.write_state(
                self.db_path,
                self.user["id"],
                {"activeListId": "missing", "lists": [{"id": "existing", "name": "列表", "applications": []}]},
            )

    def test_rejects_duplicate_application_ids(self):
        state = example_state()
        state["lists"][0]["applications"].append(dict(state["lists"][0]["applications"][0]))
        with self.assertRaisesRegex(ValueError, "application ids"):
            server.write_state(self.db_path, self.user["id"], state)

    def test_personal_document_round_trip_and_revision_conflict(self):
        self.assertEqual(
            server.read_document(self.db_path, self.user["id"]),
            {"initialized": False, "revision": 0, "content": ""},
        )
        content = '<h2>投递规则</h2><p>同一家公司可投 2 个岗位</p><img src="data:image/png;base64,AA==">'
        self.assertEqual(
            server.write_document(self.db_path, self.user["id"], {"content": content}, 0),
            1,
        )
        self.assertEqual(server.read_document(self.db_path, self.user["id"])["content"], content)
        with self.assertRaisesRegex(server.StateConflictError, "another device"):
            server.write_document(self.db_path, self.user["id"], {"content": "stale"}, 0)

    def test_personal_documents_are_isolated_by_user(self):
        second_user = server.register_user(self.db_path, "second-user", "second-password")
        server.write_document(self.db_path, self.user["id"], {"content": "用户一"}, 0)
        server.write_document(self.db_path, second_user["id"], {"content": "用户二"}, 0)
        self.assertEqual(server.read_document(self.db_path, self.user["id"])["content"], "用户一")
        self.assertEqual(server.read_document(self.db_path, second_user["id"])["content"], "用户二")

    def test_password_is_hashed_and_authentication_is_case_insensitive(self):
        row = server.get_user_by_username(self.db_path, "FIRST-USER")
        self.assertNotEqual(row["password_hash"], "first-password")
        self.assertTrue(row["password_hash"].startswith("pbkdf2_sha256$"))
        self.assertEqual(
            server.authenticate_user(self.db_path, "FIRST-USER", "first-password")["id"],
            self.user["id"],
        )
        self.assertIsNone(server.authenticate_user(self.db_path, "first-user", "wrong-password"))


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "legacy.db"
        connection = sqlite3.connect(self.db_path)
        connection.executescript(
            """
            CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
            CREATE TABLE applications (
                id TEXT PRIMARY KEY,
                list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
                company TEXT NOT NULL DEFAULT '', company_type TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT '', application_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                interview_date TEXT, interview_time TEXT, interview_round TEXT,
                interview_mode TEXT, interview_place TEXT, position INTEGER NOT NULL
            );
            CREATE INDEX applications_list_position ON applications(list_id, position);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO lists VALUES ('autumn', '2026 秋招', 0);
            INSERT INTO applications VALUES (
                'old-app', 'autumn', '原有公司', '私企', '工程师', '2026-08-01',
                '已投递', '', NULL, NULL, NULL, NULL, NULL, 0
            );
            INSERT INTO settings VALUES ('active_list_id', 'autumn');
            """
        )
        connection.close()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_legacy_state_moves_to_bootstrap_account(self):
        server.initialize_database(self.db_path, "offerflow", "migration-password")
        user = server.authenticate_user(self.db_path, "offerflow", "migration-password")
        state = server.read_state(self.db_path, user["id"])["state"]
        self.assertEqual(state["lists"][0]["name"], "2026 秋招")
        self.assertEqual(state["lists"][0]["applications"][0]["company"], "原有公司")
        with server.connect(self.db_path) as connection:
            self.assertIn("user_id", server.table_columns(connection, "lists"))
            self.assertFalse(server.table_exists(connection, "settings"))

    def test_legacy_state_can_be_claimed_when_no_bootstrap_password_exists(self):
        server.initialize_database(self.db_path, "offerflow")
        self.assertTrue(server.setup_required(self.db_path))
        user = server.register_user(self.db_path, "offerflow", "claimed-password")
        self.assertEqual(server.read_state(self.db_path, user["id"])["state"]["lists"][0]["id"], "autumn")
        self.assertFalse(server.setup_required(self.db_path))


class BootstrapAccountTests(unittest.TestCase):
    def test_fresh_database_uses_configured_bootstrap_account(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "fresh.db"
            server.initialize_database(db_path, "owner-user", "owner-password")
            user = server.authenticate_user(db_path, "owner-user", "owner-password")
            self.assertIsNotNone(user)
            self.assertEqual(server.read_state(db_path, user["id"])["state"]["lists"][0]["applications"], [])


class ManagedAccountTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "managed.db"
        server.initialize_database(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_sync_creates_account_with_empty_isolated_state(self):
        summary = manage_users.sync_users(
            self.db_path,
            [{
                "key": "person-1", "username": "managed-user",
                "username_key": "managed-user", "password": "managed-password",
                "enabled": True,
            }],
        )
        user = server.authenticate_user(self.db_path, "managed-user", "managed-password")
        self.assertEqual(summary["created"], 1)
        self.assertEqual(server.read_state(self.db_path, user["id"])["state"]["lists"][0]["applications"], [])

    def test_stable_key_preserves_data_when_username_and_password_change(self):
        original = {
            "key": "person-1", "username": "old-name", "username_key": "old-name",
            "password": "old-password", "enabled": True,
        }
        manage_users.sync_users(self.db_path, [original])
        old_user = server.authenticate_user(self.db_path, "old-name", "old-password")
        server.write_state(self.db_path, old_user["id"], example_state("保留的数据"), 0)
        updated = {
            "key": "person-1", "username": "new-name", "username_key": "new-name",
            "password": "new-password", "enabled": True,
        }
        summary = manage_users.sync_users(self.db_path, [updated])
        new_user = server.authenticate_user(self.db_path, "new-name", "new-password")
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(new_user["id"], old_user["id"])
        self.assertEqual(server.read_state(self.db_path, new_user["id"])["state"]["lists"][0]["name"], "保留的数据")
        self.assertIsNone(server.authenticate_user(self.db_path, "old-name", "old-password"))

    def test_disabled_account_cannot_login_and_keeps_data(self):
        enabled = {
            "key": "person-1", "username": "managed-user", "username_key": "managed-user",
            "password": "managed-password", "enabled": True,
        }
        manage_users.sync_users(self.db_path, [enabled])
        user = server.authenticate_user(self.db_path, "managed-user", "managed-password")
        server.write_state(self.db_path, user["id"], example_state("停用后保留"), 0)
        manage_users.sync_users(self.db_path, [{**enabled, "enabled": False}])
        self.assertIsNone(server.authenticate_user(self.db_path, "managed-user", "managed-password"))
        self.assertEqual(server.read_state(self.db_path, user["id"])["state"]["lists"][0]["name"], "停用后保留")
        manage_users.sync_users(self.db_path, [enabled])
        self.assertIsNotNone(server.authenticate_user(self.db_path, "managed-user", "managed-password"))

    def test_config_requires_private_permissions(self):
        config_path = Path(self.temp_dir.name) / "users.json"
        config_path.write_text(
            json.dumps({
                "version": 1,
                "users": [{
                    "key": "person-1", "username": "managed-user",
                    "password": "managed-password", "enabled": True,
                }],
            }),
            encoding="utf-8",
        )
        config_path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "chmod 660"):
            manage_users.load_config(config_path)
        config_path.chmod(0o600)
        self.assertEqual(manage_users.load_config(config_path)[0]["username"], "managed-user")

    def test_sync_replaces_plaintext_config_password_with_hash(self):
        config_path = Path(self.temp_dir.name) / "users.json"
        config_path.write_text(
            json.dumps({
                "version": 1,
                "users": [{
                    "key": "person-1", "username": "managed-user",
                    "password": "managed-password", "enabled": True,
                }],
            }),
            encoding="utf-8",
        )
        config_path.chmod(0o660)
        entries = manage_users.load_config(config_path)
        manage_users.sync_users(self.db_path, entries)
        manage_users.save_config(config_path, entries)
        saved = json.loads(config_path.read_text(encoding="utf-8"))["users"][0]
        self.assertNotIn("password", saved)
        self.assertTrue(server.verify_password("managed-password", saved["passwordHash"]))

    def test_misplaced_plaintext_password_hash_is_recovered(self):
        config_path = Path(self.temp_dir.name) / "users.json"
        config_path.write_text(
            json.dumps({
                "version": 1,
                "users": [{
                    "key": "person-1", "username": "managed-user",
                    "passwordHash": "managed-password", "enabled": True,
                }],
            }),
            encoding="utf-8",
        )
        config_path.chmod(0o660)
        entries = manage_users.load_config(config_path)
        self.assertEqual(entries[0]["password"], "managed-password")
        self.assertIsNone(entries[0]["password_hash"])
        manage_users.sync_users(self.db_path, entries)
        manage_users.save_config(config_path, entries)
        saved = json.loads(config_path.read_text(encoding="utf-8"))["users"][0]
        self.assertTrue(server.verify_password("managed-password", saved["passwordHash"]))
        self.assertNotIn("password", saved)

    def test_password_change_updates_database_and_managed_config(self):
        config_path = Path(self.temp_dir.name) / "users.json"
        config_path.write_text(
            json.dumps({
                "version": 1,
                "users": [{
                    "key": "person-1", "username": "managed-user",
                    "password": "managed-password", "enabled": True,
                }],
            }),
            encoding="utf-8",
        )
        config_path.chmod(0o660)
        entries = manage_users.load_config(config_path)
        manage_users.sync_users(self.db_path, entries)
        manage_users.save_config(config_path, entries)
        user = server.authenticate_user(self.db_path, "managed-user", "managed-password")
        current_token = server.create_session(self.db_path, user["id"])
        other_token = server.create_session(self.db_path, user["id"])

        server.change_password(
            self.db_path,
            config_path,
            user["id"],
            "managed-password",
            "new-managed-password",
            current_token,
        )

        self.assertIsNone(server.authenticate_user(self.db_path, "managed-user", "managed-password"))
        self.assertIsNotNone(server.authenticate_user(self.db_path, "managed-user", "new-managed-password"))
        self.assertIsNotNone(server.find_session_user(self.db_path, current_token))
        self.assertIsNone(server.find_session_user(self.db_path, other_token))
        saved = json.loads(config_path.read_text(encoding="utf-8"))["users"][0]
        self.assertTrue(server.verify_password("new-managed-password", saved["passwordHash"]))
        self.assertNotIn("password", saved)


class HttpServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "offerflow.db"
        server.initialize_database(self.db_path)
        self.first_user = server.register_user(self.db_path, "test-user", "test-password")
        self.users_config_path = Path(self.temp_dir.name) / "users.json"
        self.users_config_path.write_text(
            json.dumps({
                "version": 1,
                "users": [{
                    "key": "test-owner", "username": "test-user",
                    "passwordHash": server.get_user_by_username(self.db_path, "test-user")["password_hash"],
                    "enabled": True,
                }],
            }),
            encoding="utf-8",
        )
        self.users_config_path.chmod(0o660)
        with server.connect(self.db_path) as connection:
            connection.execute(
                "UPDATE users SET managed_key = 'test-owner' WHERE id = ?",
                (self.first_user["id"],),
            )
        self.http_server = server.OfferFlowServer(
            ("127.0.0.1", 0),
            server.OfferFlowHandler,
            self.db_path,
            registration_code="join-code",
            users_config_path=self.users_config_path,
        )
        self.thread = threading.Thread(target=self.http_server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.http_server.server_address[1]

    def tearDown(self):
        self.http_server.shutdown()
        self.http_server.server_close()
        self.thread.join()
        self.temp_dir.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload)
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        response_body = response.read()
        result = response.status, dict(response.getheaders()), response_body
        connection.close()
        return result

    def login(self, username="test-user", password="test-password"):
        status, headers, _ = self.request(
            "POST",
            "/api/auth/login",
            {"username": username, "password": password},
            {"X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 200)
        return headers["Set-Cookie"].split(";", 1)[0]

    def test_health_and_static_app_are_public_but_state_is_private(self):
        self.assertEqual(self.request("GET", "/api/health")[0], 200)
        self.assertEqual(self.request("GET", "/")[0], 200)
        status, headers, body = self.request("GET", "/api/state")
        self.assertEqual(status, 401)
        self.assertNotIn("WWW-Authenticate", headers)
        self.assertEqual(json.loads(body)["code"], "authentication_required")

    def test_only_public_app_assets_are_served(self):
        self.assertEqual(self.request("GET", "/app.js")[0], 200)
        self.assertEqual(self.request("GET", "/auth-react.js")[0], 200)
        self.assertEqual(self.request("GET", "/server.py")[0], 404)
        self.assertEqual(self.request("GET", "/.git/config")[0], 404)

    def test_login_session_reads_state_and_logout_invalidates_it(self):
        cookie = self.login()
        status, _, body = self.request("GET", "/api/state", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["initialized"])

        status, headers, _ = self.request(
            "POST", "/api/auth/logout", headers={"Cookie": cookie, "X-OfferFlow-CSRF": "1"}
        )
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/api/state", headers={"Cookie": cookie})[0], 401)

    def test_mutations_require_csrf_header(self):
        cookie = self.login()
        self.assertEqual(
            self.request("PUT", "/api/state", example_state(), {"Cookie": cookie, "If-Match": "0"})[0],
            403,
        )
        self.assertEqual(
            self.request(
                "PUT", "/api/document", {"content": "private"},
                {"Cookie": cookie, "If-Match": "0"},
            )[0],
            403,
        )
        self.assertEqual(
            self.request("POST", "/api/auth/logout", headers={"Cookie": cookie})[0],
            403,
        )

    def test_user_can_change_password_and_config_is_updated(self):
        cookie = self.login()
        status, _, body = self.request(
            "POST",
            "/api/auth/password",
            {"currentPassword": "test-password", "newPassword": "updated-password"},
            {"Cookie": cookie, "X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 200, body)
        self.assertIsNone(server.authenticate_user(self.db_path, "test-user", "test-password"))
        self.assertIsNotNone(server.authenticate_user(self.db_path, "test-user", "updated-password"))
        config = json.loads(self.users_config_path.read_text(encoding="utf-8"))
        self.assertTrue(server.verify_password("updated-password", config["users"][0]["passwordHash"]))
        self.assertEqual(self.request("GET", "/api/state", headers={"Cookie": cookie})[0], 200)

    def test_password_change_rejects_wrong_current_password(self):
        cookie = self.login()
        status, _, body = self.request(
            "POST",
            "/api/auth/password",
            {"currentPassword": "wrong-password", "newPassword": "updated-password"},
            {"Cookie": cookie, "X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 400)
        self.assertIn("当前密码", json.loads(body)["error"])
        self.assertIsNotNone(server.authenticate_user(self.db_path, "test-user", "test-password"))

    def test_registration_requires_invite_and_creates_isolated_state(self):
        status, _, _ = self.request(
            "POST",
            "/api/auth/register",
            {"username": "second-user", "password": "second-password", "inviteCode": "wrong"},
            {"X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 400)
        status, headers, _ = self.request(
            "POST",
            "/api/auth/register",
            {"username": "second-user", "password": "second-password", "inviteCode": "join-code"},
            {"X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 201)
        second_cookie = headers["Set-Cookie"].split(";", 1)[0]
        second_state = json.loads(self.request("GET", "/api/state", headers={"Cookie": second_cookie})[2])
        self.assertEqual(second_state["state"]["lists"][0]["applications"], [])

    def test_registration_can_be_disabled_for_admin_managed_accounts(self):
        self.http_server.registration_enabled = False
        status, _, body = self.request(
            "POST",
            "/api/auth/register",
            {"username": "blocked-user", "password": "blocked-password", "inviteCode": "join-code"},
            {"X-OfferFlow-CSRF": "1"},
        )
        self.assertEqual(status, 403)
        self.assertIn("不开放", json.loads(body)["error"])
        session = json.loads(self.request("GET", "/api/auth/session")[2])
        self.assertFalse(session["registration"]["enabled"])

    def test_put_uses_per_user_revision_and_returns_conflict_details(self):
        cookie = self.login()
        headers = {"Cookie": cookie, "If-Match": "0", "X-OfferFlow-CSRF": "1"}
        state = example_state()
        status, _, body = self.request("PUT", "/api/state", state, headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["revision"], 1)
        status, _, body = self.request("PUT", "/api/state", state, headers)
        payload = json.loads(body)
        self.assertEqual(status, 409)
        self.assertEqual(payload["revision"], 1)
        self.assertEqual(payload["latest"]["state"], state)

    def test_personal_document_api_is_private_and_versioned(self):
        self.assertEqual(self.request("GET", "/api/document")[0], 401)
        cookie = self.login()
        headers = {"Cookie": cookie, "If-Match": "0", "X-OfferFlow-CSRF": "1"}
        content = "<h2>公司投递限制</h2><p>示例公司：2 个岗位</p>"
        status, _, body = self.request("PUT", "/api/document", {"content": content}, headers)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["revision"], 1)
        saved = json.loads(self.request("GET", "/api/document", headers={"Cookie": cookie})[2])
        self.assertEqual(saved["content"], content)
        self.assertEqual(saved["revision"], 1)

        status, _, body = self.request("PUT", "/api/document", {"content": "stale"}, headers)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["latest"]["content"], content)

    def test_https_proxy_sets_secure_session_cookie(self):
        status, headers, _ = self.request(
            "POST",
            "/api/auth/login",
            {"username": "test-user", "password": "test-password"},
            {"X-OfferFlow-CSRF": "1", "X-Forwarded-Proto": "https"},
        )
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", headers["Set-Cookie"])
        self.assertIn("Secure", headers["Set-Cookie"])


if __name__ == "__main__":
    unittest.main()
