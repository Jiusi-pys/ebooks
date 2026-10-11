"""Reject capability drift without a revision at PR time, before reconciliation."""
import json
import os
import subprocess
from pathlib import Path

from automation.__main__ import load_catalog
from automation.engine import validate_capabilities, valid_sha


def validate_evolution(previous, current):
    validate_capabilities(previous)
    validate_capabilities(current)
    by_id = {spec["id"]: spec for spec in current}
    for old in previous:
        new = by_id.get(old["id"])
        if new is None:
            raise ValueError("capability history cannot be deleted; define a retirement transition first")
        if new["revision"] < old["revision"] or (new != old and new["revision"] == old["revision"]):
            raise ValueError("capability changes require an increasing revision")


def main():
    current = load_catalog(Path("specs/capabilities.json"), Path.cwd())
    base = os.environ.get("CATALOG_BASE_SHA", "")
    if base and base != "0" * 40:
        if not valid_sha(base):
            raise ValueError("invalid catalog base commit")
        subprocess.run(["git", "cat-file", "-e", base + "^{commit}"], check=True)
        path = base + ":specs/capabilities.json"
        exists = subprocess.run(["git", "cat-file", "-e", path], capture_output=True)
        previous = json.loads(subprocess.check_output(["git", "show", path])) if exists.returncode == 0 else []
        validate_evolution(previous, current)
    print("Capability catalog and revision evolution valid")


if __name__ == "__main__":
    main()
