from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from cardbush_app.paths import normalize_data_dir

SCHEDULED_DELIVERY_MODE_DELIVER_PREPARED = "deliver_prepared"
SCHEDULED_DELIVERY_STATUS_PENDING = "pending"
SCHEDULED_DELIVERY_STATUS_DELIVERING = "delivering"
SCHEDULED_DELIVERY_STATUS_COMPLETED = "completed"
SCHEDULED_DELIVERY_STATUS_FAILED = "failed"
SCHEDULED_DELIVERY_STATUS_CANCELLED = "cancelled"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None = None) -> str:
    target = value or utc_now()
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    return target.astimezone(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True, slots=True)
class ScheduledDeliverable:
    path: str
    caption: str = ""
    label: str = ""

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ScheduledDeliverable":
        return cls(
            path=str(payload.get("path") or "").strip(),
            caption=str(payload.get("caption") or "").strip(),
            label=str(payload.get("label") or "").strip(),
        )

    def to_dict(self) -> dict[str, str]:
        payload = {"path": self.path}
        if self.caption:
            payload["caption"] = self.caption
        if self.label:
            payload["label"] = self.label
        return payload


@dataclass(frozen=True, slots=True)
class ScheduledDeliveryJob:
    job_id: str
    session_id: str
    user_id: str
    channel_id: str
    platform: str
    mode: str
    status: str
    execute_at: str
    task_text: str
    reply_text: str
    deliverables: tuple[ScheduledDeliverable, ...]
    transport_channel: str
    created_turn_id: str = ""
    transport_delivery_id: str = ""
    last_error: str = ""
    attempts: int = 0

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "ScheduledDeliveryJob":
        try:
            raw_deliverables = json.loads(str(row["deliverables_json"] or "[]"))
        except Exception:
            raw_deliverables = []
        deliverables = tuple(
            ScheduledDeliverable.from_dict(item)
            for item in raw_deliverables
            if isinstance(item, dict) and str(item.get("path") or "").strip()
        )
        return cls(
            job_id=str(row["job_id"] or ""),
            session_id=str(row["session_id"] or ""),
            user_id=str(row["user_id"] or ""),
            channel_id=str(row["channel_id"] or ""),
            platform=str(row["platform"] or ""),
            mode=str(row["mode"] or ""),
            status=str(row["status"] or ""),
            execute_at=str(row["execute_at"] or ""),
            task_text=str(row["task_text"] or ""),
            reply_text=str(row["reply_text"] or ""),
            deliverables=deliverables,
            transport_channel=str(row["transport_channel"] or ""),
            created_turn_id=str(row["created_turn_id"] or ""),
            transport_delivery_id=str(row["transport_delivery_id"] or ""),
            last_error=str(row["last_error"] or ""),
            attempts=int(row["attempts"] or 0),
        )

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "channel_id": self.channel_id,
            "platform": self.platform,
            "mode": self.mode,
            "status": self.status,
            "execute_at": self.execute_at,
            "task_text": self.task_text,
            "reply_text": self.reply_text,
            "deliverables": [item.to_dict() for item in self.deliverables],
            "transport_channel": self.transport_channel,
            "created_turn_id": self.created_turn_id,
            "transport_delivery_id": self.transport_delivery_id,
            "last_error": self.last_error,
            "attempts": self.attempts,
        }


