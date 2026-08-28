from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from typing import Any

from lark_oapi import LogLevel
from lark_oapi.api.im.v1 import P2ImMessageMessageReadV1, P2ImMessageReceiveV1
from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
from lark_oapi.ws import Client as FeishuWSClient
from lark_oapi.ws import client as feishu_ws_runtime

from cardbush_app.adapters.common import AsyncBridge

from .app import FeishuBotService
from .config import FeishuBotSettings

logger = logging.getLogger(__name__)

_PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


class FeishuLongConnectionRunner:
    def __init__(self, *, settings: FeishuBotSettings, service: FeishuBotService) -> None:
        self._settings = settings
        self._service = service
        self._bridge = AsyncBridge()
        self._client: FeishuWSClient | None = None
        self._service_started = False
        self._closed = False

    def startup(self) -> None:
        if self._service_started:
            return
        self._bridge.run(self._service.startup())
        self._service_started = True

    def run(self) -> None:
        self.startup()
        self._prepare_network_environment()
        handler = (
            EventDispatcherHandler.builder(
                self._settings.encrypt_key or "",
                self._settings.verification_token or "",
                level=LogLevel.INFO,
            )
            .register_p2_im_message_receive_v1(self._handle_message_event)
            .register_p2_im_message_message_read_v1(self._handle_message_read_event)
            .build()
        )
        self._client = FeishuWSClient(
            self._settings.app_id,
            self._settings.app_secret,
            log_level=LogLevel.INFO,
            event_handler=handler,
            domain=self._settings.api_base,
            auto_reconnect=True,
        )
        try:
            self._client.start()
        except KeyboardInterrupt:
            logger.info("Feishu long connection interrupted; shutting down")
        finally:
            self.shutdown()

    def _prepare_network_environment(self) -> None:
        if not self._settings.disable_env_proxy:
            return
        removed: list[str] = []
        for key in _PROXY_ENV_KEYS:
            value = os.environ.pop(key, None)
            if value:
                removed.append(key)
        if removed:
            logger.info(
                "Feishu proxy environment disabled by FEISHU_DISABLE_ENV_PROXY=1; removed=%s",
                ",".join(sorted(removed)),
            )

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._shutdown_sdk_client()
        if self._service_started:
            with contextlib.suppress(Exception):  # noqa: BLE001
                self._bridge.run(self._service.shutdown())
            self._service_started = False
        self._bridge.close()

    def _shutdown_sdk_client(self) -> None:
        client = self._client
        self._client = None
        if client is None:
            return
        client._auto_reconnect = False
        loop = getattr(feishu_ws_runtime, "loop", None)
        if loop is None or loop.is_closed():
            return
        pending: list[asyncio.Task[Any]] = []
        with contextlib.suppress(RuntimeError):
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
        if getattr(client, "_conn", None) is not None:
            with contextlib.suppress(Exception):  # noqa: BLE001
                loop.run_until_complete(client._disconnect())
        if pending:
            for task in pending:
                task.cancel()
            with contextlib.suppress(Exception):  # noqa: BLE001
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))

    def _handle_message_event(self, data: P2ImMessageReceiveV1) -> None:
        self._bridge.run(self._service.handle_sdk_event(data))

    def _handle_message_read_event(self, data: P2ImMessageMessageReadV1) -> None:
        self._bridge.run(self._service.handle_sdk_read_event(data))
