"""The core's data fails (a full disk: SQLite says "disk I/O error" or "database or disk is full"): every API answers 503 with a JSON error
the shell shows (down: true), instead of the thread dying and the proxy in front saying 503 with no reason (2026-10-25, Google Cloud Shell)."""

import errno
import sqlite3
import unittest

from conformance.helpers import NO_SAMPLES, SAMPLES, Live


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Down(unittest.TestCase):
    def setUp(self):
        self.live = Live()
        self.store = self.live.srv.core.store

    def tearDown(self):
        self.live.close()

    def broken(self, name, e):
        def fail(*a, **k):
            raise e
        setattr(self.store, name, fail)

    def test_read_fails(self):
        self.broken("tasks", sqlite3.OperationalError("disk I/O error"))
        code, j = self.live.json("api/tasks?all=1")
        self.assertEqual(code, 503)
        self.assertTrue(j["down"])
        self.assertIn("disk is full", j["error"])

    def test_write_fails(self):
        self.broken("add_task", sqlite3.OperationalError("database or disk is full"))
        code, j = self.live.json("api/tasks", {"title": "x"})
        self.assertEqual(code, 503)
        self.assertIn("disk is full", j["error"])

    def test_no_space_on_a_file(self):
        self.broken("rev", OSError(errno.ENOSPC, "No space left on device"))
        code, j = self.live.json("api/poll")
        self.assertEqual((code, j["down"]), (503, True))

    def test_other_db_error_is_not_called_full(self):
        self.broken("tasks", sqlite3.OperationalError("no such table: tasks"))
        code, j = self.live.json("api/tasks")
        self.assertEqual(code, 503)
        self.assertNotIn("disk is full", j["error"])

    def test_still_answers_after(self):
        self.broken("tasks", sqlite3.OperationalError("disk I/O error"))
        self.live.json("api/tasks")
        self.assertEqual(self.live.json("api/info")[0], 200)


if __name__ == "__main__":
    unittest.main()
