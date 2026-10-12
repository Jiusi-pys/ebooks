"""Manual release admission. GitHub metadata, never model claims, supplies checks."""
import json
import os
import re

from automation.coordinator import GitHubIssues
from automation.engine import valid_sha
from automation.evidence import verify_checks


REQUIRED = {
    "web-ci.yml": ["web"],
    "native-core.yml": ["native (windows-latest)", "native (ubuntu-latest)", "native (macos-latest)"],
    "automation-ci.yml": ["policy (ubuntu-latest)", "policy (windows-latest)"],
    "apple-ci.yml": ["swift-core"],
}


def authorize_actor(*, event, ref, actor, triggering_actor, allowed):
    if (event != "workflow_dispatch" or ref != "refs/heads/main"
            or not isinstance(allowed, list) or not allowed
            or any(not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9-]+", login)
                   for login in allowed)
            or actor not in allowed or triggering_actor not in allowed):
        raise ValueError("release requires manual main dispatch by an explicitly allowed human")


def collect_required_checks(request, sha, requirements=None):
    if not valid_sha(sha):
        raise ValueError("exact release SHA required")
    requirements = REQUIRED if requirements is None else requirements
    verified = {}
    if not requirements:
        raise ValueError("required workflows cannot be empty")
    for filename, names in requirements.items():
        if not re.fullmatch(r"[a-z0-9-]+\.yml", filename):
            raise ValueError("invalid workflow identity")
        data = request(f"/actions/workflows/{filename}/runs?head_sha={sha}&event=push&per_page=100")
        candidates = [run for run in data["workflow_runs"]
                      if run.get("head_sha") == sha and run.get("head_branch") == "main"
                      and run.get("event") == "push"]
        if not candidates:
            raise ValueError(f"no main integration run: {filename}")
        run = max(candidates, key=lambda row: (row["run_number"], row["run_attempt"]))
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            raise ValueError(f"integration workflow not successful: {filename}")
        jobs = []
        page = 1
        while True:
            data = request(f"/actions/runs/{int(run['id'])}/attempts/{int(run['run_attempt'])}/jobs?per_page=100&page={page}")
            jobs.extend(data["jobs"])
            if len(jobs) >= data["total_count"]:
                break
            if not data["jobs"]:
                raise ValueError("incomplete job evidence")
            page += 1
        rows = [{**job, "workflow_id": run["workflow_id"]} for job in jobs]
        result = verify_checks(sha, dict.fromkeys(names, run["workflow_id"]), rows)
        verified.update({filename + ":" + name: value for name, value in result.items()})
    return verified


def main():
    authorize_actor(event=os.environ["GITHUB_EVENT_NAME"], ref=os.environ["GITHUB_REF"],
                    actor=os.environ["GITHUB_ACTOR"],
                    triggering_actor=os.environ["GITHUB_TRIGGERING_ACTOR"],
                    allowed=json.loads(os.environ.get("SHUFANG_RELEASE_ACTORS", "[]") or "[]"))
    api = GitHubIssues(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    checks = collect_required_checks(api.request, os.environ["GITHUB_SHA"])
    print(json.dumps({"head_sha": os.environ["GITHUB_SHA"], "required_checks": checks}))


if __name__ == "__main__":
    main()
