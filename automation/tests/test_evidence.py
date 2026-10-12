import unittest

from automation.evidence import authorize_merge, verify_checks
from test_engine import SHA


REQUIRED = {"web": 101, "native": 102}


def checks():
    return [{"name": name, "workflow_id": workflow, "head_sha": SHA,
             "status": "completed", "conclusion": "success"}
            for name, workflow in REQUIRED.items()]


class EvidenceTests(unittest.TestCase):
    def test_exact_revision_and_trusted_workflows_are_required(self):
        self.assertEqual(verify_checks(SHA, REQUIRED, checks()),
                         {"web": "success", "native": "success"})
        for field, value in (("head_sha", "b" * 40), ("workflow_id", 999),
                             ("conclusion", "skipped"), ("status", "in_progress")):
            altered = checks()
            altered[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_checks(SHA, REQUIRED, altered)

    def test_missing_empty_or_ambiguous_checks_cannot_pass(self):
        for rows in ([], checks()[:1], checks() + [checks()[0]]):
            with self.assertRaises(ValueError):
                verify_checks(SHA, REQUIRED, rows)
        with self.assertRaises(ValueError):
            verify_checks(SHA, {}, checks())

    def test_no_automatic_merge_without_enforced_rules(self):
        context = dict(private=True, rules_enforced=True, independent_review=True,
                       base_current=True, checks_verified=True)
        self.assertTrue(authorize_merge("low", **context))
        for field in context:
            self.assertFalse(authorize_merge("low", **(context | {field: False})))
        for risk in ("medium", "high", "unknown"):
            self.assertFalse(authorize_merge(risk, **context))


if __name__ == "__main__":
    unittest.main()
