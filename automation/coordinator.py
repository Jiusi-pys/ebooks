"""GitHub Issue ledger reconciliation; no checkout or execution of issue text.

Run through the single `client-followup-ledger` workflow concurrency group.
Issue edits are administrative state changes, not authenticated test evidence.
This coordinator only queues/supersedes tasks; it cannot merge or deploy.
"""
import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

from automation.__main__ import load_catalog
from automation.engine import PLATFORMS, STATES, digest, reconcile, valid_sha


MARKER = "<!-- shufang-task-v1\n"


def encode_task(task):
    return (f"Shared-core follow-up: **{task['capability']}** / **{task['platform']}**\n\n"
            f"Revision: {task['revision']}; state: {task['state']}.\n"
            "The versioned capability catalog defines acceptance. This issue is a task ledger, "
            "not proof of implementation or permission to merge/deploy.\n\n"
            + MARKER + json.dumps(task, sort_keys=True, ensure_ascii=True) + "\n-->")


def decode_task(body):
    if not isinstance(body, str) or MARKER not in body:
        return None
    if len(body) > 60000 or body.count(MARKER) != 1:
        raise ValueError("invalid task ledger envelope")
    tail = body.split(MARKER, 1)[1]
    if "\n-->" not in tail:
        raise ValueError("incomplete task ledger")
    task = json.loads(tail.split("\n-->", 1)[0])
    if not isinstance(task, dict):
        raise ValueError("invalid task ledger")
    identifier = task.get("capability")
    revision = task.get("revision")
    platform = task.get("platform")
    if (not isinstance(identifier, str)
            or not re.fullmatch(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*", identifier)
            or type(revision) is not int or revision < 1
            or not isinstance(platform, str) or platform not in PLATFORMS
            or task.get("id") != digest([identifier, revision, platform])[:24]
            or not isinstance(task.get("state"), str) or task["state"] not in STATES
            or not valid_sha(task.get("source_sha"))
            or not isinstance(task.get("spec_hash"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", task["spec_hash"])
            or type(task.get("repair_attempts")) is not int
            or not 0 <= task["repair_attempts"] <= 2):
        raise ValueError("invalid task ledger identity or state")
    return task


def coordinate(issues, specifications, source_sha, *, ledger_author="github-actions[bot]"):
    existing = []
    by_id = {}
    for issue in issues.list():
        task = decode_task(issue.get("body"))
        if task is None:
            continue
        if issue.get("user", {}).get("login") != ledger_author:
            raise ValueError("task ledger authored by an unexpected identity")
        if task["id"] in by_id:
            raise ValueError("duplicate remote task ledger")
        by_id[task["id"]] = (issue["number"], task)
        existing.append(task)
    tasks = reconcile(existing, specifications, source_sha)
    # All validation above completes before the first remote mutation.
    for task in tasks:
        prior = by_id.get(task["id"])
        if prior is None:
            title = f"[follow-up] {task['platform']}: {task['capability']} r{task['revision']}"
            issues.create(title, encode_task(task))
        elif prior[1] != task:
            issues.update(prior[0], encode_task(task))
    return tasks


class GitHubIssues:
    def __init__(self, repository, token):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not token:
            raise ValueError("GitHub repository and token required")
        self.base = "https://api.github.com/repos/" + repository
        self.token = token

    def request(self, path, method="GET", body=None):
        request = Request(self.base + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + self.token,
                                   "Accept": "application/vnd.github+json",
                                   "X-GitHub-Api-Version": "2022-11-28",
                                   "Content-Type": "application/json"})
        # No blind retry of writes. A workflow rerun first reconciles the ledger.
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    def list(self):
        rows = []
        page = 1
        while True:
            batch = self.request(f"/issues?state=all&per_page=100&page={page}")
            rows.extend(row for row in batch if "pull_request" not in row)
            if len(batch) < 100:
                return rows
            page += 1

    def create(self, title, body):
        return self.request("/issues", "POST", {"title": title, "body": body})

    def update(self, number, body):
        return self.request(f"/issues/{int(number)}", "PATCH", {"body": body})


def main():
    specs = load_catalog(Path("specs/capabilities.json"), Path.cwd())
    api = GitHubIssues(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    tasks = coordinate(api, specs, os.environ["GITHUB_SHA"])
    print(json.dumps({"tasks": len(tasks), "queued": sum(t["state"] == "queued" for t in tasks)}))


if __name__ == "__main__":
    main()
