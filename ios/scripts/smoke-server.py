#!/usr/bin/env python3
"""Disposable loopback fixture, NOT the production Hono/MySQL service.
Use Debug simulator only: http://127.0.0.1:8787, demo/demo-password.
State is held in memory and discarded on exit. No real books or credentials.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
import json
import time

book = dict(extId='demo-book', title='论语 · 移动端联调样本', author='孔子及其弟子', format='txt', folder='联调样本', chapterCount=2)
chapters = [
    dict(id='chapter-1', index=0, title='学而', paragraphs=['子曰：“学而时习之，不亦说乎？有朋自远方来，不亦乐乎？”', '曾子曰：“吾日三省吾身。”', '这是一份模拟器专用测试数据，用于检查中文排版、章节切换和摘录回写。📚']),
    dict(id='chapter-2', index=1, title='为政', paragraphs=['子曰：“温故而知新，可以为师矣。”', '子曰：“学而不思则罔，思而不学则殆。”'])
]
notes = {}
highlights = {}
class Handler(BaseHTTPRequestHandler):
    def respond(self, value, status=200, cookie=None):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if cookie: self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)
    def route(self):
        route = urlparse(self.path).path
        if route == '/api/auth/login' and self.command == 'POST':
            if self.headers.get('Origin') != 'http://127.0.0.1:8787':
                self.respond({'error':'csrf_rejected'}, 403); return
            try: credentials = json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
            except (ValueError, json.JSONDecodeError):
                self.respond({'error':'invalid_json'}, 400); return
            if credentials != {'appId':'demo', 'appSecret':'demo-password'}:
                self.respond({'error':'invalid_credentials'}, 401); return
            self.respond({'ok':True, 'user':{'id':'demo'},
                          'expiresAt':int((time.time()+3600)*1000), 'setupRequired':False},
                         cookie='shufang_session=simulator-session; Path=/; HttpOnly; SameSite=Strict')
            return
        if route.startswith('/api/v2/'):
            self.respond({'error':'not_found'}, 404); return
        if self.headers.get('Cookie') != 'shufang_session=simulator-session':
            self.respond({'error':'unauthorized'}, 401); return
        if self.command not in ('GET','HEAD') and self.headers.get('Origin') != 'http://127.0.0.1:8787':
            self.respond({'error':'csrf_rejected'}, 403); return
        path = [unquote(s) for s in urlparse(self.path).path.strip('/').split('/')][2:]
        if self.command == 'GET':
            if path == ['books']: self.respond({'books':[book]})
            elif path == ['books', 'demo-book', 'chapters']:
                self.respond({'chapters':[dict(id=c['id'], index=c['index'], title=c['title'], paragraphs=len(c['paragraphs']), chars=sum(len(p) for p in c['paragraphs'])) for c in chapters]})
            elif len(path) == 4 and path[:3] == ['books', 'demo-book', 'chapters'] and path[3] in ['0','1']:
                self.respond(chapters[int(path[3])])
            elif path == ['notes']: self.respond({'notes':[dict(extId=n['extId'], title=n['title'], chars=len(n['content'])) for n in notes.values()]})
            elif len(path) == 2 and path[0] == 'notes' and path[1] in notes: self.respond(notes[path[1]])
            elif path == ['highlights']: self.respond({'highlights':list(highlights.values())})
            elif path == ['review','due']:
                now = time.time() * 1000
                cards = [h for h in highlights.values() if h.get('review') and h['review']['due'] <= now]
                self.respond({'now':now, 'count':len(cards), 'cards':cards})
            else: self.respond({'error':'not_found'}, 404)
            return
        try: data = json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        except (ValueError, json.JSONDecodeError): self.respond({'error':'invalid_json'}, 400); return
        if path == ['notes'] and self.command == 'POST': notes[data['extId']] = data
        elif len(path) == 2 and path[0] == 'notes' and path[1] in notes and self.command == 'PATCH': notes[path[1]].update(data)
        elif path == ['highlights'] and self.command == 'POST': highlights[data['extId']] = data
        elif len(path) == 2 and path[0] == 'highlights' and path[1] in highlights and self.command == 'PATCH': highlights[path[1]].update(data)
        elif path == ['ask']:
            self.respond({'answer':'这是联调桩返回的固定回答，仅验证客户端展示，不代表真实 AI 推理。'}); return
        else: self.respond({'error':'not_found'},404); return
        self.respond({'ok':True}, 201 if self.command == 'POST' else 200)
    do_GET = route
    do_POST = route
    do_PATCH = route
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)  # Only method/path/status; never headers/body.
if __name__ == '__main__':
    print('Fixture only: http://127.0.0.1:8787; demo/demo-password', flush=True)
    ThreadingHTTPServer(('127.0.0.1',8787), Handler).serve_forever()
