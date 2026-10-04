"""Package the exact reviewed source and prebuilt server for isolated deployment.

Ignored files (especially .env, node_modules and runtime data) never enter the
archive. The included manifest binds every source and dist byte to a checksum.
"""

import hashlib
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: package_candidate.py OUTPUT.tar.gz")
    root = Path(__file__).resolve().parent.parent
    output = Path(sys.argv[1]).resolve()
    if output.is_relative_to(root):
        raise SystemExit("candidate archive must be outside the repository")
    source = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
    )
    paths = {Path(raw.decode("utf-8")) for raw in source.split(b"\0") if raw}
    paths.update(
        path.relative_to(root)
        for path in (root / "app" / "dist").rglob("*")
        if path.is_file()
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    with tarfile.open(output, "w:gz") as archive:
        for relative in sorted(paths, key=lambda path: path.as_posix()):
            path = root / relative
            if not path.is_file():
                raise SystemExit(f"tracked file missing: {relative}")
            data = path.read_bytes()
            name = relative.as_posix()
            entry = tarfile.TarInfo(name)
            entry.mode = 0o644
            entry.size = len(data)
            entry.mtime = 0
            archive.addfile(entry, io.BytesIO(data))
            entries.append(
                {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
            )
        manifest = json.dumps(
            {
                "baseCommit": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=root, text=True
                ).strip(),
                "files": entries,
            },
            separators=(",", ":"),
        ).encode()
        entry = tarfile.TarInfo("candidate-manifest.json")
        entry.mode = 0o644
        entry.size = len(manifest)
        entry.mtime = 0
        archive.addfile(entry, io.BytesIO(manifest))
    print(
        json.dumps(
            {
                "archive": str(output),
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "files": len(entries),
            }
        )
    )


if __name__ == "__main__":
    main()
