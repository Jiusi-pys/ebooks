"""Record exact source inputs and APK identity without collecting local secrets."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
def command(*args):
    return subprocess.check_output(args, cwd=root).decode("utf-8").strip()

paths = subprocess.check_output(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root
).decode("utf-8").split("\0")
def source(name):
    return name.startswith(("base/", "platforms/android/", "app/src/", "app/contracts/", "ios/Shufang/", "ios/ShufangTests/", "ios/scripts/", "ios/Shufang.xcodeproj/")) or name in (
        ".gitattributes", "app/package.json", "app/package-lock.json", "app/tsconfig.json", "app/public/pdf.worker.min.mjs", "ios/Package.swift"
    )

inputs = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
          for name in sorted(set(paths)) if source(name) and (root / name).is_file()}
manifest = json.dumps(inputs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
apk = root / "platforms/android/app/build/outputs/apk/debug/app-debug.apk"
jdk = Path(os.environ["JAVA_HOME"])
ndk = root / ".tools/android-downloads/android-ndk-r28c"
receipt = {
    "branch": command("git", "branch", "--show-current"),
    "sourceCommit": command("git", "rev-parse", "HEAD"),
    "sourceManifestSha256": hashlib.sha256(manifest.encode("utf-8")).hexdigest(),
    "sourceFiles": inputs,
    "workingTreeSourceChanges": [name for name in command("git", "-c", "core.quotePath=false", "diff", "HEAD", "--name-only").splitlines() if source(name)],
    "untrackedSourceFiles": [name for name in command("git", "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard").splitlines() if source(name)],
    "apk": {"name": apk.name, "bytes": apk.stat().st_size, "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "signing": "debug"},
    "toolchain": {"gradle": "9.6.0", "agp": "9.4.0", "composeCompiler": "2.4.20", "compileSdk": 37, "minSdk": 26,
                  "rust": command(str(Path.home() / ".cargo/bin/rustc.exe"), "--version"),
                  "node": command("node", "--version"),
                  "jdkRelease": (jdk / "release").read_text(),
                  "ndkProperties": (ndk / "source.properties").read_text()},
}
destination = apk.with_name("build-receipt.json")
destination.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Build receipt: {destination}")
print(f"Source manifest SHA-256: {receipt['sourceManifestSha256']}")
