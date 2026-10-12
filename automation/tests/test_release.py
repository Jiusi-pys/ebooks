import unittest

from automation.release import authorize_actor, collect_required_checks
from test_engine import SHA


class ReleaseTests(unittest.TestCase):
    def test_only_explicit_humans_on_manual_main_runs_may_release(self):
        arguments = dict(event="workflow_dispatch", ref="refs/heads/main",
                         actor="maintainer", triggering_actor="maintainer",
                         allowed=["maintainer"])
        authorize_actor(**arguments)
        for override in ({"event": "push"}, {"ref": "refs/heads/base"},
                         {"actor": "github-actions[bot]"}, {"allowed": []},
                         {"triggering_actor": "outsider"}, {"allowed": "maintainer"}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                authorize_actor(**(arguments | override))

    def test_latest_attempt_and_every_matrix_job_are_required(self):
        calls = []
        def request(path):
            calls.append(path)
            if "/actions/workflows/" in path:
                return {"workflow_runs": [
                    {"id": 9, "workflow_id": 7, "head_sha": SHA, "run_number": 2,
                     "run_attempt": 2, "event": "push", "head_branch": "main",
                     "status": "completed", "conclusion": "success"},
                    {"id": 8, "workflow_id": 7, "head_sha": SHA, "run_number": 1,
                     "run_attempt": 1, "event": "push", "head_branch": "main",
                     "status": "completed", "conclusion": "success"}]}
            return {"total_count": 2, "jobs": [
                {"name": "native (windows)", "head_sha": SHA, "status": "completed", "conclusion": "success"},
                {"name": "native (macos)", "head_sha": SHA, "status": "completed", "conclusion": "success"}]}
        result = collect_required_checks(request, SHA, {"native.yml": ["native (windows)", "native (macos)"]})
        self.assertEqual(len(result), 2)
        self.assertTrue(any("/9/attempts/2/jobs" in p for p in calls))
        with self.assertRaises(ValueError):
            collect_required_checks(request, SHA, {"native.yml": ["missing android"]})

    def test_no_previous_success_fallback_when_latest_run_fails(self):
        def request(path):
            return {"workflow_runs": [
                {"id": 9, "workflow_id": 7, "head_sha": SHA, "run_number": 2,
                 "run_attempt": 1, "event": "push", "head_branch": "main",
                 "status": "completed", "conclusion": "failure"}]}
        with self.assertRaises(ValueError):
            collect_required_checks(request, SHA, {"native.yml": ["native"]})


if __name__ == "__main__":
    unittest.main()
