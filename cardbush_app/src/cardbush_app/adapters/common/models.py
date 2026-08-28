from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ChatEnvelope:
    platform: str
    session_id: str
    user_id: str
    channel_id: str
    text: str
    message_id: str | None = None
    thread_id: str | None = None
    raw_event: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ChatReply:
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
