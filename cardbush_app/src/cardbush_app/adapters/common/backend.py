from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from cardbush_app.network import (
    apply_service_auth_headers,
    build_httpx_async_client,
    build_local_api_base_url,
    is_loopback_url,
)

from .interactive_text import format_pending_interaction_text
from .models import ChatEnvelope, ChatReply
from .session_links import SessionLinkKey, SessionLinkStore

logger = logging.getLogger(__name__)
DEFAULT_STREAM_SERVICE_BASE_URL = build_local_api_base_url()
_INTERACTION_CANCEL_TOKENS = frozenset(
    {"取消", "取消本次", "cancel", "/cancel", "算了", "不用了", "先不继续"}
)

class PendingInteractiveRequestError(RuntimeError):
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = dict(payload or {})
        message = str(
            self.payload.get("message")
            or self.payload.get("title")
            or "session is waiting for interactive input"
        ).strip() or "session is waiting for interactive input"
        super().__init__(message)


class InteractiveReplyValidationError(RuntimeError):
    def __init__(self, detail: str) -> None:
        self.detail = str(detail or "").strip() or "interactive reply validation failed"
        super().__init__(self.detail)


class ModelAuthenticationError(RuntimeError):
    category = "model_authentication"

    def __init__(self, message: str, *, provider: str | None = None) -> None:
        self.provider = provider
        self.message = str(message or "").strip() or "model authentication failed"
        super().__init__(self.message)


class ModelConnectionError(RuntimeError):
    category = "model_connection"

    def __init__(self, message: str, *, provider: str | None = None) -> None:
        self.provider = provider
        self.message = str(message or "").strip() or "model connection failed"
        super().__init__(self.message)


class ModelRateLimitError(RuntimeError):
    category = "model_rate_limit"

    def __init__(self, message: str, *, provider: str | None = None) -> None:
        self.provider = provider
        self.message = str(message or "").strip() or "model rate limit exceeded"
        super().__init__(self.message)


