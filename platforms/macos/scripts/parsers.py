"""Build the pinned LGPL MOBI adapter as replaceable universal dynamic binaries."""
from pathlib import Path
import subprocess
import shutil

COMMIT = "85dcfe803fc2a21020ddcf15c3eb66b93d388add"


def build(root: Path, environment: dict) -> tuple[Path, Path, Path]:
    source = root / ".tools/native/libmobi"
    output = root / ".tools/native/libmobi-build-mac"
    cmake = root / ".tools/macos-parser-env/bin/cmake"
    executable = str(cmake) if cmake.is_file() else shutil.which("cmake", path=environment["PATH"])
    if not executable:
        raise RuntimeError("CMake required; install locally in .tools/macos-parser-env or on PATH")
    def run(args, **kw):
        return subprocess.run(args, env=environment, check=True, **kw)
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--depth", "1", "--branch", "v0.12", "https://github.com/bfabiszewski/libmobi.git", str(source)])
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip()
    if actual != COMMIT or dirty:
        raise RuntimeError("libmobi must match the clean pinned source")
    run([executable, "-S", str(source), "-B", str(output), "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64",
         "-DUSE_LIBXML2=OFF", "-DUSE_ZLIB=OFF", "-DUSE_MINIZ=ON", "-DUSE_ENCRYPTION=OFF", "-DBUILD_SHARED_LIBS=ON"])
    run([executable, "--build", str(output), "--target", "mobitool", "-j", "2"])
    return output / "tools/mobitool", output / "src/libmobi.0.12.dylib", source
