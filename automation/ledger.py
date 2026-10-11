"""Single-coordinator durable journal; never infer process death from a timeout.

This local journal is a worker/coordinator cache, not a replacement for GitHub
Issues. Keep one coordinator instance and back up the file while it is stopped.
Schema 1 is initial-only; unknown versions require an explicit future migration.
"""
import json
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from automation.engine import reconcile, transition


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._transaction() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("unsupported automation ledger schema")
            db.execute("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS leases (task TEXT PRIMARY KEY, "
                       "host TEXT NOT NULL UNIQUE, token TEXT NOT NULL, started INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS budgets (task TEXT PRIMARY KEY, "
                       "reserved INTEGER NOT NULL)")
            db.execute("PRAGMA user_version = 1")

    @contextmanager
    def _transaction(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _tasks(db):
        return [json.loads(row[0]) for row in db.execute("SELECT body FROM tasks ORDER BY rowid")]

    @staticmethod
    def _write(db, task):
        db.execute("INSERT INTO tasks(id, body) VALUES (?, ?) "
                   "ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                   (task["id"], json.dumps(task, ensure_ascii=True, sort_keys=True)))

    @staticmethod
    def _owned(db, task_id, token):
        row = db.execute("SELECT token FROM leases WHERE task=?", (task_id,)).fetchone()
        if not row or not secrets.compare_digest(row[0], token):
            raise PermissionError("task lease is not owned by this worker")
        row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise ValueError("unknown task")
        return json.loads(row[0])

    def tasks(self):
        with self._transaction() as db:
            return self._tasks(db)

    def reconcile(self, specifications, source_sha):
        with self._transaction() as db:
            tasks = reconcile(self._tasks(db), specifications, source_sha)
            for task in tasks:
                self._write(db, task)
            return tasks

    def claim(self, task_id, host, *, now):
        if not isinstance(host, str) or not host.strip():
            raise ValueError("host identity required")
        with self._transaction() as db:
            if db.execute("SELECT 1 FROM leases WHERE host=? OR task=?", (host, task_id)).fetchone():
                raise BlockingIOError("host or task already leased; reconcile process before retry")
            row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise ValueError("unknown task")
            task = json.loads(row[0])
            if task["state"] != "queued":
                raise ValueError("only queued tasks may be claimed")
            token = secrets.token_hex(32)
            db.execute("INSERT INTO leases VALUES (?, ?, ?, ?)", (task_id, host, token, now))
            self._write(db, transition(task, "planning"))
            return token

    def advance(self, task_id, token, state, **kwargs):
        with self._transaction() as db:
            task = transition(self._owned(db, task_id, token), state, **kwargs)
            self._write(db, task)
            # Lease stays held until the caller confirms its process has stopped.
            return task

    def reserve_call(self, task_id, token):
        """Charge before launching: a crash cannot reset the two-hour budget."""
        with self._transaction() as db:
            task = self._owned(db, task_id, token)
            if task["state"] not in {"planning", "implementing", "verifying"}:
                raise ValueError("task is not runnable")
            row = db.execute("SELECT reserved FROM budgets WHERE task=?", (task_id,)).fetchone()
            used = row[0] if row else 0
            duration = min(2700, 7200 - used)
            if duration <= 0:
                raise ValueError("execution budget exhausted")
            db.execute("INSERT INTO budgets VALUES (?, ?) "
                       "ON CONFLICT(task) DO UPDATE SET reserved=excluded.reserved",
                       (task_id, used + duration))
            return duration

    def recover(self, task_id, token, *, stopped):
        if stopped is not True:
            raise ValueError("process termination must be confirmed before releasing the host")
        with self._transaction() as db:
            task = self._owned(db, task_id, token)
            if task["state"] in {"planning", "implementing", "verifying"}:
                task = transition(task, "waiting", reason="host_offline")
                self._write(db, task)
            db.execute("DELETE FROM leases WHERE task=?", (task_id,))
