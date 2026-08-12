import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server


class StateDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "offerflow.db"
        server.initialize_database(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_new_database_is_uninitialized(self):
        self.assertEqual(
            server.read_state(self.db_path),
            {"initialized": False, "revision": 0, "state": None},
        )

    def test_state_round_trip_preserves_interview(self):
        state = {
            "activeListId": "autumn",
            "lists": [
                {
                    "id": "autumn",
                    "name": "2026 秋招",
                    "applications": [
                        {
                            "id": "application-1",
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

        revision = server.write_state(self.db_path, state)

        self.assertEqual(revision, 1)
        self.assertEqual(
            server.read_state(self.db_path),
            {"initialized": True, "revision": 1, "state": state},
        )

    def test_rejects_stale_revision_without_overwriting_state(self):
        initial_state = {
            "activeListId": "list-1",
            "lists": [{"id": "list-1", "name": "初始列表", "applications": []}],
        }
        updated_state = {
            "activeListId": "list-1",
            "lists": [{"id": "list-1", "name": "已更新列表", "applications": []}],
        }

        self.assertEqual(server.write_state(self.db_path, initial_state, 0), 1)
        with self.assertRaisesRegex(server.StateConflictError, "another device"):
            server.write_state(self.db_path, updated_state, 0)

        self.assertEqual(server.read_state(self.db_path)["state"], initial_state)

    def test_rejects_unknown_active_list(self):
        with self.assertRaisesRegex(ValueError, "activeListId"):
            server.write_state(
                self.db_path,
                {
                    "activeListId": "missing",
                    "lists": [
                        {"id": "existing", "name": "列表", "applications": []}
                    ],
                },
            )

    def test_rejects_duplicate_application_ids(self):
        application = {
            "id": "duplicate",
            "company": "示例公司",
            "type": "私企",
            "role": "工程师",
            "date": "2026-08-11",
            "status": "已投递",
            "notes": "",
            "interview": None,
        }
        with self.assertRaisesRegex(ValueError, "application ids"):
            server.write_state(
                self.db_path,
                {
                    "activeListId": "list-1",
                    "lists": [
                        {
                            "id": "list-1",
                            "name": "列表",
                            "applications": [application, dict(application)],
                        }
                    ],
                },
            )


class HttpServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "offerflow.db"
        server.initialize_database(self.db_path)
        self.http_server = server.OfferFlowServer(
            ("127.0.0.1", 0),
            server.OfferFlowHandler,
            self.db_path,
            auth_username="test-user",
            auth_password="test-password",
        )
        self.thread = threading.Thread(target=self.http_server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.http_server.server_address[1]
        credentials = base64.b64encode(b"test-user:test-password").decode("ascii")
        self.auth_headers = {"Authorization": "Basic " + credentials}

    def tearDown(self):
        self.http_server.shutdown()
        self.http_server.server_close()
        self.thread.join()
        self.temp_dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        result = response.status, dict(response.getheaders()), response_body
        connection.close()
        return result

    def test_health_check_does_not_require_authentication(self):
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_app_and_state_require_authentication(self):
        for path in ("/", "/api/state"):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 401)
                self.assertIn("Basic", headers["WWW-Authenticate"])
                self.assertEqual(body, b"")

    def test_only_public_app_assets_are_served(self):
        status, _, _ = self.request("GET", "/app.js", headers=self.auth_headers)
        self.assertEqual(status, 200)
        status, _, _ = self.request("GET", "/server.py", headers=self.auth_headers)
        self.assertEqual(status, 404)
        status, _, _ = self.request("GET", "/.git/config", headers=self.auth_headers)
        self.assertEqual(status, 404)

    def test_put_requires_revision_and_returns_conflict_details(self):
        state = {
            "activeListId": "list-1",
            "lists": [{"id": "list-1", "name": "列表", "applications": []}],
        }
        headers = {
            **self.auth_headers,
            "Content-Type": "application/json",
            "If-Match": "0",
        }
        status, _, body = self.request("PUT", "/api/state", json.dumps(state), headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["revision"], 1)

        status, _, body = self.request("PUT", "/api/state", json.dumps(state), headers)
        payload = json.loads(body)
        self.assertEqual(status, 409)
        self.assertEqual(payload["revision"], 1)
        self.assertEqual(payload["latest"]["state"], state)


if __name__ == "__main__":
    unittest.main()
