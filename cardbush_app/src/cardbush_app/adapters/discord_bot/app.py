from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request

from cardbush_app import __version__
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
    load_bushserver_backend_from_env,
)

from .config import DiscordBotSettings
from .security import DiscordSignatureVerifier

DISCORD_PING = 1
DISCORD_APPLICATION_COMMAND = 2
DISCORD_PONG_RESPONSE = 1
DISCORD_CHANNEL_MESSAGE_RESPONSE = 4

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


class DiscordBotService:
    def __init__(
        self,
        *,
        settings: DiscordBotSettings,
        backend: ConversationBackend,
        verifier: DiscordSignatureVerifier,
    ) -> None:
        self._settings = settings
        self._backend = backend
        self._verifier = verifier
        self._lifecycle = LifecycleManager()
        self._lifecycle.add_resource(name="backend", resource=self._backend)

    async def startup(self) -> None:
        await self._lifecycle.startup()

    async def shutdown(self) -> None:
        await self._lifecycle.shutdown()

    def _format_pending_interaction(self, payload: dict[str, Any]) -> str:
        text = format_pending_interaction_text(payload)
        if self._settings.mode == "webhook":
            text += (
                f"\n\nWebhook 模式下，请再次使用 `/{self._settings.command_name}`，"
                "把选择填入 message 参数。"
            )
        return text

    def verify_request(self, *, signature: str, timestamp: str, body: bytes) -> None:
        if not signature or not timestamp:
            raise HTTPException(status_code=401, detail="missing Discord signature headers")
        if not self._verifier.verify(signature_hex=signature, timestamp=timestamp, body=body):
            raise HTTPException(status_code=401, detail="invalid Discord signature")

    async def handle_interaction(self, payload: dict[str, Any]) -> dict[str, Any]:
        interaction_type = int(payload.get("type", 0) or 0)
        if interaction_type == DISCORD_PING:
            return {"type": DISCORD_PONG_RESPONSE}
        if interaction_type != DISCORD_APPLICATION_COMMAND:
            raise HTTPException(status_code=400, detail="unsupported interaction type")

        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        command_name = str(data.get("name", "") or "").strip()
        if command_name != self._settings.command_name:
            raise HTTPException(status_code=400, detail="unsupported command")

        options = data.get("options") if isinstance(data.get("options"), list) else []
        message_text = ""
        for option in options:
            if isinstance(option, dict) and option.get("name") == "message":
                message_text = str(option.get("value", "") or "").strip()
                break
        if not message_text:
            raise HTTPException(status_code=400, detail="missing message option")

        channel_id = str(payload.get("channel_id", "") or "").strip()
        member = payload.get("member") if isinstance(payload.get("member"), dict) else {}
        user = member.get("user") if isinstance(member.get("user"), dict) else payload.get("user") if isinstance(payload.get("user"), dict) else {}
        user_id = str(user.get("id", "") or "").strip()
        if not channel_id or not user_id:
            raise HTTPException(status_code=400, detail="missing channel_id or user id")
        if not channel_identity_is_allowed(
            user_id=user_id,
            channel_id=channel_id,
            allowed_user_ids=self._settings.allowed_user_ids,
            allowed_channel_ids=self._settings.allowed_channel_ids,
        ):
            logger.info(
                "Rejected Discord interaction from unauthorized identity user=%s channel=%s",
                user_id,
                channel_id,
            )
            return {
                "type": DISCORD_CHANNEL_MESSAGE_RESPONSE,
                "data": {
                    "content": "当前账号或频道未获授权。",
                    "flags": 64,
                },
            }

        envelope = ChatEnvelope(
            platform="discord",
            session_id=f"discord:{channel_id}:{user_id}",
            user_id=user_id,
            channel_id=channel_id,
            text=message_text,
            raw_event=payload,
        )
        try:
            resolver = getattr(self._backend, "resolve_pending_interaction", None)
            reply = (
                await resolver(envelope.session_id, raw_text=message_text)
                if callable(resolver)
                else None
            )
            if reply is None:
                reply = await self._backend.respond(envelope)
        except PendingInteractiveRequestError as exc:
            return {
                "type": DISCORD_CHANNEL_MESSAGE_RESPONSE,
                "data": {
                    "content": self._format_pending_interaction(exc.payload),
                },
            }
        except (
            ModelAuthenticationError,
            ModelConnectionError,
            ModelRateLimitError,
        ) as exc:
            logger.warning(
                "Discord backend model service error category=%s provider=%s session_id=%s error=%s",
                exc.category,
                exc.provider or "",
                envelope.session_id,
                exc.message,
            )
            return {
                "type": DISCORD_CHANNEL_MESSAGE_RESPONSE,
                "data": {
                    "content": _format_model_service_error_text(exc),
                },
            }
        reply_text = str(reply.text or "")
        reply_metadata = reply.metadata if isinstance(reply.metadata, dict) else {}
        if bool(reply_metadata.get("interaction_pending")) and self._settings.mode == "webhook":
            reply_text += (
                f"\n\n请再次使用 `/{self._settings.command_name}`，"
                "把选择填入 message 参数。"
            )
        return {
            "type": DISCORD_CHANNEL_MESSAGE_RESPONSE,
            "data": {
                "content": reply_text,
            },
        }


def build_service(
    settings: DiscordBotSettings | None = None,
    *,
    backend: ConversationBackend | None = None,
    verifier: DiscordSignatureVerifier | None = None,
) -> DiscordBotService:
    resolved_settings = settings or DiscordBotSettings.from_env()
    resolved_backend = backend or load_bushserver_backend_from_env()
    resolved_verifier = verifier or DiscordSignatureVerifier(resolved_settings.public_key or "00" * 32)
    return DiscordBotService(
        settings=resolved_settings,
        backend=resolved_backend,
        verifier=resolved_verifier,
    )


def create_app(
    settings: DiscordBotSettings | None = None,
    *,
    backend: ConversationBackend | None = None,
    verifier: DiscordSignatureVerifier | None = None,
) -> FastAPI:
    resolved_settings = settings or DiscordBotSettings.from_env()
    service = build_service(resolved_settings, backend=backend, verifier=verifier)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await service.startup()
        try:
            yield
        finally:
            await service.shutdown()

    app = FastAPI(
        title="BushServer Discord Bot Adapter",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.discord_service = service
    app.state.discord_settings = resolved_settings

    def get_service() -> DiscordBotService:
        return app.state.discord_service

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "mode": resolved_settings.mode}

    @app.post("/discord/interactions")
    async def discord_interactions(
        request: Request,
        bot_service: DiscordBotService = Depends(get_service),
    ) -> dict[str, Any]:
        body = await request.body()
        bot_service.verify_request(
            signature=request.headers.get("X-Signature-Ed25519", ""),
            timestamp=request.headers.get("X-Signature-Timestamp", ""),
            body=body,
        )
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid payload")
        return await bot_service.handle_interaction(payload)

    return app
