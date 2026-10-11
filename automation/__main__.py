"""Local planning CLI. Output is a proposal, never evidence of implemented parity."""
import argparse
import json
from pathlib import Path

from automation.engine import classify, reconcile, validate_capabilities


def load_catalog(path, root):
    specs = json.loads(path.read_text(encoding="utf-8"))
    validate_capabilities(specs)
    for spec in specs:
        for reference in spec["references"]:
            resolved = (root / reference).resolve()
            if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
                raise ValueError(f"missing or escaping reference: {reference}")
    return specs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "plan", "risk"])
    parser.add_argument("--catalog", type=Path, default=Path("specs/capabilities.json"))
    parser.add_argument("--source-sha")
    parser.add_argument("--existing", type=Path)
    parser.add_argument("--changed", type=Path, help="JSON array of changed repository paths")
    args = parser.parse_args()
    if args.command == "risk":
        if not args.changed:
            parser.error("risk requires --changed")
        result = {"risk": classify(json.loads(args.changed.read_text(encoding="utf-8")))}
    else:
        specs = load_catalog(args.catalog, Path.cwd())
        if args.command == "validate":
            result = {"capabilities": len(specs), "valid": True}
        else:
            if not args.source_sha:
                parser.error("plan requires --source-sha")
            existing = json.loads(args.existing.read_text(encoding="utf-8")) if args.existing else []
            result = reconcile(existing, specs, args.source_sha)
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
