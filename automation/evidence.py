"""Fail-closed gates for evidence collected by a trusted GitHub API adapter.

Never feed these functions an agent report or PR-authored JSON as check evidence.
The caller must resolve workflow IDs from the trusted default branch and collect
the latest run attempt's jobs directly from GitHub, including all matrix jobs.
"""
from automation.engine import valid_sha


def verify_checks(head_sha, required, observed):
    if not valid_sha(head_sha) or not isinstance(required, dict) or not required:
        raise ValueError("explicit current-head required checks are mandatory")
    verified = {}
    for name, workflow_id in required.items():
        if type(workflow_id) is not int or workflow_id <= 0:
            raise ValueError("trusted workflow id is required")
        matches = [row for row in observed if row.get("name") == name]
        if len(matches) != 1:
            raise ValueError(f"missing or ambiguous required check: {name}")
        row = matches[0]
        if (row.get("workflow_id") != workflow_id or row.get("head_sha") != head_sha
                or row.get("status") != "completed" or row.get("conclusion") != "success"):
            raise ValueError(f"required check not successful on exact head: {name}")
        verified[name] = "success"
    return verified


def authorize_merge(risk, *, private, rules_enforced, independent_review,
                    base_current, checks_verified):
    # Unknown/unavailable private-repo branch protection is explicitly False.
    return risk == "low" and all(value is True for value in (
        private, rules_enforced, independent_review, base_current, checks_verified
    ))
