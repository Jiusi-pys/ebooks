"""Real process acceptance; only a newly created temporary workspace is used."""
import ctypes
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.request
import sys
import base64
import hashlib
import re
import urllib.parse


def oauth_acceptance(origin, owner_token):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def send(path, body=None, form=False, bearer=None):
        headers = {}
        if bearer: headers["Authorization"] = "Bearer " + bearer
        raw = None
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
            raw = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        req = urllib.request.Request(origin + path, data=raw, headers=headers)
        try: response = client.open(req, timeout=5)
        except urllib.error.HTTPError as error: response = error
        with response: return response.status, response.read().decode(), response.headers
    code, raw, _ = send("/.well-known/oauth-authorization-server")
    assert code == 200
    discovery = json.loads(raw)
    assert discovery["issuer"].rstrip("/") == origin
    code, raw, _ = send("/oauth/register", {"client_name":"Isolated external HTTP client","redirect_uris":["http://127.0.0.1:5555/callback"]})
    assert code == 200 or code == 201
    client_id = json.loads(raw)["client_id"]
    verifier = "a" * 43
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    query = dict(client_id=client_id, redirect_uri="http://127.0.0.1:5555/callback", response_type="code", code_challenge_method="S256", code_challenge=challenge, resource=origin+"/mcp", scope="library:read", state="isolated-state")
    status, page, _ = send("/oauth/authorize?"+urllib.parse.urlencode(query))
    assert status == 200
    pending = re.search("name='request' value='([^']+)'", page).group(1)
    assert send("/oauth/authorize", dict(request=pending, token="wrong", decision="approve"), True)[0] == 401
    status, _, headers = send("/oauth/authorize", dict(request=pending, token=owner_token, decision="approve"), True)
    assert status == 303
    params = urllib.parse.parse_qs(urllib.parse.urlparse(headers["Location"]).query)
    assert params["state"] == ["isolated-state"]
    exchange = dict(grant_type="authorization_code", code=params["code"][0], client_id=client_id, redirect_uri=query["redirect_uri"], code_verifier=verifier, resource=query["resource"])
    status, raw, _ = send("/oauth/token", exchange, True)
    assert status == 200
    tokens=json.loads(raw)
    assert send("/oauth/token", exchange, True)[0] == 400
    access=tokens["access_token"]
    assert send("/api/v1/notes", bearer=access)[0] == 200
    assert send("/api/v1/notes", {"extId":"forbidden","title":"No","content":"No"}, bearer=access)[0] == 401
    assert send("/admin/status", bearer=access)[0] == 401
    refresh=dict(grant_type="refresh_token", refresh_token=tokens["refresh_token"], client_id=client_id, resource=query["resource"])
    status, raw, _ = send("/oauth/token", refresh, True)
    assert status == 200
    rotated=json.loads(raw)
    assert send("/oauth/token", refresh, True)[0] == 400
    assert send("/oauth/revoke", dict(client_id=client_id, token=rotated["refresh_token"]), True)[0] == 200
    for token in [access, rotated["access_token"]]:
        assert send("/api/v1/notes", bearer=token)[0] == 401
    print("PASS external HTTP OAuth client: discovery, PKCE, consent, one-use code, scope, rotation, revocation")


def run(directory):
    directory = pathlib.Path(directory).resolve()
    dll = ctypes.CDLL(str(directory / "shufang_bindings.dll"))
    dll.core_alloc.argtypes = [ctypes.c_size_t]
    dll.core_alloc.restype = ctypes.c_void_p
    dll.core_execute.argtypes = [ctypes.c_void_p]
    dll.core_execute.restype = ctypes.c_void_p
    dll.core_buffer_len.argtypes = [ctypes.c_void_p]
    dll.core_buffer_len.restype = ctypes.c_size_t
    dll.core_free.argtypes = [ctypes.c_void_p]

    def command(name, **args):
        data = json.dumps(dict(version=1, command=name, **args), ensure_ascii=False).encode()
        ptr = dll.core_alloc(len(data))
        assert ptr
        result = None
        try:
            ctypes.memmove(ptr, data, len(data))
            result = dll.core_execute(ptr)
            value = json.loads(ctypes.string_at(result, dll.core_buffer_len(result)))
            assert value["ok"], value
            return value["value"]
        finally:
            dll.core_free(ptr)
            if result:
                dll.core_free(result)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="shufang-process-") as temporary:
        root = pathlib.Path(temporary)
        session = command("sessionOpen", path=str(root / "library.sqlite3"), workspace="local-preview", replica="windows-preview")["session"]
        token = command("sessionCommand", session=session, action="serviceToken")["token"]
        command("sessionCommand", session=session, action="save", args=dict(kind="notes", id="desktop", expected=0, patch=dict(title="桌面", content="共享核心😀")))
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        process = subprocess.Popen([str(directory / "shufang-service.exe"), "--workspace", str(root), "--port", str(port)], creationflags=subprocess.CREATE_NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        def request(path, method="GET", body=None, auth=True):
            headers = {"X-API-Key": token} if auth else {}
            data = None
            if body is not None:
                headers["Content-Type"] = "application/json"
                data = json.dumps(body).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=headers)
            with opener.open(req, timeout=3) as response:
                return json.load(response)

        try:
            for _ in range(50):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode(errors="replace"))
                try:
                    if request("/admin/status")["ok"]:
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("service startup timeout")
            assert request("/api/v1/notes/desktop")["content"] == "共享核心😀"
            request("/api/v1/notes", "POST", dict(extId="service", title="服务", content="背景进程写入"))
            assert len(command("sessionCommand", session=session, action="list", args=dict(kind="notes"))) == 2
            command("sessionClose", session=session)
            session = None
            assert len(request("/api/v1/notes")["notes"]) == 2
            denied = False
            try:
                request("/api/v1/notes", auth=False)
            except urllib.error.HTTPError as error:
                denied = error.code == 401
            assert denied
            duplicate = subprocess.run([str(directory / "shufang-service.exe"), "--workspace", str(root), "--port", str(port)], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            assert duplicate.returncode != 0 and b"service_already_running" in duplicate.stderr
            mcp = request("/mcp", "POST", dict(jsonrpc="2.0", id=1, method="tools/call", params=dict(name="search_notes", arguments=dict(query="背景"))))
            assert "背景" in mcp["result"]["content"][0]["text"]
            oauth_acceptance(f"http://127.0.0.1:{port}", token)
            request("/admin/stop", "POST")
            assert process.wait(timeout=10) == 0
            result = subprocess.run([str(directory / "shufang-service.exe"), "--workspace", str(root), "--stdio"], input=json.dumps(dict(jsonrpc="2.0", id=1, method="tools/list")) + "\n", capture_output=True, text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            assert result.returncode == 0, result.stderr
            assert len(json.loads(result.stdout)["result"]["tools"]) == 6
            print("PASS: native desktop/service shared SQLite, independent lifetime, authentication, single instance, MCP HTTP/stdio, graceful shutdown")
        finally:
            if session:
                command("sessionClose", session=session)
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            process.stderr.close()


if __name__ == "__main__":
    run(sys.argv[1])
