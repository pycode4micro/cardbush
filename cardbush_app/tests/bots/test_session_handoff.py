from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from cardbush_app.adapters.common import ChatEnvelope
from cardbush_app.adapters.common.backend import BushServerStreamBackend, BushServerStreamSettings
from cardbush_app.adapters.common.session_links import SessionLinkKey, SessionLinkStore


class _ConsumeClient:
    def __init__(self, *, session_id: str = "shared-session") -> None:
        self.session_id = session_id
        self.calls: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={
                "protocol": "bush.session_handoff.v1",
                "session_id": self.session_id,
            },
        )


def _envelope(text: str) -> ChatEnvelope:
    return ChatEnvelope(
        platform="weixin",
        session_id="weixin:account:user",
        user_id="user",
        channel_id="account",
        text=text,
        message_id="message-1",
    )


def test_session_link_store_is_scoped_by_platform_channel_and_user(
    tmp_path: Path,
) -> None:
    store = SessionLinkStore(tmp_path / "links.sqlite3")
    key = SessionLinkKey.create(
        platform="weixin",
        channel_id="account",
        user_id="user",
    )

    assert store.resolve(key) is None
    store.bind(key, "shared-session")
    assert store.resolve(key) == "shared-session"
    assert store.resolve(
        SessionLinkKey.create(
            platform="feishu",
            channel_id="account",
            user_id="user",
        )
    ) is None
    assert store.unbind(key) is True
    assert store.resolve(key) is None
    assert store.unbind(key) is False


def test_stream_backend_consumes_link_and_reuses_session_without_llm(
    tmp_path: Path,
) -> None:
    async def _run() -> None:
        client = _ConsumeClient()
        store = SessionLinkStore(tmp_path / "links.sqlite3")
        backend = BushServerStreamBackend(
            BushServerStreamSettings(service_base_url="http://127.0.0.1:51717"),
            http_client=client,
            session_link_store=store,
        )

        linked_envelope, reply = await backend._apply_session_link(  # noqa: SLF001
            _envelope("/link ABCDEF123456")
        )
        assert linked_envelope.session_id == "shared-session"
        assert reply is not None
        assert reply.metadata["session_handoff"] == "linked"
        assert len(client.calls) == 1
        assert client.calls[0]["json"] == {
            "platform": "weixin",
            "channel_id": "account",
            "user_id": "user",
        }

        continued_envelope, continued_reply = await backend._apply_session_link(  # noqa: SLF001
            _envelope("继续刚才的工作")
        )
        assert continued_envelope.session_id == "shared-session"
        assert continued_reply is None
        assert len(client.calls) == 1

        _, unlinked_reply = await backend._apply_session_link(  # noqa: SLF001
            _envelope("/unlink")
        )
        assert unlinked_reply is not None
        assert unlinked_reply.metadata == {
            "session_handoff": "unlinked",
            "unlinked": True,
        }
        restored_envelope, _ = await backend._apply_session_link(  # noqa: SLF001
            _envelope("新的 Bot 会话")
        )
        assert restored_envelope.session_id == "weixin:account:user"

    asyncio.run(_run())
