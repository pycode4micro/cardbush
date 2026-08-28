from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from lark_oapi.api.im.v1 import P2ImMessageMessageReadV1, P2ImMessageReceiveV1

from cardbush_app import __version__
from cardbush_app.paths import default_app_data_dir, session_workspace_dir
from cardbush_app.adapters.common import (
    AdapterEvent,
    AdapterEventSink,
    ChatEnvelope,
    CompositeAdapterEventSink,
    ConversationBackend,
    InMemoryAdapterEventBus,
    LifecycleManager,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelRateLimitError,
    NoopAdapterEventSink,
    PendingInteractiveRequestError,
    channel_identity_is_allowed,
    format_pending_interaction_text,
    format_transport_receipt_notice,
    load_bushserver_backend_from_env,
)

from .client import FeishuMessageClient
from .config import FeishuBotSettings
from .dedup import FeishuMessageDeduplicator
from .read_receipts import FeishuOutboundMessage, FeishuReadReceiptStore

logger = logging.getLogger(__name__)

_DELIVERABLE_PATH_TRAILING = ".,;:!?)】）]}>"
_FEISHU_RESOURCE_DATA_SEGMENT = "/feishu_sdk_resouce_data/"
_IMAGE_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
}


def _format_model_service_error_text(exc: BaseException) -> str:
    category = str(getattr(exc, "category", "") or "").strip()
    if category == "model_authentication":
        return "模型 API Key 无效或无权限，请在模型配置中检查默认槽位。"
    if category == "model_connection":
        return "模型服务连接失败，请检查默认模型槽位、供应商网络或稍后重试。"
    if category == "model_rate_limit":
        return "模型服务触发限流或额度不足，请切换默认模型槽位或稍后重试。"
    return "模型服务暂时不可用，请稍后重试。"


@dataclass(slots=True)
class _PendingAttachment:
    kind: str
    key: str
    name: str | None
    path: str
    message_id: str | None
    created_at: float


@dataclass(slots=True)
class _StructuredDeliverable:
    path: str
    caption: str = ""
    label: str = ""


def _resolve_feishu_dedup_sqlite_path(settings: FeishuBotSettings) -> str | None:
    configured = str(settings.dedup_sqlite_path or "").strip()
    if configured:
        return str(Path(configured).expanduser())
    base = str(os.getenv("CARDBUSH_APP_DATA_DIR", "") or "").strip()
    if base:
        return str((Path(base).expanduser() / "feishu_dedup.db"))
    return str(default_app_data_dir() / "feishu_dedup.db")


