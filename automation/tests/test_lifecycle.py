import tempfile
import unittest
from pathlib import Path

from automation.engine import classify
from automation.ledger import Ledger
from test_engine import SHA, NEXT, capability


class LifecycleTests(unittest.TestCase):
    def test_recovery_requeues_without_resetting_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory) / "ledger.sqlite3")
            task = ledger.reconcile([capability()], SHA)[0]["id"]
            first = ledger.claim(task, "windows-1", now=1)
            ledger.reserve_call(task, first)
            with self.assertRaises(BlockingIOError):
                ledger.requeue(task)
            ledger.recover(task, first, stopped=True)
            ledger.requeue(task)
            second = ledger.claim(task, "windows-1", now=2)
            self.assertNotEqual(first, second)
            self.assertEqual(ledger.reserve_call(task, second), 2700)
            self.assertEqual(ledger.reserve_call(task, second), 1800)

    def test_full_implementation_to_verified_merge_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory) / "ledger.sqlite3")
            task = ledger.reconcile([capability()], SHA)[0]["id"]
            token = ledger.claim(task, "windows-1", now=1)
            with self.assertRaises(ValueError):
                ledger.record_head(task, token, NEXT)
            ledger.advance(task, token, "implementing")
            with self.assertRaises(ValueError):
                ledger.record_head(task, token, "main")
            ledger.record_head(task, token, NEXT)
            ledger.advance(task, token, "verifying")
            ledger.advance(task, token, "pr_open")
            with self.assertRaises(ValueError):
                ledger.record_head(task, token, SHA)
            ledger.advance(task, token, "integrated", evidence={
                "head_sha": NEXT, "merged": True,
                "required_checks": {"independently-collected-check": "success"},
            })
            ledger.recover(task, token, stopped=True)
            self.assertEqual(ledger.tasks()[0]["state"], "integrated")
            with self.assertRaises(ValueError):
                ledger.requeue(task)

    def test_non_array_risk_input_fails_closed(self):
        for paths in (None, "app/src/pages/Page.tsx", {"app/src/pages/Page.tsx": "low"}, 12):
            with self.subTest(paths=paths):
                self.assertEqual(classify(paths), "high")


if __name__ == "__main__":
    unittest.main()
