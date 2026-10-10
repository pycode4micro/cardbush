"""Bounded plugin-owned image jobs with durable receipts, never paid replay."""
from __future__ import annotations

import asyncio
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

from .client import SeedreamClient, SeedreamError, prepare
from .config import get_config
from .models import DEFAULT_MODEL, ImageRequest, LocalOptions
from .task_io import TaskError


def _lock(handle):
    handle.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def account_scope(client: SeedreamClient) -> str:
    # Never persist credentials. Separates receipts when switching accounts/endpoints.
    return hashlib.sha256((client.base_url + '\0' + client.api_key).encode()).hexdigest()


class ImageJobs:
    """Two paid requests at once across processes sharing this local state directory.

    Inputs remain in the submitting process. Restarted processes read receipts but
    never replay queued/ambiguous paid work. OS locks identify dead owners without
    guessing from request duration or reusing process IDs.
    """
    def __init__(self, root: Path | None = None):
        self.root = root or Path.home() / '.volcengine-plugins' / 'image-jobs'
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.owner = uuid.uuid4().hex
        self.owner_file = self.root / (self.owner + '.lock')
        self.handle = self.owner_file.open('x+b')
        self.handle.write(b'0')
        self.handle.flush()
        _lock(self.handle)
        self.database = self.root / 'jobs.sqlite3'
        self.workers: set[asyncio.Task] = set()
        self.closed = False
        with closing(self._db()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, account TEXT NOT NULL, request_key TEXT NOT NULL,
                fingerprint TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL, result TEXT,
                UNIQUE(account, request_key))''')
        if os.name != 'nt':
            self.database.chmod(0o600)

    def _db(self):
        db = sqlite3.connect(self.database, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def _alive(self, owner):
        if owner == self.owner:
            return not self.closed
        try:
            with (self.root / (owner + '.lock')).open('r+b') as handle:
                try:
                    _lock(handle)
                except OSError:
                    return True
                return False  # Closing this probe releases its temporary lock.
        except FileNotFoundError:
            return False
        except OSError:
            return True  # Inability to inspect is not evidence of a dead owner.

    def _reap(self, db):
        for row in db.execute("SELECT id, owner, status FROM jobs WHERE status IN ('queued','running')").fetchall():
            if not self._alive(row['owner']):
                status = 'interrupted' if row['status'] == 'queued' else 'unknown'
                db.execute('UPDATE jobs SET status=?, updated=? WHERE id=? AND status=?',
                           (status, time.time(), row['id'], row['status']))

    @staticmethod
    def _receipt(row):
        status = row['status']
        task = {'id': row['id'], 'kind': 'seedream', 'status': status,
                'created_at': row['created'], 'updated_at': row['updated']}
        if row['result']:
            task['result'] = json.loads(row['result'])
        if status in {'unknown', 'interrupted'}:
            task['message'] = ('Owner stopped before dispatch; no paid request was sent. Submit a new request only if still wanted.'
                               if status == 'interrupted' else
                               'Outcome uncertain; the provider may have accepted/charged the request. Check Ark usage before any new generation. This task will not be replayed.')
        return {'task': task, 'paid_request_sent': True if status == 'succeeded' else
                False if status in {'queued', 'interrupted'} else None,
                'automatic_retry': False}

    def get(self, task_id: str, scope: str):
        with closing(self._db()) as db, db:
            self._reap(db)
            row = db.execute('SELECT * FROM jobs WHERE id=? AND account=?', (task_id, scope)).fetchone()
            if row is None:
                raise ValueError('Image task not found for this account/endpoint on this host')
            return self._receipt(row)

    async def create(self, client: SeedreamClient, request: ImageRequest, options: LocalOptions, request_id: str):
        if self.closed:
            raise TaskError('Image job service is closed; no request sent', stage='preflight')
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request_id):
            raise TaskError('request_id must be 8..128 letters/digits/_/-; reuse it for retries of the same intended generation', stage='preflight')
        if not client.api_key.strip():
            raise TaskError('ARK_API_KEY is not configured; no request sent', stage='configuration')
        # Snapshot local image bytes/options now, before acknowledging the job.
        try:
            body, warnings = prepare(request, options, get_config('SEEDREAM_MODEL', DEFAULT_MODEL))
        except ValueError as exc:
            raise TaskError('Invalid image request; inspect seedream_preview_request before submission', stage='preflight') from exc
        options = options.model_copy(deep=True)
        fingerprint = hashlib.sha256(json.dumps([body, options.model_dump(), str(client.output_dir.resolve())],
                                                sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        scope = account_scope(client)
        with closing(self._db()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            self._reap(db)
            previous = db.execute('SELECT * FROM jobs WHERE account=? AND request_key=?', (scope, request_id)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise TaskError('request_id already belongs to different input; no new request sent', stage='preflight')
                return {**self._receipt(previous), 'reused': True}
            if db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0] >= 32:
                raise TaskError('Image queue is full; no request accepted or sent', stage='preflight')
            task_id, now = 'img-' + uuid.uuid4().hex, time.time()
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,NULL)',
                       (task_id, scope, request_id, fingerprint, 'queued', self.owner, now, now))
            receipt = self._receipt(db.execute('SELECT * FROM jobs WHERE id=?', (task_id,)).fetchone())
        worker = asyncio.create_task(self._run(task_id, client, body, warnings, options))
        self.workers.add(worker)
        worker.add_done_callback(self.workers.discard)
        return {**receipt, 'reused': False,
                'next_step': 'Accepted into the local plugin queue, not a completed image. Use generation_wait_tasks with kind=seedream and this task.id. Reuse request_id to recover a lost receipt; never create another key merely to poll.'}

    def _claim(self, task_id):
        with closing(self._db()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            self._reap(db)
            if db.execute("SELECT count(*) FROM jobs WHERE status='running'").fetchone()[0] >= 2:
                return False
            return db.execute("UPDATE jobs SET status='running',updated=? WHERE id=? AND status='queued' AND owner=?",
                              (time.time(), task_id, self.owner)).rowcount == 1

    def _finish(self, task_id, status, result=None):
        with closing(self._db()) as db, db:
            db.execute('UPDATE jobs SET status=?,updated=?,result=? WHERE id=? AND owner=?',
                       (status, time.time(), json.dumps(result, ensure_ascii=False) if result is not None else None, task_id, self.owner))

    async def _run(self, task_id, client, body, warnings, options):
        dispatched = False
        try:
            while not self._claim(task_id):
                await asyncio.sleep(0.25)
            dispatched = True
            result = await client.generate_prepared(body, warnings, options)
            self._finish(task_id, 'succeeded', result)
        except asyncio.CancelledError:
            self._finish(task_id, 'unknown' if dispatched else 'interrupted')
        except SeedreamError as exc:
            # The adapter has already sanitized codes/request IDs and transport errors.
            self._finish(task_id, 'unknown' if dispatched else 'interrupted', {'error': str(exc)})
        except Exception:
            # No raw provider exception, signed input URL or credential enters receipts.
            self._finish(task_id, 'unknown' if dispatched else 'interrupted')

    async def close(self):
        if self.closed:
            return
        self.closed = True
        for worker in self.workers:
            worker.cancel()
        await asyncio.gather(*self.workers, return_exceptions=True)
        # A worker cancelled before its coroutine started also needs a durable receipt.
        with closing(self._db()) as db, db:
            db.execute("UPDATE jobs SET status=CASE status WHEN 'queued' THEN 'interrupted' ELSE 'unknown' END,updated=? WHERE owner=? AND status IN ('queued','running')",
                       (time.time(), self.owner))
        self.handle.close()