class FeishuBotService:
    def __init__(
        self,
        *,
        settings: FeishuBotSettings,
        backend: ConversationBackend,
        sender: FeishuMessageClient,
        deduplicator: FeishuMessageDeduplicator,
        read_receipts: FeishuReadReceiptStore,
        event_sink: AdapterEventSink,
    ) -> None:
        self._settings = settings
        self._backend = backend
        self._sender = sender
        self._deduplicator = deduplicator
        self._read_receipts = read_receipts
        self._event_sink = event_sink
        self._lifecycle = LifecycleManager()
        self._lifecycle.add_resource(name="backend", resource=self._backend)
        self._lifecycle.add_resource(name="sender", resource=self._sender)
        self._lifecycle.add_resource(name="deduplicator", resource=self._deduplicator)
        self._lifecycle.add_resource(name="read_receipts", resource=self._read_receipts)
        self._lifecycle.add_resource(name="event_sink", resource=self._event_sink)
        self._pending_attachments: dict[str, list[_PendingAttachment]] = {}
        self._pending_attachments_lock = asyncio.Lock()
        self._pending_attachments_ttl_seconds = 1800.0
        self._pending_attachments_max_items = 8
        self._deliverable_transfer_max_files = 6
        self._inflight_dedup_keys: set[str] = set()
        self._inflight_dedup_lock = asyncio.Lock()

    async def startup(self) -> None:
        await self._lifecycle.startup()

    async def shutdown(self) -> None:
        await self._lifecycle.shutdown()

    async def handle_callback(self, payload: dict[str, Any]) -> dict[str, Any]:
        header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
        token = str(
            payload.get("token", "") or header.get("token", "") or ""
        ).strip()
        if (
            self._settings.verification_token
            and token != self._settings.verification_token
        ):
            raise HTTPException(status_code=403, detail="invalid verification token")

        challenge = payload.get("challenge")
        if isinstance(challenge, str) and challenge:
            return {"challenge": challenge}

        event_type = str(header.get("event_type", "") or payload.get("type", "")).strip()
        if event_type == "im.message.message_read_v1":
            return await self._handle_read_callback(payload)
        if event_type != "im.message.receive_v1":
            return {"code": 0, "msg": "ignored"}

        event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
        sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
        if str(sender.get("sender_type", "") or "").strip().lower() == "app":
            return {"code": 0, "msg": "ignored self message"}

        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        message_type = str(message.get("message_type", "") or "text").strip().lower()
        content = message.get("content")
        message_text = self._extract_text(content)
        file_key, file_name = self._extract_file_info(content)
        image_key, image_name = self._extract_image_info(content)
        resource_kind: str | None = None
        resource_key: str | None = None
        resource_name: str | None = None
        if file_key:
            resource_kind = "file"
            resource_key = file_key
            resource_name = file_name
        elif image_key:
            resource_kind = "image"
            resource_key = image_key
            resource_name = image_name
        if message_type == "text":
            if not message_text and resource_kind is None:
                return {"code": 0, "msg": "ignored empty message"}
        elif message_type == "file" or resource_kind == "file":
            if not file_key:
                return {"code": 0, "msg": "ignored invalid file message"}
            resource_kind = "file"
            resource_key = file_key
            resource_name = file_name
        elif message_type == "image" or resource_kind == "image":
            if not image_key:
                return {"code": 0, "msg": "ignored invalid image message"}
            resource_kind = "image"
            resource_key = image_key
            resource_name = image_name
        else:
            return {"code": 0, "msg": "ignored unsupported message type"}
        dedup_key = self._build_webhook_dedup_key(payload, message)
        source_event_id = str(header.get("event_id", "") or "").strip() or None
        source_message_id = str(message.get("message_id", "") or "").strip() or None
        logger.info(
            "Feishu webhook inbound: message_id=%s chat_id=%s message_type=%s has_text=%s has_file_key=%s has_image_key=%s resource_kind=%s dedup_key=%s",
            str(message.get("message_id", "") or "").strip(),
            str(message.get("chat_id", "") or "").strip(),
            message_type,
            bool(message_text),
            bool(file_key),
            bool(image_key),
            str(resource_kind or ""),
            dedup_key,
        )
        if not self._deduplicator.should_process(
            dedup_key,
            source_message_id=source_message_id,
            source_event_id=source_event_id,
        ):
            return {"code": 0, "msg": "ignored duplicate message"}
        if not await self._try_enter_inflight_dedup_key(dedup_key):
            logger.info("Feishu webhook inbound ignored inflight duplicate: dedup_key=%s", dedup_key)
            return {"code": 0, "msg": "ignored inflight duplicate message"}

        try:
            chat_id = str(message.get("chat_id", "") or "").strip()
            message_id = str(message.get("message_id", "") or "").strip() or None
            user_id = self._extract_sender_user_id(sender.get("sender_id"))
            if not chat_id or not user_id:
                raise HTTPException(status_code=400, detail="missing chat_id or sender user_id")
            if not channel_identity_is_allowed(
                user_id=user_id,
                channel_id=chat_id,
                allowed_user_ids=self._settings.allowed_user_ids,
                allowed_channel_ids=self._settings.allowed_channel_ids,
            ):
                logger.info(
                    "Ignored Feishu message from unauthorized identity user=%s chat=%s",
                    user_id,
                    chat_id,
                )
                return {"code": 0, "msg": "ignored unauthorized message"}
            session_id = f"feishu:{chat_id}:{user_id}"

            if resource_kind and resource_key:
                downloaded_path: str | None = None
                if message_id:
                    if resource_kind == "file":
                        downloaded_path = await self._download_and_store_file_resource(
                            session_id=session_id,
                            message_id=message_id,
                            file_key=resource_key,
                            file_name=resource_name,
                        )
                    else:
                        downloaded_path = await self._download_and_store_image_resource(
                            session_id=session_id,
                            message_id=message_id,
                            image_key=resource_key,
                            image_name=resource_name,
                        )
                else:
                    logger.warning(
                        "Feishu resource message missing message_id; skip auto-download: chat_id=%s user_id=%s resource_kind=%s resource_key=%s",
                        chat_id,
                        user_id,
                        resource_kind,
                        resource_key,
                    )
                pending_total = 0
                if downloaded_path:
                    pending_total = await self._cache_pending_attachment(
                        session_id=session_id,
                        kind=resource_kind,
                        key=resource_key,
                        name=resource_name,
                        path=downloaded_path,
                        message_id=message_id,
                    )
                await self._reply_direct_message(
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    text=self._build_resource_ack_text(
                        resource_kind=resource_kind,
                        resource_name=resource_name,
                        downloaded_path=downloaded_path,
                        pending_total=pending_total,
                    ),
                )
                return {"code": 0, "msg": "ok"}

            await self._reply_to_message_with_cached_attachments(
                chat_id=chat_id,
                user_id=user_id,
                session_id=session_id,
                text=message_text,
                message_id=message_id,
                raw_event=payload,
            )
            return {"code": 0, "msg": "ok"}
        finally:
            await self._leave_inflight_dedup_key(dedup_key)

    async def handle_sdk_event(self, data: P2ImMessageReceiveV1) -> None:
        event = data.event
        if event is None or event.sender is None or event.message is None:
            return
        if str(event.sender.sender_type or "").strip().lower() == "app":
            return
        message = event.message
        message_type = str(message.message_type or "text").strip().lower()
        message_text = self._extract_text(message.content)
        file_key, file_name = self._extract_file_info(message.content)
        image_key, image_name = self._extract_image_info(message.content)
        resource_kind: str | None = None
        resource_key: str | None = None
        resource_name: str | None = None
        if file_key:
            resource_kind = "file"
            resource_key = file_key
            resource_name = file_name
        elif image_key:
            resource_kind = "image"
            resource_key = image_key
            resource_name = image_name
        if message_type == "text":
            if not message_text and resource_kind is None:
                return
        elif message_type == "file" or resource_kind == "file":
            if not file_key:
                return
            resource_kind = "file"
            resource_key = file_key
            resource_name = file_name
        elif message_type == "image" or resource_kind == "image":
            if not image_key:
                return
            resource_kind = "image"
            resource_key = image_key
            resource_name = image_name
        else:
            return
        dedup_key = self._build_sdk_dedup_key(data, message)
        header = getattr(data, "header", None)
        source_event_id = str(getattr(header, "event_id", "") or "").strip() or None
        source_message_id = str(getattr(message, "message_id", "") or "").strip() or None
        logger.info(
            "Feishu SDK inbound: message_id=%s chat_id=%s message_type=%s has_text=%s has_file_key=%s has_image_key=%s resource_kind=%s dedup_key=%s",
            str(message.message_id or "").strip(),
            str(message.chat_id or "").strip(),
            message_type,
            bool(message_text),
            bool(file_key),
            bool(image_key),
            str(resource_kind or ""),
            dedup_key,
        )
        if not self._deduplicator.should_process(
            dedup_key,
            source_message_id=source_message_id,
            source_event_id=source_event_id,
        ):
            return
        if not await self._try_enter_inflight_dedup_key(dedup_key):
            logger.info("Feishu SDK inbound ignored inflight duplicate: dedup_key=%s", dedup_key)
            return
        try:
            user_id = self._extract_sender_user_id(event.sender.sender_id)
            chat_id = str(message.chat_id or "").strip()
            message_id = str(message.message_id or "").strip() or None
            if not user_id or not chat_id:
                return
            if not channel_identity_is_allowed(
                user_id=user_id,
                channel_id=chat_id,
                allowed_user_ids=self._settings.allowed_user_ids,
                allowed_channel_ids=self._settings.allowed_channel_ids,
            ):
                logger.info(
                    "Ignored Feishu SDK message from unauthorized identity user=%s chat=%s",
                    user_id,
                    chat_id,
                )
                return
            session_id = f"feishu:{chat_id}:{user_id}"

            if resource_kind and resource_key:
                downloaded_path: str | None = None
                if message_id:
                    if resource_kind == "file":
                        downloaded_path = await self._download_and_store_file_resource(
                            session_id=session_id,
                            message_id=message_id,
                            file_key=resource_key,
                            file_name=resource_name,
                        )
                    else:
                        downloaded_path = await self._download_and_store_image_resource(
                            session_id=session_id,
                            message_id=message_id,
                            image_key=resource_key,
                            image_name=resource_name,
                        )
                else:
                    logger.warning(
                        "Feishu SDK resource message missing message_id; skip auto-download: chat_id=%s user_id=%s resource_kind=%s resource_key=%s",
                        chat_id,
                        user_id,
                        resource_kind,
                        resource_key,
                    )
                pending_total = 0
                if downloaded_path:
                    pending_total = await self._cache_pending_attachment(
                        session_id=session_id,
                        kind=resource_kind,
                        key=resource_key,
                        name=resource_name,
                        path=downloaded_path,
                        message_id=message_id,
                    )
                await self._reply_direct_message(
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    text=self._build_resource_ack_text(
                        resource_kind=resource_kind,
                        resource_name=resource_name,
                        downloaded_path=downloaded_path,
                        pending_total=pending_total,
                    ),
                )
                return

            await self._reply_to_message_with_cached_attachments(
                chat_id=chat_id,
                user_id=user_id,
                session_id=session_id,
                text=message_text,
                message_id=message_id,
                raw_event={},
            )
        finally:
            await self._leave_inflight_dedup_key(dedup_key)

    async def handle_sdk_read_event(self, data: P2ImMessageMessageReadV1) -> None:
        event = data.event
        if event is None or not event.message_id_list:
            return
        reader = event.reader
        reader_id = getattr(reader, "reader_id", None)
        reader_open_id = str(getattr(reader_id, "open_id", "") or "").strip() or None
        read_time = str(getattr(reader, "read_time", "") or "").strip() or None
        tenant_key = str(getattr(reader, "tenant_key", "") or "").strip() or None
        for raw_message_id in event.message_id_list:
            record = self._read_receipts.mark_read(
                message_id=str(raw_message_id or "").strip(),
                reader_open_id=reader_open_id,
                read_time=read_time,
                tenant_key=tenant_key,
            )
            await self._publish_read_receipt_event(record)

    async def _try_enter_inflight_dedup_key(self, dedup_key: str | None) -> bool:
        key = str(dedup_key or "").strip()
        if not key:
            return True
        async with self._inflight_dedup_lock:
            if key in self._inflight_dedup_keys:
                return False
            self._inflight_dedup_keys.add(key)
            return True

    async def _leave_inflight_dedup_key(self, dedup_key: str | None) -> None:
        key = str(dedup_key or "").strip()
        if not key:
            return
        async with self._inflight_dedup_lock:
            self._inflight_dedup_keys.discard(key)

    async def _reply_to_message_with_cached_attachments(
        self,
        *,
        chat_id: str,
        user_id: str,
        session_id: str,
        text: str,
        message_id: str | None,
        raw_event: dict[str, Any],
    ) -> None:
        pending_context = await self._get_pending_attachment_context(session_id=session_id)
        merged_text = self._merge_user_text_with_attachments(text=text, attachments=pending_context)
        merged_raw_event = self._inject_pending_attachments(raw_event=raw_event, attachments=pending_context)
        await self._reply_to_message(
            chat_id=chat_id,
            user_id=user_id,
            text=merged_text,
            message_id=message_id,
            raw_event=merged_raw_event,
        )
        if pending_context:
            await self._clear_pending_attachments(session_id=session_id)

    async def _reply_to_message(
        self,
        *,
        chat_id: str,
        user_id: str,
        text: str,
        message_id: str | None,
        raw_event: dict[str, Any],
    ) -> None:
        placeholder_message_id: str | None = None
        if message_id:
            placeholder_message_id = await self._acknowledge_incoming_message(message_id=message_id)
        envelope = ChatEnvelope(
            platform="feishu",
            session_id=f"feishu:{chat_id}:{user_id}",
            user_id=user_id,
            channel_id=chat_id,
            text=text,
            message_id=message_id,
            raw_event=raw_event,
        )
        try:
            resolver = getattr(self._backend, "resolve_pending_interaction", None)
            reply = (
                await resolver(envelope.session_id, raw_text=text)
                if callable(resolver)
                else None
            )
            if reply is None:
                reply = await self._backend.respond(envelope)
        except PendingInteractiveRequestError as exc:
            await self._send_reply_text(
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                text=format_pending_interaction_text(exc.payload),
                skip_acknowledge=True,
                placeholder_message_id=placeholder_message_id,
            )
            return
        except (
            ModelAuthenticationError,
            ModelConnectionError,
            ModelRateLimitError,
        ) as exc:
            logger.warning(
                "Feishu backend model service error category=%s provider=%s session_id=%s message_id=%s error=%s",
                exc.category,
                exc.provider or "",
                envelope.session_id,
                message_id or "",
                exc.message,
            )
            await self._send_reply_text(
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                text=_format_model_service_error_text(exc),
                skip_acknowledge=True,
                placeholder_message_id=placeholder_message_id,
            )
            return
        reply_text = str(reply.text or "").strip()
        reply_metadata = reply.metadata if isinstance(reply.metadata, dict) else {}
        card_payload = self._extract_transport_card(reply_metadata)
        structured_deliverables = self._extract_structured_deliverables(
            reply_metadata=reply_metadata
        )
        rendered_reply_text = self._render_transport_reply_text(
            assistant_text=reply_text,
            card_payload=card_payload,
        )
        text_to_send = rendered_reply_text
        if structured_deliverables:
            sent_paths, failed_paths = (
                await self._deliver_structured_deliverables_to_feishu(
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    session_id=envelope.session_id,
                    deliverables=structured_deliverables,
                )
            )
            await self._record_transport_delivery_receipts_safely(
                session_id=envelope.session_id,
                turn_id=str(reply_metadata.get("turn_id") or "").strip(),
                directives=reply_metadata.get("transport_directives"),
                sent_paths=sent_paths,
                failed_paths=failed_paths,
            )
            receipt_notice = format_transport_receipt_notice(
                channel_label="飞书",
                accepted_count=len(sent_paths),
                failed_count=len(failed_paths),
            )
            text_to_send = "\n\n".join(
                part for part in (text_to_send, receipt_notice) if part
            )
        if text_to_send or not structured_deliverables:
            await self._send_reply_text(
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                text=text_to_send or "没有生成可发送的回复。",
                skip_acknowledge=True,
                placeholder_message_id=placeholder_message_id,
            )
        if structured_deliverables:
            return

    async def _reply_direct_message(
        self,
        *,
        chat_id: str,
        user_id: str,
        message_id: str | None,
        text: str,
    ) -> None:
        await self._send_reply_text(
            chat_id=chat_id,
            user_id=user_id,
            message_id=message_id,
            text=text,
        )

    async def _send_reply_text(
        self,
        *,
        chat_id: str,
        user_id: str,
        message_id: str | None,
        text: str,
        skip_acknowledge: bool = False,
        placeholder_message_id: str | None = None,
    ) -> None:
        if not skip_acknowledge and message_id:
            placeholder_message_id = await self._acknowledge_incoming_message(message_id=message_id)
        send_result: dict[str, Any] | None = None
        final_message_id: str | None = None
        if placeholder_message_id:
            try:
                send_result = await self._sender.update_text(message_id=placeholder_message_id, text=text)
                final_message_id = placeholder_message_id
            except Exception as exc:
                logger.warning(
                    "Feishu placeholder update failed for message_id=%s: %s",
                    placeholder_message_id,
                    exc,
                )
        if final_message_id is None and message_id:
            send_result = await self._sender.reply_text(message_id=message_id, text=text)
        elif final_message_id is None:
            logger.warning("Feishu source message_id missing; falling back to send_text for chat_id=%s", chat_id)
            send_result = await self._sender.send_text(chat_id=chat_id, text=text)
        sent_message_id = final_message_id or self._extract_sent_message_id(send_result)
        if sent_message_id:
            self._read_receipts.register_outbound(
                message_id=sent_message_id,
                chat_id=chat_id,
                user_id=user_id,
                source_message_id=message_id,
                text=text,
            )

    async def _deliver_structured_deliverables_to_feishu(
        self,
        *,
        chat_id: str,
        user_id: str,
        message_id: str | None,
        session_id: str,
        deliverables: list[_StructuredDeliverable],
    ) -> tuple[list[str], list[str]]:
        if not deliverables:
            return [], []
        sent_paths: list[str] = []
        failed_paths: list[str] = []
        for item in deliverables[: self._deliverable_transfer_max_files]:
            try:
                if item.caption:
                    await self._send_reply_text(
                        chat_id=chat_id,
                        user_id=user_id,
                        message_id=message_id,
                        text=item.caption,
                        skip_acknowledge=True,
                    )
                if self._is_image_file_path(item.path):
                    await self._send_image_path_to_feishu(
                        chat_id=chat_id,
                        message_id=message_id,
                        image_path=item.path,
                    )
                else:
                    await self._send_file_path_to_feishu(
                        chat_id=chat_id,
                        message_id=message_id,
                        file_path=item.path,
                    )
                sent_paths.append(item.path)
            except Exception as exc:
                failed_paths.append(item.path)
                logger.warning(
                    "Feishu structured deliverable transfer failed: session_id=%s message_id=%s path=%s error=%s",
                    session_id,
                    message_id,
                    item.path,
                    exc,
                )
        if sent_paths:
            logger.info(
                "Feishu structured deliverables transferred: session_id=%s message_id=%s count=%d paths=%s",
                session_id,
                message_id,
                len(sent_paths),
                sent_paths,
            )
        if failed_paths:
            logger.warning(
                "Feishu structured deliverables transfer incomplete: session_id=%s message_id=%s failed_count=%d failed_paths=%s",
                session_id,
                message_id,
                len(failed_paths),
                failed_paths,
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
        delivery_id = str(directives.get("delivery_id") or "").strip()
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
                "attempt_count": 1,
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
                channel="feishu",
                results=results,
            )
        except Exception:
            logger.exception(
                "Feishu transport receipt callback failed: session_id=%s turn_id=%s delivery_id=%s",
                session_id,
                turn_id,
                delivery_id,
            )

    async def _send_file_path_to_feishu(
        self,
        *,
        chat_id: str,
        message_id: str | None,
        file_path: str,
    ) -> None:
        file_key = await self._sender.upload_file_from_path(
            file_path=file_path,
            file_type="stream",
        )
        if message_id:
            await self._sender.reply_file(message_id=message_id, file_key=file_key)
            return
        await self._sender.send_file(chat_id=chat_id, file_key=file_key)

    async def _send_image_path_to_feishu(
        self,
        *,
        chat_id: str,
        message_id: str | None,
        image_path: str,
    ) -> None:
        image_key = await self._sender.upload_image_from_path(
            image_path=image_path,
            image_type="message",
        )
        if message_id:
            await self._sender.reply_image(message_id=message_id, image_key=image_key)
            return
        await self._sender.send_image(chat_id=chat_id, image_key=image_key)

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
            if _FEISHU_RESOURCE_DATA_SEGMENT in resolved_text or resolved_text in seen:
                continue
            seen.add(resolved_text)
            deliverables.append(
                _StructuredDeliverable(
                    path=resolved_text,
                    caption=str(raw_item.get("caption") or "").strip(),
                    label=str(raw_item.get("label") or "").strip(),
                )
            )
        return deliverables[: self._deliverable_transfer_max_files]

    @classmethod
    def _render_transport_reply_text(
        cls,
        *,
        assistant_text: str,
        card_payload: dict[str, Any] | None,
    ) -> str:
        if not isinstance(card_payload, dict):
            return str(assistant_text or "").strip()
        lines: list[str] = []
        title = str(card_payload.get("title") or "").strip()
        summary = str(card_payload.get("summary") or "").strip()
        body = str(card_payload.get("body") or "").strip()
        footer = str(card_payload.get("footer") or "").strip()
        bullets = [
            str(item or "").strip()
            for item in list(card_payload.get("bullets") or [])
            if str(item or "").strip()
        ]
        if title:
            lines.append(title)
        if summary:
            lines.append(summary)
        elif assistant_text:
            lines.append(str(assistant_text).strip())
        elif body:
            lines.append(body)
        if body and body not in lines:
            lines.append(body)
        for item in bullets[:6]:
            lines.append(f"- {item}")
        if footer:
            lines.append(footer)
        rendered = "\n".join(line for line in lines if line).strip()
        return rendered or str(assistant_text or "").strip()

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
    def _is_image_file_path(path: str) -> bool:
        suffix = str(Path(path).suffix or "").strip().lower()
        return suffix in _IMAGE_SUFFIXES

    async def _acknowledge_incoming_message(self, *, message_id: str) -> str | None:
        ack_mode = self._settings.ack_mode
        if ack_mode == "none":
            return None
        if ack_mode == "reaction":
            try:
                await self._sender.add_reaction(
                    message_id=message_id,
                    emoji_type=self._settings.ack_reaction_emoji,
                )
            except Exception as exc:
                logger.warning("Feishu reaction acknowledgement failed for message_id=%s: %s", message_id, exc)
            return None
        if ack_mode == "placeholder":
            try:
                result = await self._sender.reply_text(
                    message_id=message_id,
                    text=self._settings.ack_placeholder_text,
                )
            except Exception as exc:
                logger.warning("Feishu placeholder acknowledgement failed for message_id=%s: %s", message_id, exc)
                return None
            return self._extract_sent_message_id(result)
        return None

    async def _handle_read_callback(self, payload: dict[str, Any]) -> dict[str, Any]:
        event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
        reader = event.get("reader") if isinstance(event.get("reader"), dict) else {}
        reader_id = reader.get("reader_id") if isinstance(reader.get("reader_id"), dict) else {}
        reader_open_id = str(reader_id.get("open_id", "") or "").strip() or None
        read_time = str(reader.get("read_time", "") or "").strip() or None
        tenant_key = str(reader.get("tenant_key", "") or "").strip() or None
        message_ids = event.get("message_id_list") if isinstance(event.get("message_id_list"), list) else []
        for raw_message_id in message_ids:
            record = self._read_receipts.mark_read(
                message_id=str(raw_message_id or "").strip(),
                reader_open_id=reader_open_id,
                read_time=read_time,
                tenant_key=tenant_key,
            )
            await self._publish_read_receipt_event(record)
        return {"code": 0, "msg": "ok"}

    async def _publish_read_receipt_event(self, record: FeishuOutboundMessage | None) -> None:
        if record is None:
            return
        if record.read_event_emitted:
            return
        await self._event_sink.publish(
            AdapterEvent(
                platform="feishu",
                event_type="message_read",
                session_id=f"feishu:{record.chat_id}:{record.user_id}",
                channel_id=record.chat_id,
                user_id=record.user_id,
                message_id=record.message_id,
                payload={
                    "source_message_id": record.source_message_id,
                    "text": record.text,
                    "sent_at": record.sent_at,
                    "read_at": record.read_at,
                    "read_by_open_id": record.read_by_open_id,
                    "tenant_key": record.tenant_key,
                },
            )
        )
        self._read_receipts.mark_read_event_emitted(message_id=record.message_id)

    @staticmethod
    def _extract_text(raw_content: Any) -> str:
        if isinstance(raw_content, dict):
            return str(raw_content.get("text", "") or "").strip()
        if isinstance(raw_content, str):
            raw_text = raw_content.strip()
            if not raw_text:
                return ""
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                return raw_text
            if isinstance(parsed, dict):
                return str(parsed.get("text", "") or "").strip()
        return ""

    @staticmethod
    def _extract_file_info(raw_content: Any) -> tuple[str | None, str | None]:
        payload: dict[str, Any] = {}
        if isinstance(raw_content, dict):
            payload = raw_content
        elif isinstance(raw_content, str):
            raw_text = raw_content.strip()
            if not raw_text:
                return (None, None)
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                return (None, None)
            if isinstance(parsed, dict):
                payload = parsed
        file_key = str(payload.get("file_key", "") or "").strip() or None
        file_name = str(payload.get("file_name", "") or "").strip() or None
        return (file_key, file_name)

    @staticmethod
    def _extract_image_info(raw_content: Any) -> tuple[str | None, str | None]:
        payload: dict[str, Any] = {}
        if isinstance(raw_content, dict):
            payload = raw_content
        elif isinstance(raw_content, str):
            raw_text = raw_content.strip()
            if not raw_text:
                return (None, None)
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                return (None, None)
            if isinstance(parsed, dict):
                payload = parsed
        image_key = str(payload.get("image_key", "") or "").strip() or None
        image_name = str(payload.get("image_name", "") or "").strip() or None
        if not image_name:
            image_name = str(payload.get("file_name", "") or "").strip() or None
        return (image_key, image_name)

    @staticmethod
    def _build_resource_ack_text(
        *,
        resource_kind: str,
        resource_name: str | None,
        downloaded_path: str | None,
        pending_total: int,
    ) -> str:
        label = "文件" if resource_kind == "file" else "图片"
        display_name = str(resource_name or "").strip()
        name_suffix = f"：{display_name}" if display_name else ""
        if downloaded_path:
            cache_suffix = f"（当前待处理附件 {pending_total} 个）" if pending_total > 0 else ""
            return (
                f"已收到{label}{name_suffix}，并已保存到：{downloaded_path}{cache_suffix}\n"
                "请继续发送文字指令，我会结合该附件一起处理。"
            )
        return f"已收到{label}{name_suffix}，但下载失败，请稍后重试。"

    async def _cache_pending_attachment(
        self,
        *,
        session_id: str,
        kind: str,
        key: str,
        name: str | None,
        path: str,
        message_id: str | None,
    ) -> int:
        now = time.monotonic()
        entry = _PendingAttachment(
            kind=kind,
            key=key,
            name=name,
            path=path,
            message_id=message_id,
            created_at=now,
        )
        async with self._pending_attachments_lock:
            self._cleanup_expired_pending_attachments_locked(now=now)
            bucket = self._pending_attachments.setdefault(session_id, [])
            bucket.append(entry)
            if len(bucket) > self._pending_attachments_max_items:
                del bucket[:-self._pending_attachments_max_items]
            return len(bucket)

    async def _get_pending_attachment_context(self, *, session_id: str) -> list[dict[str, Any]]:
        now = time.monotonic()
        async with self._pending_attachments_lock:
            self._cleanup_expired_pending_attachments_locked(now=now)
            bucket = self._pending_attachments.get(session_id) or []
            context: list[dict[str, Any]] = []
            for item in bucket:
                context.append(
                    {
                        "kind": item.kind,
                        "key": item.key,
                        "name": item.name,
                        "path": item.path,
                        "message_id": item.message_id,
                    }
                )
            return context

    async def _clear_pending_attachments(self, *, session_id: str) -> None:
        async with self._pending_attachments_lock:
            self._pending_attachments.pop(session_id, None)

    def _cleanup_expired_pending_attachments_locked(self, *, now: float) -> None:
        expired_before = now - self._pending_attachments_ttl_seconds
        stale_sessions: list[str] = []
        for session_id, bucket in self._pending_attachments.items():
            kept = [item for item in bucket if item.created_at >= expired_before]
            if kept:
                self._pending_attachments[session_id] = kept[-self._pending_attachments_max_items :]
            else:
                stale_sessions.append(session_id)
        for session_id in stale_sessions:
            self._pending_attachments.pop(session_id, None)

    @staticmethod
    def _merge_user_text_with_attachments(*, text: str, attachments: list[dict[str, Any]]) -> str:
        plain_text = str(text or "").strip()
        if not attachments:
            return plain_text
        lines = [
            "【本会话附件上下文】",
            "以下文件/图片是用户在当前会话刚发送的，请结合这些路径完成任务。",
        ]
        for idx, item in enumerate(attachments, start=1):
            kind = "文件" if str(item.get("kind", "")).strip().lower() == "file" else "图片"
            name = str(item.get("name", "") or "").strip() or "(未命名)"
            path = str(item.get("path", "") or "").strip()
            lines.append(f"{idx}. {kind}: {name}")
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
    def _extract_sender_user_id(raw_sender_id: Any) -> str | None:
        if isinstance(raw_sender_id, dict):
            for key in ("open_id", "user_id", "union_id"):
                value = str(raw_sender_id.get(key, "") or "").strip()
                if value:
                    return value
            return None
        for key in ("open_id", "user_id", "union_id"):
            value = str(getattr(raw_sender_id, key, "") or "").strip()
            if value:
                return value
        return None

    async def _download_and_store_file_resource(
        self,
        *,
        session_id: str,
        message_id: str,
        file_key: str,
        file_name: str | None,
    ) -> str | None:
        day_segment = datetime.now().strftime("%Y-%m-%d")
        workspace = session_workspace_dir(
            os.getenv("CARDBUSH_APP_DATA_DIR"),
            session_id,
        )
        target_dir = workspace / "feishu_sdk_resouce_data" / day_segment
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = self._allocate_target_file_path(
            target_dir=target_dir,
            file_name=file_name,
            fallback_key=file_key,
        )
        try:
            download_to_path = getattr(
                self._sender,
                "download_message_resource_to_path",
                None,
            )
            if callable(download_to_path):
                byte_count = int(
                    await download_to_path(
                        message_id=message_id,
                        file_key=file_key,
                        target_path=target_path,
                        resource_type="file",
                    )
                )
            else:
                content = await self._sender.download_message_resource(
                    message_id=message_id,
                    file_key=file_key,
                    resource_type="file",
                )
                if not content:
                    logger.warning(
                        "Feishu file download returned empty content: session_id=%s message_id=%s file_key=%s",
                        session_id,
                        message_id,
                        file_key,
                    )
                    return None
                target_path.write_bytes(content)
                byte_count = len(content)
        except Exception as exc:
            logger.warning(
                "Feishu file download failed: session_id=%s message_id=%s file_key=%s error=%s",
                session_id,
                message_id,
                file_key,
                exc,
            )
            return None
        logger.info(
            "Feishu file saved: session_id=%s message_id=%s file_key=%s path=%s bytes=%d",
            session_id,
            message_id,
            file_key,
            target_path,
            byte_count,
        )
        return str(target_path)

    async def _download_and_store_image_resource(
        self,
        *,
        session_id: str,
        message_id: str,
        image_key: str,
        image_name: str | None,
    ) -> str | None:
        day_segment = datetime.now().strftime("%Y-%m-%d")
        workspace = session_workspace_dir(
            os.getenv("CARDBUSH_APP_DATA_DIR"),
            session_id,
        )
        target_dir = workspace / "feishu_sdk_resouce_data" / day_segment
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = self._allocate_target_file_path(
            target_dir=target_dir,
            file_name=image_name,
            fallback_key=image_key,
        )
        try:
            download_to_path = getattr(
                self._sender,
                "download_message_resource_to_path",
                None,
            )
            if callable(download_to_path):
                byte_count = int(
                    await download_to_path(
                        message_id=message_id,
                        file_key=image_key,
                        target_path=target_path,
                        resource_type="image",
                    )
                )
            else:
                content = await self._sender.download_message_resource(
                    message_id=message_id,
                    file_key=image_key,
                    resource_type="image",
                )
                if not content:
                    logger.warning(
                        "Feishu image download returned empty content: session_id=%s message_id=%s image_key=%s",
                        session_id,
                        message_id,
                        image_key,
                    )
                    return None
                target_path.write_bytes(content)
                byte_count = len(content)
        except Exception as exc:
            logger.warning(
                "Feishu image download failed: session_id=%s message_id=%s image_key=%s error=%s",
                session_id,
                message_id,
                image_key,
                exc,
            )
            return None
        logger.info(
            "Feishu image saved: session_id=%s message_id=%s image_key=%s path=%s bytes=%d",
            session_id,
            message_id,
            image_key,
            target_path,
            byte_count,
        )
        return str(target_path)

    @staticmethod
    def _allocate_target_file_path(
        *,
        target_dir: Path,
        file_name: str | None,
        fallback_key: str,
    ) -> Path:
        raw_name = Path(str(file_name or "").strip()).name
        if not raw_name:
            raw_name = f"{fallback_key}.bin"
        candidate = target_dir / raw_name
        if not candidate.exists():
            return candidate
        stem = candidate.stem or "file"
        suffix = candidate.suffix
        index = 1
        while True:
            next_candidate = target_dir / f"{stem}_{index}{suffix}"
            if not next_candidate.exists():
                return next_candidate
            index += 1

    @staticmethod
    def _build_webhook_dedup_key(payload: dict[str, Any], message: dict[str, Any]) -> str | None:
        message_id = str(message.get("message_id", "") or "").strip()
        if message_id:
            return f"message:{message_id}"
        header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
        event_id = str(header.get("event_id", "") or "").strip()
        if event_id:
            return f"event:{event_id}"
        return None

    @staticmethod
    def _build_sdk_dedup_key(data: P2ImMessageReceiveV1, message: Any) -> str | None:
        message_id = str(getattr(message, "message_id", "") or "").strip()
        if message_id:
            return f"message:{message_id}"
        header = getattr(data, "header", None)
        event_id = str(getattr(header, "event_id", "") or "").strip()
        if event_id:
            return f"event:{event_id}"
        return None

    @staticmethod
    def _extract_sent_message_id(result: Any) -> str | None:
        if not isinstance(result, dict):
            return None
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        message_id = str(data.get("message_id", "") or "").strip()
        return message_id or None


