import copy
import unittest

from automation.catalog_gate import validate_evolution
from test_engine import capability


class CatalogTests(unittest.TestCase):
    def test_same_catalog_or_incremented_revision_is_valid(self):
        previous = [capability()]
        validate_evolution(previous, copy.deepcopy(previous))
        validate_evolution(previous, [capability(2)])
        validate_evolution([], previous)

    def test_semantic_change_requires_revision(self):
        changed = capability()
        changed["acceptance"].append("new behavior")
        with self.assertRaisesRegex(ValueError, "revision"):
            validate_evolution([capability()], [changed])

    def test_deletion_or_revision_reversal_cannot_erase_history(self):
        with self.assertRaises(ValueError):
            validate_evolution([capability()], [])
        with self.assertRaises(ValueError):
            validate_evolution([capability(2)], [capability()])


if __name__ == "__main__":
    unittest.main()
