import tempfile
import unittest
from pathlib import Path

from automation.engine import reconcile
from automation.ledger import Ledger
from test_engine import SHA, capability


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "tasks.sqlite3"
        self.ledger = Ledger(self.path)
        self.tasks = reconcile([], [capability()], SHA)
        self.ledger.reconcile([capability()], SHA)

    def tearDown(self):
        self.directory.cleanup()

    def test_reconcile_is_durable_and_idempotent(self):
        self.ledger.reconcile([capability()], SHA)
        restored = Ledger(self.path)
        self.assertEqual(restored.tasks(), self.tasks)

    def test_only_one_task_per_host_and_one_host_per_task(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        self.assertTrue(token)
        with self.assertRaises(BlockingIOError):
            Ledger(self.path).claim(task, "mac-1", now=11)
        with self.assertRaises(BlockingIOError):
            self.ledger.claim(self.tasks[1]["id"], "windows-1", now=11)

    def test_expired_lease_requires_reconciliation_not_parallel_retry(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        with self.assertRaises(BlockingIOError):
            self.ledger.claim(task, "mac-1", now=10000)
        # Operator must confirm that the old process stopped before recovering.
        self.ledger.recover(task, token, stopped=True)
        self.assertEqual(self.ledger.tasks()[0]["state"], "waiting")
        self.assertEqual(self.ledger.tasks()[0]["repair_attempts"], 0)

    def test_stale_owner_cannot_transition(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        with self.assertRaises(PermissionError):
            self.ledger.advance(task, "wrong-token", "implementing")
        self.ledger.advance(task, token, "implementing")
        self.assertEqual(self.ledger.tasks()[0]["state"], "implementing")

    def test_budget_reserved_before_execution_survives_crash(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        self.assertEqual(self.ledger.reserve_call(task, token), 2700)
        self.assertEqual(Ledger(self.path).reserve_call(task, token), 2700)
        self.assertEqual(self.ledger.reserve_call(task, token), 1800)
        with self.assertRaisesRegex(ValueError, "budget"):
            self.ledger.reserve_call(task, token)

    def test_failed_reconcile_rolls_back_all_changes(self):
        bad = capability() | {"title": "changed without revision"}
        with self.assertRaises(ValueError):
            self.ledger.reconcile([bad], SHA)
        self.assertEqual(self.ledger.tasks(), self.tasks)

    def test_superseding_running_task_does_not_release_host(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        self.ledger.reconcile([capability(2)], SHA)
        with self.assertRaises(ValueError):
            self.ledger.advance(task, token, "implementing")
        next_task = self.ledger.tasks()[2]["id"]
        with self.assertRaises(BlockingIOError):
            self.ledger.claim(next_task, "windows-1", now=11)
        self.ledger.recover(task, token, stopped=True)
        self.assertTrue(self.ledger.claim(next_task, "windows-1", now=12))

    def test_recovery_without_process_confirmation_fails(self):
        task = self.tasks[0]["id"]
        token = self.ledger.claim(task, "windows-1", now=10)
        with self.assertRaises(ValueError):
            self.ledger.recover(task, token, stopped=False)


if __name__ == "__main__":
    unittest.main()