def build_service(
    settings: FeishuBotSettings | None = None,
    *,
    backend: ConversationBackend | None = None,
    sender: FeishuMessageClient | None = None,
    deduplicator: FeishuMessageDeduplicator | None = None,
    read_receipts: FeishuReadReceiptStore | None = None,
    event_sink: AdapterEventSink | None = None,
) -> FeishuBotService:
    resolved_settings = settings or FeishuBotSettings.from_env()
    resolved_backend = backend or load_bushserver_backend_from_env()
    resolved_sender = sender or FeishuMessageClient(resolved_settings)
    dedup_sqlite_path = _resolve_feishu_dedup_sqlite_path(resolved_settings)
    resolved_deduplicator = deduplicator or FeishuMessageDeduplicator(
        ttl_seconds=resolved_settings.dedup_ttl_seconds,
        max_entries=resolved_settings.dedup_max_entries,
        sqlite_path=dedup_sqlite_path,
        sqlite_ttl_seconds=max(
            resolved_settings.dedup_ttl_seconds,
            resolved_settings.dedup_persistent_ttl_seconds,
        ),
    )
    resolved_read_receipts = read_receipts or FeishuReadReceiptStore(
        ttl_seconds=max(3600.0, resolved_settings.dedup_ttl_seconds),
        max_entries=resolved_settings.dedup_max_entries,
    )
    resolved_event_sink = event_sink or NoopAdapterEventSink()
    return FeishuBotService(
        settings=resolved_settings,
        backend=resolved_backend,
        sender=resolved_sender,
        deduplicator=resolved_deduplicator,
        read_receipts=resolved_read_receipts,
        event_sink=resolved_event_sink,
    )


