"""Pure task reconciliation. GitHub adapters must verify evidence independently."""
import copy
import hashlib
import json
import re
from pathlib import PurePosixPath


PLATFORMS = {"web", "windows", "android", "ios", "macos"}
STATES = {
    "queued": {"planning", "waiting", "blocked", "superseded"},
    "planning": {"implementing", "needs_design", "waiting", "blocked", "superseded"},
    "needs_design": {"queued", "superseded"},
    "implementing": {"verifying", "waiting", "blocked", "superseded"},
    "verifying": {"implementing", "pr_open", "blocked", "waiting", "superseded"},
    "pr_open": {"integrated", "implementing", "blocked", "superseded"},
    "waiting": {"queued", "superseded"},
    "blocked": {"queued", "superseded"},
    "integrated": set(),
    "superseded": set(),
}


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def valid_path(value):
    return (isinstance(value, str) and bool(value) and "\\" not in value
            and ":" not in value and not value.startswith("/")
            and not any(part in {"", ".", ".."} for part in value.split("/"))
            and str(PurePosixPath(value)) == value)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                    separators=(",", ":")).encode()).hexdigest()


def validate_capabilities(specs):
    if not isinstance(specs, list):
        raise ValueError("capabilities must be a list")
    ids = set()
    for spec in specs:
        if not isinstance(spec, dict) or set(spec) != {
            "id", "revision", "title", "platforms", "references", "acceptance"
        }:
            raise ValueError("invalid capability fields")
        identifier = spec["id"]
        if (not isinstance(identifier, str)
                or not re.fullmatch(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*", identifier)
                or identifier in ids):
            raise ValueError("invalid or duplicate capability id")
        ids.add(identifier)
        if type(spec["revision"]) is not int or spec["revision"] < 1:
            raise ValueError("revision must be a positive integer")
        if not isinstance(spec["title"], str) or not spec["title"].strip():
            raise ValueError("title required")
        platforms = spec["platforms"]
        if (not isinstance(platforms, list) or not platforms
                or any(not isinstance(p, str) or p not in PLATFORMS for p in platforms)
                or len(set(platforms)) != len(platforms)):
            raise ValueError("invalid platforms")
        if (not isinstance(spec["references"], list) or not spec["references"]
                or not all(valid_path(p) for p in spec["references"])):
            raise ValueError("invalid reference path")
        if (not isinstance(spec["acceptance"], list) or not spec["acceptance"]
                or not all(isinstance(s, str) and s.strip() for s in spec["acceptance"])):
            raise ValueError("acceptance scenarios required")


def reconcile(existing, specs, source_sha):
    validate_capabilities(specs)
    if not valid_sha(source_sha):
        raise ValueError("invalid source SHA")
    tasks = copy.deepcopy(existing)
    identities = {}
    for task in tasks:
        identity = (task["capability"], task["revision"], task["platform"])
        if identity in identities or task["state"] not in STATES:
            raise ValueError("duplicate task or invalid state")
        identities[identity] = task
    for spec in specs:
        spec_hash = digest(spec)
        for task in tasks:
            if task["capability"] != spec["id"]:
                continue
            if task["revision"] == spec["revision"] and task["spec_hash"] != spec_hash:
                raise ValueError("changed specification requires a new revision")
            if task["revision"] > spec["revision"]:
                raise ValueError("capability revision cannot go backwards")
            if task["revision"] < spec["revision"] and task["state"] not in {"integrated", "superseded"}:
                task["state"] = "superseded"
        for platform in spec["platforms"]:
            identity = (spec["id"], spec["revision"], platform)
            if identity in identities:
                continue
            task = {
                "id": digest(list(identity))[:24], "capability": spec["id"],
                "revision": spec["revision"], "platform": platform,
                "spec_hash": spec_hash, "source_sha": source_sha,
                "state": "queued", "repair_attempts": 0,
            }
            tasks.append(task)
            identities[identity] = task
    return tasks


def transition(task, state, *, reason=None, evidence=None):
    prior = task["state"]
    if state not in STATES.get(prior, set()):
        raise ValueError(f"invalid transition {prior} -> {state}")
    result = copy.deepcopy(task)
    if state == "waiting" and reason not in {"host_offline", "auth_required", "quota_exhausted"}:
        raise ValueError("waiting requires an environment reason")
    if state == "implementing" and prior in {"verifying", "pr_open"}:
        if result["repair_attempts"] >= 2:
            raise ValueError("repair budget exhausted")
        result["repair_attempts"] += 1
    if state == "integrated":
        checks = evidence.get("required_checks") if isinstance(evidence, dict) else None
        if (not evidence or not valid_sha(task.get("head_sha"))
                or evidence.get("head_sha") != task["head_sha"]
                or evidence.get("merged") is not True or not checks
                or not isinstance(checks, dict)
                or any(value != "success" for value in checks.values())):
            raise ValueError("integration requires current-head merged and successful check evidence")
        result["evidence"] = copy.deepcopy(evidence)
    result["state"] = state
    if reason:
        result["reason"] = reason
    else:
        result.pop("reason", None)
    return result


def classify(paths):
    """Unknown code is high risk; UI-only allowlist is deliberately narrow."""
    level = "low"
    if not paths:
        return "high"
    for path in paths:
        if not valid_path(path):
            return "high"
        lowered = path.lower()
        if (path.startswith((".github/", "automation/", "specs/", "deploy/", "app/db/"))
                or PurePosixPath(path).name == "AGENTS.md"
                or any(word in lowered for word in (
                    "test", "fixture", "migration", "sync", "conflict", "auth", "backup", "restore",
                    "credential", "bindings", "corebridge", "studystore", "package", "lock"
                ))):
            return "high"
        if path.startswith(("base/crates/application/", "base/crates/domain/",
                            "app/src/lib/", "app/contracts/")):
            level = "medium"
        elif path.startswith(("app/src/components/", "app/src/pages/",
                              "platforms/windows/Shufang.Windows/Views/", "ios/Shufang/Views/")):
            continue
        else:
            return "high"
    return level
