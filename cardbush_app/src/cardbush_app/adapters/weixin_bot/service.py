from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import mimetypes
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from cardbush_app.adapters.message_text import strip_turn_search_hint
from cardbush_app.adapters.scheduled_delivery import (
    ScheduledDeliveryJob,
    ScheduledDeliveryStore,
)
from cardbush_app.paths import session_workspace_dir
from cardbush_app.adapters.common import (
    ChatEnvelope,
    ConversationBackend,
    InteractiveReplyValidationError,
    LifecycleManager,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelRateLimitError,
    PendingInteractiveRequestError,
    channel_identity_is_allowed,
    format_pending_interaction_text,
    format_transport_receipt_notice,
)

from .client import (
    SESSION_EXPIRED_ERRCODE,
    GetUpdatesResult,
    WeixinClient,
    WeixinMessage,
)
from .config import WeixinBotSettings
from .media import FILE_KIND, IMAGE_KIND, VIDEO_KIND
from .state import WeixinAccount, WeixinStateStore

logger = logging.getLogger(__name__)

TEXT_MESSAGE_TYPE = 1
VOICE_MESSAGE_TYPE = 3
_SEND_TEXT_MAX_ATTEMPTS = 4
_SEND_TEXT_RETRY_DELAY_SECONDS = 5.0
_SEND_TEXT_RETRY_MAX_DELAY_SECONDS = 30.0
_SEND_TEXT_SCHEDULED_RETRY_MAX_ATTEMPTS = 12
_INTERACTIVE_NOTICE_RETRY_DELAY_SECONDS = 10.0
_SEND_DELIVERABLE_MAX_ATTEMPTS = 4
_SEND_DELIVERABLE_RETRY_DELAY_SECONDS = 5.0
_SEND_DELIVERABLE_RETRY_MAX_DELAY_SECONDS = 30.0
_SEND_DELIVERABLE_SCHEDULED_RETRY_MAX_ATTEMPTS = 12
_POLL_EXCEPTION_RETRY_BASE_SECONDS = 2.0
_POLL_EXCEPTION_RETRY_MAX_SECONDS = 30.0
_POLL_TASK_RESTART_BASE_SECONDS = 2.0
_POLL_TASK_RESTART_MAX_SECONDS = 30.0
_INTERACTION_POLL_INTERVAL_SECONDS = 0.5
_INTERACTION_REPLY_BACKGROUND_DRAIN_MAX_SECONDS = 0.75
_PENDING_ATTACHMENTS_TTL_SECONDS = 1800.0
_ANNOUNCED_INTERACTION_TTL_SECONDS = 1800.0
_PENDING_ATTACHMENTS_MAX_ITEMS = 8
_DELIVERABLE_TRANSFER_MAX_FILES = 6
_DELIVERABLE_PATH_TRAILING = ".,;:!?)】）]}>"
_RECENT_HANDLED_MESSAGE_TTL_SECONDS = 600.0
_MESSAGE_HANDLE_RETRY_DELAY_SECONDS = 1.0
_MAX_MESSAGE_HANDLE_FAILURES = 3
_RUNTIME_TRACE_MAX_EVENTS = 20
_RUNTIME_TRACE_PREVIEW_LIMIT = 160
_SHADOW_OBSERVATION_SCHEMA = "weixin_shadow_observation_v2"
_SHADOW_TEXT_HASH_LENGTH = 12
_SCHEDULED_DELIVERY_POLL_INTERVAL_SECONDS = 5.0
_SCHEDULED_DELIVERY_CLAIM_LIMIT = 5
_SCHEDULED_DELIVERY_RETRY_DELAY_SECONDS = 30.0
_MODEL_SELECTION_TTL_SECONDS = 300.0
_IMAGE_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
}

_CANCEL_TOKENS = frozenset(
    {
        "取消",
        "取消本次",
        "cancel",
        "/cancel",
        "算了",
        "不用了",
        "先不继续",
    }
)
_NEW_SESSION_TOKENS = frozenset({"/new"})
_SLASH_EN_COMMAND_RE = re.compile(r"^/([a-zA-Z]+)$")
_SUPPORTED_SLASH_COMMANDS: dict[str, str] = {
    "/new": "切换到一个全新的会话",
    "/model": "查看并切换默认模型槽位",
    "/cancel": "取消当前等待中的确认或输入",
    "/stop": "停止当前正在处理的请求",
    "/status": "查看当前会话和引导状态",
    "/subagent": "为当前会话开启 subagent 委派能力",
    "/link": "连接 CardBush 中生成的会话绑定码",
    "/unlink": "断开当前 CardBush 会话连接",
}
_PERMISSION_ALLOW_TOKENS = frozenset(
    {
        "1",
        "allow",
        "allow_once",
        "allow once",
        "yes",
        "y",
        "ok",
        "允许",
        "允许一次",
        "授权",
        "同意",
        "确认",
        "继续",
        "可以",
        "本次允许",
    }
)
_PERMISSION_ALLOW_SESSION_TOKENS = frozenset(
    {
        "allow_session",
        "allow session",
        "session",
        "本会话",
        "本会话允许",
        "允许本会话",
        "会话允许",
        "一直允许",
    }
)
_PERMISSION_DENY_TOKENS = frozenset(
    {
        "2",
        "3",
        "deny",
        "no",
        "n",
        "拒绝",
        "不授权",
        "不允许",
        "不同意",
        "不可以",
        "deny access",
    }
)


@dataclass(slots=True)
class _PendingAttachment:
    kind: str
    name: str | None
    path: str
    message_id: str | None
    created_at: float


@dataclass(slots=True)
class _StructuredDeliverable:
    path: str
    caption: str = ""
    label: str = ""


@dataclass(slots=True)
class _PendingModelSelection:
    session_id: str
    account_id: str
    user_id: str
    model_ids: tuple[str, ...]
    created_at: float


class _ScheduledDeliveryRetryError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        failed_deliverables: list[_StructuredDeliverable],
        failure_messages: list[str],
    ) -> None:
        super().__init__(message)
        self.failed_deliverables = list(failed_deliverables)
        self.failure_messages = list(failure_messages)


def extract_message_text(message: WeixinMessage) -> str:
    item_list = message.raw.get("item_list")
    if not isinstance(item_list, list):
        return ""
    for item in item_list:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == TEXT_MESSAGE_TYPE:
            text_item = item.get("text_item")
            if isinstance(text_item, dict):
                text = str(text_item.get("text") or "").strip()
                if text:
                    return text
        if item_type == VOICE_MESSAGE_TYPE:
            voice_item = item.get("voice_item")
            if isinstance(voice_item, dict):
                text = str(voice_item.get("text") or "").strip()
                if text:
                    return text
    return ""



def _normalize_text(value: object | None) -> str:
    return str(value or "").strip()


def _normalize_match_text(value: object | None) -> str:
    normalized = _normalize_text(value).lower()
    normalized = normalized.replace("：", ":")
    normalized = normalized.replace("　", " ")
    return " ".join(normalized.split())


def _preview_text(value: object | None, *, limit: int = _RUNTIME_TRACE_PREVIEW_LIMIT) -> str:
    text = _normalize_text(value)
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _format_exception_brief(exc: BaseException) -> str:
    error_type = type(exc).__name__
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        body = _preview_text(getattr(response, "text", "") or "", limit=240)
        status = getattr(response, "status_code", None)
        if body:
            return f"{error_type}: HTTP {status}: {body}"
        return f"{error_type}: HTTP {status}"
    message = str(exc).strip()
    if message:
        if message.startswith(error_type):
            return message
        return f"{error_type}: {message}"
    error_repr = repr(exc).strip()
    if error_repr and error_repr != f"{error_type}()":
        return f"{error_type}: {error_repr}"
    cause = exc.__cause__ or exc.__context__
    if cause is not None and cause is not exc:
        cause_message = str(cause).strip() or repr(cause).strip()
        if cause_message:
            return f"{error_type}: caused by {type(cause).__name__}: {cause_message}"
    return error_type


def _is_model_service_exception(exc: BaseException) -> bool:
    candidates = [exc, exc.__cause__, exc.__context__]
    for item in candidates:
        if item is None:
            continue
        if isinstance(
            item,
            (ModelAuthenticationError, ModelConnectionError, ModelRateLimitError),
        ):
            return True
        cls = type(item)
        name = cls.__name__.lower()
        module = str(cls.__module__ or "").lower()
        message = str(item or "").lower()
        if "litellm" in module or "litellm" in message:
            return True
        if (
            "timeout" in name
            or "connection" in name
            or "ratelimit" in name
            or "rate_limit" in name
        ) and (
            "openai" in module
            or "httpx" in module
            or "litellm" in module
        ):
            return True
    return False


def _backend_error_category(exc: BaseException) -> dict[str, str]:
    candidates = [exc, exc.__cause__, exc.__context__]
    for item in candidates:
        if isinstance(
            item,
            (ModelAuthenticationError, ModelConnectionError, ModelRateLimitError),
        ):
            payload = {
                "category": item.category,
                "message": item.message,
            }
            if item.provider:
                payload["provider"] = item.provider
            return payload
    return {}


def _format_user_visible_backend_error(exc: BaseException) -> str:
    category = _backend_error_category(exc).get("category")
    if category == "model_authentication":
        return "模型 API Key 无效或无权限，请在模型配置中检查默认槽位。"
    if category == "model_connection":
        return "模型服务连接失败，请检查默认模型槽位、供应商网络或稍后重试。"
    if category == "model_rate_limit":
        return "模型服务触发限流或额度不足，请切换默认模型槽位或稍后重试。"
    if isinstance(exc, httpx.ConnectError):
        return "无法连接 BushServer 后端，请确认服务正在运行后重试。"
    if isinstance(exc, httpx.TimeoutException):
        return "BushServer 后端响应超时，请稍后重试。"
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) or _is_model_service_exception(
        exc
    ):
        return "模型服务响应超时或暂时不可用，请稍后重试。"
    if isinstance(exc, httpx.HTTPStatusError):
        return "服务请求暂时失败，请稍后重试。"
    return "系统处理本条消息失败，请稍后重试，或发送 `/new` 开启新会话。"


def _user_visible_backend_error_notice(exc: BaseException) -> tuple[str, str]:
    category = _backend_error_category(exc).get("category")
    if category == "model_authentication":
        title = "模型认证失败"
    elif category == "model_connection":
        title = "模型连接失败"
    elif category == "model_rate_limit":
        title = "模型限流或额度不足"
    elif isinstance(exc, httpx.ConnectError):
        title = "BushServer 连接失败"
    elif isinstance(exc, httpx.TimeoutException):
        title = "BushServer 响应超时"
    elif isinstance(exc, (TimeoutError, asyncio.TimeoutError)) or _is_model_service_exception(
        exc
    ):
        title = "模型服务暂时不可用"
    elif isinstance(exc, httpx.HTTPStatusError):
        title = "后端服务请求失败"
    else:
        title = "处理消息失败"
    return title, _format_user_visible_backend_error(exc)


def _duration_ms_since(started_at_monotonic: float | None) -> int | None:
    if started_at_monotonic is None:
        return None
    return max(0, int((time.monotonic() - started_at_monotonic) * 1000))


def _shadow_text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:_SHADOW_TEXT_HASH_LENGTH]


def _md_code(value: object | None) -> str:
    text = _normalize_text(value).replace("\r", " ").replace("\n", " ")
    text = " ".join(text.split())
    if not text:
        return "`-`"
    if "`" not in text:
        return f"`{text}`"
    return f"`` {text} ``"


def _md_notice(
    title: str,
    *body: object | None,
    bullets: list[str] | tuple[str, ...] | None = None,
) -> str:
    lines = [f"**{_normalize_text(title)}**"]
    body_lines = [_normalize_text(item) for item in body if _normalize_text(item)]
    if body_lines:
        lines.append("")
        lines.extend(body_lines)
    bullet_lines = [
        _normalize_text(item)
        for item in list(bullets or [])
        if _normalize_text(item)
    ]
    if bullet_lines:
        lines.append("")
        lines.extend(f"- {item}" for item in bullet_lines)
    return "\n".join(lines).strip()


def _md_with_help(title: str, body: str, command_lines: list[str]) -> str:
    lines = [_md_notice(title, body), "", "**当前支持的 / 命令**"]
    lines.extend(command_lines)
    return "\n".join(lines).strip()


