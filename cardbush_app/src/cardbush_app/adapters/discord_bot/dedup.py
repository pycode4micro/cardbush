from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from threading import Lock
from time import monotonic


@dataclass(frozen=True, slots=True)
class DiscordDedupEntry:
    key: str
    expires_at: float


class DiscordMessageDeduplicator:
    def __init__(self, *, ttl_seconds: float = 600.0, max_entries: int = 4096) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, float] = {}
        self._expiry_queue: deque[DiscordDedupEntry] = deque()
        self._lock = Lock()

    def should_process(self, key: str | None) -> bool:
        if not key:
            return True
        now = monotonic()
        expires_at = now + self._ttl_seconds
        with self._lock:
            self._purge_locked(now)
            current = self._entries.get(key)
            if current is not None and current > now:
                return False
            self._entries[key] = expires_at
            self._expiry_queue.append(DiscordDedupEntry(key=key, expires_at=expires_at))
            self._trim_locked(now)
            return True

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

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._expiry_queue.clear()

    def close(self) -> None:
        self.clear()