class ScheduledDeliveryStore:
    """SQLite-backed scheduled delivery job store.

    The store is used by the LLM-facing `schedule_task` tool to persist jobs
    and by transport bridges to atomically claim due deliveries.
    """

    def __init__(self, data_dir: Path | str) -> None:
        root = normalize_data_dir(Path(data_dir))
        self._db_path = root / "scheduled_delivery" / "jobs.db"
        self._lock = threading.Lock()
        self._ensure_schema()

    @property
    def db_path(self) -> Path:
        return self._db_path

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS scheduled_delivery_jobs (
                        job_id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        channel_id TEXT NOT NULL,
                        platform TEXT NOT NULL,
                        mode TEXT NOT NULL,
                        status TEXT NOT NULL,
                        execute_at TEXT NOT NULL,
                        next_attempt_at TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        delivered_at TEXT NOT NULL DEFAULT '',
                        task_text TEXT NOT NULL DEFAULT '',
                        reply_text TEXT NOT NULL DEFAULT '',
                        deliverables_json TEXT NOT NULL DEFAULT '[]',
                        transport_channel TEXT NOT NULL DEFAULT '',
                        created_turn_id TEXT NOT NULL DEFAULT '',
                        transport_delivery_id TEXT NOT NULL DEFAULT '',
                        last_error TEXT NOT NULL DEFAULT '',
                        attempts INTEGER NOT NULL DEFAULT 0,
                        max_attempts INTEGER NOT NULL DEFAULT 3,
                        claim_token TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                columns = {
                    str(row["name"])
                    for row in conn.execute(
                        "PRAGMA table_info(scheduled_delivery_jobs)"
                    ).fetchall()
                }
                if "transport_delivery_id" not in columns:
                    conn.execute(
                        "ALTER TABLE scheduled_delivery_jobs ADD COLUMN "
                        "transport_delivery_id TEXT NOT NULL DEFAULT ''"
                    )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_scheduled_delivery_due
                    ON scheduled_delivery_jobs (
                        platform,
                        channel_id,
                        status,
                        next_attempt_at,
                        execute_at
                    )
                    """
                )

    def create_job(
        self,
        *,
        session_id: str,
        user_id: str,
        channel_id: str,
        platform: str,
        mode: str,
        execute_at: datetime,
        task_text: str,
        reply_text: str = "",
        deliverables: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
        transport_channel: str = "",
        created_turn_id: str = "",
        transport_delivery_id: str = "",
        max_attempts: int = 3,
    ) -> ScheduledDeliveryJob:
        normalized_execute_at = iso_utc(execute_at)
        now = iso_utc()
        job_id = f"sched_{uuid.uuid4().hex}"
        normalized_deliverables = [
            ScheduledDeliverable.from_dict(dict(item)).to_dict()
            for item in deliverables
            if isinstance(item, dict)
            and str(item.get("path") or "").strip()
        ]
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO scheduled_delivery_jobs (
                        job_id, session_id, user_id, channel_id, platform,
                        mode, status, execute_at, next_attempt_at, created_at,
                        updated_at, task_text, reply_text, deliverables_json,
                        transport_channel, created_turn_id, transport_delivery_id,
                        max_attempts
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        session_id,
                        user_id,
                        channel_id,
                        platform,
                        mode,
                        SCHEDULED_DELIVERY_STATUS_PENDING,
                        normalized_execute_at,
                        normalized_execute_at,
                        now,
                        now,
                        task_text,
                        reply_text,
                        json.dumps(normalized_deliverables, ensure_ascii=False),
                        transport_channel,
                        created_turn_id,
                        transport_delivery_id,
                        max(1, int(max_attempts or 3)),
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM scheduled_delivery_jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
        if row is None:
            raise RuntimeError("scheduled delivery job was not persisted")
        return ScheduledDeliveryJob.from_row(row)

    def list_jobs(
        self,
        *,
        session_id: str = "",
        user_id: str = "",
        include_terminal: bool = False,
    ) -> list[ScheduledDeliveryJob]:
        clauses: list[str] = []
        params: list[Any] = []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        if not include_terminal:
            clauses.append("status NOT IN (?, ?, ?)")
            params.extend(
                [
                    SCHEDULED_DELIVERY_STATUS_COMPLETED,
                    SCHEDULED_DELIVERY_STATUS_CANCELLED,
                    SCHEDULED_DELIVERY_STATUS_FAILED,
                ]
            )
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = (
            "SELECT * FROM scheduled_delivery_jobs "
            f"{where} ORDER BY execute_at ASC, created_at ASC LIMIT 100"
        )
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(sql, tuple(params)).fetchall()
        return [ScheduledDeliveryJob.from_row(row) for row in rows]

    def cancel_job(
        self,
        *,
        job_id: str,
        session_id: str = "",
        user_id: str = "",
    ) -> bool:
        clauses = ["job_id = ?", "status NOT IN (?, ?)"]
        params: list[Any] = [
            job_id,
            SCHEDULED_DELIVERY_STATUS_COMPLETED,
            SCHEDULED_DELIVERY_STATUS_CANCELLED,
        ]
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        with self._lock:
            with self._connect() as conn:
                cursor = conn.execute(
                    f"""
                    UPDATE scheduled_delivery_jobs
                    SET status = ?, updated_at = ?, claim_token = ''
                    WHERE {' AND '.join(clauses)}
                    """,
                    (
                        SCHEDULED_DELIVERY_STATUS_CANCELLED,
                        iso_utc(),
                        *params,
                    ),
                )
                return cursor.rowcount > 0

    def claim_due_jobs(
        self,
        *,
        platform: str,
        channel_id: str,
        now: datetime | None = None,
        limit: int = 10,
    ) -> list[ScheduledDeliveryJob]:
        token = uuid.uuid4().hex
        now_iso = iso_utc(now)
        with self._lock:
            with self._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                rows = conn.execute(
                    """
                    SELECT job_id FROM scheduled_delivery_jobs
                    WHERE platform = ?
                      AND channel_id = ?
                      AND status = ?
                      AND execute_at <= ?
                      AND next_attempt_at <= ?
                      AND attempts < max_attempts
                    ORDER BY execute_at ASC, created_at ASC
                    LIMIT ?
                    """,
                    (
                        platform,
                        channel_id,
                        SCHEDULED_DELIVERY_STATUS_PENDING,
                        now_iso,
                        now_iso,
                        max(1, int(limit or 10)),
                    ),
                ).fetchall()
                job_ids = [str(row["job_id"]) for row in rows]
                if not job_ids:
                    conn.commit()
                    return []
                placeholders = ",".join("?" for _ in job_ids)
                conn.execute(
                    f"""
                    UPDATE scheduled_delivery_jobs
                    SET status = ?,
                        claim_token = ?,
                        attempts = attempts + 1,
                        updated_at = ?
                    WHERE job_id IN ({placeholders})
                    """,
                    (
                        SCHEDULED_DELIVERY_STATUS_DELIVERING,
                        token,
                        now_iso,
                        *job_ids,
                    ),
                )
                claimed = conn.execute(
                    f"""
                    SELECT * FROM scheduled_delivery_jobs
                    WHERE claim_token = ? AND job_id IN ({placeholders})
                    ORDER BY execute_at ASC, created_at ASC
                    """,
                    (token, *job_ids),
                ).fetchall()
                conn.commit()
        return [ScheduledDeliveryJob.from_row(row) for row in claimed]

    def reset_stale_delivering_jobs(
        self,
        *,
        platform: str,
        channel_id: str,
        older_than_seconds: float = 300.0,
    ) -> int:
        cutoff = iso_utc(utc_now() - timedelta(seconds=max(1.0, older_than_seconds)))
        now_iso = iso_utc()
        with self._lock:
            with self._connect() as conn:
                failed_cursor = conn.execute(
                    """
                    UPDATE scheduled_delivery_jobs
                    SET status = ?,
                        claim_token = '',
                        updated_at = ?,
                        last_error = CASE
                            WHEN last_error = '' THEN ?
                            ELSE last_error
                        END
                    WHERE platform = ?
                      AND channel_id = ?
                      AND status = ?
                      AND updated_at <= ?
                      AND attempts >= max_attempts
                    """,
                    (
                        SCHEDULED_DELIVERY_STATUS_FAILED,
                        now_iso,
                        "scheduled delivery claim expired after max attempts",
                        platform,
                        channel_id,
                        SCHEDULED_DELIVERY_STATUS_DELIVERING,
                        cutoff,
                    ),
                )
                retry_cursor = conn.execute(
                    """
                    UPDATE scheduled_delivery_jobs
                    SET status = ?,
                        claim_token = '',
                        updated_at = ?
                    WHERE platform = ?
                      AND channel_id = ?
                      AND status = ?
                      AND updated_at <= ?
                      AND attempts < max_attempts
                    """,
                    (
                        SCHEDULED_DELIVERY_STATUS_PENDING,
                        now_iso,
                        platform,
                        channel_id,
                        SCHEDULED_DELIVERY_STATUS_DELIVERING,
                        cutoff,
                    ),
                )
                return int(failed_cursor.rowcount or 0) + int(
                    retry_cursor.rowcount or 0
                )

    def mark_completed(self, job_id: str) -> None:
        now = iso_utc()
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    UPDATE scheduled_delivery_jobs
                    SET status = ?,
                        delivered_at = ?,
                        updated_at = ?,
                        last_error = '',
                        claim_token = ''
                    WHERE job_id = ?
                    """,
                    (SCHEDULED_DELIVERY_STATUS_COMPLETED, now, now, job_id),
                )

    def mark_failed(
        self,
        job_id: str,
        *,
        error: str,
        retry_delay_seconds: float = 30.0,
        deliverables: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
    ) -> None:
        now = utc_now()
        now_iso = iso_utc(now)
        normalized_deliverables = None
        if deliverables is not None:
            normalized_deliverables = [
                ScheduledDeliverable.from_dict(dict(item)).to_dict()
                for item in deliverables
                if isinstance(item, dict)
                and str(item.get("path") or "").strip()
            ]
        with self._lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT attempts, max_attempts FROM scheduled_delivery_jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
                if row is None:
                    return
                attempts = int(row["attempts"] or 0)
                max_attempts = int(row["max_attempts"] or 3)
                terminal = attempts >= max_attempts
                next_attempt = now + timedelta(seconds=max(1.0, retry_delay_seconds))
                if normalized_deliverables is None:
                    conn.execute(
                        """
                        UPDATE scheduled_delivery_jobs
                        SET status = ?,
                            next_attempt_at = ?,
                            updated_at = ?,
                            last_error = ?,
                            claim_token = ''
                        WHERE job_id = ?
                        """,
                        (
                            SCHEDULED_DELIVERY_STATUS_FAILED
                            if terminal
                            else SCHEDULED_DELIVERY_STATUS_PENDING,
                            iso_utc(next_attempt),
                            now_iso,
                            str(error or "")[:1000],
                            job_id,
                        ),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE scheduled_delivery_jobs
                        SET status = ?,
                            next_attempt_at = ?,
                            updated_at = ?,
                            last_error = ?,
                            deliverables_json = ?,
                            claim_token = ''
                        WHERE job_id = ?
                        """,
                        (
                            SCHEDULED_DELIVERY_STATUS_FAILED
                            if terminal
                            else SCHEDULED_DELIVERY_STATUS_PENDING,
                            iso_utc(next_attempt),
                            now_iso,
                            str(error or "")[:1000],
                            json.dumps(normalized_deliverables, ensure_ascii=False),
                            job_id,
                        ),
                    )


__all__ = [
    "SCHEDULED_DELIVERY_MODE_DELIVER_PREPARED",
    "SCHEDULED_DELIVERY_STATUS_CANCELLED",
    "SCHEDULED_DELIVERY_STATUS_COMPLETED",
    "SCHEDULED_DELIVERY_STATUS_DELIVERING",
    "SCHEDULED_DELIVERY_STATUS_FAILED",
    "SCHEDULED_DELIVERY_STATUS_PENDING",
    "ScheduledDeliverable",
    "ScheduledDeliveryJob",
    "ScheduledDeliveryStore",
    "iso_utc",
    "utc_now",
]
