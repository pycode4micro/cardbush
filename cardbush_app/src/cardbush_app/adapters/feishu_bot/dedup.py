from __future__ import annotations

import sqlite3
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from time import monotonic, time


@dataclass(frozen=True, slots=True)
class FeishuDedupEntry:
    key: str
    expires_at: float


class FeishuMessageDeduplicator:
    def __init__(
        self,
        *,
        ttl_seconds: float = 600.0,
        max_entries: int = 4096,
        sqlite_path: str | None = None,
        sqlite_ttl_seconds: float = 28800.0,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, float] = {}
        self._expiry_queue: deque[FeishuDedupEntry] = deque()
        self._lock = Lock()
        self._sqlite_ttl_seconds = max(60.0, float(sqlite_ttl_seconds))
        self._sqlite_conn: sqlite3.Connection | None = None
        self._sqlite_enabled = False
        self._sqlite_last_gc_at = 0.0
        self._sqlite_gc_interval_seconds = 60.0
        if sqlite_path:
            db_path = Path(sqlite_path).expanduser()
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._sqlite_conn = sqlite3.connect(str(db_path), check_same_thread=False)
            self._sqlite_conn.execute("PRAGMA journal_mode=WAL")
            self._sqlite_conn.execute(
                """
                CREATE TABLE IF NOT EXISTS feishu_inbound_dedup (
                    dedup_key TEXT PRIMARY KEY,
                    source_message_id TEXT NOT NULL DEFAULT '',
                    source_event_id TEXT NOT NULL DEFAULT '',
                    first_seen_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                )
                """
            )
            self._sqlite_conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_feishu_inbound_dedup_expires_at ON feishu_inbound_dedup (expires_at)"
            )
            self._sqlite_conn.commit()
            self._sqlite_enabled = True

    def should_process(
        self,
        key: str | None,
        *,
        source_message_id: str | None = None,
        source_event_id: str | None = None,
    ) -> bool:
        if not key:
            return True
        if not self._should_process_persisted(
            key,
            source_message_id=source_message_id,
            source_event_id=source_event_id,
        ):
            return False
        now = monotonic()
        expires_at = now + self._ttl_seconds
        with self._lock:
            self._purge_locked(now)
            current = self._entries.get(key)
            if current is not None and current > now:
                return False
            self._entries[key] = expires_at
            self._expiry_queue.append(FeishuDedupEntry(key=key, expires_at=expires_at))
            self._trim_locked(now)
            return True

    def _should_process_persisted(
        self,
        key: str,
        *,
        source_message_id: str | None,
        source_event_id: str | None,
    ) -> bool:
        if not self._sqlite_enabled:
            return True
        conn = self._sqlite_conn
        if conn is None:
            return True
        now_epoch = time()
        expires_at = now_epoch + self._sqlite_ttl_seconds
        with self._lock:
            self._gc_sqlite_locked(now_epoch)
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO feishu_inbound_dedup
                    (dedup_key, source_message_id, source_event_id, first_seen_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    key,
                    str(source_message_id or ""),
                    str(source_event_id or ""),
                    now_epoch,
                    expires_at,
                ),
            )
            conn.commit()
            return cursor.rowcount == 1

    def _gc_sqlite_locked(self, now_epoch: float) -> None:
        if not self._sqlite_enabled:
            return
        conn = self._sqlite_conn
        if conn is None:
            return
        if now_epoch - self._sqlite_last_gc_at < self._sqlite_gc_interval_seconds:
            return
        conn.execute("DELETE FROM feishu_inbound_dedup WHERE expires_at <= ?", (now_epoch,))
        conn.commit()
        self._sqlite_last_gc_at = now_epoch

    def _purge_locked(self, now: float) -> None:
        while self._expiry_queue and self._expiry_queue[0].expires_at <= now:
            entry = self._expiry_queue.popleft()
            current = self._entries.get(entry.key)
            if current is not None and current <= now and current == entry.expires_at:
                self._entries.pop(entry.key, None)

    def _trim_locked(self, now: float) -> None:
        while len(self._entries) > self._max_entries and self._expiry_queue:
            entry = self._expiry_queue.popleft()
            current = self._entries.get(entry.key)
            if current is not None and current == entry.expires_at:
                if current <= now or len(self._entries) > self._max_entries:
                    self._entries.pop(entry.key, None)

    def clear(self, *, persistent: bool = False) -> None:
        with self._lock:
            self._entries.clear()
            self._expiry_queue.clear()
            conn = self._sqlite_conn
            if persistent and conn is not None:
                conn.execute("DELETE FROM feishu_inbound_dedup")
                conn.commit()

    def close(self) -> None:
        self.clear()
        conn = self._sqlite_conn
        self._sqlite_conn = None
        self._sqlite_enabled = False
        if conn is not None:
            conn.close()
