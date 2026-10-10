#!/usr/bin/env python3
"""Disposable native study fixture. Never use as a production server.

Bind: 127.0.0.1:8788. Debug app credentials: demo / demo-password.
All data is in memory. --pdf PATH seeds a PDF source in addition to text samples.
Control: POST /__fixture/control with X-Fixture-Control: study-smoke and JSON:
{"offline":true}, {"expireSession":true}, {"dropNextPushReply":true}, or
{"remote":{"kind":"notes","id":"demo-note","patch":{"content":"remote"}}}.
GET /__fixture/state (same header) exposes fixture-only entities and operation IDs.
Swift integration tests also use POST /test/reset, /test/mutate and
/test/drop-next-reply. These controls are loopback-only and reject foreign Origins.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

WORKSPACE = "study-smoke-workspace"
COOKIE = "shufang_session=fixture-study-session"
LOCK = threading.RLock()
STATE = {"entities": {}, "operations": [], "seen": set(), "snapshots": {}, "blobs": {}, "uploads": {},
         "offline": False, "expired": False, "dropNextPushReply": False, "clock": 0}
CHUNK_SIZE = 256 * 1024
MAX_BYTES = 256 * 1024 * 1024
PORT = 8788
PDF_PATH = None


def now():
    return int(time.time() * 1000)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def operation(kind, entity_id, patch, unset=(), deleted=False, replica="fixture"):
    STATE["clock"] = max(STATE["clock"] + 1, now())
    return dict(workspaceId=WORKSPACE, operationId=str(uuid.uuid4()), replicaId=replica,
                kind=kind, entityId=entity_id, clock=f'{STATE["clock"]}:0', patch=patch,
                unset=list(unset), deleted=deleted)


def apply(op):
    if op["operationId"] in STATE["seen"]:
        prior = next(item for item in STATE["operations"] if item["operationId"] == op["operationId"])
        if prior != op:
            raise ValueError("operation_id_reused")
        return False
    key = op["kind"] + ":" + op["entityId"]
    entity = STATE["entities"].setdefault(key, dict(id=op["entityId"], kind=op["kind"], deleted=False, fields={}))
    clock = op["clock"].split(":")
    STATE["clock"] = max(STATE["clock"], int(clock[0]))
    version = f'{int(clock[0]):016d}:{int(clock[1]):010d}:{op["replicaId"]}:{op["operationId"]}'
    entity["deleted"] = entity["deleted"] or op.get("deleted", False)
    for name in set(op.get("patch", {})) | set(op.get("unset", [])):
        old = entity["fields"].get(name)
        if old and old["version"] >= version:
            continue
        field = dict(version=version, removed=name in op.get("unset", []))
        if not field["removed"]:
            field["value"] = copy.deepcopy(op["patch"][name])
        entity["fields"][name] = field
    STATE["operations"].append(copy.deepcopy(op))
    STATE["seen"].add(op["operationId"])
    return True


def values(entity):
    result = {name: copy.deepcopy(field.get("value")) for name, field in entity["fields"].items() if not field.get("removed")}
    for name, value in list(result.items()):
        if isinstance(value, dict) and "$blob" in value:
            data = STATE["blobs"].get(value["$blob"].get("sha256"))
            if data:
                result[name] = json.loads(data)
    return result


def records(kind):
    return [dict(id=e["id"], **values(e)) for e in STATE["entities"].values() if e["kind"] == kind and not e["deleted"]]


def find(kind, entity_id):
    return next((item for item in records(kind) if item["id"] == entity_id), None)


def seed(pdf_path):
    timestamp = now()
    paragraphs = ["子曰：“学而时习之，不亦说乎？有朋自远方来，不亦乐乎？”", "曾子曰：“吾日三省吾身。”", "精确选区包括中文、English 和 emoji 📚。此段用来验证 UTF-16 偏移与离线摘录。"]
    note_start = len(paragraphs[0].encode("utf-16-le")) // 2
    paragraphs[0] += "[1]"
    chapters = [dict(id="chapter-1", title="学而", paragraphs=paragraphs, footnotes=[dict(paraIndex=0, start=note_start, end=note_start + 3, content="时习：按时温习、实践所学。\n书内注释支持离线阅读，点击编号即可查看。")]),
                dict(id="chapter-2", title="为政", paragraphs=["温故而知新，可以为师矣。", "学而不思则罔，思而不学则殆。"])]
    apply(operation("books", "fixture-book", dict(title="论语 · 学习工作台样本", author="孔子及其弟子", format="txt", chapters=chapters, coverTone=1, createdAt=timestamp)))
    text = "曾子曰：“吾日三省吾身。”"
    apply(operation("highlights", "fixture-card", dict(bookId="fixture-book", chapterId="chapter-1", chapterTitle="学而", text=text,
        paraIndex=1, start=0, end=len(text.encode("utf-16-le")) // 2, name="每日反思", note="试着把反思转为可检查的问题。", tags=["备考"], cloze=["三省"],
        style=dict(kind="background", color="orange"), createdAt=timestamp, review=dict(due=timestamp, reps=0, lapses=0, interval=0, addedAt=timestamp))))
    apply(operation("notes", "demo-note", dict(title="研究记录", content="本地修改与远程冲突的固定测试笔记。\n\n关联 [[复习方法]]。", createdAt=timestamp, updatedAt=timestamp)))
    apply(operation("notes", "fixture-linked-note", dict(title="复习方法", content="从摘录回到原文，再解释其含义。", createdAt=timestamp, updatedAt=timestamp)))
    apply(operation("studySets", "fixture-set", {"name": "申论素材", "description": "离线学习样本", "@member:fixture-book": True, "createdAt": timestamp, "updatedAt": timestamp}))
    apply(operation("mindMaps", "fixture-map", {"title": "论语学习脉络", "bookId": "fixture-book", "createdAt": timestamp, "updatedAt": timestamp,
        "@node:root:text": "学与思", "@node:root:parent": None, "@node:root:order": 0,
        "@node:leaf:text": "每日反思", "@node:leaf:sourceHighlightId": "fixture-card", "@node:leaf:parent": "root", "@node:leaf:order": 0}))
    if pdf_path:
        data = Path(pdf_path).read_bytes()
        if not data.startswith(b"%PDF-"):
            raise ValueError("--pdf must be a PDF file")
        sha = digest(data)
        STATE["blobs"][sha] = data
        for book_id, title in [("fixture-pdf", "PDF 学习与旋转测试"), ("fixture-pdf-compare", "PDF 对照参考")]:
            apply(operation("books", book_id, dict(title=title, author="书房联调", format="pdf", coverTone=2, chapters=[], createdAt=timestamp)))
            apply(operation("sources", book_id, dict(sha256=sha, size=len(data), name="fixture.pdf", type="application/pdf", format="pdf")))
        apply(operation("studySets", "fixture-set", {"@member:fixture-pdf": True}))


def reset():
    STATE.update(entities={}, operations=[], seen=set(), snapshots={}, blobs={}, uploads={},
                 offline=False, expired=False, dropNextPushReply=False, clock=0)
    seed(PDF_PATH)


class Handler(BaseHTTPRequestHandler):
    def respond(self, value, status=200, headers=None):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.raw(data, "application/json", status, headers)

    def raw(self, data, content_type, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def body(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size < 0 or size > MAX_BYTES:
            raise ValueError("invalid_body_size")
        return self.rfile.read(size)

    def json_body(self):
        raw = self.body()
        return json.loads(raw) if raw else {}

    def route(self):
        try:
            with LOCK:
                self.dispatch()
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as error:
            self.respond({"error": "invalid_request", "detail": str(error)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def dispatch(self):
        parsed = urlparse(self.path)
        path = [unquote(part) for part in parsed.path.strip("/").split("/")]
        query = parse_qs(parsed.query)
        if path[0] == "test" and self.command == "POST":
            if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{PORT}"):
                self.respond({"error": "fixture_control_required"}, 403); return
            data = self.json_body()
            if path == ["test", "reset"]:
                reset()
            elif path == ["test", "mutate"]:
                apply(operation(data["kind"], data["id"], data.get("patch", {}), data.get("unset", []), data.get("deleted", False), replica="remote-fixture"))
            elif path == ["test", "drop-next-reply"]:
                STATE["dropNextPushReply"] = True
            else:
                self.respond({"error": "not_found"}, 404); return
            self.respond({"ok": True}); return
        if path[0] == "__fixture":
            if self.headers.get("X-Fixture-Control") != "study-smoke":
                self.respond({"error": "fixture_control_required"}, 403); return
            if path == ["__fixture", "state"] and self.command == "GET":
                self.respond(dict(entities=list(STATE["entities"].values()), operations=STATE["operations"], blobs=list(STATE["blobs"]),
                                  offline=STATE["offline"], expired=STATE["expired"])); return
            if path == ["__fixture", "control"] and self.command == "POST":
                data = self.json_body()
                for incoming, key in [("offline", "offline"), ("expireSession", "expired"), ("dropNextPushReply", "dropNextPushReply")]:
                    if incoming in data: STATE[key] = bool(data[incoming])
                if "remote" in data:
                    item = data["remote"]
                    apply(operation(item["kind"], item["id"], item.get("patch", {}), item.get("unset", []), item.get("deleted", False), replica="remote-fixture"))
                self.respond({"ok": True}); return
            self.respond({"error": "not_found"}, 404); return
        if STATE["offline"]:
            self.respond({"error": "fixture_network_unavailable"}, 503); return
        origin = f"http://127.0.0.1:{PORT}"
        if self.command not in ("GET", "HEAD") and self.headers.get("Origin") != origin:
            self.respond({"error": "csrf_rejected"}, 403); return
        if path == ["api", "auth", "login"] and self.command == "POST":
            if self.json_body() != {"appId": "demo", "appSecret": "demo-password"}:
                self.respond({"error": "invalid_credentials"}, 401); return
            STATE["expired"] = False
            self.respond({"ok": True, "user": {"id": "demo"}, "expiresAt": now() + 24 * 3600 * 1000, "setupRequired": False},
                         headers={"Set-Cookie": COOKIE + "; Path=/; HttpOnly; SameSite=Strict"}); return
        if self.headers.get("Cookie") != COOKIE or STATE["expired"]:
            self.respond({"error": "unauthorized"}, 401); return
        if len(path) < 3 or path[0] != "api":
            self.respond({"error": "not_found"}, 404); return
        if path[1] == "v2": self.v2(path[2:], query)
        elif path[1] == "v1": self.v1(path[2:])
        else: self.respond({"error": "not_found"}, 404)

    def v2(self, path, query):
        if path == ["capabilities"]:
            self.respond({"version": 2, "workspaceId": WORKSPACE, "nodeId": "fixture-node"}); return
        if path == ["entities"] and self.command == "GET":
            kind = query.get("kind", [None])[0]
            after = query.get("after", [""])[0]
            entries = [e for key, e in sorted(STATE["entities"].items()) if key > after and (kind is None or e["kind"] == kind)]
            batch = entries[:100]
            next_key = batch[-1]["kind"] + ":" + batch[-1]["id"] if len(entries) > 100 else None
            self.respond(dict(entities=batch, next=next_key)); return
        if path == ["sync", "snapshots"] and self.command == "POST":
            key = str(uuid.uuid4())
            STATE["snapshots"][key] = dict(entities=copy.deepcopy(list(STATE["entities"].values())), cursor=str(len(STATE["operations"])))
            self.respond({"id": key, "cursor": STATE["snapshots"][key]["cursor"]}); return
        if path[:2] == ["sync", "snapshots"] and len(path) == 3 and self.command == "GET":
            snapshot = STATE["snapshots"].get(path[2])
            if not snapshot: self.respond({"error": "snapshot_expired"}, 409); return
            offset = int(query.get("after", ["0"])[0]); batch = snapshot["entities"][offset:offset + 100]
            after = str(offset + 100) if offset + 100 < len(snapshot["entities"]) else None
            self.respond(dict(entities=batch, next=after, cursor=snapshot["cursor"])); return
        if path == ["sync", "changes"] and self.command == "GET":
            cursor = int(query.get("cursor", ["0"])[0])
            if cursor < 0 or cursor > len(STATE["operations"]): self.respond({"error": "cursor_expired"}, 409); return
            batch = STATE["operations"][cursor:cursor + 100]
            self.respond(dict(operations=batch, cursor=str(cursor + len(batch)), hasMore=cursor + len(batch) < len(STATE["operations"]))); return
        if path == ["sync", "push"] and self.command == "POST":
            receipts = []
            for op in self.json_body()["operations"]:
                if op["workspaceId"] != WORKSPACE:
                    receipts.append(dict(operationId=op["operationId"], error="wrong_workspace")); continue
                apply(op)
                receipts.append(dict(operationId=op["operationId"]))
            if STATE["dropNextPushReply"]:
                STATE["dropNextPushReply"] = False
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            self.respond({"receipts": receipts}); return
        if path == ["blobs", "uploads"] and self.command == "POST":
            manifest = self.json_body(); size = int(manifest["size"]); sha = manifest["sha256"]
            if size < 0 or size > MAX_BYTES or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha): raise ValueError("invalid_manifest")
            key = str(uuid.uuid4())
            STATE["uploads"][key] = dict(manifest=manifest, chunks={})
            self.respond(dict(id=key, chunkSize=CHUNK_SIZE, chunks=math.ceil(size / CHUNK_SIZE), present=sha in STATE["blobs"])); return
        if path[:2] == ["blobs", "uploads"] and len(path) == 4:
            upload = STATE["uploads"].get(path[2])
            if not upload: self.respond({"error": "upload_not_found"}, 404); return
            manifest = upload["manifest"]
            if path[3] == "commit" and self.command == "POST":
                if manifest["sha256"] not in STATE["blobs"]:
                    count = math.ceil(manifest["size"] / CHUNK_SIZE)
                    if sorted(upload["chunks"]) != list(range(count)): raise ValueError("missing_chunks")
                    data = b"".join(upload["chunks"][i] for i in range(count))
                    if len(data) != manifest["size"] or digest(data) != manifest["sha256"]: raise ValueError("checksum_mismatch")
                    STATE["blobs"][manifest["sha256"]] = data
                self.respond({"ok": True}); return
            if self.command == "PUT":
                index = int(path[3]); data = self.body()
                if not 0 <= index < math.ceil(manifest["size"] / CHUNK_SIZE): raise ValueError("invalid_chunk")
                if len(data) != min(CHUNK_SIZE, manifest["size"] - index * CHUNK_SIZE): raise ValueError("invalid_chunk_size")
                if digest(data) != self.headers.get("X-Chunk-SHA256"): raise ValueError("chunk_checksum_mismatch")
                upload["chunks"][index] = data
                self.respond({"ok": True}); return
        if len(path) == 2 and path[0] == "blobs" and self.command == "GET":
            data = STATE["blobs"].get(path[1])
            if data is None: self.respond({"error": "blob_not_found"}, 404)
            else: self.raw(data, "application/octet-stream")
            return
        self.respond({"error": "not_found"}, 404)

    def v1(self, path):
        if self.command == "GET":
            if path == ["books"]:
                self.respond({"books": [self.book_projection(b) for b in records("books")]}); return
            if path and path[0] == "books" and len(path) >= 2:
                book = find("books", path[1])
                if not book: self.respond({"error": "not_found"}, 404); return
                chapters = book.get("chapters", [])
                if len(path) == 2: self.respond(self.book_projection(book)); return
                if path[2:] == ["chapters"]:
                    self.respond({"chapters": [dict(id=c["id"], index=i, title=c["title"], paragraphs=len(c["paragraphs"]), chars=sum(len(p.encode("utf-16-le")) // 2 for p in c["paragraphs"])) for i, c in enumerate(chapters)]}); return
                if len(path) == 4 and path[2] == "chapters":
                    index = int(path[3])
                    if index >= len(chapters): self.respond({"error": "not_found"}, 404)
                    else: self.respond(dict(index=index, **chapters[index]))
                    return
                if path[2:] == ["source"]:
                    source = find("sources", book["id"]); data = STATE["blobs"].get(source.get("sha256")) if source else None
                    if data is None: self.respond({"error": "not_found"}, 404)
                    else: self.raw(data, "application/pdf")
                    return
            if path == ["notes"]: self.respond({"notes": [dict(extId=n["id"], **{k: v for k, v in n.items() if k != "id"}) for n in records("notes")]}); return
            if len(path) == 2 and path[0] == "notes":
                item = find("notes", path[1])
                if item: self.respond(dict(extId=item["id"], **{k: v for k, v in item.items() if k != "id"}))
                else: self.respond({"error": "not_found"}, 404)
                return
            if path in (["highlights"], ["review", "due"]):
                cards = [dict(extId=h["id"], bookExtId=h["bookId"], bookTitle=(find("books", h["bookId"]) or {}).get("title", ""), **{k: v for k, v in h.items() if k != "id"}) for h in records("highlights")]
                if path == ["highlights"]: self.respond({"highlights": cards})
                else: self.respond({"now": now(), "cards": [c for c in cards if c.get("review", {}).get("due", now() + 1) <= now()]})
                return
        if path == ["ask"] and self.command == "POST":
            self.json_body()
            self.respond({"answer": "联调固定回答：先复述所选原文，再解释其证据。\n这只是客户端流程测试，不是真实模型推理。"}); return
        if path and path[0] in ("books", "notes", "highlights") and self.command in ("PATCH", "POST"):
            data = self.json_body(); entity_id = path[1] if len(path) == 2 else data.pop("extId", str(uuid.uuid4()))
            if "bookExtId" in data: data["bookId"] = data.pop("bookExtId")
            apply(operation(path[0], entity_id, data)); self.respond({"ok": True}); return
        self.respond({"error": "not_found"}, 404)

    @staticmethod
    def book_projection(book):
        result = dict(book)
        result["extId"] = result.pop("id")
        result.setdefault("author", ""); result.setdefault("folder", "")
        result["chapterCount"] = len(result.get("chapters", []))
        return result

    do_GET = route
    do_HEAD = route
    do_POST = route
    do_PATCH = route
    do_PUT = route
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)  # Request path/status only, never headers or body.


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--pdf", type=Path)
    args = parser.parse_args()
    PORT = args.port
    PDF_PATH = args.pdf
    reset()
    print(f"Disposable fixture: http://127.0.0.1:{PORT}; demo/demo-password; {len(STATE['entities'])} entities", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
