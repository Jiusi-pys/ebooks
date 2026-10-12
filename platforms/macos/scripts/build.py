"""Build a local macOS bundle with the actual Rust ABI 1 library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import shutil
import secrets
import subprocess
import sys

from parsers import build as build_parsers

ROOT = Path(__file__).resolve().parents[3]


def main():
    if sys.platform != "darwin":
        raise SystemExit("macOS required")
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--universal", action="store_true", help="build ARM64 and Intel app/core plus macOS XCFramework")
    options = arguments.parse_args()
    allowed = {"PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "CARGO_HOME", "RUSTUP_HOME"}
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    tooling = ROOT / ".tools/rust"
    if (tooling / "cargo/bin/cargo").is_file():
        environment.update(CARGO_HOME=str(tooling / "cargo"), RUSTUP_HOME=str(tooling / "rustup"))
        environment["PATH"] = str(tooling / "cargo/bin") + os.pathsep + environment.get("PATH", "")
    environment["MACOSX_DEPLOYMENT_TARGET"] = "13.0"
    environment["CARGO_BUILD_JOBS"] = "2"
    environment["SHUFANG_CREDENTIAL_KEY"] = secrets.token_hex(32)
    def run(argv):
        return subprocess.run(argv, cwd=ROOT, env=environment, check=True)
    parser, parser_library, parser_source = build_parsers(ROOT, environment)
    run(["cargo", "build", "--manifest-path", "base/Cargo.toml", "-p", "shufang-bindings", "--release", "--locked"])
    run(["swift", "build", "--package-path", "platforms/macos", "-c", "release"])
    bin_path = subprocess.check_output(["swift", "build", "--package-path", "platforms/macos", "-c", "release", "--show-bin-path"], cwd=ROOT, env=environment, text=True).strip()
    library = ROOT / "base/target/release/libshufang_bindings.dylib"
    run(["cargo", "build", "--manifest-path", "base/Cargo.toml", "-p", "shufang-service", "--example", "macos-test-server", "--locked"])
    environment["SHUFANG_MAC_TEST_SERVER"] = str(ROOT / "base/target/debug/examples/macos-test-server")
    environment["SHUFANG_MOBITOOL"] = str(parser)
    environment["SHUFANG_MAC_MOBI_FIXTURE"] = str(parser_source / "tests/samples/sample-ncx.mobi")
    environment["SHUFANG_MAC_CORE"] = str(library)
    run(["swift", "test", "--package-path", "platforms/macos"])
    # Keep generated bundles outside iCloud; Finder metadata can invalidate signing.
    bundle = Path.home() / "Library/Caches/Shufang/macos-local-build/Shufang.app"
    contents = bundle / "Contents"
    executable = contents / "MacOS/ShufangMac"
    dylib = contents / "Frameworks/libshufang_bindings.dylib"
    executable.parent.mkdir(parents=True, exist_ok=True)
    dylib.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(bin_path) / "ShufangMac", executable)
    executable.chmod(0o755)
    shutil.copyfile(library, dylib)
    resources = contents / "Resources"
    resources.mkdir(parents=True, exist_ok=True)
    bundled_parser = resources / "mobitool"
    bundled_mobi = contents / "Frameworks/libmobi.dylib"
    shutil.copyfile(parser, bundled_parser)
    bundled_parser.chmod(0o755)
    shutil.copyfile(parser_library, bundled_mobi)
    for filename in ["COPYING", "COPYING.LESSER"]:
        if (parser_source / filename).is_file():
            shutil.copyfile(parser_source / filename, resources / ("libmobi-" + filename))
    subprocess.run(["git", "-C", str(parser_source), "archive", "--format=tar.gz",
                    "--output=" + str(resources / "libmobi-v0.12-source.tar.gz"), "HEAD"], check=True)
    shutil.copyfile(Path(__file__).with_name("parsers.py"), resources / "libmobi-build.py")
    run(["install_name_tool", "-id", "@executable_path/../Frameworks/libmobi.dylib", str(bundled_mobi)])
    run(["install_name_tool", "-change", "@rpath/libmobi.0.dylib", "@executable_path/../Frameworks/libmobi.dylib", str(bundled_parser)])
    if options.universal:
        other_target = "x86_64-apple-darwin" if platform.machine() == "arm64" else "aarch64-apple-darwin"
        other_triple = "x86_64-apple-macosx13.0" if platform.machine() == "arm64" else "arm64-apple-macosx13.0"
        run(["rustup", "target", "add", other_target])
        run(["cargo", "build", "--manifest-path", "base/Cargo.toml", "-p", "shufang-bindings", "--release", "--locked", "--target", other_target])
        run(["swift", "build", "--package-path", "platforms/macos", "-c", "release", "--triple", other_triple])
        intel_path = subprocess.check_output(["swift", "build", "--package-path", "platforms/macos", "-c", "release", "--triple", other_triple, "--show-bin-path"], cwd=ROOT, env=environment, text=True).strip()
        run(["lipo", "-create", str(Path(bin_path) / "ShufangMac"), str(Path(intel_path) / "ShufangMac"), "-output", str(executable)])
        run(["lipo", "-create", str(library), str(ROOT / f"base/target/{other_target}/release/libshufang_bindings.dylib"), "-output", str(dylib)])
        static = bundle.parent / "libshufang_bindings.a"
        run(["lipo", "-create", str(ROOT / "base/target/release/libshufang_bindings.a"), str(ROOT / f"base/target/{other_target}/release/libshufang_bindings.a"), "-output", str(static)])
        framework = bundle.parent / "ShufangCore.xcframework"
        if framework.exists():
            if framework.is_symlink(): raise RuntimeError("refusing symlink XCFramework output")
            shutil.rmtree(framework)
        run(["xcodebuild", "-create-xcframework", "-library", str(static), "-headers", str(ROOT / "base/crates/bindings/include"), "-output", str(framework)])
    with (contents / "Info.plist").open("wb") as output:
        plistlib.dump({"CFBundleName": "书房", "CFBundleIdentifier": "org.shufang.mac",
                      "CFBundleExecutable": "ShufangMac", "CFBundlePackageType": "APPL",
                      "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1",
                      "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True}, output)
    run(["install_name_tool", "-id", "@rpath/libshufang_bindings.dylib", str(dylib)])
    # Local ad-hoc identity only; never Developer ID/notarization acceptance.
    run(["codesign", "--force", "--sign", "-", str(dylib)])
    run(["codesign", "--force", "--sign", "-", str(bundled_mobi)])
    run(["codesign", "--force", "--sign", "-", str(bundled_parser)])
    run(["codesign", "--force", "--sign", "-", str(bundle)])
    run(["codesign", "--verify", "--strict", str(bundle)])
    receipt = {"libmobi_source": "85dcfe803fc2a21020ddcf15c3eb66b93d388add", "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "worktree_clean": not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip(),
               "signing": "local_ad_hoc", "bundle": str(bundle),
               "sha256": {str(path.relative_to(bundle)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in (executable, dylib, bundled_parser, bundled_mobi)},
               "gui": "NOT_TESTED", "architectures": ["arm64", "x86_64"] if options.universal else [platform.machine()], "intel_hardware": "NOT_TESTED", "full_capability_matrix": "INCOMPLETE"}
    sources = list((ROOT / "platforms/macos/Sources").rglob("*.swift")) + list((ROOT / "platforms/macos/Tests").rglob("*.swift")) + list((ROOT / "platforms/macos/scripts").glob("*.py")) + [ROOT / "platforms/macos/Package.swift", ROOT / "base/Cargo.lock", ROOT / "base/Cargo.toml"]
    for crate in (ROOT / "base/crates").iterdir():
        sources += list((crate / "src").rglob("*.rs")) + list((crate / "include").rglob("*.h")) + list((crate / "examples").rglob("*.rs")) + list((crate / "tests").rglob("*.rs")) + list((crate / "migrations").rglob("*.sql")) + [crate / "Cargo.toml"]
    manifest = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(sources) if path.is_file()}
    receipt["source_manifest_sha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    receipt["tests"] = "passed_native_swift_real_abi_http"
    (bundle.parent / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (bundle.parent / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(bundle)


if __name__ == "__main__":
    main()
