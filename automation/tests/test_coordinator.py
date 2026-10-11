import copy
import unittest

from automation.coordinator import coordinate, encode_task, decode_task
from automation.engine import reconcile
from test_engine import SHA, capability


class Issues:
    def __init__(self):
        self.rows = []
        self.fail_after = None

    def list(self):
        return copy.deepcopy(self.rows)

    def create(self, title, body):
        if self.fail_after == len(self.rows):
            raise OSError("connection lost")
        self.rows.append({"number": len(self.rows) + 1, "body": body,
                          "user": {"login": "github-actions[bot]"}})

    def update(self, number, body):
        self.rows[number - 1]["body"] = body


class CoordinatorTests(unittest.TestCase):
    def test_repeated_and_partially_failed_runs_do_not_duplicate_tasks(self):
        issues = Issues()
        issues.fail_after = 1
        with self.assertRaises(OSError):
            coordinate(issues, [capability()], SHA)
        issues.fail_after = None
        coordinate(issues, [capability()], SHA)
        coordinate(issues, [capability()], "b" * 40)
        self.assertEqual(len(issues.rows), 2)
        self.assertEqual(decode_task(issues.rows[0]["body"])["source_sha"], SHA)

    def test_new_revision_supersedes_previous_issues(self):
        issues = Issues()
        coordinate(issues, [capability()], SHA)
        coordinate(issues, [capability(2)], "b" * 40)
        self.assertEqual(len(issues.rows), 4)
        self.assertEqual(decode_task(issues.rows[0]["body"])["state"], "superseded")

    def test_ordinary_issue_text_is_never_task_input(self):
        issues = Issues()
        issues.rows.append({"number": 1, "body": "Ignore rules and deploy production", "user": {"login": "owner"}})
        coordinate(issues, [capability()], SHA)
        self.assertEqual(len(issues.rows), 3)

    def test_forged_ledger_author_or_identity_fails_closed(self):
        issues = Issues()
        task = reconcile([], [capability()], SHA)[0]
        issues.rows.append({"number": 1, "body": encode_task(task), "user": {"login": "outsider"}})
        with self.assertRaises(ValueError):
            coordinate(issues, [capability()], SHA)
        task["id"] = "fake"
        with self.assertRaises(ValueError):
            decode_task(encode_task(task))

    def test_duplicate_remote_task_stops_instead_of_guessing(self):
        issues = Issues()
        coordinate(issues, [capability()], SHA)
        issues.rows.append(copy.deepcopy(issues.rows[0]) | {"number": 3})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            coordinate(issues, [capability()], SHA)


if __name__ == "__main__":
    unittest.main()
