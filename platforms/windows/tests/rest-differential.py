"""Runs actual old MySQL routes against a temporary native service process."""
import ctypes
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

directory = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(__file__).resolve().parents[3]
dll = ctypes.CDLL(str(directory / "shufang_bindings.dll"))
for name in ("core_alloc", "core_execute"):
    getattr(dll, name).restype = ctypes.c_void_p
dll.core_alloc.argtypes = [ctypes.c_size_t]
dll.core_execute.argtypes = [ctypes.c_void_p]
dll.core_buffer_len.argtypes = [ctypes.c_void_p]
dll.core_buffer_len.restype = ctypes.c_size_t
dll.core_free.argtypes = [ctypes.c_void_p]
def core(command, **args):
    raw = json.dumps(dict(version=1, command=command, **args)).encode()
    ptr = dll.core_alloc(len(raw)); result = None
    try:
        ctypes.memmove(ptr, raw, len(raw)); result = dll.core_execute(ptr)
        response = json.loads(ctypes.string_at(result, dll.core_buffer_len(result)))
        assert response["ok"], response
        return response["value"]
    finally:
        dll.core_free(ptr)
        if result: dll.core_free(result)
with tempfile.TemporaryDirectory(prefix="shufang-differential-") as temporary:
    root = pathlib.Path(temporary)
    session = core("sessionOpen", path=str(root / "library.sqlite3"), workspace="local-preview", replica="windows-preview")["session"]
    token = core("sessionCommand", session=session, action="serviceToken")["token"]
    core("sessionClose", session=session)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
    process = subprocess.Popen([str(directory / "shufang-service.exe"), "--workspace", str(root), "--port", str(port)], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        origin = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(origin + "/health", timeout=1).close(); break
            except OSError:
                if process.poll() is not None: raise RuntimeError("native service exited")
                time.sleep(.1)
        else: raise RuntimeError("native service not ready")
        env = dict(os.environ, RUN_NATIVE_DIFFERENTIAL="1", NATIVE_TEST_ORIGIN=origin, NATIVE_TEST_TOKEN=token)
        args = ["npm.cmd", "test", "--", "--no-file-parallelism"] if "--full" in sys.argv else ["npx.cmd", "vitest", "run", "api/v1.native-differential.test.ts"]
        result = subprocess.run(args, cwd=repo / "app", env=env)
    finally:
        try:
            request = urllib.request.Request(origin + "/admin/stop", method="POST", headers={"X-API-Key": token})
            urllib.request.urlopen(request, timeout=3).close(); process.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            process.terminate(); process.wait(timeout=10)
    sys.exit(result.returncode)
