from __future__ import annotations

import asyncio
from types import SimpleNamespace

from cardbush_app.adapters.common.backend import PendingInteractiveRequestError
from cardbush_app.adapters.discord_bot.app import (
    DISCORD_APPLICATION_COMMAND,
    DISCORD_CHANNEL_MESSAGE_RESPONSE,
    DiscordBotService,
)
from cardbush_app.adapters.discord_bot.config import DiscordBotSettings
from cardbush_app.adapters.discord_bot.gateway import DiscordGatewayRunner


class _PendingBackend:
    async def respond(self, envelope):
        _ = envelope
        raise PendingInteractiveRequestError(
            {
                "title": "继续前请确认",
                "reason": "需要先确认这一步为什么必要。",
                "description": "这个步骤需要你先确认授权。",
                "questions": [
                    {
                        "id": "permission",
                        "label": "权限",
                        "question": "是否允许？",
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }
        )


class _Verifier:
    def verify(self, *, signature_hex: str, timestamp: str, body: bytes) -> bool:
        _ = (signature_hex, timestamp, body)
        return True


def test_discord_service_renders_pending_interaction_reason_text() -> None:
    service = DiscordBotService(
        settings=DiscordBotSettings(
            application_id="app-1",
            bot_token="bot-token",
            public_key="00" * 32,
            mode="webhook",
        ),
        backend=_PendingBackend(),
        verifier=_Verifier(),
    )

    payload = {
        "type": DISCORD_APPLICATION_COMMAND,
        "channel_id": "channel-1",
        "member": {"user": {"id": "user-1"}},
        "data": {
            "name": "ask",
            "options": [{"name": "message", "value": "继续"}],
        },
    }
    service._settings.command_name = "ask"

    result = asyncio.run(service.handle_interaction(payload))

    assert result["type"] == DISCORD_CHANNEL_MESSAGE_RESPONSE
    content = str(result["data"]["content"] or "")
    assert "原因：需要先确认这一步为什么必要。" in content
    assert "继续前请确认" in content
    assert "再次使用 `/ask`" in content


def test_discord_service_resolves_pending_interaction_reply() -> None:
    class _Backend:
        async def resolve_pending_interaction(self, session_id, *, raw_text):
            assert session_id == "discord:channel-1:user-1"
            assert raw_text == "2"
            return SimpleNamespace(text="已收到你的选择，正在继续处理。", metadata={})

        async def respond(self, envelope):
            raise AssertionError(f"must not open a new turn: {envelope}")

    service = DiscordBotService(
        settings=DiscordBotSettings(
            application_id="app-1",
            bot_token="bot-token",
            public_key="00" * 32,
            command_name="ask",
        ),
        backend=_Backend(),
        verifier=_Verifier(),
    )
    payload = {
        "type": DISCORD_APPLICATION_COMMAND,
        "channel_id": "channel-1",
        "member": {"user": {"id": "user-1"}},
        "data": {
            "name": "ask",
            "options": [{"name": "message", "value": "2"}],
        },
    }

    result = asyncio.run(service.handle_interaction(payload))

    assert result["data"]["content"] == "已收到你的选择，正在继续处理。"


def test_discord_service_rejects_unauthorized_user_and_channel() -> None:
    service = DiscordBotService(
        settings=DiscordBotSettings(
            application_id="app-1",
            bot_token="bot-token",
            public_key="00" * 32,
            command_name="ask",
            allowed_user_ids=("allowed-user",),
            allowed_channel_ids=("allowed-channel",),
        ),
        backend=SimpleNamespace(),
        verifier=_Verifier(),
    )
    payload = {
        "type": DISCORD_APPLICATION_COMMAND,
        "channel_id": "denied-channel",
        "member": {"user": {"id": "denied-user"}},
        "data": {
            "name": "ask",
            "options": [{"name": "message", "value": "hello"}],
        },
    }

    result = asyncio.run(service.handle_interaction(payload))

    assert result["data"]["flags"] == 64
    assert "未获授权" in result["data"]["content"]


def test_discord_gateway_ignores_unauthorized_identity() -> None:
    class _Sender:
        async def send_text(self, **kwargs):
            raise AssertionError(f"must not send a reply: {kwargs}")

    class _Backend:
        async def respond(self, envelope):
            raise AssertionError(f"must not call backend: {envelope}")

    runner = DiscordGatewayRunner(
        settings=DiscordBotSettings(
            application_id="app-1",
            bot_token="bot-token",
            allowed_user_ids=("allowed-user",),
            allowed_channel_ids=("allowed-channel",),
        ),
        backend=_Backend(),
        sender=_Sender(),
    )

    asyncio.run(
        runner._handle_message_create(
            {
                "id": "message-1",
                "author": {"id": "denied-user", "bot": False},
                "channel_id": "denied-channel",
                "channel_type": 1,
                "content": "hello",
            }
        )
    )


def test_discord_gateway_renders_pending_interaction_prompt() -> None:
    sent: list[dict[str, object]] = []

    class _Sender:
        async def send_text(self, **kwargs):
            sent.append(dict(kwargs))

    runner = DiscordGatewayRunner(
        settings=DiscordBotSettings(
            application_id="app-1",
            bot_token="bot-token",
        ),
        backend=_PendingBackend(),
        sender=_Sender(),
    )

    asyncio.run(
        runner._handle_message_create(
            {
                "id": "message-1",
                "author": {"id": "user-1", "bot": False},
                "channel_id": "channel-1",
                "channel_type": 1,
                "content": "继续",
            }
        )
    )

    assert len(sent) == 1
    assert sent[0]["channel_id"] == "channel-1"
    assert sent[0]["reply_to_message_id"] == "message-1"
    assert "继续前请确认" in str(sent[0]["text"])
    assert "允许一次" in str(sent[0]["text"])
