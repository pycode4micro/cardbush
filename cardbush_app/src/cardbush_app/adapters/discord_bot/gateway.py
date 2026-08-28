from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any

import aiohttp

from cardbush_app.adapters.common import (
    ChatEnvelope,
    ConversationBackend,
    LifecycleManager,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelRateLimitError,
    PendingInteractiveRequestError,
    channel_identity_is_allowed,
    format_pending_interaction_text,
)

from .client import DiscordMessageClient
from .config import DiscordBotSettings
from .dedup import DiscordMessageDeduplicator

DISCORD_GATEWAY_OP_DISPATCH = 0
DISCORD_GATEWAY_OP_HEARTBEAT = 1
DISCORD_GATEWAY_OP_IDENTIFY = 2
DISCORD_GATEWAY_OP_RECONNECT = 7
DISCORD_GATEWAY_OP_INVALID_SESSION = 9
DISCORD_GATEWAY_OP_HELLO = 10
DISCORD_GATEWAY_OP_HEARTBEAT_ACK = 11

logger = logging.getLogger(__name__)


def _format_model_service_error_text(exc: BaseException) -> str:
    category = str(getattr(exc, "category", "") or "").strip()
    if category == "model_authentication":
        return "模型 API Key 无效或无权限，请在模型配置中检查默认槽位。"
    if category == "model_connection":
        return "模型服务连接失败，请检查默认模型槽位、供应商网络或稍后重试。"
    if category == "model_rate_limit":
        return "模型服务触发限流或额度不足，请切换默认模型槽位或稍后重试。"
    return "模型服务暂时不可用，请稍后重试。"