class WeixinBotService:
    def __init__(
        self,
        *,
        settings: WeixinBotSettings,
        backend: ConversationBackend,
        client: WeixinClient | None = None,
        state_store: WeixinStateStore | None = None,
    ) -> None:
        self._settings = settings
        self._backend = backend
        self._client = client or WeixinClient(settings)
        self._state = state_store or WeixinStateStore(settings.state_dir)
        self._lifecycle = LifecycleManager()
        self._lifecycle.add_resource(name="backend", resource=self._backend)
        self._lifecycle.add_resource(name="weixin_client", resource=self._client)
        self._poll_tasks: dict[str, asyncio.Task[None]] = {}
        self._scheduled_delivery_tasks: dict[str, asyncio.Task[None]] = {}
        self._restart_tasks: dict[str, asyncio.Task[None]] = {}
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._scheduled_delivery_store = ScheduledDeliveryStore(settings.data_dir)
        self._accounts: dict[str, WeixinAccount] = {}
        self._poll_restart_attempts: dict[str, int] = {}
        self._idle_event = asyncio.Event()
        self._shutdown_requested = False
        self._pending_attachments: dict[str, list[_PendingAttachment]] = {}
        self._pending_attachments_lock = asyncio.Lock()
        self._recent_handled_message_ids: dict[str, dict[str, float]] = {}
        self._message_handle_failures: dict[str, dict[str, int]] = {}
        self._active_backend_response_tasks: dict[str, asyncio.Task[Any]] = {}
        self._background_exchange_tasks: dict[str, asyncio.Task[None]] = {}
        self._announced_interactions: dict[str, dict[str, Any]] = {}
        self._pending_model_selections: dict[str, _PendingModelSelection] = {}
        self._expired_account_ids: set[str] = set()

    async def startup(self) -> None:
        await self._lifecycle.startup()
        self._shutdown_requested = False
        self._idle_event.clear()
        accounts = self._state.list_accounts()
        if not accounts:
            raise RuntimeError(
                "no configured Weixin account found; run `cardbush-weixin login` first"
            )
        self._accounts = {account.account_id: account for account in accounts}
        self._expired_account_ids.clear()
        self._save_runtime_status()
        for account in accounts:
            self._clear_stale_requests_on_startup(account.account_id)
            self._start_account_task(account)
            self._start_scheduled_delivery_task(account)

    async def shutdown(self) -> None:
        self._shutdown_requested = True
        tasks = [
            *self._poll_tasks.values(),
            *self._scheduled_delivery_tasks.values(),
            *self._restart_tasks.values(),
            *self._background_tasks,
        ]
        self._poll_tasks.clear()
        self._scheduled_delivery_tasks.clear()
        self._restart_tasks.clear()
        self._background_tasks.clear()
        self._background_exchange_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._idle_event.set()
        await self._lifecycle.shutdown()

    async def run(self) -> None:
        await self.startup()
        try:
            await self._idle_event.wait()
        finally:
            await self.shutdown()

    def _start_account_task(self, account: WeixinAccount) -> None:
        self._accounts[account.account_id] = account
        self._expired_account_ids.discard(account.account_id)
        self._save_runtime_status()
        self._idle_event.clear()
        task = asyncio.create_task(
            self._poll_account(account),
            name=f"weixin-poll-{account.account_id}",
        )
        self._poll_tasks[account.account_id] = task
        task.add_done_callback(
            lambda finished, account_id=account.account_id: self._handle_task_done(
                account_id,
                finished,
            )
        )

    def _start_scheduled_delivery_task(self, account: WeixinAccount) -> None:
        if account.account_id in self._scheduled_delivery_tasks:
            return
        self._idle_event.clear()
        task = asyncio.create_task(
            self._poll_scheduled_deliveries(account),
            name=f"weixin-scheduled-delivery-{account.account_id}",
        )
        self._scheduled_delivery_tasks[account.account_id] = task
        task.add_done_callback(
            lambda finished, account_id=account.account_id: self._handle_scheduled_delivery_task_done(
                account_id,
                finished,
            )
        )

    def _save_runtime_status(self) -> None:
        account_ids = tuple(sorted(self._accounts))
        expired_ids = self._expired_account_ids.intersection(account_ids)
        all_expired = bool(account_ids) and len(expired_ids) == len(account_ids)
        self._state.save_runtime_status(
            {
                "protocol": "cardbush_app.bot_runtime_status.v1",
                "platform": "weixin",
                "service_status": "failed" if all_expired else "running",
                "health_status": (
                    "authentication_expired"
                    if all_expired
                    else "degraded"
                    if expired_ids
                    else "healthy"
                ),
                "error_code": "weixin_session_expired" if expired_ids else "",
                "last_error": (
                    "Weixin login expired; reconnect the account and restart the bot."
                    if expired_ids
                    else ""
                ),
                "requires_reauthentication": bool(expired_ids),
                "accounts": [
                    {
                        "account_id": account_id,
                        "status": (
                            "authentication_expired"
                            if account_id in expired_ids
                            else "running"
                        ),
                    }
                    for account_id in account_ids
                ],
                "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }
        )

    def _handle_task_done(
        self,
        account_id: str,
        task: asyncio.Task[None],
    ) -> None:
        self._poll_tasks.pop(account_id, None)
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            logger.exception("Weixin poll loop crashed for account=%s", account_id)
            if not self._shutdown_requested:
                self._schedule_poll_restart(account_id)
        else:
            logger.info("Weixin poll loop exited for account=%s", account_id)
        self._notify_if_idle()

    def _handle_restart_task_done(
        self,
        account_id: str,
        task: asyncio.Task[None],
    ) -> None:
        self._restart_tasks.pop(account_id, None)
        if task.cancelled():
            self._notify_if_idle()
            return
        try:
            task.result()
        except Exception:
            logger.exception(
                "Weixin poll restart scheduler failed for account=%s",
                account_id,
            )
            if not self._shutdown_requested:
                self._schedule_poll_restart(account_id)
        self._notify_if_idle()

    def _handle_scheduled_delivery_task_done(
        self,
        account_id: str,
        task: asyncio.Task[None],
    ) -> None:
        self._scheduled_delivery_tasks.pop(account_id, None)
        if task.cancelled():
            self._notify_if_idle()
            return
        try:
            task.result()
        except Exception:
            logger.exception(
                "Weixin scheduled delivery loop crashed for account=%s",
                account_id,
            )
            if not self._shutdown_requested:
                account = self._state.load_account(account_id) or self._accounts.get(
                    account_id
                )
                if account is not None:
                    self._start_scheduled_delivery_task(account)
        self._notify_if_idle()

    def _handle_background_task_done(
        self,
        task: asyncio.Task[None],
    ) -> None:
        self._background_tasks.discard(task)
        if task.cancelled():
            self._notify_if_idle()
            return
        try:
            task.result()
        except Exception:
            logger.exception("Weixin background interaction task failed")
        self._notify_if_idle()

    def _schedule_poll_restart(self, account_id: str) -> None:
        if self._shutdown_requested or account_id in self._restart_tasks:
            return
        attempt = self._poll_restart_attempts.get(account_id, 0) + 1
        self._poll_restart_attempts[account_id] = attempt
        delay_seconds = self._compute_backoff_delay(
            attempt,
            base_seconds=_POLL_TASK_RESTART_BASE_SECONDS,
            max_seconds=_POLL_TASK_RESTART_MAX_SECONDS,
        )
        self._idle_event.clear()
        logger.warning(
            "Scheduling Weixin poll loop restart account=%s attempt=%s delay=%.1fs",
            account_id,
            attempt,
            delay_seconds,
        )
        task = asyncio.create_task(
            self._restart_poll_task_after_delay(
                account_id=account_id,
                delay_seconds=delay_seconds,
            ),
            name=f"weixin-poll-restart-{account_id}",
        )
        self._restart_tasks[account_id] = task
        task.add_done_callback(
            lambda finished, restart_account_id=account_id: self._handle_restart_task_done(
                restart_account_id,
                finished,
            )
        )

    async def _restart_poll_task_after_delay(
        self,
        *,
        account_id: str,
        delay_seconds: float,
    ) -> None:
        await asyncio.sleep(delay_seconds)
        if self._shutdown_requested:
            return
        account = self._state.load_account(account_id) or self._accounts.get(account_id)
        if account is None:
            logger.warning(
                "Skipping Weixin poll loop restart for missing account=%s",
                account_id,
            )
            return
        self._start_account_task(account)

    def _notify_if_idle(self) -> None:
        if self._shutdown_requested:
            return
        if (
            self._poll_tasks
            or self._scheduled_delivery_tasks
            or self._restart_tasks
            or self._background_tasks
        ):
            return
        self._idle_event.set()

    def _track_background_task(
        self,
        coro: Any,
        *,
        name: str,
    ) -> asyncio.Task[None]:
        self._idle_event.clear()
        task = asyncio.create_task(coro, name=name)
        self._background_tasks.add(task)
        task.add_done_callback(self._handle_background_task_done)
        return task

    def _clear_active_backend_response_task(
        self,
        session_id: str,
        response_task: asyncio.Task[Any],
    ) -> None:
        tracked_task = self._active_backend_response_tasks.get(session_id)
        if tracked_task is response_task:
            self._active_backend_response_tasks.pop(session_id, None)

    def _track_background_exchange_task(
        self,
        session_id: str,
        task: asyncio.Task[None],
    ) -> None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return
        self._background_exchange_tasks[normalized_session_id] = task
        task.add_done_callback(
            lambda finished, current_session_id=normalized_session_id: (
                self._clear_background_exchange_task(current_session_id, finished)
            )
        )

    def _clear_background_exchange_task(
        self,
        session_id: str,
        task: asyncio.Task[None],
    ) -> None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return
        if self._background_exchange_tasks.get(normalized_session_id) is task:
            self._background_exchange_tasks.pop(normalized_session_id, None)

    async def _drain_background_exchange_after_interaction_reply(
        self,
        session_id: str,
    ) -> None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return
        task = self._background_exchange_tasks.get(normalized_session_id)
        if task is None:
            return
        if task.done():
            await asyncio.gather(task, return_exceptions=True)
            return
        timeout_seconds = min(
            _INTERACTION_REPLY_BACKGROUND_DRAIN_MAX_SECONDS,
            max(0.05, float(_INTERACTION_POLL_INTERVAL_SECONDS) + 0.1),
        )
        try:
            await asyncio.wait_for(
                asyncio.shield(task),
                timeout=timeout_seconds,
            )
        except TimeoutError:
            return

    @staticmethod
    def _compute_backoff_delay(
        failures: int,
        *,
        base_seconds: float,
        max_seconds: float,
    ) -> float:
        normalized_failures = max(1, int(failures))
        exponent = max(0, normalized_failures - 1)
        return min(
            float(max_seconds),
            float(base_seconds) * (2**exponent),
        )

    async def _poll_account(self, account: WeixinAccount) -> None:
        sync_buffer = self._state.load_sync_buffer(account.account_id)
        timeout_seconds = self._settings.poll_timeout_seconds
        poll_failures = 0
        logger.info(
            "Weixin poll loop started account=%s base_url=%s",
            account.account_id,
            account.base_url,
        )
        while True:
            try:
                result = await self._client.get_updates(
                    base_url=account.base_url,
                    token=account.token,
                    sync_buffer=sync_buffer,
                    timeout_seconds=timeout_seconds,
                )
            except asyncio.CancelledError:
                raise
            except httpx.RequestError as exc:
                poll_failures += 1
                delay_seconds = self._compute_backoff_delay(
                    poll_failures,
                    base_seconds=_POLL_EXCEPTION_RETRY_BASE_SECONDS,
                    max_seconds=_POLL_EXCEPTION_RETRY_MAX_SECONDS,
                )
                logger.warning(
                    "Weixin getupdates request failed account=%s failure=%s retry_in=%.1fs error=%s: %s",
                    account.account_id,
                    poll_failures,
                    delay_seconds,
                    exc.__class__.__name__,
                    exc,
                )
                await asyncio.sleep(delay_seconds)
                timeout_seconds = self._settings.poll_timeout_seconds
                continue
            except Exception:
                poll_failures += 1
                delay_seconds = self._compute_backoff_delay(
                    poll_failures,
                    base_seconds=_POLL_EXCEPTION_RETRY_BASE_SECONDS,
                    max_seconds=_POLL_EXCEPTION_RETRY_MAX_SECONDS,
                )
                logger.warning(
                    "Weixin getupdates request failed account=%s failure=%s retry_in=%.1fs",
                    account.account_id,
                    poll_failures,
                    delay_seconds,
                    exc_info=True,
                )
                await asyncio.sleep(delay_seconds)
                timeout_seconds = self._settings.poll_timeout_seconds
                continue
            poll_failures = 0
            self._poll_restart_attempts.pop(account.account_id, None)
            if result.longpolling_timeout_ms and result.longpolling_timeout_ms > 0:
                timeout_seconds = max(
                    5.0,
                    result.longpolling_timeout_ms / 1000.0,
                )
            if self._is_api_error(result):
                if (
                    result.errcode == SESSION_EXPIRED_ERRCODE
                    or result.ret == SESSION_EXPIRED_ERRCODE
                ):
                    self._expired_account_ids.add(account.account_id)
                    self._save_runtime_status()
                    logger.warning(
                        "Weixin session expired for account=%s; rerun `cardbush-weixin login`",
                        account.account_id,
                    )
                    return
                logger.warning(
                    "Weixin getupdates error account=%s ret=%s errcode=%s errmsg=%s",
                    account.account_id,
                    result.ret,
                    result.errcode,
                    result.errmsg,
                )
                await asyncio.sleep(2.0)
                continue
            next_sync_buffer = result.sync_buffer
            should_advance_sync_buffer = True
            for message in result.messages:
                message_id = str(message.message_id or "").strip()
                if message_id and self._was_recently_handled_message_id(
                    account.account_id,
                    message_id,
                ):
                    continue
                try:
                    await self._handle_message(account, message)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    failure_count = self._record_message_handle_failure(
                        account.account_id,
                        message_id,
                    )
                    logger.exception(
                        "Weixin message handling failed account=%s user=%s message_id=%s",
                        account.account_id,
                        message.from_user_id,
                        message.message_id,
                    )
                    if message_id and failure_count < _MAX_MESSAGE_HANDLE_FAILURES:
                        should_advance_sync_buffer = False
                    elif message_id:
                        logger.error(
                            "Weixin message exceeded retry budget and will be skipped account=%s user=%s message_id=%s failures=%s",
                            account.account_id,
                            message.from_user_id,
                            message.message_id,
                            failure_count,
                        )
                        self._mark_message_handled(account.account_id, message_id)
                        self._clear_message_handle_failure(
                            account.account_id,
                            message_id,
                        )
                    continue
                if message_id:
                    self._mark_message_handled(account.account_id, message_id)
                    self._clear_message_handle_failure(
                        account.account_id,
                        message_id,
                    )
            if should_advance_sync_buffer:
                sync_buffer = next_sync_buffer
                self._state.save_sync_buffer(account.account_id, sync_buffer)
            else:
                await asyncio.sleep(_MESSAGE_HANDLE_RETRY_DELAY_SECONDS)

    async def _poll_scheduled_deliveries(self, account: WeixinAccount) -> None:
        logger.info(
            "Weixin scheduled delivery loop started account=%s",
            account.account_id,
        )
        while True:
            try:
                await self._drain_due_scheduled_deliveries(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Weixin scheduled delivery drain failed account=%s",
                    account.account_id,
                )
            await asyncio.sleep(_SCHEDULED_DELIVERY_POLL_INTERVAL_SECONDS)

    async def _drain_due_scheduled_deliveries(
        self,
        account: WeixinAccount,
    ) -> int:
        self._scheduled_delivery_store.reset_stale_delivering_jobs(
            platform="weixin",
            channel_id=account.account_id,
        )
        jobs = self._scheduled_delivery_store.claim_due_jobs(
            platform="weixin",
            channel_id=account.account_id,
            limit=_SCHEDULED_DELIVERY_CLAIM_LIMIT,
        )
        delivered = 0
        for job in jobs:
            try:
                await self._deliver_scheduled_delivery_job(account=account, job=job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if isinstance(exc, _ScheduledDeliveryRetryError):
                    logger.warning(
                        "Weixin scheduled delivery incomplete account=%s job_id=%s failed_paths=%s",
                        account.account_id,
                        job.job_id,
                        [item.path for item in exc.failed_deliverables],
                    )
                else:
                    logger.exception(
                        "Weixin scheduled delivery failed account=%s job_id=%s",
                        account.account_id,
                        job.job_id,
                    )
                self._scheduled_delivery_store.mark_failed(
                    job.job_id,
                    error=str(exc),
                    retry_delay_seconds=_SCHEDULED_DELIVERY_RETRY_DELAY_SECONDS,
                    deliverables=(
                        self._scheduled_failed_deliverable_payload(
                            exc.failed_deliverables
                        )
                        if isinstance(exc, _ScheduledDeliveryRetryError)
                        else None
                    ),
                )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="scheduled_delivery_failure",
                    user_id=job.user_id,
                    message_id=None,
                    session_id=job.session_id,
                    job_id=job.job_id,
                    error=str(exc),
                    failed_deliverable_paths=(
                        [item.path for item in exc.failed_deliverables]
                        if isinstance(exc, _ScheduledDeliveryRetryError)
                        else []
                    ),
                )
                continue
            self._scheduled_delivery_store.mark_completed(job.job_id)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="scheduled_delivery_success",
                user_id=job.user_id,
                message_id=None,
                session_id=job.session_id,
                job_id=job.job_id,
                deliverable_count=len(job.deliverables),
                deliverable_paths=[item.path for item in job.deliverables],
            )
            delivered += 1
        return delivered

    async def _deliver_scheduled_delivery_job(
        self,
        *,
        account: WeixinAccount,
        job: ScheduledDeliveryJob,
    ) -> None:
        context_token = self._latest_context_token(
            account.account_id,
            job.user_id,
            None,
        )
        structured_deliverables = self._structured_deliverables_from_scheduled_job(job)
        if structured_deliverables:
            sent_paths, failed_paths = await self._deliver_structured_files_if_any(
                account=account,
                to_user_id=job.user_id,
                context_token=context_token,
                session_id=job.session_id,
                deliverables=structured_deliverables,
                message_id=None,
                schedule_retry_on_failure=False,
                notify_on_failure=False,
            )
            await self._record_transport_delivery_receipts_safely(
                session_id=job.session_id,
                turn_id=job.created_turn_id,
                directives={"delivery_id": job.transport_delivery_id},
                sent_paths=sent_paths,
                failed_paths=failed_paths,
            )
            if failed_paths:
                failed_set = set(failed_paths)
                failed_deliverables = [
                    item for item in structured_deliverables if item.path in failed_set
                ]
                raise _ScheduledDeliveryRetryError(
                    "scheduled deliverable transfer incomplete",
                    failed_deliverables=failed_deliverables,
                    failure_messages=[],
                )
        reply_text = job.reply_text.strip()
        if reply_text:
            try:
                await self._send_text_with_retry(
                    account=account,
                    base_url=account.base_url,
                    token=account.token,
                    to_user_id=job.user_id,
                    text=reply_text,
                    context_token=context_token,
                    purpose="scheduled-delivery-text",
                    message_id=None,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if structured_deliverables:
                    scheduled_retry = self._schedule_text_delivery_retry(
                        account=account,
                        to_user_id=job.user_id,
                        text=reply_text,
                        purpose="scheduled-delivery-reply",
                        message_id=None,
                        session_id=job.session_id,
                        error=exc,
                    )
                    if scheduled_retry is not None:
                        return
                raise

    @staticmethod
    def _structured_deliverables_from_scheduled_job(
        job: ScheduledDeliveryJob,
    ) -> list[_StructuredDeliverable]:
        deliverables: list[_StructuredDeliverable] = []
        for item in job.deliverables[:_DELIVERABLE_TRANSFER_MAX_FILES]:
            path = str(item.path or "").strip()
            if not path:
                continue
            deliverables.append(
                _StructuredDeliverable(
                    path=path,
                    caption=str(item.caption or "").strip(),
                    label=str(item.label or "").strip(),
                )
                )
        return deliverables

    @staticmethod
    def _scheduled_failed_deliverable_payload(
        deliverables: list[_StructuredDeliverable],
    ) -> list[dict[str, str]]:
        return [
            {
                "path": item.path,
                "caption": item.caption,
                "label": item.label,
            }
            for item in deliverables[:_DELIVERABLE_TRANSFER_MAX_FILES]
            if str(item.path or "").strip()
        ]

    @staticmethod
    def _should_schedule_text_delivery_retry(purpose: str) -> bool:
        normalized = _normalize_match_text(purpose)
        if not normalized or normalized == "scheduled-delivery-text":
            return False
        # Interaction cards and acks are stateful; delayed delivery can be stale.
        if normalized == "interactive-request" or normalized.startswith("interactive-"):
            return False
        return True

    def _schedule_text_delivery_retry(
        self,
        *,
        account: WeixinAccount,
        to_user_id: str,
        text: str,
        purpose: str,
        message_id: str | None,
        session_id: str | None,
        error: BaseException,
    ) -> ScheduledDeliveryJob | None:
        normalized_text = str(text or "").strip()
        normalized_session_id = _normalize_text(session_id)
        if (
            not normalized_text
            or not normalized_session_id
            or not self._should_schedule_text_delivery_retry(purpose)
        ):
            return None
        execute_at = datetime.now().astimezone() + timedelta(
            seconds=max(1.0, _SCHEDULED_DELIVERY_RETRY_DELAY_SECONDS)
        )
        job = self._scheduled_delivery_store.create_job(
            session_id=normalized_session_id,
            user_id=to_user_id,
            channel_id=account.account_id,
            platform="weixin",
            mode="deliver_prepared",
            execute_at=execute_at,
            task_text=(
                f"retry weixin text delivery purpose={purpose} "
                f"message_id={message_id or ''}"
            ).strip(),
            reply_text=normalized_text,
            deliverables=(),
            transport_channel="weixin",
            max_attempts=_SEND_TEXT_SCHEDULED_RETRY_MAX_ATTEMPTS,
        )
        error_text = _format_exception_brief(error)
        logger.warning(
            "Weixin send_text scheduled retry account=%s user=%s purpose=%s message_id=%s session_id=%s job_id=%s error=%s",
            account.account_id,
            to_user_id,
            purpose,
            message_id,
            normalized_session_id,
            job.job_id,
            error_text,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="send_text_scheduled_retry",
            user_id=to_user_id,
            message_id=message_id,
            session_id=normalized_session_id,
            purpose=purpose,
            job_id=job.job_id,
            error=error_text,
            error_type=type(error).__name__,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="send_text_delivery_failure",
            user_id=to_user_id,
            message_id=message_id,
            session_id=normalized_session_id,
            purpose=purpose,
            error=error_text,
            error_type=type(error).__name__,
            scheduled_retry=True,
            job_id=job.job_id,
        )
        return job

    async def _reset_client_connections_after_request_error(
        self,
        *,
        account: WeixinAccount,
        purpose: str,
        attempt: int,
        error: BaseException,
    ) -> None:
        if not isinstance(error, httpx.RequestError):
            return
        reset_connections = getattr(self._client, "reset_connections", None)
        if not callable(reset_connections):
            return
        try:
            result = reset_connections()
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug(
                "Weixin reset client connections failed account=%s purpose=%s attempt=%s",
                account.account_id,
                purpose,
                attempt,
                exc_info=True,
            )

    def _was_recently_handled_message_id(
        self,
        account_id: str,
        message_id: str,
    ) -> bool:
        normalized_account_id = str(account_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_account_id or not normalized_message_id:
            return False
        now = time.time()
        self._ensure_message_processing_state_loaded(normalized_account_id)
        bucket = self._recent_handled_message_ids.get(normalized_account_id) or {}
        cutoff = now - _RECENT_HANDLED_MESSAGE_TTL_SECONDS
        stale_ids = [key for key, ts in bucket.items() if float(ts) < cutoff]
        for stale_id in stale_ids:
            bucket.pop(stale_id, None)
        self._recent_handled_message_ids[normalized_account_id] = bucket
        if stale_ids:
            self._save_message_processing_state(normalized_account_id)
        return normalized_message_id in bucket

    def _mark_message_handled(
        self,
        account_id: str,
        message_id: str,
    ) -> None:
        normalized_account_id = str(account_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_account_id or not normalized_message_id:
            return
        self._ensure_message_processing_state_loaded(normalized_account_id)
        bucket = self._recent_handled_message_ids.setdefault(normalized_account_id, {})
        bucket[normalized_message_id] = time.time()
        self._save_message_processing_state(normalized_account_id)

    def _record_message_handle_failure(
        self,
        account_id: str,
        message_id: str,
    ) -> int:
        normalized_account_id = str(account_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_account_id or not normalized_message_id:
            return 0
        self._ensure_message_processing_state_loaded(normalized_account_id)
        bucket = self._message_handle_failures.setdefault(normalized_account_id, {})
        failures = int(bucket.get(normalized_message_id) or 0) + 1
        bucket[normalized_message_id] = failures
        self._save_message_processing_state(normalized_account_id)
        return failures

    def _clear_message_handle_failure(
        self,
        account_id: str,
        message_id: str,
    ) -> None:
        normalized_account_id = str(account_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_account_id or not normalized_message_id:
            return
        self._ensure_message_processing_state_loaded(normalized_account_id)
        bucket = self._message_handle_failures.get(normalized_account_id)
        if not bucket:
            return
        bucket.pop(normalized_message_id, None)
        self._message_handle_failures[normalized_account_id] = bucket
        self._save_message_processing_state(normalized_account_id)

    def _ensure_message_processing_state_loaded(self, account_id: str) -> None:
        normalized_account_id = str(account_id or "").strip()
        if not normalized_account_id:
            return
        if normalized_account_id not in self._recent_handled_message_ids:
            state = self._state.load_message_processing_state(normalized_account_id)
            handled = dict(state.get("handled") or {})
            failures = dict(state.get("failures") or {})
            self._recent_handled_message_ids[normalized_account_id] = {
                str(key): float(value)
                for key, value in handled.items()
                if str(key).strip()
            }
            self._message_handle_failures[normalized_account_id] = {
                str(key): int(value)
                for key, value in failures.items()
                if str(key).strip() and int(value) > 0
            }

    def _save_message_processing_state(self, account_id: str) -> None:
        normalized_account_id = str(account_id or "").strip()
        if not normalized_account_id:
            return
        handled = self._recent_handled_message_ids.get(normalized_account_id) or {}
        failures = self._message_handle_failures.get(normalized_account_id) or {}
        self._state.save_message_processing_state(
            normalized_account_id,
            handled=handled,
            failures=failures,
        )

    def _record_runtime_trace_event(
        self,
        *,
        account_id: str,
        event: str,
        **payload: object,
    ) -> None:
        normalized_account_id = str(account_id or "").strip()
        normalized_event = str(event or "").strip()
        if not normalized_account_id or not normalized_event:
            return
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        trace = self._state.load_runtime_trace(normalized_account_id)
        entry = self._sanitize_runtime_trace_payload(
            {
                "event": normalized_event,
                "at": timestamp,
                **payload,
            }
        )
        recent_events = trace.get("recent_events")
        if not isinstance(recent_events, list):
            recent_events = []
        trace["updated_at"] = timestamp
        trace["recent_events"] = [*recent_events, entry][-_RUNTIME_TRACE_MAX_EVENTS:]
        if normalized_event == "received":
            trace["last_received"] = entry
        elif normalized_event == "new_session_switched":
            trace["last_session_switch"] = entry
        elif normalized_event == "forward_start":
            trace["last_forward_attempt"] = entry
        elif normalized_event in {
            "forward_success",
            "forward_partial_success",
            "forward_failure",
            "forward_interactive_request",
            "forward_backgrounded",
            "guidance_delivered",
            "guidance_fallback",
        }:
            trace["last_forward_result"] = entry
        self._state.save_runtime_trace(normalized_account_id, trace)

    def _clear_stale_requests_on_startup(self, account_id: str) -> None:
        normalized_account_id = str(account_id or "").strip()
        if not normalized_account_id:
            return
        state = self._state.load_message_processing_state(normalized_account_id)
        handled = {
            str(key).strip(): float(value)
            for key, value in dict(state.get("handled") or {}).items()
            if str(key).strip()
        }
        failures = {
            str(key).strip(): int(value)
            for key, value in dict(state.get("failures") or {}).items()
            if str(key).strip() and int(value) > 0
        }
        trace = self._state.load_runtime_trace(normalized_account_id)
        stale_message_ids: set[str] = set(failures)
        inflight_message_id = self._extract_stale_forward_attempt_message_id(trace)
        if inflight_message_id:
            stale_message_ids.add(inflight_message_id)
        if not stale_message_ids:
            return
        now = time.time()
        for message_id in stale_message_ids:
            handled[message_id] = now
        self._state.save_message_processing_state(
            normalized_account_id,
            handled=handled,
            failures={},
        )
        self._recent_handled_message_ids[normalized_account_id] = handled
        self._message_handle_failures[normalized_account_id] = {}
        self._record_runtime_trace_event(
            account_id=normalized_account_id,
            event="startup_cleared_stale_requests",
            cleared_message_ids=sorted(stale_message_ids),
        )

    @staticmethod
    def _extract_stale_forward_attempt_message_id(trace: dict[str, object]) -> str:
        if not isinstance(trace, dict):
            return ""
        attempt = trace.get("last_forward_attempt")
        if not isinstance(attempt, dict):
            return ""
        attempt_message_id = str(attempt.get("message_id") or "").strip()
        if not attempt_message_id:
            return ""
        result = trace.get("last_forward_result")
        if isinstance(result, dict):
            result_message_id = str(result.get("message_id") or "").strip()
            if result_message_id == attempt_message_id:
                return ""
        return attempt_message_id

    @staticmethod
    def _sanitize_runtime_trace_payload(payload: dict[str, object]) -> dict[str, object]:
        sanitized: dict[str, object] = {}
        for key, value in payload.items():
            normalized_key = str(key or "").strip()
            if not normalized_key or value is None:
                continue
            if isinstance(value, Path):
                text = str(value).strip()
                if text:
                    sanitized[normalized_key] = text
                continue
            if isinstance(value, (str, int, float, bool)):
                if isinstance(value, str):
                    text = value.strip()
                    if not text:
                        continue
                    sanitized[normalized_key] = text
                else:
                    sanitized[normalized_key] = value
                continue
            if isinstance(value, list):
                normalized_items: list[object] = []
                for item in value:
                    if isinstance(item, (str, int, float, bool)):
                        if isinstance(item, str):
                            text = item.strip()
                            if not text:
                                continue
                            normalized_items.append(text)
                        else:
                            normalized_items.append(item)
                if normalized_items:
                    sanitized[normalized_key] = normalized_items
                continue
            if isinstance(value, dict):
                normalized_object = WeixinBotService._sanitize_runtime_trace_payload(
                    dict(value)
                )
                if normalized_object:
                    sanitized[normalized_key] = normalized_object
                continue
            text = str(value).strip()
            if text:
                sanitized[normalized_key] = text
        return sanitized

    def _shadow_observation_path(self) -> Path:
        return (
            self._settings.shadow_observation_path
            or self._settings.state_dir / "shadow_observations.jsonl"
        )

    def _record_shadow_observation(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        message_id: str | None,
        phase: str,
        duration_ms: int | None = None,
        reply_metadata: dict[str, Any] | None = None,
        reply_text_sent: bool | None = None,
        deliverable_count: int | None = None,
        deliverable_sent_count: int | None = None,
        deliverable_failed_count: int | None = None,
        interactive_request_sent: bool | None = None,
        error: BaseException | None = None,
    ) -> None:
        if not self._settings.shadow_observation_enabled:
            return
        normalized_phase = _normalize_text(phase)
        if not normalized_phase:
            return
        try:
            text = _normalize_text(envelope.text)
            metadata = reply_metadata or {}
            if not isinstance(metadata, dict):
                metadata = {}
            outcome: dict[str, object] = {
                "status": normalized_phase,
                "duration_ms": duration_ms,
                "reply_text_sent": reply_text_sent,
                "deliverable_count": deliverable_count,
                "deliverable_sent_count": deliverable_sent_count,
                "deliverable_failed_count": deliverable_failed_count,
                "interactive_request_sent": interactive_request_sent,
                "turn_id": _normalize_text(metadata.get("turn_id")),
                "stopped": bool(metadata.get("stopped")),
                "stream_error": bool(metadata.get("stream_error")),
            }
            if error is not None:
                outcome.update(
                    {
                        "error_type": type(error).__name__,
                        "model_service_error": _is_model_service_exception(error),
                        "user_visible_error": _format_user_visible_backend_error(error),
                        "user_visible_error_sanitized": True,
                    }
                )
            record = self._sanitize_runtime_trace_payload(
                {
                    "schema": _SHADOW_OBSERVATION_SCHEMA,
                    "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "phase": normalized_phase,
                    "account_id": account.account_id,
                    "user_id": envelope.user_id,
                    "session_id": envelope.session_id,
                    "message_id": message_id,
                    "observation_mode": "facts_only",
                    "input": {
                        "preview": _preview_text(text),
                        "length": len(text),
                        "sha256_12": _shadow_text_hash(text) if text else "",
                    },
                    "outcome": outcome,
                }
            )
            path = self._shadow_observation_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
                )
        except Exception:  # noqa: BLE001
            logger.warning(
                "Weixin shadow observation write failed account=%s session=%s",
                account.account_id,
                envelope.session_id,
                exc_info=True,
            )

    @staticmethod
    def _is_api_error(result: GetUpdatesResult) -> bool:
        return bool(
            result.ret not in (0, None)
            or result.errcode not in (0, None)
        )

    @staticmethod
    def _message_has_downloadable_attachments(message: WeixinMessage) -> bool:
        item_list = message.raw.get("item_list")
        if not isinstance(item_list, list):
            return False
        for raw_item in item_list:
            if not isinstance(raw_item, dict):
                continue
            if raw_item.get("type") in {2, 3, 4, 5}:
                return True
        return False

    async def _handle_message(
        self,
        account: WeixinAccount,
        message: WeixinMessage,
    ) -> None:
        from_user_id = message.from_user_id
        if not from_user_id:
            return
        if not channel_identity_is_allowed(
            user_id=from_user_id,
            channel_id=account.account_id,
            allowed_user_ids=self._settings.allowed_user_ids,
            allowed_channel_ids=self._settings.allowed_channel_ids,
        ):
            logger.info(
                "Ignored Weixin message from unauthorized user account=%s user=%s",
                account.account_id,
                from_user_id,
            )
            return

        context_token = message.context_token
        if context_token:
            self._state.set_context_token(
                account.account_id,
                from_user_id,
                context_token,
            )
        else:
            context_token = self._state.get_context_token(
                account.account_id,
                from_user_id,
            )

        text = extract_message_text(message)
        current_session_id = self._session_id_for_user(
            account_id=account.account_id,
            user_id=from_user_id,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="received",
            user_id=from_user_id,
            message_id=message.message_id,
            session_id=current_session_id,
            text_preview=_preview_text(text),
            has_text=bool(text),
            has_attachments=self._message_has_downloadable_attachments(message),
        )
        if self._is_new_session_command(text):
            await self._handle_new_session_command(
                account=account,
                user_id=from_user_id,
                context_token=context_token,
                message_id=message.message_id,
            )
            return
        slash_command = self._extract_english_slash_command(text)

        session_id = self._session_id_for_user(
            account_id=account.account_id,
            user_id=from_user_id,
        )
        downloaded_attachments = await self._download_and_store_media_attachments(
            session_id=session_id,
            message=message,
        )
        pending_total = 0
        for attachment in downloaded_attachments:
            pending_total = await self._cache_pending_attachment(
                session_id=session_id,
                kind=attachment["kind"],
                name=attachment.get("name"),
                path=attachment["path"],
                message_id=message.message_id,
            )

        if not text:
            if downloaded_attachments:
                await self._send_text_with_retry(
                    account=account,
                    base_url=account.base_url,
                    token=account.token,
                    to_user_id=from_user_id,
                    text=self._build_resource_ack_text(
                        attachments=downloaded_attachments,
                        pending_total=pending_total,
                    ),
                    context_token=self._latest_context_token(
                        account.account_id,
                        from_user_id,
                        context_token,
                    ),
                    purpose="attachment-ack",
                    message_id=message.message_id,
                )
                return
            if self._settings.unsupported_message_text:
                await self._send_text_with_retry(
                    account=account,
                    base_url=account.base_url,
                    token=account.token,
                    to_user_id=from_user_id,
                    text=_md_notice(
                        "暂不支持这类消息",
                        self._settings.unsupported_message_text,
                    ),
                    context_token=self._latest_context_token(
                        account.account_id,
                        from_user_id,
                        context_token,
                    ),
                    purpose="unsupported-message",
                    message_id=message.message_id,
                )
            return

        envelope = ChatEnvelope(
            platform="weixin",
            session_id=session_id,
            user_id=from_user_id,
            channel_id=account.account_id,
            text=text,
            message_id=message.message_id,
            raw_event={
                **dict(message.raw or {}),
                "_bridge_subagent_enabled": self._state.get_session_flag(
                    account.account_id,
                    session_id,
                    key="subagent_enabled",
                ),
            },
        )
        if self._is_session_handoff_command(text):
            await self._reply_to_message_with_cached_attachments(
                account=account,
                envelope=envelope,
                context_token=context_token,
                message_id=message.message_id,
            )
            return
        if slash_command == "/stop":
            handled = await self._handle_supported_slash_command(
                account=account,
                envelope=envelope,
                slash_command=slash_command,
                context_token=context_token,
                message_id=message.message_id,
            )
            if handled:
                return
        if await self._maybe_handle_pending_model_selection(
            account=account,
            envelope=envelope,
            slash_command=slash_command,
            context_token=context_token,
            message_id=message.message_id,
        ):
            return
        pending = await self._load_pending_interaction(envelope.session_id)
        if pending is not None:
            handled = await self._handle_pending_interaction_message(
                account=account,
                envelope=envelope,
                pending=pending,
                text=text,
                context_token=context_token,
                message_id=message.message_id,
            )
            if handled:
                return
        elif self._looks_like_interactive_reply_text(text):
            cached_pending = self._cached_announced_interaction(envelope.session_id)
            if cached_pending is not None:
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="interactive_reply_using_announced_cache",
                    user_id=from_user_id,
                    message_id=message.message_id,
                    session_id=envelope.session_id,
                    interaction_id=_normalize_text(
                        cached_pending.get("interaction_id")
                    ),
                    text_preview=_preview_text(text),
                )
                handled = await self._handle_pending_interaction_message(
                    account=account,
                    envelope=envelope,
                    pending=cached_pending,
                    text=text,
                    context_token=context_token,
                    message_id=message.message_id,
                )
                if handled:
                    return
        if slash_command:
            handled = await self._handle_supported_slash_command(
                account=account,
                envelope=envelope,
                slash_command=slash_command,
                context_token=context_token,
                message_id=message.message_id,
            )
            if handled:
                return
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=from_user_id,
                text=self._build_unknown_slash_command_text(slash_command),
                context_token=self._latest_context_token(
                    account.account_id,
                    from_user_id,
                    context_token,
                ),
                purpose="unknown-slash-command",
                message_id=message.message_id,
            )
            return

        await self._reply_to_message_with_cached_attachments(
            account=account,
            envelope=envelope,
            context_token=context_token,
            message_id=message.message_id,
        )

    @staticmethod
    def _default_session_id(account_id: str, user_id: str) -> str:
        return f"weixin:{account_id}:{user_id}"

    def _session_id_for_user(self, *, account_id: str, user_id: str) -> str:
        session_id = self._state.get_active_session_id(account_id, user_id)
        if session_id:
            return session_id
        return self._default_session_id(account_id, user_id)

    @staticmethod
    def _is_new_session_command(text: str) -> bool:
        return _normalize_match_text(text) in _NEW_SESSION_TOKENS

    @staticmethod
    def _build_new_session_ack_text() -> str:
        return _md_notice(
            "已切换到新会话",
            "接下来我们按一条新的对话继续。",
        )

    @staticmethod
    def _extract_english_slash_command(text: str) -> str:
        normalized = _normalize_match_text(text)
        match = _SLASH_EN_COMMAND_RE.fullmatch(normalized)
        if match is None:
            return ""
        return f"/{match.group(1).lower()}"

    @staticmethod
    def _is_session_handoff_command(text: str) -> bool:
        parts = str(text or "").strip().split()
        if not parts:
            return False
        command = parts[0].casefold()
        return command == "/unlink" or command == "/link"

    @staticmethod
    def _supported_slash_command_lines() -> list[str]:
        return [
            f"- `{name}`: {description}"
            for name, description in sorted(_SUPPORTED_SLASH_COMMANDS.items())
        ]

    @classmethod
    def _build_unknown_slash_command_text(cls, slash_command: str) -> str:
        return _md_with_help(
            "未知命令",
            f"未识别 {_md_code(slash_command)}，请检查是不是输入错误了。",
            cls._supported_slash_command_lines(),
        )

    @classmethod
    def _build_cancel_without_pending_text(cls) -> str:
        return _md_with_help(
            "没有可取消的确认",
            "当前没有等待中的确认可取消。",
            cls._supported_slash_command_lines(),
        )

    @classmethod
    def _build_stop_without_active_text(cls) -> str:
        return _md_with_help(
            "没有可停止的请求",
            "当前没有正在处理的请求可停止。",
            cls._supported_slash_command_lines(),
        )

    @staticmethod
    def _compact_status_id(value: object | None) -> str:
        text = _normalize_text(value)
        if not text:
            return "`-`"
        if len(text) <= 32:
            return _md_code(text)
        return _md_code(f"...{text[-24:]}")

    def _active_turn_id_for_session_snapshot(self, session_id: str) -> str:
        active_turns = getattr(self._backend, "_active_turns", None)
        if not isinstance(active_turns, dict):
            return ""
        normalized_session_id = _normalize_text(session_id)
        for turn_id, record in active_turns.items():
            if not isinstance(record, dict):
                continue
            if _normalize_text(record.get("session_id")) == normalized_session_id:
                return _normalize_text(turn_id)
        return ""

    async def _build_status_text(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
    ) -> str:
        active_task = self._active_backend_response_tasks.get(envelope.session_id)
        request_status = (
            "运行中"
            if active_task is not None and not active_task.done()
            else "空闲"
        )
        turn_id = self._active_turn_id_for_session_snapshot(envelope.session_id)
        pending = await self._load_pending_interaction(envelope.session_id)
        trace = self._state.load_runtime_trace(account.account_id)
        last_result = trace.get("last_forward_result")
        if not isinstance(last_result, dict):
            last_result = {}
        last_event = _normalize_text(last_result.get("event"))
        if last_event == "guidance_delivered":
            guidance_status = "最近补充已并入正在执行的任务"
        elif last_event == "guidance_fallback":
            guidance_status = "最近补充未并入，已按普通消息继续"
        elif last_event:
            guidance_status = "最近没有补充引导"
        else:
            guidance_status = "暂无转发记录"
        active_turn_text = (
            self._compact_status_id(turn_id)
            if turn_id
            else self._compact_status_id(last_result.get("turn_id"))
        )
        return _md_notice(
            "当前状态",
            bullets=[
                f"会话: {self._compact_status_id(envelope.session_id)}",
                f"请求: {request_status}",
                f"turn: {active_turn_text}",
                f"待确认: {'有' if pending else '无'}",
                f"引导: {guidance_status}",
            ],
        )

    def _get_pending_model_selection(
        self,
        session_id: str,
    ) -> _PendingModelSelection | None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return None
        pending = self._pending_model_selections.get(normalized_session_id)
        if pending is None:
            return None
        if time.monotonic() - pending.created_at > _MODEL_SELECTION_TTL_SECONDS:
            self._pending_model_selections.pop(normalized_session_id, None)
            return None
        return pending

    def _clear_pending_model_selection(self, session_id: str) -> None:
        normalized_session_id = _normalize_text(session_id)
        if normalized_session_id:
            self._pending_model_selections.pop(normalized_session_id, None)

    @staticmethod
    def _parse_model_selection_index(text: str) -> int | None:
        normalized = _normalize_match_text(text)
        if not normalized or not normalized.isdecimal():
            return None
        try:
            return int(normalized)
        except ValueError:
            return None

    @staticmethod
    def _model_config_default_id(document: dict[str, Any]) -> str:
        return _normalize_text(
            document.get("default_model_id")
            or document.get("defaultModelId")
            or document.get("default")
            or document.get("default_model")
        )

    @staticmethod
    def _model_config_items(document: dict[str, Any]) -> list[dict[str, str]]:
        raw_models = document.get("models")
        if not isinstance(raw_models, list):
            raw_models = document.get("items")
        if not isinstance(raw_models, list):
            return []
        items: list[dict[str, str]] = []
        for raw in raw_models:
            if not isinstance(raw, dict):
                continue
            config_id = _normalize_text(raw.get("id"))
            model = _normalize_text(
                raw.get("model")
                or raw.get("model_name")
                or raw.get("modelName")
                or raw.get("name")
            )
            if not config_id or not model:
                continue
            items.append(
                {
                    "id": config_id,
                    "provider": _normalize_text(raw.get("provider")),
                    "model": model,
                }
            )
        return items

    @staticmethod
    def _find_model_config_item(
        models: list[dict[str, str]],
        model_config_id: str,
    ) -> dict[str, str] | None:
        target_id = _normalize_text(model_config_id)
        for item in models:
            if item.get("id") == target_id:
                return item
        return None

    @classmethod
    def _build_model_selection_text(
        cls,
        *,
        models: list[dict[str, str]],
        default_model_id: str,
    ) -> str:
        if not models:
            return _md_notice(
                "没有可切换的模型",
                "当前还没有配置模型槽位，请先在 BushServer 模型配置里添加。",
            )
        lines = ["**可选模型**", "", "回复序号切换默认模型。", ""]
        for index, item in enumerate(models, start=1):
            provider = item.get("provider") or "-"
            model = item.get("model") or "-"
            config_id = item.get("id") or "-"
            current_marker = "（当前）" if config_id == default_model_id else ""
            lines.append(
                f"{index}. {_md_code(provider)} / {_md_code(model)}"
                f"{current_marker}，槽位 {_md_code(config_id)}"
            )
        return "\n".join(lines).strip()

    @staticmethod
    def _build_model_switched_text(item: dict[str, str]) -> str:
        provider = item.get("provider") or "-"
        model = item.get("model") or "-"
        config_id = item.get("id") or "-"
        return _md_notice(
            "已切换默认模型",
            bullets=[
                f"provider: {_md_code(provider)}",
                f"model: {_md_code(model)}",
                f"槽位: {_md_code(config_id)}",
            ],
        )

    @classmethod
    def _build_model_selection_index_error_text(
        cls,
        *,
        count: int,
    ) -> str:
        return _md_notice(
            "序号无效",
            f"请回复 1-{count} 之间的数字，或发送 /cancel 取消本次模型切换。",
        )

    async def _load_model_config_document(self) -> dict[str, Any]:
        method = getattr(self._backend, "get_model_configs", None)
        if not callable(method):
            raise RuntimeError("current backend does not support model config listing")
        payload = await method()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected model config response: {payload!r}")
        return dict(payload)

    async def _switch_default_model_config(self, model_config_id: str) -> dict[str, Any]:
        method = getattr(self._backend, "switch_default_model_config", None)
        if not callable(method):
            raise RuntimeError("current backend does not support model switching")
        payload = await method(model_config_id)
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected model config update response: {payload!r}")
        return dict(payload)

    async def _handle_model_command(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        context_token: str | None,
        message_id: str | None,
    ) -> None:
        try:
            document = await self._load_model_config_document()
        except Exception as exc:  # noqa: BLE001
            self._clear_pending_model_selection(envelope.session_id)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="slash_model_list_failed",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                error=_format_exception_brief(exc),
            )
            text = _md_notice(
                "无法读取模型配置",
                _format_exception_brief(exc),
            )
        else:
            models = self._model_config_items(document)
            default_model_id = self._model_config_default_id(document)
            if models:
                self._pending_model_selections[envelope.session_id] = (
                    _PendingModelSelection(
                        session_id=envelope.session_id,
                        account_id=account.account_id,
                        user_id=envelope.user_id,
                        model_ids=tuple(item["id"] for item in models),
                        created_at=time.monotonic(),
                    )
                )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="slash_model_menu",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    default_model_id=default_model_id,
                    model_count=len(models),
                )
            else:
                self._clear_pending_model_selection(envelope.session_id)
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="slash_model_empty",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                )
            text = self._build_model_selection_text(
                models=models,
                default_model_id=default_model_id,
            )
        await self._send_text_with_retry(
            account=account,
            base_url=account.base_url,
            token=account.token,
            to_user_id=envelope.user_id,
            text=text,
            context_token=self._latest_context_token(
                account.account_id,
                envelope.user_id,
                context_token,
            ),
            purpose="slash-model",
            message_id=message_id,
        )

    async def _maybe_handle_pending_model_selection(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        slash_command: str,
        context_token: str | None,
        message_id: str | None,
    ) -> bool:
        pending = self._get_pending_model_selection(envelope.session_id)
        if pending is None:
            return False
        if slash_command == "/cancel":
            self._clear_pending_model_selection(envelope.session_id)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="slash_model_cancelled",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
            )
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=_md_notice("已取消模型切换", "默认模型槽位保持不变。"),
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-model-cancel",
                message_id=message_id,
            )
            return True
        if slash_command:
            self._clear_pending_model_selection(envelope.session_id)
            return False
        selected_index = self._parse_model_selection_index(envelope.text)
        if selected_index is None:
            self._clear_pending_model_selection(envelope.session_id)
            return False
        if selected_index < 1 or selected_index > len(pending.model_ids):
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=self._build_model_selection_index_error_text(
                    count=len(pending.model_ids),
                ),
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-model-invalid-selection",
                message_id=message_id,
            )
            return True

        target_model_id = pending.model_ids[selected_index - 1]
        try:
            document = await self._switch_default_model_config(target_model_id)
            models = self._model_config_items(document)
            selected = self._find_model_config_item(models, target_model_id) or {
                "id": target_model_id,
                "provider": "",
                "model": target_model_id,
            }
        except Exception as exc:  # noqa: BLE001
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="slash_model_switch_failed",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                model_config_id=target_model_id,
                error=_format_exception_brief(exc),
            )
            text = _md_notice(
                "模型切换失败",
                _format_exception_brief(exc),
            )
        else:
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="slash_model_switched",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                model_config_id=target_model_id,
                selected_model=selected.get("model") or "",
                selected_provider=selected.get("provider") or "",
            )
            text = self._build_model_switched_text(selected)
        finally:
            self._clear_pending_model_selection(envelope.session_id)

        await self._send_text_with_retry(
            account=account,
            base_url=account.base_url,
            token=account.token,
            to_user_id=envelope.user_id,
            text=text,
            context_token=self._latest_context_token(
                account.account_id,
                envelope.user_id,
                context_token,
            ),
            purpose="slash-model-selection",
            message_id=message_id,
        )
        return True

    async def _handle_supported_slash_command(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        slash_command: str,
        context_token: str | None,
        message_id: str | None,
    ) -> bool:
        if slash_command == "/model":
            await self._handle_model_command(
                account=account,
                envelope=envelope,
                context_token=context_token,
                message_id=message_id,
            )
            return True
        if slash_command == "/cancel":
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=self._build_cancel_without_pending_text(),
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-cancel-no-pending",
                message_id=message_id,
            )
            return True
        if slash_command == "/stop":
            active_task = self._active_backend_response_tasks.get(envelope.session_id)
            if active_task is None or active_task.done():
                self._active_backend_response_tasks.pop(envelope.session_id, None)
                await self._send_text_with_retry(
                    account=account,
                    base_url=account.base_url,
                    token=account.token,
                    to_user_id=envelope.user_id,
                    text=self._build_stop_without_active_text(),
                    context_token=self._latest_context_token(
                        account.account_id,
                        envelope.user_id,
                        context_token,
                    ),
                    purpose="slash-stop-no-active",
                    message_id=message_id,
                )
                return True
            active_task.cancel()
            await asyncio.gather(active_task, return_exceptions=True)
            self._active_backend_response_tasks.pop(envelope.session_id, None)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="forward_stop_requested",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
            )
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    "已请求停止",
                    "当前处理中的消息正在停止。",
                ),
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-stop",
                message_id=message_id,
            )
            return True
        if slash_command == "/status":
            status_text = await self._build_status_text(
                account=account,
                envelope=envelope,
            )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="slash_status",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
            )
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=status_text,
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-status",
                message_id=message_id,
            )
            return True
        if slash_command == "/subagent":
            self._state.set_session_flag(
                account.account_id,
                envelope.session_id,
                key="subagent_enabled",
                enabled=True,
            )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="subagent_enabled_for_session",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
            )
            await self._send_text_with_retry(
                account=account,
                base_url=account.base_url,
                token=account.token,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    "Subagent 已开启",
                    (
                        "已为当前会话开启 subagent。后续只有在你明确允许的这个会话里，"
                        "模型才可以使用 subagent 委派子任务。"
                    ),
                ),
                context_token=self._latest_context_token(
                    account.account_id,
                    envelope.user_id,
                    context_token,
                ),
                purpose="slash-subagent",
                message_id=message_id,
            )
            return True
        return False

    async def _handle_new_session_command(
        self,
        *,
        account: WeixinAccount,
        user_id: str,
        context_token: str | None,
        message_id: str | None,
    ) -> None:
        previous_session_id = self._session_id_for_user(
            account_id=account.account_id,
            user_id=user_id,
        )
        previous_active_task = self._active_backend_response_tasks.get(previous_session_id)
        if previous_active_task is not None and not previous_active_task.done():
            previous_active_task.cancel()
            await asyncio.gather(previous_active_task, return_exceptions=True)
            self._active_backend_response_tasks.pop(previous_session_id, None)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="new_session_cancelled_previous_forward",
                user_id=user_id,
                message_id=message_id,
                previous_session_id=previous_session_id,
            )
        new_session_id = (
            f"{self._default_session_id(account.account_id, user_id)}:{uuid.uuid4().hex}"
        )
        self._clear_pending_model_selection(previous_session_id)
        self._clear_pending_model_selection(new_session_id)
        self._state.set_active_session_id(
            account.account_id,
            user_id,
            new_session_id,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="new_session_switched",
            user_id=user_id,
            message_id=message_id,
            previous_session_id=previous_session_id,
            session_id=new_session_id,
        )
        await self._clear_pending_attachments(session_id=previous_session_id)
        await self._clear_pending_attachments(session_id=new_session_id)
        await self._send_text_with_retry(
            account=account,
            base_url=account.base_url,
            token=account.token,
            to_user_id=user_id,
            text=self._build_new_session_ack_text(),
            context_token=self._latest_context_token(
                account.account_id,
                user_id,
                context_token,
            ),
            purpose="new-session",
            message_id=message_id,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="new_session_ack_sent",
            user_id=user_id,
            message_id=message_id,
            session_id=new_session_id,
        )

    async def _reply_to_message_with_cached_attachments(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        context_token: str | None,
        message_id: str | None,
    ) -> None:
        pending_context = await self._get_pending_attachment_context(
            session_id=envelope.session_id
        )
        merged_text = self._merge_user_text_with_attachments(
            text=envelope.text,
            attachments=pending_context,
        )
        merged_raw_event = self._inject_pending_attachments(
            raw_event=envelope.raw_event,
            attachments=pending_context,
        )
        merged_envelope = ChatEnvelope(
            platform=envelope.platform,
            session_id=envelope.session_id,
            user_id=envelope.user_id,
            channel_id=envelope.channel_id,
            text=merged_text,
            message_id=envelope.message_id,
            thread_id=envelope.thread_id,
            raw_event=merged_raw_event,
        )
        await self._handle_backend_exchange(
            account=account,
            envelope=merged_envelope,
            context_token=context_token,
            message_id=message_id,
        )
        if pending_context:
            await self._clear_pending_attachments(session_id=envelope.session_id)

    async def _download_and_store_media_attachments(
        self,
        *,
        session_id: str,
        message: WeixinMessage,
    ) -> list[dict[str, str]]:
        item_list = message.raw.get("item_list")
        if not isinstance(item_list, list):
            return []
        saved: list[dict[str, str]] = []
        for index, raw_item in enumerate(item_list, start=1):
            if not isinstance(raw_item, dict):
                continue
            item_type = raw_item.get("type")
            if item_type not in {2, 3, 4, 5}:
                continue
            try:
                downloaded = await self._client.download_media_item(item=raw_item)
            except Exception:
                logger.warning(
                    "Weixin media download failed session=%s message_id=%s item_index=%s",
                    session_id,
                    message.message_id,
                    index,
                    exc_info=True,
                )
                continue
            has_temp_path = bool(str(getattr(downloaded, "temp_path", "") or "").strip())
            if downloaded is None or (not has_temp_path and not downloaded.content):
                continue
            try:
                target_path = self._save_downloaded_attachment(
                    session_id=session_id,
                    message=message,
                    attachment=downloaded,
                    index=index,
                )
            except Exception:
                self._cleanup_downloaded_attachment(downloaded)
                logger.warning(
                    "Weixin media save failed session=%s message_id=%s item_index=%s",
                    session_id,
                    message.message_id,
                    index,
                    exc_info=True,
                )
                continue
            saved.append(
                {
                    "kind": downloaded.kind,
                    "name": Path(target_path).name,
                    "path": target_path,
                }
            )
        return saved

    def _save_downloaded_attachment(
        self,
        *,
        session_id: str,
        message: WeixinMessage,
        attachment: Any,
        index: int,
    ) -> str:
        day_segment = datetime.now().strftime("%Y-%m-%d")
        workspace = session_workspace_dir(
            self._settings.data_dir,
            session_id,
        )
        target_dir = workspace / "weixin_resource_data" / day_segment
        target_dir.mkdir(parents=True, exist_ok=True)
        fallback_name = self._default_attachment_name(
            kind=str(attachment.kind),
            message_id=message.message_id,
            index=index,
            mime_type=getattr(attachment, "mime_type", None),
        )
        target_path = self._allocate_target_file_path(
            target_dir=target_dir,
            file_name=getattr(attachment, "file_name", None) or fallback_name,
        )
        temp_path_text = str(getattr(attachment, "temp_path", "") or "").strip()
        if temp_path_text:
            source_path = Path(temp_path_text)
            if not source_path.exists() or not source_path.is_file():
                raise FileNotFoundError(source_path)
            shutil.move(str(source_path), str(target_path))
            return str(target_path.resolve(strict=False))
        content = getattr(attachment, "content", b"")
        if isinstance(content, memoryview):
            target_path.write_bytes(content.tobytes())
        elif isinstance(content, bytearray):
            with target_path.open("wb") as handle:
                handle.write(content)
        elif isinstance(content, bytes):
            target_path.write_bytes(content)
        else:
            target_path.write_bytes(bytes(content))
        return str(target_path.resolve(strict=False))

    @staticmethod
    def _cleanup_downloaded_attachment(attachment: Any) -> None:
        temp_path_text = str(getattr(attachment, "temp_path", "") or "").strip()
        if not temp_path_text:
            return
        try:
            Path(temp_path_text).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    async def _handle_backend_exchange(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        context_token: str | None,
        message_id: str | None,
    ) -> None:
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="forward_start",
            user_id=envelope.user_id,
            message_id=message_id,
            session_id=envelope.session_id,
            text_preview=_preview_text(envelope.text),
        )
        started_at_monotonic = time.monotonic()
        response_task = asyncio.create_task(
            self._backend.respond(envelope),
            name=f"weixin-backend-{envelope.session_id}",
        )
        self._active_backend_response_tasks[envelope.session_id] = response_task
        backgrounded = False
        try:
            while True:
                done, _ = await asyncio.wait(
                    {response_task},
                    timeout=_INTERACTION_POLL_INTERVAL_SECONDS,
                )
                if done:
                    reply = response_task.result()
                    await self._deliver_backend_reply(
                        account=account,
                        envelope=envelope,
                        reply=reply,
                        context_token=context_token,
                        message_id=message_id,
                        response_duration_ms=_duration_ms_since(
                            started_at_monotonic
                        ),
                    )
                    return
                pending = await self._load_pending_interaction(envelope.session_id)
                if pending is None:
                    continue
                interactive_notice_sent = await self._try_deliver_reply_text(
                    account=account,
                    to_user_id=envelope.user_id,
                    text=self._format_pending_interaction_text(pending),
                    context_token=context_token,
                    purpose="interactive-request",
                    message_id=message_id,
                    session_id=envelope.session_id,
                )
                if interactive_notice_sent:
                    self._remember_announced_interaction(
                        envelope.session_id,
                        pending,
                    )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="forward_backgrounded",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    interactive_request_sent=interactive_notice_sent,
                )
                self._record_shadow_observation(
                    account=account,
                    envelope=envelope,
                    message_id=message_id,
                    phase="backgrounded",
                    duration_ms=_duration_ms_since(started_at_monotonic),
                    interactive_request_sent=interactive_notice_sent,
                )
                backgrounded = True
                background_task = self._track_background_task(
                    self._finalize_background_exchange(
                        account=account,
                        envelope=envelope,
                        context_token=context_token,
                        message_id=message_id,
                        response_task=response_task,
                        started_at_monotonic=started_at_monotonic,
                        last_announced_interaction_id=_normalize_text(
                            pending.get("interaction_id")
                        )
                        if interactive_notice_sent
                        else "",
                    ),
                    name=f"weixin-backend-wait-{envelope.session_id}",
                )
                self._track_background_exchange_task(
                    envelope.session_id,
                    background_task,
                )
                return
        except asyncio.CancelledError:
            if not backgrounded and not response_task.done():
                response_task.cancel()
                await asyncio.gather(response_task, return_exceptions=True)
            raise
        except PendingInteractiveRequestError as exc:
            if not backgrounded:
                interactive_notice_sent = await self._try_deliver_reply_text(
                    account=account,
                    to_user_id=envelope.user_id,
                    text=self._format_pending_interaction_text(exc.payload),
                    context_token=context_token,
                    purpose="interactive-request",
                    message_id=message_id,
                    session_id=envelope.session_id,
                )
                if interactive_notice_sent:
                    self._remember_announced_interaction(
                        envelope.session_id,
                        exc.payload,
                    )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="forward_interactive_request",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    title=_normalize_text(exc.payload.get("title")),
                    interactive_request_sent=interactive_notice_sent,
                )
                self._record_shadow_observation(
                    account=account,
                    envelope=envelope,
                    message_id=message_id,
                    phase="interactive_request",
                    duration_ms=_duration_ms_since(started_at_monotonic),
                    interactive_request_sent=interactive_notice_sent,
                )
            return
        except Exception as exc:
            error_category = _backend_error_category(exc)
            if response_task.done() and not response_task.cancelled():
                task_exception = response_task.exception()
                if task_exception is None:
                    raise
            if not backgrounded and not response_task.done():
                response_task.cancel()
                await asyncio.gather(response_task, return_exceptions=True)
            logger.exception(
                "Weixin backend request failed session=%s",
                envelope.session_id,
            )
            self._forget_announced_interaction(envelope.session_id)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="forward_failure",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                error=str(exc),
                **error_category,
            )
            self._record_shadow_observation(
                account=account,
                envelope=envelope,
                message_id=message_id,
                phase="failed",
                duration_ms=_duration_ms_since(started_at_monotonic),
                error=exc,
            )
            error_title, error_message = _user_visible_backend_error_notice(exc)
            await self._try_deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    error_title,
                    error_message,
                ),
                context_token=context_token,
                purpose="reply-error",
                message_id=message_id,
                session_id=envelope.session_id,
            )
        finally:
            if not backgrounded:
                self._clear_active_backend_response_task(
                    envelope.session_id,
                    response_task,
                )

    async def _finalize_background_exchange(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        context_token: str | None,
        message_id: str | None,
        response_task: asyncio.Task[Any],
        started_at_monotonic: float | None = None,
        last_announced_interaction_id: str = "",
    ) -> None:
        last_failed_interaction_id = ""
        next_interactive_notice_attempt_at = 0.0
        try:
            while True:
                done, _ = await asyncio.wait(
                    {response_task},
                    timeout=_INTERACTION_POLL_INTERVAL_SECONDS,
                )
                if done:
                    reply = response_task.result()
                    break
                pending = await self._load_pending_interaction(envelope.session_id)
                if pending is None:
                    continue
                interaction_id = _normalize_text(pending.get("interaction_id"))
                if (
                    interaction_id
                    and interaction_id == last_announced_interaction_id
                ):
                    continue
                now = time.monotonic()
                if (
                    interaction_id
                    and interaction_id == last_failed_interaction_id
                    and now < next_interactive_notice_attempt_at
                ):
                    continue
                interactive_notice_sent = await self._try_deliver_reply_text(
                    account=account,
                    to_user_id=envelope.user_id,
                    text=self._format_pending_interaction_text(pending),
                    context_token=context_token,
                    purpose="interactive-request",
                    message_id=message_id,
                    session_id=envelope.session_id,
                )
                if interactive_notice_sent:
                    self._remember_announced_interaction(
                        envelope.session_id,
                        pending,
                    )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="forward_interactive_request",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    title=_normalize_text(pending.get("title")),
                    interactive_request_sent=interactive_notice_sent,
                )
                if interactive_notice_sent:
                    last_failed_interaction_id = ""
                    next_interactive_notice_attempt_at = 0.0
                    last_announced_interaction_id = interaction_id or (
                        last_announced_interaction_id
                    )
                else:
                    last_failed_interaction_id = interaction_id
                    next_interactive_notice_attempt_at = (
                        now + _INTERACTIVE_NOTICE_RETRY_DELAY_SECONDS
                    )
        except asyncio.CancelledError:
            if not response_task.done():
                response_task.cancel()
                await asyncio.gather(response_task, return_exceptions=True)
            self._clear_active_backend_response_task(
                envelope.session_id,
                response_task,
            )
            raise
        except PendingInteractiveRequestError as exc:
            interactive_notice_sent = await self._try_deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=self._format_pending_interaction_text(exc.payload),
                context_token=context_token,
                purpose="interactive-request",
                message_id=message_id,
                session_id=envelope.session_id,
            )
            if interactive_notice_sent:
                self._remember_announced_interaction(
                    envelope.session_id,
                    exc.payload,
                )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="forward_interactive_request",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                title=_normalize_text(exc.payload.get("title")),
                interactive_request_sent=interactive_notice_sent,
            )
            self._record_shadow_observation(
                account=account,
                envelope=envelope,
                message_id=message_id,
                phase="interactive_request",
                duration_ms=_duration_ms_since(started_at_monotonic),
                interactive_request_sent=interactive_notice_sent,
            )
            self._clear_active_backend_response_task(
                envelope.session_id,
                response_task,
            )
            return
        except Exception as exc:
            error_category = _backend_error_category(exc)
            logger.exception(
                "Weixin background backend request failed session=%s",
                envelope.session_id,
            )
            self._forget_announced_interaction(envelope.session_id)
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="forward_failure",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                error=str(exc),
                **error_category,
            )
            self._record_shadow_observation(
                account=account,
                envelope=envelope,
                message_id=message_id,
                phase="failed",
                duration_ms=_duration_ms_since(started_at_monotonic),
                error=exc,
            )
            error_title, error_message = _user_visible_backend_error_notice(exc)
            await self._try_deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    error_title,
                    error_message,
                ),
                context_token=context_token,
                purpose="reply-error",
                message_id=message_id,
                session_id=envelope.session_id,
            )
            self._clear_active_backend_response_task(
                envelope.session_id,
                response_task,
            )
            return
        try:
            await self._deliver_backend_reply(
                account=account,
                envelope=envelope,
                reply=reply,
                context_token=context_token,
                message_id=message_id,
                response_duration_ms=_duration_ms_since(started_at_monotonic),
            )
        finally:
            self._clear_active_backend_response_task(
                envelope.session_id,
                response_task,
            )

    async def _handle_pending_interaction_message(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        pending: dict[str, Any],
        text: str,
        context_token: str | None,
        message_id: str | None,
    ) -> bool:
        interaction_id = _normalize_text(pending.get("interaction_id"))
        if not interaction_id:
            return False
        if self._is_cancel_text(text):
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="interactive_cancel_received",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                interaction_id=interaction_id,
            )
            try:
                await self._cancel_pending_interaction(interaction_id)
            except Exception as exc:
                logger.warning(
                    "Weixin cancel interaction failed session=%s interaction=%s",
                    envelope.session_id,
                    interaction_id,
                    exc_info=True,
                )
                await self._deliver_reply_text(
                    account=account,
                    to_user_id=envelope.user_id,
                    text=_md_notice(
                        "取消确认失败",
                        _md_code(exc),
                        "可以稍后重试，或发送 `/cancel` 再试一次。",
                    ),
                    context_token=context_token,
                    purpose="interactive-cancel-error",
                    message_id=message_id,
                )
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="interactive_cancel_failure",
                    user_id=envelope.user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    interaction_id=interaction_id,
                    error=_format_exception_brief(exc),
                    error_type=type(exc).__name__,
                )
                return True
            self._forget_announced_interaction(
                envelope.session_id,
                interaction_id,
            )
            await self._deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    "已取消确认",
                    "继续处理中。",
                ),
                context_token=context_token,
                purpose="interactive-cancel",
                message_id=message_id,
            )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="interactive_cancel_submitted",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                interaction_id=interaction_id,
            )
            return True
        reply_text = self._normalize_pending_interaction_reply_text(pending, text)
        try:
            await self._reply_pending_interaction(
                interaction_id,
                raw_text=reply_text,
            )
        except InteractiveReplyValidationError:
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="interactive_reply_invalid",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                interaction_id=interaction_id,
                text_preview=_preview_text(text),
                submitted_text_preview=_preview_text(reply_text),
            )
            await self._deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=self._format_pending_interaction_text(
                    pending,
                    invalid_input=True,
                ),
                context_token=context_token,
                purpose="interactive-reply-invalid",
                message_id=message_id,
            )
            return True
        except Exception as exc:
            logger.warning(
                "Weixin reply interaction failed session=%s interaction=%s",
                envelope.session_id,
                interaction_id,
                exc_info=True,
            )
            await self._deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=_md_notice(
                    "提交确认失败",
                    _md_code(exc),
                    "可以稍后重试，或发送 `/cancel` 取消这次确认。",
                ),
                context_token=context_token,
                purpose="interactive-reply-error",
                message_id=message_id,
            )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="interactive_reply_failure",
                user_id=envelope.user_id,
                message_id=message_id,
                session_id=envelope.session_id,
                interaction_id=interaction_id,
                error=_format_exception_brief(exc),
                error_type=type(exc).__name__,
            )
            return True
        self._forget_announced_interaction(
            envelope.session_id,
            interaction_id,
        )
        await self._deliver_reply_text(
            account=account,
            to_user_id=envelope.user_id,
            text=_md_notice(
                "已收到你的选择",
                "继续处理中。",
            ),
            context_token=context_token,
            purpose="interactive-reply",
            message_id=message_id,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="interactive_reply_submitted",
            user_id=envelope.user_id,
            message_id=message_id,
            session_id=envelope.session_id,
            interaction_id=interaction_id,
            text_preview=_preview_text(text),
            submitted_text_preview=_preview_text(reply_text),
        )
        await self._drain_background_exchange_after_interaction_reply(
            envelope.session_id,
        )
        return True

    async def _deliver_backend_reply(
        self,
        *,
        account: WeixinAccount,
        envelope: ChatEnvelope,
        reply: Any,
        context_token: str | None,
        message_id: str | None,
        response_duration_ms: int | None = None,
    ) -> None:
        delivery_started_at = time.monotonic()
        self._forget_announced_interaction(envelope.session_id)
        assistant_text = strip_turn_search_hint(
            str(getattr(reply, "text", "") or "").strip()
        )
        reply_metadata = getattr(reply, "metadata", {}) or {}
        if not isinstance(reply_metadata, dict):
            reply_metadata = {}
        stream_timing_ms = reply_metadata.get("stream_timing_ms")
        if not isinstance(stream_timing_ms, dict):
            stream_timing_ms = {}
        stream_error = bool(reply_metadata.get("stream_error"))
        guidance_delivered = bool(reply_metadata.get("guidance_delivered"))
        guidance_turn_id = _normalize_text(reply_metadata.get("turn_id"))
        card_payload = self._extract_transport_card(reply_metadata)
        structured_deliverables = self._extract_structured_deliverables(
            reply_metadata=reply_metadata,
        )
        reply_text = self._render_transport_reply_text(
            assistant_text=assistant_text,
            card_payload=card_payload,
        )
        sent_deliverable_paths: list[str] = []
        failed_deliverable_paths: list[str] = []
        deliverable_delivery_duration_ms: int | None = None
        if structured_deliverables:
            deliverable_delivery_started_at = time.monotonic()
            sent_deliverable_paths, failed_deliverable_paths = (
                await self._deliver_structured_files_if_any(
                    account=account,
                    to_user_id=envelope.user_id,
                    context_token=context_token,
                    session_id=envelope.session_id,
                    deliverables=structured_deliverables,
                    message_id=message_id,
                    turn_id=_normalize_text(reply_metadata.get("turn_id")),
                    delivery_id=_normalize_text(
                        dict(reply_metadata.get("transport_directives") or {}).get(
                            "delivery_id"
                        )
                    ),
                )
            )
            deliverable_delivery_duration_ms = _duration_ms_since(
                deliverable_delivery_started_at
            )
            await self._record_transport_delivery_receipts_safely(
                session_id=envelope.session_id,
                turn_id=_normalize_text(reply_metadata.get("turn_id")),
                directives=reply_metadata.get("transport_directives"),
                sent_paths=sent_deliverable_paths,
                failed_paths=failed_deliverable_paths,
            )
            accepted_count = len(sent_deliverable_paths)
            failed_count = len(failed_deliverable_paths)
            receipt_notice = format_transport_receipt_notice(
                channel_label="微信",
                accepted_count=accepted_count,
                failed_count=failed_count,
            )
            reply_text = "\n\n".join(
                part for part in (reply_text, receipt_notice) if part
            )
        if not reply_text and structured_deliverables:
            reply_text = (
                f"微信发送接口已接受 {len(sent_deliverable_paths)} 个文件；"
                "这不表示对方已读。"
            )
        if failed_deliverable_paths and not assistant_text:
            # The transfer failure notice above is authoritative. Do not send a
            # success-oriented card after the corresponding upload failed.
            reply_text = ""
        reply_text_sent: bool | None = None
        reply_text_delivery_duration_ms: int | None = None
        if reply_text or not structured_deliverables:
            reply_text_delivery_started_at = time.monotonic()
            reply_text_sent = await self._try_deliver_reply_text(
                account=account,
                to_user_id=envelope.user_id,
                text=reply_text
                or _md_notice(
                    "没有生成可发送的回复",
                    "本轮没有可展示的文本内容。",
                ),
                context_token=context_token,
                purpose="reply",
                message_id=message_id,
                session_id=envelope.session_id,
            )
            reply_text_delivery_duration_ms = _duration_ms_since(
                reply_text_delivery_started_at
            )
        delivery_total_duration_ms = _duration_ms_since(delivery_started_at)
        logger.info(
            "Weixin reply delivery timing account=%s user=%s session=%s message_id=%s backend_response_ms=%s delivery_total_ms=%s deliverable_delivery_ms=%s reply_text_delivery_ms=%s reply_text_sent=%s deliverable_count=%s deliverable_failed_count=%s stream_timing_ms=%s",
            account.account_id,
            envelope.user_id,
            envelope.session_id,
            message_id,
            response_duration_ms,
            delivery_total_duration_ms,
            deliverable_delivery_duration_ms,
            reply_text_delivery_duration_ms,
            reply_text_sent,
            len(structured_deliverables),
            len(failed_deliverable_paths),
            stream_timing_ms,
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event=(
                "guidance_delivered"
                if guidance_delivered
                and not (
                    failed_deliverable_paths
                    or reply_text_sent is False
                    or (stream_error and not structured_deliverables)
                )
                else
                "forward_partial_success"
                if (
                    failed_deliverable_paths
                    or reply_text_sent is False
                    or (stream_error and not structured_deliverables)
                )
                else "forward_success"
            ),
            user_id=envelope.user_id,
            message_id=message_id,
            session_id=envelope.session_id,
            turn_id=guidance_turn_id,
            guidance_delivered=guidance_delivered,
            reply_preview=_preview_text(reply_text or assistant_text),
            deliverable_count=len(structured_deliverables),
            deliverable_paths=[item.path for item in structured_deliverables],
            deliverable_sent_count=len(sent_deliverable_paths),
            deliverable_sent_paths=sent_deliverable_paths,
            deliverable_failed_count=len(failed_deliverable_paths),
            deliverable_failed_paths=failed_deliverable_paths,
            reply_text_sent=reply_text_sent,
            backend_response_duration_ms=response_duration_ms,
            reply_delivery_duration_ms=delivery_total_duration_ms,
            deliverable_delivery_duration_ms=deliverable_delivery_duration_ms,
            reply_text_delivery_duration_ms=reply_text_delivery_duration_ms,
            backend_stream_timing_ms=stream_timing_ms,
            stream_error=stream_error,
            stopped=bool(reply_metadata.get("stopped")),
        )
        self._record_shadow_observation(
            account=account,
            envelope=envelope,
            message_id=message_id,
            phase=(
                "partial_success"
                if (
                    failed_deliverable_paths
                    or reply_text_sent is False
                    or (stream_error and not structured_deliverables)
                )
                else "completed"
            ),
            duration_ms=response_duration_ms,
            reply_metadata=reply_metadata,
            reply_text_sent=reply_text_sent,
            deliverable_count=len(structured_deliverables),
            deliverable_sent_count=len(sent_deliverable_paths),
            deliverable_failed_count=len(failed_deliverable_paths),
        )

    async def _deliver_structured_files_if_any(
        self,
        *,
        account: WeixinAccount,
        to_user_id: str,
        context_token: str | None,
        session_id: str,
        deliverables: list[_StructuredDeliverable],
        message_id: str | None,
        schedule_retry_on_failure: bool = True,
        notify_on_failure: bool = True,
        turn_id: str = "",
        delivery_id: str = "",
    ) -> tuple[list[str], list[str]]:
        if not deliverables:
            return [], []
        sent_paths: list[str] = []
        failed_paths: list[str] = []
        failed_items: list[_StructuredDeliverable] = []
        failure_messages: list[str] = []
        for item in deliverables[:_DELIVERABLE_TRANSFER_MAX_FILES]:
            media_kind = ""
            last_error = ""
            last_error_type = ""
            for attempt in range(1, _SEND_DELIVERABLE_MAX_ATTEMPTS + 1):
                # Preserve the media type selected by the transport client. If a
                # deployment rejects native media, later retries use the generic
                # file channel as a capability fallback rather than a default.
                force_file_kind = attempt > 1
                try:
                    media_kind = await self._client.send_path(
                        base_url=account.base_url,
                        token=account.token,
                        to_user_id=to_user_id,
                        file_path=item.path,
                        context_token=self._latest_context_token(
                            account.account_id,
                            to_user_id,
                            context_token,
                        ),
                        caption="",
                        force_file_kind=force_file_kind,
                    )
                    sent_paths.append(item.path)
                    self._record_runtime_trace_event(
                        account_id=account.account_id,
                        event="structured_deliverable_transfer_success",
                        user_id=to_user_id,
                        message_id=message_id,
                        session_id=session_id,
                        path=item.path,
                        media_kind=media_kind,
                        attempt=attempt,
                        force_file_kind=force_file_kind,
                    )
                    break
                except Exception as exc:
                    last_error = _format_exception_brief(exc)
                    last_error_type = type(exc).__name__
                    logger.warning(
                        "Weixin structured deliverable transfer failed: session_id=%s message_id=%s path=%s attempt=%d/%d force_file_kind=%s error_type=%s error=%r",
                        session_id,
                        message_id,
                        item.path,
                        attempt,
                        _SEND_DELIVERABLE_MAX_ATTEMPTS,
                        force_file_kind,
                        last_error_type,
                        last_error,
                        exc_info=True,
                    )
                    if attempt < _SEND_DELIVERABLE_MAX_ATTEMPTS:
                        retry_delay = self._compute_backoff_delay(
                            attempt,
                            base_seconds=_SEND_DELIVERABLE_RETRY_DELAY_SECONDS,
                            max_seconds=_SEND_DELIVERABLE_RETRY_MAX_DELAY_SECONDS,
                        )
                        await asyncio.sleep(retry_delay)
            else:
                failed_paths.append(item.path)
                failed_items.append(item)
                failure_messages.append(last_error)
                self._record_runtime_trace_event(
                    account_id=account.account_id,
                    event="structured_deliverable_transfer_failure",
                    user_id=to_user_id,
                    message_id=message_id,
                    session_id=session_id,
                    path=item.path,
                    error=last_error,
                    error_type=last_error_type,
                    attempts=_SEND_DELIVERABLE_MAX_ATTEMPTS,
                )
        if sent_paths:
            logger.info(
                "Weixin structured deliverables transferred: session_id=%s message_id=%s count=%d paths=%s",
                session_id,
                message_id,
                len(sent_paths),
                sent_paths,
            )
        if failed_paths:
            logger.warning(
                "Weixin structured deliverables transfer incomplete: session_id=%s message_id=%s failed_count=%d failed_paths=%s",
                session_id,
                message_id,
                len(failed_paths),
                failed_paths,
            )
            scheduled_retry = None
            if schedule_retry_on_failure:
                scheduled_retry = self._schedule_deliverable_transfer_retry(
                    account=account,
                    to_user_id=to_user_id,
                    session_id=session_id,
                    deliverables=failed_items,
                    message_id=message_id,
                    failure_messages=failure_messages,
                    turn_id=turn_id,
                    delivery_id=delivery_id,
                )
            if notify_on_failure:
                try:
                    await self._deliver_reply_text(
                        account=account,
                        to_user_id=to_user_id,
                        text=self._build_deliverable_transfer_failure_notice(
                            failed_paths=failed_paths,
                            failure_messages=failure_messages,
                            scheduled_retry=scheduled_retry is not None,
                        ),
                        context_token=context_token,
                        purpose="deliverable-transfer-failure",
                        message_id=message_id,
                    )
                except Exception as exc:
                    logger.warning(
                        "Weixin deliverable failure notice failed: session_id=%s message_id=%s error_type=%s error=%r",
                        session_id,
                        message_id,
                        type(exc).__name__,
                        _format_exception_brief(exc),
                        exc_info=True,
                    )
        return sent_paths, failed_paths

    async def _record_transport_delivery_receipts_safely(
        self,
        *,
        session_id: str,
        turn_id: str,
        directives: object,
        sent_paths: list[str],
        failed_paths: list[str],
    ) -> None:
        if not isinstance(directives, dict):
            return
        delivery_id = _normalize_text(directives.get("delivery_id"))
        callback = getattr(self._backend, "record_transport_delivery_receipts", None)
        if not delivery_id or not turn_id or not callable(callback):
            return
        results = [
            {"path": path, "state": "accepted_by_transport", "attempt_count": 1}
            for path in sent_paths
        ] + [
            {
                "path": path,
                "state": "failed",
                "attempt_count": _SEND_DELIVERABLE_MAX_ATTEMPTS,
                "error_code": "adapter_send_failed",
            }
            for path in failed_paths
        ]
        if not results:
            return
        try:
            await callback(
                session_id=session_id,
                turn_id=turn_id,
                delivery_id=delivery_id,
                channel="weixin",
                results=results,
            )
        except Exception as exc:
            logger.warning(
                "Weixin transport receipt callback failed: session_id=%s turn_id=%s delivery_id=%s error=%s",
                session_id,
                turn_id,
                delivery_id,
                _format_exception_brief(exc),
                exc_info=True,
            )

    def _schedule_deliverable_transfer_retry(
        self,
        *,
        account: WeixinAccount,
        to_user_id: str,
        session_id: str,
        deliverables: list[_StructuredDeliverable],
        message_id: str | None,
        failure_messages: list[str],
        turn_id: str = "",
        delivery_id: str = "",
    ) -> ScheduledDeliveryJob | None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id or not deliverables:
            return None
        payload = [
            {
                "path": item.path,
                "caption": item.caption,
                "label": item.label,
            }
            for item in deliverables[:_DELIVERABLE_TRANSFER_MAX_FILES]
            if str(item.path or "").strip()
        ]
        if not payload:
            return None
        execute_at = datetime.now().astimezone() + timedelta(
            seconds=max(1.0, _SCHEDULED_DELIVERY_RETRY_DELAY_SECONDS)
        )
        job = self._scheduled_delivery_store.create_job(
            session_id=normalized_session_id,
            user_id=to_user_id,
            channel_id=account.account_id,
            platform="weixin",
            mode="deliver_prepared",
            execute_at=execute_at,
            task_text=(
                "retry weixin deliverable transfer "
                f"message_id={message_id or ''}"
            ).strip(),
            reply_text="",
            deliverables=payload,
            transport_channel="weixin",
            created_turn_id=turn_id,
            transport_delivery_id=delivery_id,
            max_attempts=_SEND_DELIVERABLE_SCHEDULED_RETRY_MAX_ATTEMPTS,
        )
        logger.warning(
            "Weixin deliverable transfer scheduled retry account=%s user=%s message_id=%s session_id=%s job_id=%s failed_paths=%s",
            account.account_id,
            to_user_id,
            message_id,
            normalized_session_id,
            job.job_id,
            [item.get("path") for item in payload],
        )
        self._record_runtime_trace_event(
            account_id=account.account_id,
            event="structured_deliverable_scheduled_retry",
            user_id=to_user_id,
            message_id=message_id,
            session_id=normalized_session_id,
            job_id=job.job_id,
            failed_paths=[item.get("path") for item in payload],
            failure_messages=[
                str(item or "").strip()
                for item in failure_messages[:_DELIVERABLE_TRANSFER_MAX_FILES]
            ],
        )
        return job

    @staticmethod
    def _build_deliverable_transfer_failure_notice(
        *,
        failed_paths: list[str],
        failure_messages: list[str],
        scheduled_retry: bool = False,
    ) -> str:
        failure_bullets: list[str] = []
        for index, path in enumerate(failed_paths[:_DELIVERABLE_TRANSFER_MAX_FILES]):
            file_name = Path(path).name or path
            error = (
                str(failure_messages[index] if index < len(failure_messages) else "")
                .strip()
            )
            failure_bullets.append(f"{file_name}: {error}" if error else file_name)
        return _md_notice(
            "文件发送未完成",
            (
                "文件已经在本地生成，但微信上传/发送失败；系统已安排后台自动重试。也可以先到本机路径取文件。"
                if scheduled_retry
                else "文件已经在本地生成，但微信上传/发送失败。可以稍后重试，或先到本机路径取文件。"
            ),
            "本地路径：",
            bullets=[
                str(path) for path in failed_paths[:_DELIVERABLE_TRANSFER_MAX_FILES]
            ],
        ) + (
            "\n\n**失败原因**\n"
            + "\n".join(f"- {item}" for item in failure_bullets if item)
            if failure_bullets
            else ""
        )

    @staticmethod
    def _extract_transport_card(reply_metadata: dict[str, Any]) -> dict[str, Any] | None:
        transport_directives = reply_metadata.get("transport_directives")
        if not isinstance(transport_directives, dict):
            return None
        card = transport_directives.get("card")
        if not isinstance(card, dict):
            return None
        return dict(card)

    def _extract_structured_deliverables(
        self,
        *,
        reply_metadata: dict[str, Any],
    ) -> list[_StructuredDeliverable]:
        transport_directives = reply_metadata.get("transport_directives")
        if not isinstance(transport_directives, dict):
            return []
        raw_deliverables = transport_directives.get("deliverables")
        if not isinstance(raw_deliverables, list):
            return []
        deliverables: list[_StructuredDeliverable] = []
        seen: set[str] = set()
        for raw_item in raw_deliverables:
            if isinstance(raw_item, str):
                raw_item = {"path": raw_item}
            if not isinstance(raw_item, dict):
                continue
            normalized = self._normalize_path_candidate(raw_item.get("path") or "")
            if not normalized:
                continue
            try:
                resolved = Path(normalized).expanduser().resolve(strict=False)
            except Exception:
                continue
            if not resolved.exists() or not resolved.is_file():
                continue
            resolved_text = str(resolved)
            if resolved_text in seen:
                continue
            seen.add(resolved_text)
            deliverables.append(
                _StructuredDeliverable(
                    path=resolved_text,
                    caption=str(raw_item.get("caption") or "").strip(),
                    label=str(raw_item.get("label") or "").strip(),
                )
            )
        return deliverables[:_DELIVERABLE_TRANSFER_MAX_FILES]

    @classmethod
    def _render_transport_reply_text(
        cls,
        *,
        assistant_text: str,
        card_payload: dict[str, Any] | None,
    ) -> str:
        normalized_assistant_text = str(assistant_text or "").strip()
        if normalized_assistant_text:
            return normalized_assistant_text
        if not isinstance(card_payload, dict):
            return ""
        lines: list[str] = []
        title = _normalize_text(card_payload.get("title"))
        summary = _normalize_text(card_payload.get("summary"))
        body = _normalize_text(card_payload.get("body"))
        footer = _normalize_text(card_payload.get("footer"))
        bullets = [
            _normalize_text(item)
            for item in list(card_payload.get("bullets") or [])
            if _normalize_text(item)
        ]
        if title:
            lines.append(f"**{title}**")
        if summary:
            lines.append(summary)
        elif body:
            lines.append(body)
        if body and body not in lines and f"**{body}**" not in lines:
            lines.append(body)
        for item in bullets[:6]:
            lines.append(f"- {item}")
        if footer:
            lines.append(footer)
        rendered = "\n".join(line for line in lines if line).strip()
        return rendered

    async def _deliver_reply_text(
        self,
        *,
        account: WeixinAccount,
        to_user_id: str,
        text: str,
        context_token: str | None,
        purpose: str,
        message_id: str | None,
        session_id: str | None = None,
    ) -> bool:
        return await self._send_text_with_retry(
            account=account,
            base_url=account.base_url,
            token=account.token,
            to_user_id=to_user_id,
            text=text,
            context_token=self._latest_context_token(
                account.account_id,
                to_user_id,
                context_token,
            ),
            purpose=purpose,
            message_id=message_id,
            session_id=session_id,
            schedule_on_final_failure=True,
        )

    async def _try_deliver_reply_text(
        self,
        *,
        account: WeixinAccount,
        to_user_id: str,
        text: str,
        context_token: str | None,
        purpose: str,
        message_id: str | None,
        session_id: str | None = None,
    ) -> bool:
        try:
            sent = await self._deliver_reply_text(
                account=account,
                to_user_id=to_user_id,
                text=text,
                context_token=context_token,
                purpose=purpose,
                message_id=message_id,
                session_id=session_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Weixin reply text delivery failed account=%s user=%s purpose=%s message_id=%s error_type=%s error=%r",
                account.account_id,
                to_user_id,
                purpose,
                message_id,
                type(exc).__name__,
                _format_exception_brief(exc),
                exc_info=True,
            )
            self._record_runtime_trace_event(
                account_id=account.account_id,
                event="send_text_delivery_failure",
                user_id=to_user_id,
                message_id=message_id,
                session_id=session_id,
                purpose=purpose,
                error=_format_exception_brief(exc),
                error_type=type(exc).__name__,
            )
            return False
        return sent

    def _latest_context_token(
        self,
        account_id: str,
        user_id: str,
        fallback: str | None,
    ) -> str | None:
        return self._state.get_context_token(account_id, user_id) or fallback

    async def _load_pending_interaction(
        self,
        session_id: str,
    ) -> dict[str, Any] | None:
        loader = getattr(self._backend, "get_pending_interaction", None)
        if not callable(loader):
            return None
        try:
            pending = await loader(session_id)
        except Exception:
            logger.debug(
                "Weixin pending interaction lookup failed session=%s",
                session_id,
                exc_info=True,
            )
            return None
        if not isinstance(pending, dict):
            return None
        return dict(pending)

    def _remember_announced_interaction(
        self,
        session_id: str,
        pending: dict[str, Any],
    ) -> None:
        normalized_session_id = _normalize_text(session_id)
        interaction_id = _normalize_text(pending.get("interaction_id"))
        if not normalized_session_id or not interaction_id:
            return
        self._announced_interactions[normalized_session_id] = {
            "pending": dict(pending),
            "saved_at": time.monotonic(),
        }

    def _cached_announced_interaction(
        self,
        session_id: str,
    ) -> dict[str, Any] | None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return None
        entry = self._announced_interactions.get(normalized_session_id)
        if not isinstance(entry, dict):
            return None
        saved_at = float(entry.get("saved_at") or 0.0)
        if time.monotonic() - saved_at > _ANNOUNCED_INTERACTION_TTL_SECONDS:
            self._announced_interactions.pop(normalized_session_id, None)
            return None
        pending = entry.get("pending")
        if not isinstance(pending, dict):
            self._announced_interactions.pop(normalized_session_id, None)
            return None
        return dict(pending)

    def _forget_announced_interaction(
        self,
        session_id: str,
        interaction_id: str | None = None,
    ) -> None:
        normalized_session_id = _normalize_text(session_id)
        if not normalized_session_id:
            return
        if interaction_id:
            cached = self._cached_announced_interaction(normalized_session_id)
            cached_id = _normalize_text((cached or {}).get("interaction_id"))
            if cached_id and cached_id != _normalize_text(interaction_id):
                return
        self._announced_interactions.pop(normalized_session_id, None)

    async def _reply_pending_interaction(
        self,
        interaction_id: str,
        *,
        raw_text: str,
    ) -> None:
        reply_method = getattr(self._backend, "reply_interaction", None)
        if not callable(reply_method):
            raise RuntimeError("backend does not support interactive replies")
        await reply_method(interaction_id, raw_text=raw_text)

    async def _cancel_pending_interaction(self, interaction_id: str) -> None:
        cancel_method = getattr(self._backend, "cancel_interaction", None)
        if not callable(cancel_method):
            raise RuntimeError("backend does not support interactive cancellation")
        await cancel_method(interaction_id)

    @classmethod
    def _format_pending_interaction_text(
        cls,
        pending: dict[str, Any],
        *,
        invalid_input: bool = False,
    ) -> str:
        if _normalize_text(pending.get("type")) == "path_permission_request":
            return cls._format_permission_interaction_text(
                pending,
                invalid_input=invalid_input,
            )
        text = format_pending_interaction_text(
            pending,
            invalid_input=invalid_input,
        )
        lines = [line.rstrip() for line in text.splitlines()]
        for index, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if not stripped.startswith("**"):
                lines[index] = f"**{stripped}**"
            break
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("原因："):
                lines[index] = f"**原因**：{stripped.removeprefix('原因：')}"
        return "\n".join(lines).strip()

    @classmethod
    def _format_permission_interaction_text(
        cls,
        pending: dict[str, Any],
        *,
        invalid_input: bool = False,
    ) -> str:
        heading = "授权没识别成功" if invalid_input else "需要你确认授权"
        lines = [f"**{heading}**", ""]
        reason = cls._permission_reason_text(pending)
        if reason:
            lines.append(f"**原因**：{reason}")
        title = _normalize_text(pending.get("title"))
        if title and _normalize_match_text(title) != _normalize_match_text(reason):
            lines.append(f"**事项**：{title}")
        lines.append("")
        lines.append("回复 `1` 授权，回复 `2` 拒绝。")
        return "\n".join(line for line in lines if line is not None).strip()

    @staticmethod
    def _permission_reason_text(pending: dict[str, Any]) -> str:
        preview = pending.get("permission_preview")
        preview_reason = ""
        if isinstance(preview, dict):
            preview_reason = _normalize_text(preview.get("reason"))
        return (
            _normalize_text(pending.get("reason"))
            or preview_reason
            or _normalize_text(pending.get("description"))
            or _normalize_text(pending.get("title"))
            or "这一步需要临时授权才能继续。"
        )

    @classmethod
    def _normalize_pending_interaction_reply_text(
        cls,
        pending: dict[str, Any],
        text: str,
    ) -> str:
        if _normalize_text(pending.get("type")) != "path_permission_request":
            return text
        normalized = _normalize_match_text(text)
        if not normalized:
            return text
        option_ids = cls._pending_permission_option_ids(pending)
        allow_session_id = cls._first_permission_option_id(
            option_ids,
            preferred=("allow_session",),
            contains=("session", "会话"),
        )
        allow_once_id = cls._first_permission_option_id(
            option_ids,
            preferred=("allow_once",),
            contains=("allow", "允许", "同意"),
        )
        deny_id = cls._first_permission_option_id(
            option_ids,
            preferred=("deny",),
            contains=("deny", "拒绝", "不允许"),
        )
        if normalized in _PERMISSION_ALLOW_SESSION_TOKENS and allow_session_id:
            return allow_session_id
        if normalized in _PERMISSION_ALLOW_TOKENS and allow_once_id:
            return allow_once_id
        if normalized in _PERMISSION_DENY_TOKENS and deny_id:
            return deny_id
        return text

    @staticmethod
    def _pending_permission_option_ids(pending: dict[str, Any]) -> list[str]:
        option_ids: list[str] = []
        for raw_question in list(pending.get("questions") or []):
            if not isinstance(raw_question, dict):
                continue
            for raw_option in list(raw_question.get("options") or []):
                if not isinstance(raw_option, dict):
                    continue
                option_id = _normalize_text(raw_option.get("id"))
                if option_id:
                    option_ids.append(option_id)
        return option_ids

    @staticmethod
    def _first_permission_option_id(
        option_ids: list[str],
        *,
        preferred: tuple[str, ...],
        contains: tuple[str, ...],
    ) -> str:
        normalized_options = [
            (_normalize_match_text(option_id), option_id) for option_id in option_ids
        ]
        for preferred_id in preferred:
            normalized_preferred = _normalize_match_text(preferred_id)
            for normalized_option, option_id in normalized_options:
                if normalized_option == normalized_preferred:
                    return option_id
        for normalized_option, option_id in normalized_options:
            if any(item in normalized_option for item in contains):
                return option_id
        return ""

    async def _cache_pending_attachment(
        self,
        *,
        session_id: str,
        kind: str,
        name: str | None,
        path: str,
        message_id: str | None,
    ) -> int:
        now = time.monotonic()
        entry = _PendingAttachment(
            kind=str(kind or "").strip() or FILE_KIND,
            name=str(name or "").strip() or None,
            path=str(path or "").strip(),
            message_id=str(message_id or "").strip() or None,
            created_at=now,
        )
        async with self._pending_attachments_lock:
            self._cleanup_expired_pending_attachments_locked(now=now)
            bucket = self._pending_attachments.setdefault(session_id, [])
            bucket.append(entry)
            if len(bucket) > _PENDING_ATTACHMENTS_MAX_ITEMS:
                del bucket[:-_PENDING_ATTACHMENTS_MAX_ITEMS]
            return len(bucket)

    async def _get_pending_attachment_context(
        self,
        *,
        session_id: str,
    ) -> list[dict[str, Any]]:
        now = time.monotonic()
        async with self._pending_attachments_lock:
            self._cleanup_expired_pending_attachments_locked(now=now)
            bucket = self._pending_attachments.get(session_id) or []
            return [
                {
                    "kind": item.kind,
                    "name": item.name,
                    "path": item.path,
                    "message_id": item.message_id,
                }
                for item in bucket
            ]

    async def _clear_pending_attachments(self, *, session_id: str) -> None:
        async with self._pending_attachments_lock:
            self._pending_attachments.pop(session_id, None)

    def _cleanup_expired_pending_attachments_locked(self, *, now: float) -> None:
        expired_before = now - _PENDING_ATTACHMENTS_TTL_SECONDS
        stale_sessions: list[str] = []
        for session_id, bucket in self._pending_attachments.items():
            kept = [item for item in bucket if item.created_at >= expired_before]
            if kept:
                self._pending_attachments[session_id] = kept[
                    -_PENDING_ATTACHMENTS_MAX_ITEMS :
                ]
            else:
                stale_sessions.append(session_id)
        for session_id in stale_sessions:
            self._pending_attachments.pop(session_id, None)

    @staticmethod
    def _merge_user_text_with_attachments(
        *,
        text: str,
        attachments: list[dict[str, Any]],
    ) -> str:
        plain_text = str(text or "").strip()
        if not attachments:
            return plain_text
        lines = [
            "【本会话附件上下文】",
            "以下附件是用户刚发送的，请结合这些本地路径一起处理。",
        ]
        for index, item in enumerate(attachments, start=1):
            kind = str(item.get("kind", "") or "").strip().lower()
            label = {
                IMAGE_KIND: "图片",
                VIDEO_KIND: "视频",
                "voice": "语音",
            }.get(kind, "文件")
            name = str(item.get("name", "") or "").strip() or "(未命名)"
            path = str(item.get("path", "") or "").strip()
            lines.append(f"{index}. {label}: {name}")
            if path:
                lines.append(f"   路径: {path}")
        lines.append("")
        lines.append("【用户文字指令】")
        lines.append(plain_text or "(空)")
        return "\n".join(lines).strip()

    @staticmethod
    def _inject_pending_attachments(
        *,
        raw_event: dict[str, Any],
        attachments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not attachments:
            return dict(raw_event or {})
        payload = dict(raw_event or {})
        payload["cached_attachments"] = attachments
        return payload

    @staticmethod
    def _build_resource_ack_text(
        *,
        attachments: list[dict[str, str]],
        pending_total: int,
    ) -> str:
        if not attachments:
            return _md_notice(
                "附件保存失败",
                "已收到附件，但暂时没能保存，请稍后重试。",
            )
        if len(attachments) == 1:
            attachment = attachments[0]
            kind = str(attachment.get("kind", "") or "").strip().lower()
            label = {
                IMAGE_KIND: "图片",
                VIDEO_KIND: "视频",
                "voice": "语音",
            }.get(kind, "文件")
            display_name = str(attachment.get("name", "") or "").strip()
            display_path = str(attachment.get("path", "") or "").strip()
            bullets = ["状态：已保存", f"类型：{label}"]
            if display_name:
                bullets.append(f"名称：{_md_code(display_name)}")
            if display_path:
                bullets.append(f"路径：{_md_code(display_path)}")
            if pending_total > 0:
                bullets.append(f"当前待处理附件：{pending_total} 个")
            return _md_notice(
                f"已收到{label}",
                "请继续发送文字指令，我会结合这个附件一起处理。",
                bullets=bullets,
            )
        lines = [
            _md_notice(
                f"已收到 {len(attachments)} 个附件",
                (
                    f"当前待处理附件：{pending_total} 个"
                    if pending_total > 0
                    else "附件已保存。"
                ),
            )
        ]
        for index, attachment in enumerate(attachments, start=1):
            name = str(attachment.get("name", "") or "").strip() or "(未命名)"
            path = str(attachment.get("path", "") or "").strip()
            lines.append(f"{index}. {_md_code(name)}")
            if path:
                lines.append(f"   路径：{_md_code(path)}")
        lines.append("")
        lines.append("请继续发送文字指令，我会结合这些附件一起处理。")
        return "\n".join(lines)

    @staticmethod
    def _normalize_path_candidate(raw_path: str) -> str:
        candidate = str(raw_path or "").strip()
        if not candidate:
            return ""
        candidate = candidate.rstrip(_DELIVERABLE_PATH_TRAILING).strip()
        if not candidate:
            return ""
        if not (
            candidate.startswith("/")
            or candidate.startswith("~")
            or re.match(r"^[A-Za-z]:[\\/]", candidate)
        ):
            return ""
        return candidate

    @staticmethod
    def _default_attachment_name(
        *,
        kind: str,
        message_id: str | None,
        index: int,
        mime_type: str | None,
    ) -> str:
        suffix = Path(
            mimetypes.guess_extension(str(mime_type or "").strip().lower()) or ""
        ).suffix
        if not suffix:
            suffix = {
                IMAGE_KIND: ".png",
                VIDEO_KIND: ".mp4",
                "voice": ".silk",
            }.get(str(kind or "").strip().lower(), ".bin")
        stem = str(message_id or "").strip() or f"attachment-{index}"
        return f"{stem}-{index}{suffix}"

    @staticmethod
    def _allocate_target_file_path(
        *,
        target_dir: Path,
        file_name: str | None,
    ) -> Path:
        raw_name = Path(str(file_name or "").strip()).name
        if not raw_name:
            raw_name = "attachment.bin"
        candidate = target_dir / raw_name
        if not candidate.exists():
            return candidate
        stem = candidate.stem or "attachment"
        suffix = candidate.suffix
        index = 1
        while True:
            next_candidate = target_dir / f"{stem}_{index}{suffix}"
            if not next_candidate.exists():
                return next_candidate
            index += 1

    @staticmethod
    def _is_cancel_text(text: str) -> bool:
        return _normalize_match_text(text) in {
            _normalize_match_text(item)
            for item in _CANCEL_TOKENS
        }

    @classmethod
    def _looks_like_interactive_reply_text(cls, text: str) -> bool:
        normalized = _normalize_match_text(text)
        if not normalized:
            return False
        if cls._is_cancel_text(normalized):
            return True
        if re.fullmatch(r"[1-9]", normalized):
            return True
        return normalized in {
            "允许",
            "允许一次",
            "本会话允许",
            "拒绝",
            "同意",
            "不同意",
            "确认",
            "继续",
            "可以",
            "allow",
            "allow once",
            "allow session",
            "deny",
            "yes",
            "no",
            "ok",
        }

    @staticmethod
    def _question_accepts_input(question: dict[str, Any]) -> bool:
        selection_mode = _normalize_match_text(question.get("selection_mode"))
        if selection_mode == "input":
            return True
        if selection_mode in {"single_with_input", "multi_with_input"}:
            return True
        return bool(question.get("allow_input"))

    async def _send_text_with_retry(
        self,
        *,
        account: WeixinAccount,
        base_url: str,
        token: str,
        to_user_id: str,
        text: str,
        context_token: str | None,
        purpose: str,
        message_id: str | None,
        session_id: str | None = None,
        schedule_on_final_failure: bool = False,
    ) -> bool:
        last_error: Exception | None = None
        for attempt in range(1, _SEND_TEXT_MAX_ATTEMPTS + 1):
            try:
                await self._client.send_text(
                    base_url=base_url,
                    token=token,
                    to_user_id=to_user_id,
                    text=text,
                    context_token=context_token,
                )
                if attempt > 1:
                    logger.info(
                        "Weixin send_text recovered account=%s user=%s purpose=%s attempt=%s/%s message_id=%s",
                        account.account_id,
                        to_user_id,
                        purpose,
                        attempt,
                        _SEND_TEXT_MAX_ATTEMPTS,
                        message_id,
                    )
                return True
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Weixin send_text failed account=%s user=%s purpose=%s attempt=%s/%s message_id=%s error_type=%s error=%r",
                    account.account_id,
                    to_user_id,
                    purpose,
                    attempt,
                    _SEND_TEXT_MAX_ATTEMPTS,
                    message_id,
                    type(exc).__name__,
                    exc,
                )
                await self._reset_client_connections_after_request_error(
                    account=account,
                    purpose=purpose,
                    attempt=attempt,
                    error=exc,
                )
                if attempt >= _SEND_TEXT_MAX_ATTEMPTS:
                    break
                retry_delay = self._compute_backoff_delay(
                    attempt,
                    base_seconds=_SEND_TEXT_RETRY_DELAY_SECONDS,
                    max_seconds=_SEND_TEXT_RETRY_MAX_DELAY_SECONDS,
                )
                await asyncio.sleep(retry_delay)
        assert last_error is not None
        if schedule_on_final_failure:
            job = self._schedule_text_delivery_retry(
                account=account,
                to_user_id=to_user_id,
                text=text,
                purpose=purpose,
                message_id=message_id,
                session_id=session_id,
                error=last_error,
            )
            if job is not None:
                return False
        raise last_error