def create_app(
    settings: FeishuBotSettings | None = None,
    *,
    backend: ConversationBackend | None = None,
    sender: FeishuMessageClient | None = None,
    deduplicator: FeishuMessageDeduplicator | None = None,
    read_receipts: FeishuReadReceiptStore | None = None,
    event_sink: AdapterEventSink | None = None,
) -> FastAPI:
    resolved_settings = settings or FeishuBotSettings.from_env()
    event_bus = InMemoryAdapterEventBus()
    resolved_event_sink = CompositeAdapterEventSink(event_bus, event_sink or NoopAdapterEventSink())
    service = build_service(
        resolved_settings,
        backend=backend,
        sender=sender,
        deduplicator=deduplicator,
        read_receipts=read_receipts,
        event_sink=resolved_event_sink,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await service.startup()
        try:
            yield
        finally:
            await service.shutdown()

    app = FastAPI(
        title="BushServer Feishu Bot Adapter",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.feishu_service = service
    app.state.feishu_settings = resolved_settings
    app.state.feishu_event_bus = event_bus

    def get_service() -> FeishuBotService:
        return app.state.feishu_service

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "mode": resolved_settings.mode}

    @app.get("/feishu/adapter-events")
    async def feishu_adapter_events(request: Request) -> StreamingResponse:
        async def event_stream():
            last_seq = 0
            idle_ticks = 0
            while True:
                if await request.is_disconnected():
                    break
                records = event_bus.poll_after(last_seq)
                if records:
                    for record in records:
                        last_seq = max(last_seq, int(record["seq"]))
                        yield f"id: {record['seq']}\n"
                        yield "event: adapter_event\n"
                        yield f"data: {json.dumps(record, ensure_ascii=False)}\n\n"
                    idle_ticks = 0
                    continue
                idle_ticks += 1
                if idle_ticks >= 10:
                    yield ": ping\n\n"
                    idle_ticks = 0
                await asyncio.sleep(0.5)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    @app.post("/feishu/events")
    async def feishu_events(
        request: Request,
        bot_service: FeishuBotService = Depends(get_service),
    ) -> dict[str, Any]:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid payload")
        return await bot_service.handle_callback(payload)

    return app