def _as_optional_int(value: str | None) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _as_optional_resolved_path(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return str(Path(text).expanduser().resolve(strict=False))


def _as_bool(value: object, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if not text:
        return bool(default)
    return text not in {"0", "false", "no", "off"}


def _elapsed_ms(started_at: float | None) -> int | None:
    if started_at is None:
        return None
    return max(0, int((time.perf_counter() - started_at) * 1000))


def _infer_model_auth_provider(message: str) -> str | None:
    lowered = str(message or "").lower()
    providers = (
        "deepseek",
        "volcengine",
        "minimax",
        "openai",
        "anthropic",
        "gemini",
        "google",
        "azure",
    )
    for provider in providers:
        if provider in lowered:
            return provider
    return None


def _looks_like_model_authentication_error(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    auth_markers = (
        "api key",
        "apikey",
        "authentication",
        "unauthorized",
        "invalid key",
        "key invalid",
        "invalid api",
        "invalid token",
        "permission denied",
        "401",
        "403",
    )
    model_markers = (
        "model",
        "llm",
        "openai",
        "deepseek",
        "anthropic",
        "gemini",
        "volcengine",
        "minimax",
        "litellm",
    )
    return any(marker in lowered for marker in auth_markers) and any(
        marker in lowered for marker in model_markers
    )


def _looks_like_model_rate_limit_error(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "ratelimiterror",
            "rate limit",
            "rate_limit",
            "quota",
            "usage quota",
            "insufficient balance",
            "payment required",
            "billing",
            "balance",
            "too many requests",
            "402",
            "429",
        )
    ) and any(
        marker in lowered
        for marker in (
            "model",
            "llm",
            "litellm",
            "openai",
            "deepseek",
            "volcengine",
            "minimax",
        )
    )


def _looks_like_model_connection_error(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "connection error",
            "apiconnectionerror",
            "server disconnected",
            "service has some internal error",
            "internalservererror",
            "volcengineexception",
            "deepseekexception",
            "openaierror",
            "litellm.internalservererror",
        )
    ) and any(
        marker in lowered
        for marker in (
            "model",
            "llm",
            "litellm",
            "openai",
            "deepseek",
            "volcengine",
            "minimax",
        )
    )


class ConversationBackend(Protocol):
    async def respond(self, envelope: ChatEnvelope) -> ChatReply: ...


@dataclass(slots=True)
class BushServerStreamSettings:
    service_base_url: str = DEFAULT_STREAM_SERVICE_BASE_URL
    auth_token: str | None = None
    api_key: str | None = None
    model: str | None = None
    provider: str | None = None
    llm_base_url: str | None = None
    prompt_language: str | None = None
    workspace_dir: str | None = None
    project_dir: str | None = None
    workspace_mode: str | None = None
    permission_mode: str = "task_free"
    tool_calling_enabled: bool = True
    subagent_enabled: bool = True
    allowed_skills: list[str] | None = None
    disabled_tools: list[str] | None = None
    timeout_seconds: float = 1800.0
    history_word_trigger_single_message: int | None = None
    history_word_trigger_session_total: int | None = None
    history_word_trigger_summary: int | None = None
    tool_deadlock_consecutive_failures: int | None = None
    guidance_for_active_turns: bool = True
    session_link_store_path: str | None = None

    @classmethod
    def from_env(cls) -> "BushServerStreamSettings":
        allowed_skills_raw = str(os.getenv("CARDBUSH_BOT_STREAM_ALLOWED_SKILLS", "") or "").strip()
        allowed_skills = [item.strip() for item in allowed_skills_raw.split(",") if item.strip()] or None
        disabled_tools_raw = str(
            os.getenv("CARDBUSH_BOT_STREAM_DISABLED_TOOLS", "") or ""
        ).strip()
        disabled_tools = [
            item.strip() for item in disabled_tools_raw.split(",") if item.strip()
        ] or None
        use_backend_model_default = (
            str(os.getenv("CARDBUSH_BOT_STREAM_MODEL_SOURCE", "") or "")
            .strip()
            .lower()
            in {"backend_default", "default_slot", "model_config_default"}
        )
        return cls(
            service_base_url=str(
                os.getenv("CARDBUSH_BOT_STREAM_BASE_URL", DEFAULT_STREAM_SERVICE_BASE_URL)
                or DEFAULT_STREAM_SERVICE_BASE_URL
            ).rstrip("/"),
            auth_token=(
                str(os.getenv("CARDBUSH_BOT_STREAM_AUTH_TOKEN", "") or "").strip()
                or None
            ),
            api_key=(
                None
                if use_backend_model_default
                else str(os.getenv("CARDBUSH_BOT_STREAM_API_KEY", "") or "").strip()
                or None
            ),
            model=(
                None
                if use_backend_model_default
                else str(os.getenv("CARDBUSH_BOT_STREAM_MODEL", "") or "").strip()
                or None
            ),
            provider=(
                None
                if use_backend_model_default
                else str(os.getenv("CARDBUSH_BOT_STREAM_PROVIDER", "") or "").strip()
                or None
            ),
            llm_base_url=(
                None
                if use_backend_model_default
                else str(os.getenv("CARDBUSH_BOT_STREAM_LLM_BASE_URL", "") or "").strip()
                or None
            ),
            prompt_language=str(os.getenv("CARDBUSH_BOT_STREAM_PROMPT_LANGUAGE", "") or "").strip() or None,
            workspace_dir=_as_optional_resolved_path(
                os.getenv("CARDBUSH_BOT_STREAM_WORKSPACE_DIR")
            ),
            project_dir=_as_optional_resolved_path(
                os.getenv("CARDBUSH_BOT_STREAM_PROJECT_DIR")
            ),
            workspace_mode=(
                str(os.getenv("CARDBUSH_BOT_STREAM_WORKSPACE_MODE", "") or "")
                .strip()
                .lower()
                or None
            ),
            permission_mode=(
                str(
                    os.getenv(
                        "CARDBUSH_BOT_STREAM_PERMISSION_MODE",
                        "task_free",
                    )
                    or "task_free"
                )
                .strip()
                .lower()
                or "task_free"
            ),
            tool_calling_enabled=_as_bool(
                os.getenv("CARDBUSH_BOT_STREAM_TOOL_CALLING_ENABLED"),
                default=True,
            ),
            subagent_enabled=_as_bool(
                os.getenv("CARDBUSH_BOT_STREAM_SUBAGENT_ENABLED"),
                default=True,
            ),
            allowed_skills=allowed_skills,
            disabled_tools=disabled_tools,
            timeout_seconds=float(os.getenv("CARDBUSH_BOT_STREAM_TIMEOUT_SECONDS", "1800") or "1800"),
            history_word_trigger_single_message=_as_optional_int(
                os.getenv("CARDBUSH_BOT_STREAM_HISTORY_WORD_TRIGGER_SINGLE_MESSAGE")
            ),
            history_word_trigger_session_total=_as_optional_int(
                os.getenv("CARDBUSH_BOT_STREAM_HISTORY_WORD_TRIGGER_SESSION_TOTAL")
            ),
            history_word_trigger_summary=_as_optional_int(
                os.getenv("CARDBUSH_BOT_STREAM_HISTORY_WORD_TRIGGER_SUMMARY")
            ),
            tool_deadlock_consecutive_failures=_as_optional_int(
                os.getenv("CARDBUSH_BOT_STREAM_TOOL_DEADLOCK_CONSECUTIVE_FAILURES")
            ),
            guidance_for_active_turns=_as_bool(
                os.getenv("CARDBUSH_BOT_STREAM_GUIDANCE_FOR_ACTIVE_TURNS"),
                default=True,
            ),
            session_link_store_path=_as_optional_resolved_path(
                os.getenv("CARDBUSH_BOT_SESSION_LINK_DB")
            ),
        )


class BushServerStreamBackend:
    def __init__(
        self,
        settings: BushServerStreamSettings | None = None,
        http_client: httpx.AsyncClient | Any | None = None,
        session_link_store: SessionLinkStore | None = None,
    ) -> None:
        self._settings = settings or BushServerStreamSettings.from_env()
        self._http_client = http_client
        self._owned_http_client: httpx.AsyncClient | None = None
        self._active_turns: dict[str, dict[str, str]] = {}
        self._session_link_store = session_link_store or SessionLinkStore(
            self._settings.session_link_store_path
        )

    def _client(self) -> httpx.AsyncClient | Any:
        if self._http_client is not None:
            return self._http_client
        if self._owned_http_client is None:
            timeout = httpx.Timeout(self._settings.timeout_seconds)
            if is_loopback_url(self._settings.service_base_url):
                self._owned_http_client = build_httpx_async_client(
                    self._settings.service_base_url,
                    timeout=timeout,
                )
            else:
                self._owned_http_client = httpx.AsyncClient(timeout=timeout)
        return self._owned_http_client

    async def respond(self, envelope: ChatEnvelope) -> ChatReply:
        envelope, command_reply = await self._apply_session_link(envelope)
        if command_reply is not None:
            return command_reply
        payload = self._build_payload(envelope)
        logger.info(
            "CardBush Bot stream request: platform=%s session_id=%s payload=%s",
            envelope.platform,
            envelope.session_id,
            json.dumps(
                self._redacted_payload(payload),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        client = self._client()
        guidance_reply = await self._try_deliver_active_turn_guidance(
            envelope=envelope,
            client=client,
        )
        if guidance_reply is not None:
            return guidance_reply
        token_parts: list[str] = []
        final_text: str | None = None
        reply_metadata: dict[str, Any] = {}
        started_at = time.perf_counter()
        response_opened_ms: int | None = None
        first_event_ms: int | None = None
        first_token_ms: int | None = None
        done_event_ms: int | None = None
        event_count = 0
        token_event_count = 0
        token_char_count = 0
        active_turn_id: str | None = None
        try:
            async with client.stream(
                "POST",
                f"{self._settings.service_base_url}/v1/chat/stream",
                json=payload,
                headers=apply_service_auth_headers(
                    f"{self._settings.service_base_url}/v1/chat/stream",
                    {"Accept": "text/event-stream"},
                    bearer_token=self._settings.auth_token,
                ),
                timeout=httpx.Timeout(
                    connect=max(1.0, float(self._settings.timeout_seconds)),
                    write=max(1.0, float(self._settings.timeout_seconds)),
                    pool=max(1.0, float(self._settings.timeout_seconds)),
                    read=None,
                ),
            ) as response:
                response_opened_ms = _elapsed_ms(started_at)
                pending_interaction = await self._extract_pending_interaction_error(response)
                if pending_interaction is not None:
                    raise PendingInteractiveRequestError(pending_interaction)
                response.raise_for_status()
                async for event_name, event_payload in self._iter_sse_events(response):
                    event_count += 1
                    if first_event_ms is None:
                        first_event_ms = _elapsed_ms(started_at)
                    parsed = self._parse_event_payload(event_name, event_payload)
                    if event_name == "start":
                        turn_id = str(parsed.get("turn_id", "") or "").strip()
                        if turn_id:
                            reply_metadata["turn_id"] = turn_id
                            active_turn_id = turn_id
                            self._remember_active_turn(turn_id, envelope)
                    elif event_name == "token":
                        delta = str(parsed.get("delta", "") or "")
                        if delta:
                            if first_token_ms is None:
                                first_token_ms = _elapsed_ms(started_at)
                            token_event_count += 1
                            token_char_count += len(delta)
                            token_parts.append(delta)
                    elif event_name == "done":
                        done_event_ms = _elapsed_ms(started_at)
                        assistant_message = parsed.get("assistant_message")
                        if isinstance(assistant_message, str):
                            final_text = assistant_message
                        if "turn_id" in parsed:
                            reply_metadata["turn_id"] = parsed["turn_id"]
                            done_turn_id = str(parsed["turn_id"] or "").strip()
                            if done_turn_id:
                                active_turn_id = done_turn_id
                        if isinstance(parsed.get("usage"), dict):
                            reply_metadata["usage"] = parsed["usage"]
                        if isinstance(parsed.get("session_usage"), dict):
                            reply_metadata["session_usage"] = parsed["session_usage"]
                        transport_directives = parsed.get("transport_directives")
                        if isinstance(transport_directives, dict) and transport_directives:
                            reply_metadata["transport_directives"] = transport_directives
                        if "stopped" in parsed:
                            reply_metadata["stopped"] = bool(parsed["stopped"])
                    elif event_name == "error":
                        message = str(parsed.get("message", "") or "unknown stream error").strip() or "unknown stream error"
                        has_reply_payload = bool(
                            final_text
                            or token_parts
                            or isinstance(reply_metadata.get("transport_directives"), dict)
                            and bool(reply_metadata.get("transport_directives"))
                        )
                        if has_reply_payload:
                            reply_metadata["stream_error"] = message
                            logger.info(
                                "Ignoring post-reply BushServer stream error session=%s turn=%s error=%s",
                                envelope.session_id,
                                reply_metadata.get("turn_id"),
                                message,
                            )
                            continue
                        self._raise_stream_error(message)
        except asyncio.CancelledError:
            if active_turn_id:
                await self._stop_active_turn_safely(
                    active_turn_id,
                    reason="respond_cancelled",
                )
            raise
        except Exception as exc:
            if active_turn_id and done_event_ms is None:
                await self._stop_active_turn_safely(
                    active_turn_id,
                    reason="respond_failed",
                )
            logger.info(
                "CardBush Bot stream timing failure platform=%s session_id=%s turn=%s total_ms=%s response_opened_ms=%s first_event_ms=%s first_token_ms=%s done_event_ms=%s event_count=%s token_event_count=%s token_chars=%s error_type=%s",
                envelope.platform,
                envelope.session_id,
                reply_metadata.get("turn_id"),
                _elapsed_ms(started_at),
                response_opened_ms,
                first_event_ms,
                first_token_ms,
                done_event_ms,
                event_count,
                token_event_count,
                token_char_count,
                type(exc).__name__,
            )
            raise
        finally:
            if active_turn_id and done_event_ms is not None:
                self._forget_active_turn(active_turn_id)
        stream_timing_ms = {
            "total": _elapsed_ms(started_at),
            "response_opened": response_opened_ms,
            "first_event": first_event_ms,
            "first_token": first_token_ms,
            "done_event": done_event_ms,
        }
        reply_metadata["stream_timing_ms"] = {
            key: value for key, value in stream_timing_ms.items() if value is not None
        }
        logger.info(
            "CardBush Bot stream timing platform=%s session_id=%s turn=%s total_ms=%s response_opened_ms=%s first_event_ms=%s first_token_ms=%s done_event_ms=%s event_count=%s token_event_count=%s token_chars=%s final_text_chars=%s",
            envelope.platform,
            envelope.session_id,
            reply_metadata.get("turn_id"),
            stream_timing_ms["total"],
            response_opened_ms,
            first_event_ms,
            first_token_ms,
            done_event_ms,
            event_count,
            token_event_count,
            token_char_count,
            len(final_text or ""),
        )
        text = final_text if isinstance(final_text, str) and final_text else "".join(token_parts).strip()
        if not text and not isinstance(reply_metadata.get("transport_directives"), dict):
            if active_turn_id:
                await self._stop_active_turn_safely(
                    active_turn_id,
                    reason="empty_reply",
                )
            raise RuntimeError("BushServer stream returned no assistant text")
        return ChatReply(text=text, metadata=reply_metadata)

    async def record_transport_delivery_receipts(
        self,
        *,
        session_id: str,
        turn_id: str,
        delivery_id: str,
        channel: str,
        results: list[dict[str, object]],
    ) -> dict[str, object]:
        encoded_session_id = quote(str(session_id), safe="")
        encoded_turn_id = quote(str(turn_id), safe="")
        url = (
            f"{self._settings.service_base_url}/v1/sessions/{encoded_session_id}"
            f"/turns/{encoded_turn_id}/transport-delivery-receipts"
        )
        response = await self._client().post(
            url,
            json={
                "protocol": "bush.transport.delivery_receipt.v1",
                "delivery_id": delivery_id,
                "channel": channel,
                "results": results,
            },
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("BushServer returned an invalid transport receipt response")
        return payload

    async def _try_deliver_active_turn_guidance(
        self,
        *,
        envelope: ChatEnvelope,
        client: httpx.AsyncClient | Any,
    ) -> ChatReply | None:
        if not bool(self._settings.guidance_for_active_turns):
            return None
        text = str(envelope.text or "").strip()
        if not text:
            return None
        try:
            turn_id = await self._active_turn_id_for_session(
                envelope.session_id,
                client=client,
            )
            if not turn_id:
                return None
            payload = {
                "session_id": envelope.session_id,
                "guidance": text,
                "mode": "append_context",
                "source": envelope.platform,
                "message_id": envelope.message_id or "",
            }
            encoded_turn_id = quote(turn_id, safe="")
            url = f"{self._settings.service_base_url}/v1/turns/{encoded_turn_id}/guidance"
            accepted = False
            async with client.stream(
                "POST",
                url,
                json=payload,
                headers=apply_service_auth_headers(
                    url,
                    {"Accept": "text/event-stream"},
                    bearer_token=self._settings.auth_token,
                ),
                timeout=httpx.Timeout(
                    connect=max(1.0, float(self._settings.timeout_seconds)),
                    write=max(1.0, float(self._settings.timeout_seconds)),
                    pool=max(1.0, float(self._settings.timeout_seconds)),
                    read=None,
                ),
            ) as response:
                response.raise_for_status()
                async for event_name, event_payload in self._iter_sse_events(response):
                    if event_name != "done":
                        continue
                    parsed = self._parse_event_payload(event_name, event_payload)
                    accepted = bool(parsed.get("accepted", True))
                    if isinstance(parsed.get("turn_id"), str):
                        turn_id = str(parsed["turn_id"])
            if not accepted:
                return None
            logger.info(
                "CardBush Bot active-turn guidance delivered: platform=%s session_id=%s turn=%s",
                envelope.platform,
                envelope.session_id,
                turn_id,
            )
            return ChatReply(
                text="已收到，我会把这条补充并入当前正在执行的任务。",
                metadata={
                    "guidance_delivered": True,
                    "turn_id": turn_id,
                    "session_id": envelope.session_id,
                },
            )
        except Exception as exc:
            logger.info(
                "CardBush Bot active-turn guidance fallback: platform=%s session_id=%s error_type=%s",
                envelope.platform,
                envelope.session_id,
                type(exc).__name__,
            )
            return None

    async def _active_turn_id_for_session(
        self,
        session_id: str,
        *,
        client: httpx.AsyncClient | Any,
    ) -> str | None:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return None
        get = getattr(client, "get", None)
        if not callable(get):
            return None
        encoded_session_id = quote(normalized_session_id, safe="")
        url = (
            f"{self._settings.service_base_url}/v1/sessions/"
            f"{encoded_session_id}/active-turn"
        )
        response = await get(
            url,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        if getattr(response, "status_code", 0) in {404, 501}:
            return None
        if int(getattr(response, "status_code", 0) or 0) >= 500:
            return None
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not bool(payload.get("active")):
            return None
        turn_id = str(payload.get("turn_id") or "").strip()
        return turn_id or None

    async def get_pending_interaction(self, session_id: str) -> dict[str, Any] | None:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return None
        client = self._client()
        url = f"{self._settings.service_base_url}/v1/interactions/pending"
        response = await client.get(
            url,
            params={"session_id": normalized_session_id},
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            return None
        pending = payload.get("pending")
        if not isinstance(pending, dict):
            return None
        return dict(pending)

    async def resolve_pending_interaction(
        self,
        session_id: str,
        *,
        raw_text: str,
    ) -> ChatReply | None:
        pending = await self.get_pending_interaction(session_id)
        if pending is None:
            return None
        interaction_id = str(pending.get("interaction_id") or "").strip()
        if not interaction_id:
            return ChatReply(
                text=format_pending_interaction_text(pending),
                metadata={"interaction_pending": True, "session_id": session_id},
            )
        normalized_text = " ".join(str(raw_text or "").strip().lower().split())
        if normalized_text in _INTERACTION_CANCEL_TOKENS:
            result = await self.cancel_interaction(interaction_id)
            return ChatReply(
                text="已取消当前确认。",
                metadata={
                    "interaction_resolved": True,
                    "interaction_cancelled": True,
                    "interaction_id": interaction_id,
                    "session_id": session_id,
                    "result": result,
                },
            )
        try:
            result = await self.reply_interaction(
                interaction_id,
                raw_text=str(raw_text or "").strip(),
            )
        except InteractiveReplyValidationError:
            return ChatReply(
                text=format_pending_interaction_text(pending, invalid_input=True),
                metadata={
                    "interaction_pending": True,
                    "interaction_invalid_reply": True,
                    "interaction_id": interaction_id,
                    "session_id": session_id,
                },
            )
        return ChatReply(
            text="已收到你的选择，正在继续处理。",
            metadata={
                "interaction_resolved": True,
                "interaction_id": interaction_id,
                "session_id": session_id,
                "result": result,
            },
        )

    async def reply_interaction(
        self,
        interaction_id: str,
        *,
        answers: list[dict[str, Any]] | None = None,
        raw_text: str | None = None,
    ) -> dict[str, Any]:
        normalized_interaction_id = str(interaction_id or "").strip()
        if not normalized_interaction_id:
            raise ValueError("interaction_id is required")
        has_answers = bool(answers)
        has_raw_text = bool(str(raw_text or "").strip())
        if has_answers == has_raw_text:
            raise ValueError("provide exactly one of answers or raw_text")
        client = self._client()
        url = (
            f"{self._settings.service_base_url}/v1/interactions/"
            f"{normalized_interaction_id}/reply"
        )
        payload = (
            {"answers": list(answers or [])}
            if has_answers
            else {"raw_text": str(raw_text or "").strip()}
        )
        response = await client.post(
            url,
            json=payload,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        if response.status_code == 400:
            detail = ""
            try:
                payload = response.json()
            except Exception:
                payload = None
            if isinstance(payload, dict):
                detail = str(payload.get("detail", "") or "").strip()
            if not detail:
                detail = str(response.text or "").strip()
            raise InteractiveReplyValidationError(detail)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(
                f"Unexpected interaction reply response: {payload!r}"
            )
        return dict(payload)

    async def cancel_interaction(self, interaction_id: str) -> dict[str, Any]:
        normalized_interaction_id = str(interaction_id or "").strip()
        if not normalized_interaction_id:
            raise ValueError("interaction_id is required")
        client = self._client()
        url = (
            f"{self._settings.service_base_url}/v1/interactions/"
            f"{normalized_interaction_id}/cancel"
        )
        response = await client.post(
            url,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(
                f"Unexpected interaction cancel response: {payload!r}"
            )
        return dict(payload)

    async def stop_turn(self, turn_id: str) -> dict[str, Any]:
        return await self._post_stop_turn(turn_id)

    async def get_model_configs(self) -> dict[str, Any]:
        client = self._client()
        url = f"{self._settings.service_base_url}/v1/model-configs"
        response = await client.get(
            url,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected model config response: {payload!r}")
        return dict(payload)

    async def switch_default_model_config(self, model_config_id: str) -> dict[str, Any]:
        target_id = str(model_config_id or "").strip()
        if not target_id:
            raise ValueError("model_config_id is required")
        current = await self.get_model_configs()
        raw_models = current.get("models")
        if not isinstance(raw_models, list):
            raw_models = current.get("items")
        models = raw_models if isinstance(raw_models, list) else []
        known_ids = {
            str(item.get("id") or "").strip()
            for item in models
            if isinstance(item, dict)
        }
        if target_id not in known_ids:
            raise ValueError(f"model config `{target_id}` not found")

        updated = dict(current)
        updated["default_model_id"] = target_id
        updated["defaultModelId"] = target_id
        updated["models"] = models
        client = self._client()
        url = f"{self._settings.service_base_url}/v1/model-configs"
        response = await client.put(
            url,
            json=updated,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected model config update response: {payload!r}")
        return dict(payload)

    async def stop_active_turns(self, *, reason: str = "backend_closing") -> list[dict[str, Any]]:
        records = list(self._active_turns)
        results: list[dict[str, Any]] = []
        for turn_id in records:
            payload = await self._stop_active_turn_safely(turn_id, reason=reason)
            if payload is not None:
                results.append(payload)
        return results

    async def _post_stop_turn(
        self,
        turn_id: str,
        *,
        client: httpx.AsyncClient | Any | None = None,
    ) -> dict[str, Any]:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required")
        http_client = client or self._client()
        url = f"{self._settings.service_base_url}/v1/turns/{quote(normalized_turn_id, safe='')}/stop"
        response = await http_client.post(
            url,
            headers=apply_service_auth_headers(
                url,
                bearer_token=self._settings.auth_token,
            ),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected turn stop response: {payload!r}")
        return dict(payload)

    async def aclose(self) -> None:
        await self.stop_active_turns(reason="backend_closing")
        client = self._owned_http_client
        self._owned_http_client = None
        if client is not None:
            await client.aclose()

    def _remember_active_turn(self, turn_id: str, envelope: ChatEnvelope) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return
        self._active_turns[normalized_turn_id] = {
            "platform": envelope.platform,
            "session_id": envelope.session_id,
            "message_id": envelope.message_id or "",
        }

    def _forget_active_turn(self, turn_id: str) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if normalized_turn_id:
            self._active_turns.pop(normalized_turn_id, None)

    async def _stop_active_turn_safely(
        self,
        turn_id: str,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return None
        record = self._active_turns.get(normalized_turn_id, {})
        try:
            payload = await self._post_stop_turn(normalized_turn_id)
            logger.info(
                "CardBush Bot active turn stopped: platform=%s session_id=%s turn=%s message_id=%s reason=%s",
                record.get("platform", ""),
                record.get("session_id", ""),
                normalized_turn_id,
                record.get("message_id", ""),
                reason,
            )
            return payload
        except Exception as exc:
            logger.info(
                "CardBush Bot active turn stop failed: platform=%s session_id=%s turn=%s message_id=%s reason=%s error_type=%s",
                record.get("platform", ""),
                record.get("session_id", ""),
                normalized_turn_id,
                record.get("message_id", ""),
                reason,
                type(exc).__name__,
            )
            return None
        finally:
            self._forget_active_turn(normalized_turn_id)

    def _build_payload(self, envelope: ChatEnvelope) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "session_id": envelope.session_id,
            "user_input": str(envelope.text or ""),
            "stream": True,
            "tool_calling_enabled": self._settings.tool_calling_enabled,
            "metadata": {
                "source_platform": envelope.platform,
                "source_user_id": envelope.user_id,
                "source_channel_id": envelope.channel_id,
            },
        }
        if envelope.platform != "bush_gui":
            raw_subagent_enabled = (envelope.raw_event or {}).get(
                "_bridge_subagent_enabled"
            )
            payload["metadata"]["subagent_enabled"] = (
                _as_bool(
                    raw_subagent_enabled,
                    default=bool(self._settings.subagent_enabled),
                )
                if raw_subagent_enabled not in (None, "")
                else bool(self._settings.subagent_enabled)
            )
        if envelope.platform == "feishu":
            payload["metadata"]["deliverable_transport_channel"] = "feishu"
            payload["metadata"]["deliverable_transport_mode"] = (
                "tool_local_upload_send"
            )
        if envelope.platform == "weixin":
            payload["metadata"]["deliverable_transport_channel"] = "weixin"
            payload["metadata"]["deliverable_transport_mode"] = (
                "tool_local_upload_send"
            )
            payload["metadata"]["deliverable_transport_constraints"] = {
                "folder_delivery_supported": False,
                "native_image_supported": True,
                "file_fallback_supported": True,
            }
        if envelope.message_id:
            payload["metadata"]["source_message_id"] = envelope.message_id
        if envelope.thread_id:
            payload["metadata"]["source_thread_id"] = envelope.thread_id
        if self._settings.history_word_trigger_single_message is not None:
            payload["metadata"]["history_word_trigger_single_message"] = max(
                50,
                int(self._settings.history_word_trigger_single_message),
            )
        if self._settings.history_word_trigger_session_total is not None:
            payload["metadata"]["history_word_trigger_session_total"] = max(
                200,
                int(self._settings.history_word_trigger_session_total),
            )
        if self._settings.history_word_trigger_summary is not None:
            payload["metadata"]["history_word_trigger_summary"] = max(
                120,
                int(self._settings.history_word_trigger_summary),
            )
        if self._settings.tool_deadlock_consecutive_failures is not None:
            payload["metadata"]["tool_deadlock_consecutive_failures"] = max(
                1,
                int(self._settings.tool_deadlock_consecutive_failures),
            )
        if self._settings.api_key:
            payload["api_key"] = self._settings.api_key
        if self._settings.model:
            payload["model"] = self._settings.model
        if self._settings.provider:
            payload["provider"] = self._settings.provider
        if self._settings.llm_base_url:
            payload["base_url"] = self._settings.llm_base_url
        if self._settings.prompt_language:
            payload["prompt_language"] = self._settings.prompt_language
        if self._settings.workspace_dir:
            payload["workspace_dir"] = self._settings.workspace_dir
            payload["project_dir"] = self._settings.workspace_dir
            payload["workspace_mode"] = "workspace"
        elif self._settings.project_dir and self._settings.workspace_mode == "project":
            payload["project_dir"] = self._settings.project_dir
            payload["workspace_mode"] = "project"
        else:
            payload["workspace_mode"] = "task"
        payload["permission_mode"] = self._settings.permission_mode
        if self._settings.disabled_tools is not None:
            payload["disabled_tools"] = list(self._settings.disabled_tools)
        if self._settings.allowed_skills is not None:
            payload["allowed_skills"] = list(self._settings.allowed_skills)
        return payload

    async def _apply_session_link(
        self,
        envelope: ChatEnvelope,
    ) -> tuple[ChatEnvelope, ChatReply | None]:
        key = SessionLinkKey.create(
            platform=envelope.platform,
            channel_id=envelope.channel_id,
            user_id=envelope.user_id,
        )
        text = str(envelope.text or "").strip()
        parts = text.split()
        command = parts[0].casefold() if parts else ""
        if command == "/unlink" and len(parts) == 1:
            removed = self._session_link_store.unbind(key)
            return envelope, ChatReply(
                text=(
                    "已断开 CardBush 会话连接。"
                    if removed
                    else "当前 Bot 对话没有连接 CardBush 会话。"
                ),
                metadata={"session_handoff": "unlinked", "unlinked": removed},
            )
        if command == "/link":
            if len(parts) != 2:
                return envelope, ChatReply(
                    text="绑定命令格式不正确，请使用 `/link 绑定码`。",
                    metadata={"session_handoff": "invalid_command"},
                )
            code = parts[1].strip().upper()
            if not code or len(code) > 128:
                return envelope, ChatReply(
                    text="绑定码无效，请在 CardBush 中重新生成。",
                    metadata={"session_handoff": "invalid_code"},
                )
            client = self._client()
            url = (
                f"{self._settings.service_base_url}/v1/session-share-links/"
                f"{quote(code, safe='')}/consume"
            )
            response = await client.post(
                url,
                json={
                    "platform": key.platform,
                    "channel_id": key.channel_id,
                    "user_id": key.user_id,
                },
                headers=apply_service_auth_headers(
                    url,
                    bearer_token=self._settings.auth_token,
                ),
            )
            if int(getattr(response, "status_code", 0) or 0) >= 400:
                return envelope, ChatReply(
                    text="绑定失败：绑定码无效、已过期、平台不匹配或已被其他对话使用。",
                    metadata={
                        "session_handoff": "rejected",
                        "status_code": int(
                            getattr(response, "status_code", 0) or 0
                        ),
                    },
                )
            payload = response.json()
            session_id = (
                str(payload.get("session_id") or "").strip()
                if isinstance(payload, dict)
                else ""
            )
            if not session_id:
                return envelope, ChatReply(
                    text="绑定失败：Agent 服务没有返回有效会话。",
                    metadata={"session_handoff": "invalid_response"},
                )
            self._session_link_store.bind(key, session_id)
            return replace(envelope, session_id=session_id), ChatReply(
                text="已连接到 CardBush 会话，后续消息会继续该会话。",
                metadata={
                    "session_handoff": "linked",
                    "session_id": session_id,
                },
            )
        linked_session_id = self._session_link_store.resolve(key)
        if linked_session_id:
            return replace(envelope, session_id=linked_session_id), None
        return envelope, None

    @staticmethod
    def _redacted_payload(payload: dict[str, Any]) -> dict[str, Any]:
        sanitized = dict(payload)
        if "api_key" in sanitized:
            sanitized["api_key"] = "***"
        return sanitized

    @staticmethod
    def _raise_stream_error(message: str) -> None:
        if _looks_like_model_authentication_error(message):
            raise ModelAuthenticationError(
                message,
                provider=_infer_model_auth_provider(message),
            )
        if _looks_like_model_rate_limit_error(message):
            raise ModelRateLimitError(
                message,
                provider=_infer_model_auth_provider(message),
            )
        if _looks_like_model_connection_error(message):
            raise ModelConnectionError(
                message,
                provider=_infer_model_auth_provider(message),
            )
        raise RuntimeError(f"BushServer stream error: {message}")

    @staticmethod
    async def _iter_sse_events(response: httpx.Response):
        event_name: str | None = None
        data_lines: list[str] = []
        async for raw_line in response.aiter_lines():
            line = raw_line.rstrip("\r")
            if not line:
                if data_lines:
                    yield event_name or "message", "\n".join(data_lines)
                event_name = None
                data_lines = []
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip() or None
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            yield event_name or "message", "\n".join(data_lines)

    @staticmethod
    def _parse_event_payload(event_name: str, payload: str) -> dict[str, Any]:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid BushServer SSE payload for event '{event_name}': {payload}") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError(f"Unexpected BushServer SSE payload for event '{event_name}': {parsed!r}")
        return parsed

    @staticmethod
    async def _extract_pending_interaction_error(
        response: httpx.Response,
    ) -> dict[str, Any] | None:
        if int(response.status_code) != 409:
            return None
        try:
            payload = json.loads((await response.aread()).decode("utf-8", "replace"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        detail = payload.get("detail")
        if not isinstance(detail, dict):
            return None
        pending = detail.get("interactive_request")
        if not isinstance(pending, dict):
            return None
        result = dict(pending)
        message = str(detail.get("message") or "").strip()
        if message:
            result.setdefault("message", message)
        return result


def load_bushserver_backend_from_env() -> BushServerStreamBackend:
    """Build the sole production Bot backend from CardBush-managed settings."""

    return BushServerStreamBackend()
