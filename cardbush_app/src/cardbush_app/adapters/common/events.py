from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass, field
from threading import Lock
from typing import Any, Protocol

from .lifecycle import shutdown_resource


@dataclass(slots=True)
class AdapterEvent:
    platform: str
    event_type: str
    session_id: str
    channel_id: str
    user_id: str
    message_id: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AdapterEventRecord:
    seq: int
    event: AdapterEvent

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, **asdict(self.event)}


class AdapterEventSink(Protocol):
    async def publish(self, event: AdapterEvent) -> None: ...


class NoopAdapterEventSink:
    async def publish(self, event: AdapterEvent) -> None:
        return None

    async def shutdown(self) -> None:
        return None


class CompositeAdapterEventSink:
    def __init__(self, *sinks: AdapterEventSink) -> None:
        self._sinks = tuple(sink for sink in sinks if sink is not None)

    async def publish(self, event: AdapterEvent) -> None:
        for sink in self._sinks:
            await sink.publish(event)

    async def shutdown(self) -> None:
        for sink in reversed(self._sinks):
            await shutdown_resource(sink)


class InMemoryAdapterEventBus:
    def __init__(self, *, max_events: int = 512) -> None:
        self._max_events = max_events
        self._next_seq = 1
        self._events: deque[AdapterEventRecord] = deque()
        self._lock = Lock()

    async def publish(self, event: AdapterEvent) -> None:
        with self._lock:
            record = AdapterEventRecord(seq=self._next_seq, event=event)
            self._next_seq += 1
            self._events.append(record)
            while len(self._events) > self._max_events:
                self._events.popleft()

    def snapshot_recent(self) -> list[dict[str, Any]]:
        with self._lock:
            return [record.to_dict() for record in self._events]

    def poll_after(self, seq: int) -> list[dict[str, Any]]:
        with self._lock:
            return [record.to_dict() for record in self._events if record.seq > seq]

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
            self._next_seq = 1

    def close(self) -> None:
        self.clear()
