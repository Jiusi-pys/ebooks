import copy
import unittest

from automation.engine import classify, reconcile, transition, validate_capabilities


SHA = "a" * 40
NEXT = "b" * 40


def capability(revision=1):
    return {
        "id": "notes.tags", "revision": revision, "title": "Note tags",
        "platforms": ["windows", "ios"],
        "references": ["app/src/lib/db.ts"],
        "acceptance": ["Tags survive restart and synchronize without duplication"],
    }


class EngineTests(unittest.TestCase):
    def test_replayed_event_keeps_one_task_and_preserves_work(self):
        tasks = reconcile([], [capability()], SHA)
        tasks[0]["branch"] = "auto/windows/notes-tags"
        tasks[0]["state"] = "implementing"
        again = reconcile(tasks, [capability()], NEXT)
        self.assertEqual(len(again), 2)
        self.assertEqual(again[0], tasks[0])

    def test_semantic_revision_creates_new_tasks_and_supersedes_old(self):
        old = reconcile([], [capability()], SHA)
        new = reconcile(old, [capability(2)], NEXT)
        self.assertEqual(len(new), 4)
        self.assertEqual([t["state"] for t in new[:2]], ["superseded"] * 2)
        self.assertEqual([t["source_sha"] for t in new[2:]], [NEXT] * 2)

    def test_changed_spec_without_revision_is_rejected(self):
        tasks = reconcile([], [capability()], SHA)
        spec = capability()
        spec["acceptance"].append("Filter by tag")
        with self.assertRaisesRegex(ValueError, "revision"):
            reconcile(tasks, [spec], NEXT)

    def test_invalid_specs_and_duplicate_ids_are_rejected(self):
        for change in ({"id": "../bad"}, {"revision": True},
                       {"platforms": ["unknown"]}, {"references": ["../../secret"]},
                       {"acceptance": []}, {"platforms": ["ios", "ios"]}):
            spec = capability() | change
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_capabilities([spec])
        with self.assertRaises(ValueError):
            validate_capabilities([capability(), capability()])

    def test_no_direct_jump_from_queued_to_integrated(self):
        task = reconcile([], [capability()], SHA)[0]
        with self.assertRaises(ValueError):
            transition(task, "integrated")

    def test_environment_failure_does_not_consume_repair_budget(self):
        task = reconcile([], [capability()], SHA)[0]
        task["state"] = "implementing"
        waiting = transition(task, "waiting", reason="host_offline")
        self.assertEqual(waiting["repair_attempts"], 0)
        self.assertEqual(transition(waiting, "queued")["state"], "queued")

    def test_repairs_are_bounded_and_do_not_mutate_input(self):
        task = reconcile([], [capability()], SHA)[0]
        task["state"] = "verifying"
        original = copy.deepcopy(task)
        first = transition(task, "implementing", reason="test_failure")
        self.assertEqual(task, original)
        first["state"] = "verifying"
        second = transition(first, "implementing", reason="test_failure")
        second["state"] = "verifying"
        with self.assertRaisesRegex(ValueError, "budget"):
            transition(second, "implementing", reason="test_failure")

    def test_integrated_requires_merge_and_evidence_for_exact_head(self):
        task = reconcile([], [capability()], SHA)[0]
        task.update(state="pr_open", head_sha=NEXT)
        valid = {"head_sha": NEXT, "merged": True,
                 "required_checks": {"contract": "success", "platform": "success"}}
        for evidence in (None, valid | {"head_sha": SHA}, valid | {"merged": False},
                         valid | {"required_checks": {}},
                         valid | {"required_checks": {"platform": "skipped"}}):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                transition(task, "integrated", evidence=evidence)
        self.assertEqual(transition(task, "integrated", evidence=valid)["state"], "integrated")

    def test_risk_policy_cannot_be_lowered_by_agent(self):
        self.assertEqual(classify(["platforms/windows/Shufang.Windows/Views/Page.xaml"]), "low")
        self.assertEqual(classify(["base/crates/application/src/library.rs"]), "medium")
        for path in (".github/workflows/ci.yml", "automation/engine.py",
                     "base/crates/application/src/offline_conflicts.rs",
                     "app/db/migrations/0016.sql", "ios/Shufang/Core/StudyStore.swift",
                     "platforms/android/app/src/test/ChangedTest.kt", "AGENTS.md"):
            with self.subTest(path=path):
                self.assertEqual(classify([path]), "high")
        self.assertEqual(classify(["new-unknown-area/file.rs"]), "high")


if __name__ == "__main__":
    unittest.main()
