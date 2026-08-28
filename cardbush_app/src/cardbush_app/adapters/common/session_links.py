from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from cardbush_app.paths import default_app_data_dir


def default_session_link_store_path() -> Path:
    configured = str(os.getenv("CARDBUSH_BOT_SESSION_LINK_DB", "") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve(strict=False)
    data_dir = str(os.getenv("CARDBUSH_APP_DATA_DIR", "") or "").strip()
    root = (
        Path(data_dir).expanduser().resolve(strict=False)
        if data_dir
        else default_app_data_dir()
    )
    return root / "bots" / "session_links.sqlite3"


@dataclass(frozen=True, slots=True)
class SessionLinkKey:
    platform: str
    channel_id: str
    user_id: str

    @classmethod
    def create(
        cls,
        *,
        platform: str,
        channel_id: str,
        user_id: str,
    ) -> "SessionLinkKey":
        return cls(
            platform=str(platform or "").strip().lower(),
            channel_id=str(channel_id or "").strip(),
            user_id=str(user_id or "").strip(),
        )

    @property
    def valid(self) -> bool:
        return bool(self.platform and self.channel_id and self.user_id)


class SessionLinkStore:
    """Adapter-owned persistent mapping from a channel identity to an Agent session."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path or default_session_link_store_path()).expanduser().resolve(
            strict=False
        )

    def resolve(self, key: SessionLinkKey) -> str | None:
        if not key.valid or not self.path.exists():
            return None
        with self._connect(create=False) as connection:
            row = connection.execute(
                """
                SELECT session_id
                FROM session_links
                WHERE platform = ? AND channel_id = ? AND user_id = ?
                """,
                (key.platform, key.channel_id, key.user_id),
            ).fetchone()
        session_id = str(row[0] if row else "").strip()
        return session_id or None

    def bind(self, key: SessionLinkKey, session_id: str) -> None:
        normalized_session_id = str(session_id or "").strip()
        if not key.valid or not normalized_session_id:
            raise ValueError("valid platform, channel_id, user_id, and session_id are required")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect(create=True) as connection:
            connection.execute(
                """
                INSERT INTO session_links (
                    platform, channel_id, user_id, session_id, linked_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(platform, channel_id, user_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    linked_at = excluded.linked_at
                """,
                (
                    key.platform,
                    key.channel_id,
                    key.user_id,
                    normalized_session_id,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )

    def unbind(self, key: SessionLinkKey) -> bool:
        if not key.valid or not self.path.exists():
            return False
        with self._connect(create=False) as connection:
            cursor = connection.execute(
                """
                DELETE FROM session_links
                WHERE platform = ? AND channel_id = ? AND user_id = ?
                """,
                (key.platform, key.channel_id, key.user_id),
            )
        return bool(cursor.rowcount)

    def _connect(self, *, create: bool) -> sqlite3.Connection:
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5.0)
        if create:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS session_links (
                    platform TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    linked_at TEXT NOT NULL,
                    PRIMARY KEY (platform, channel_id, user_id)
                )
                """
            )
        return connection


__all__ = [
    "SessionLinkKey",
    "SessionLinkStore",
    "default_session_link_store_path",
]