class DiscordGatewayRunner:
    def __init__(
        self,
        *,
        settings: DiscordBotSettings,
        backend: ConversationBackend,
        sender: DiscordMessageClient,
        deduplicator: DiscordMessageDeduplicator | None = None,
    ) -> None:
        self._settings = settings
        self._backend = backend
        self._sender = sender
        self._deduplicator = deduplicator or DiscordMessageDeduplicator(
            ttl_seconds=settings.dedup_ttl_seconds,
            max_entries=settings.dedup_max_entries,
        )
        self._bot_user_id: str | None = None
        self._sequence: int | None = None
        self._lifecycle = LifecycleManager()
        self._lifecycle.add_resource(name="backend", resource=self._backend)
        self._lifecycle.add_resource(name="sender", resource=self._sender)
        self._lifecycle.add_resource(name="deduplicator", resource=self._deduplicator)
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None

    async def startup(self) -> None:
        if self._stop_event is None or self._stop_event.is_set():
            self._stop_event = asyncio.Event()
        await self._lifecycle.startup()

    async def shutdown(self) -> None:
        if self._stop_event is not None:
            self._stop_event.set()
        heartbeat_task = self._heartbeat_task
        self._heartbeat_task = None
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task
        ws = self._ws
        self._ws = None
        if ws is not None and not ws.closed:
            with contextlib.suppress(Exception):  # noqa: BLE001
                await ws.close()
        session = self._session
        self._session = None
        if session is not None and not session.closed:
            with contextlib.suppress(Exception):  # noqa: BLE001
                await session.close()
        await self._lifecycle.shutdown()

    async def run(self) -> None:
        await self.startup()
        try:
            timeout = aiohttp.ClientTimeout(total=None, connect=30.0, sock_read=None)
            self._session = aiohttp.ClientSession(timeout=timeout)
            while self._stop_event is None or not self._stop_event.is_set():
                try:
                    await self._run_once(self._session)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if self._stop_event is not None and self._stop_event.is_set():
                        break
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue
        finally:
            await self.shutdown()

    async def _run_once(self, session: aiohttp.ClientSession) -> None:
        gateway_url = await self._gateway_url(session)
        ws_url = self._build_ws_url(gateway_url)
        async with session.ws_connect(ws_url, heartbeat=0) as ws:
            self._ws = ws
            hello = await ws.receive_json()
            if int(hello.get("op", -1) or -1) != DISCORD_GATEWAY_OP_HELLO:
                raise RuntimeError(f"Discord gateway hello expected, got: {hello}")
            heartbeat_interval_ms = int((hello.get("d") or {}).get("heartbeat_interval", 45000) or 45000)
            heartbeat_task = asyncio.create_task(self._heartbeat_loop(ws, heartbeat_interval_ms / 1000.0))
            self._heartbeat_task = heartbeat_task
            try:
                await ws.send_json(self._identify_payload())
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        payload = json.loads(msg.data)
                        await self._handle_gateway_payload(payload)
                        if int(payload.get("op", -1) or -1) in {DISCORD_GATEWAY_OP_RECONNECT, DISCORD_GATEWAY_OP_INVALID_SESSION}:
                            break
                    elif msg.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                        break
            finally:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task
                if self._heartbeat_task is heartbeat_task:
                    self._heartbeat_task = None
                if self._ws is ws:
                    self._ws = None

    async def _heartbeat_loop(self, ws: aiohttp.ClientWebSocketResponse, interval_seconds: float) -> None:
        while self._stop_event is None or not self._stop_event.is_set():
            await asyncio.sleep(interval_seconds)
            await ws.send_json({"op": DISCORD_GATEWAY_OP_HEARTBEAT, "d": self._sequence})

    async def _gateway_url(self, session: aiohttp.ClientSession) -> str:
        async with session.get(
            f"{self._settings.api_base}/gateway/bot",
            headers={"Authorization": f"Bot {self._settings.bot_token}"},
        ) as response:
            response.raise_for_status()
            data = await response.json()
        url = str(data.get("url", "") or "").strip()
        if not url:
            raise RuntimeError(f"Discord gateway URL missing: {data}")
        return url

    @staticmethod
    def _build_ws_url(gateway_url: str) -> str:
        base = gateway_url.rstrip("/")
        return f"{base}/?v=10&encoding=json" if not gateway_url.endswith("/") else f"{base}?v=10&encoding=json"

    def _identify_payload(self) -> dict[str, Any]:
        return {
            "op": DISCORD_GATEWAY_OP_IDENTIFY,
            "d": {
                "token": self._settings.bot_token,
                "intents": self._settings.gateway_intents,
                "properties": {
                    "os": "linux",
                    "browser": "bushserver",
                    "device": "bushserver",
                },
            },
        }

    async def _handle_gateway_payload(self, payload: dict[str, Any]) -> None:
        sequence = payload.get("s")
        if isinstance(sequence, int):
            self._sequence = sequence
        op = int(payload.get("op", -1) or -1)
        if op == DISCORD_GATEWAY_OP_HEARTBEAT_ACK:
            return
        if op != DISCORD_GATEWAY_OP_DISPATCH:
            return
        event_type = str(payload.get("t", "") or "").strip()
        data = payload.get("d") if isinstance(payload.get("d"), dict) else {}
        if event_type == "READY":
            user = data.get("user") if isinstance(data.get("user"), dict) else {}
            self._bot_user_id = str(user.get("id", "") or "").strip() or None
            return
        if event_type == "MESSAGE_CREATE":
            await self._handle_message_create(data)

    async def _handle_message_create(self, data: dict[str, Any]) -> None:
        author = data.get("author") if isinstance(data.get("author"), dict) else {}
        if bool(author.get("bot")):
            return
        author_id = str(author.get("id", "") or "").strip()
        channel_id = str(data.get("channel_id", "") or "").strip()
        message_id = str(data.get("id", "") or "").strip() or None
        content = str(data.get("content", "") or "")
        if not author_id or not channel_id:
            return
        if not channel_identity_is_allowed(
            user_id=author_id,
            channel_id=channel_id,
            allowed_user_ids=self._settings.allowed_user_ids,
            allowed_channel_ids=self._settings.allowed_channel_ids,
        ):
            logger.info(
                "Ignored Discord gateway message from unauthorized identity user=%s channel=%s",
                author_id,
                channel_id,
            )
            return
        if not self._deduplicator.should_process(self._build_dedup_key(data)):
            return
        normalized_text = self._extract_user_text(data, content)
        if not normalized_text:
            return
        envelope = ChatEnvelope(
            platform="discord",
            session_id=f"discord:{channel_id}:{author_id}",
            user_id=author_id,
            channel_id=channel_id,
            text=normalized_text,
            message_id=message_id,
            raw_event=data,
        )
        try:
            resolver = getattr(self._backend, "resolve_pending_interaction", None)
            reply = (
                await resolver(envelope.session_id, raw_text=normalized_text)
                if callable(resolver)
                else None
            )
            if reply is None:
                reply = await self._backend.respond(envelope)
        except PendingInteractiveRequestError as exc:
            await self._sender.send_text(
                channel_id=channel_id,
                text=format_pending_interaction_text(exc.payload),
                reply_to_message_id=message_id,
            )
            return
        except (
            ModelAuthenticationError,
            ModelConnectionError,
            ModelRateLimitError,
        ) as exc:
            logger.warning(
                "Discord gateway backend model service error category=%s provider=%s session_id=%s message_id=%s error=%s",
                exc.category,
                exc.provider or "",
                envelope.session_id,
                message_id,
                exc.message,
            )
            await self._sender.send_text(
                channel_id=channel_id,
                text=_format_model_service_error_text(exc),
                reply_to_message_id=message_id,
            )
            return
        await self._sender.send_text(channel_id=channel_id, text=reply.text, reply_to_message_id=message_id)

    def _extract_user_text(self, data: dict[str, Any], content: str) -> str:
        channel_type = int(data.get("channel_type", 0) or 0)
        text = content.strip()
        if channel_type == 1:
            return text
        mentions = data.get("mentions") if isinstance(data.get("mentions"), list) else []
        if self._bot_user_id and any(str((m or {}).get("id", "") or "").strip() == self._bot_user_id for m in mentions if isinstance(m, dict)):
            text = text.replace(f"<@{self._bot_user_id}>", "").replace(f"<@!{self._bot_user_id}>", "").strip()
            return text
        return ""

    @staticmethod
    def _build_dedup_key(data: dict[str, Any]) -> str | None:
        message_id = str(data.get("id", "") or "").strip()
        if message_id:
            return f"message:{message_id}"
        nonce = str(data.get("nonce", "") or "").strip()
        if nonce:
            return f"nonce:{nonce}"
        return None
