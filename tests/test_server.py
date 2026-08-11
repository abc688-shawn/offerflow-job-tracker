import tempfile
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
            {"initialized": False, "state": None},
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

        server.write_state(self.db_path, state)

        self.assertEqual(
            server.read_state(self.db_path),
            {"initialized": True, "state": state},
        )

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


if __name__ == "__main__":
    unittest.main()
