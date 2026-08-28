from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from threading import Lock
from time import monotonic, time
from typing import Any


@dataclass(slots=True)
class FeishuOutboundMessage:
    message_id: str
    chat_id: str
    user_id: str
    source_message_id: str | None
    text: str
    sent_at: float
    read_at: str | None = None
    read_by_open_id: str | None = None
    tenant_key: str | None = None
    read_event_emitted: bool = False


class FeishuReadReceiptStore:
    def __init__(self, *, ttl_seconds: float = 86400.0, max_entries: int = 4096) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, FeishuOutboundMessage] = {}
        self._expiry_queue: deque[tuple[float, str]] = deque()
        self._lock = Lock()

    def register_outbound(
        self,
        *,
        message_id: str,
        chat_id: str,
        user_id: str,
        source_message_id: str | None,
        text: str,
    ) -> None:
        if not message_id:
            return
        now = monotonic()
        expires_at = now + self._ttl_seconds
        with self._lock:
            self._purge_locked(now)
            self._entries[message_id] = FeishuOutboundMessage(
                message_id=message_id,
                chat_id=chat_id,
                user_id=user_id,
                source_message_id=source_message_id,
                text=text,
                sent_at=time(),
            )
            self._expiry_queue.append((expires_at, message_id))
            self._trim_locked(now)

    def mark_read(
        self,
        *,
        message_id: str,
        reader_open_id: str | None,
        read_time: str | None,
        tenant_key: str | None,
    ) -> FeishuOutboundMessage | None:
        if not message_id:
            return None
        now = monotonic()
        with self._lock:
            self._purge_locked(now)
            record = self._entries.get(message_id)
            if record is None:
                return None
            record.read_by_open_id = reader_open_id or None
            record.read_at = read_time or None
            record.tenant_key = tenant_key or None
            return record

    def snapshot(self, message_id: str) -> dict[str, Any] | None:
        now = monotonic()
        with self._lock:
            self._purge_locked(now)
            record = self._entries.get(message_id)
            if record is None:
                return None
            return {
                "message_id": record.message_id,
                "chat_id": record.chat_id,
                "user_id": record.user_id,
                "source_message_id": record.source_message_id,
                "text": record.text,
                "sent_at": record.sent_at,
                "read_at": record.read_at,
                "read_by_open_id": record.read_by_open_id,
                "tenant_key": record.tenant_key,
                "read_event_emitted": record.read_event_emitted,
            }

    def mark_read_event_emitted(self, *, message_id: str) -> FeishuOutboundMessage | None:
        if not message_id:
            return None
        now = monotonic()
        with self._lock:
            self._purge_locked(now)
            record = self._entries.get(message_id)
            if record is None:
                return None
            record.read_event_emitted = True
            return record

    def _purge_locked(self, now: float) -> None:
        while self._expiry_queue and self._expiry_queue[0][0] <= now:
            _, message_id = self._expiry_queue.popleft()
            self._entries.pop(message_id, None)

    def _trim_locked(self, now: float) -> None:
        while len(self._entries) > self._max_entries and self._expiry_queue:
            expires_at, message_id = self._expiry_queue.popleft()
            if expires_at <= now or len(self._entries) > self._max_entries:
                self._entries.pop(message_id, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._expiry_queue.clear()

    def close(self) -> None:
        self.clear()
