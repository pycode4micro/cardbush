from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from cardbush_app.adapters.common.backend import PendingInteractiveRequestError
from cardbush_app.adapters.feishu_bot.app import FeishuBotService
from cardbush_app.adapters.feishu_bot.client import FeishuMessageClient
from cardbush_app.adapters.feishu_bot.config import FeishuBotSettings


class _Backend:
    def __init__(self, report_path: Path) -> None:
        self._report_path = report_path
        self.receipts: list[dict] = []

    async def respond(self, envelope):
        _ = envelope
        self._report_path.parent.mkdir(parents=True, exist_ok=True)
        self._report_path.write_text("report ready", encoding="utf-8")
        return SimpleNamespace(
            text="",
            metadata={
                "turn_id": "turn-feishu-delivery",
                "transport_directives": {
                    "delivery_id": "delivery:feishu-test",
                    "channel": "feishu",
                    "card": {
                        "title": "交付完成",
                        "summary": "已生成 1 个文件",
                        "bullets": ["report.txt"],
                    },
                    "deliverables": [
                        {
                            "path": str(self._report_path),
                        }
                    ],
                }
            },
        )

    async def record_transport_delivery_receipts(self, **kwargs):
        self.receipts.append(kwargs)
        return {"items": kwargs["results"]}


class _Sender:
    def __init__(self) -> None:
        self.sent_texts: list[str] = []
        self.uploaded_files: list[str] = []
        self.sent_files: list[str] = []

    async def send_text(self, *, chat_id: str, text: str):
        _ = chat_id
        self.sent_texts.append(text)
        return {"data": {"message_id": f"text-{len(self.sent_texts)}"}}

    async def upload_file_from_path(self, *, file_path: str, file_type: str):
        _ = file_type
        self.uploaded_files.append(file_path)
        return f"file-key-{len(self.uploaded_files)}"

    async def send_file(self, *, chat_id: str, file_key: str):
        _ = chat_id
        self.sent_files.append(file_key)
        return {"data": {"message_id": f"file-{len(self.sent_files)}"}}

    async def upload_image_from_path(self, *, image_path: str, image_type: str):
        raise AssertionError(f"unexpected image upload: {image_path} {image_type}")

    async def send_image(self, *, chat_id: str, image_key: str):
        raise AssertionError(f"unexpected image send: {chat_id} {image_key}")

    async def reply_text(self, *, message_id: str, text: str):
        raise AssertionError(f"unexpected reply_text: {message_id} {text}")

    async def update_text(self, *, message_id: str, text: str):
        raise AssertionError(f"unexpected update_text: {message_id} {text}")

    async def reply_file(self, *, message_id: str, file_key: str):
        raise AssertionError(f"unexpected reply_file: {message_id} {file_key}")

    async def reply_image(self, *, message_id: str, image_key: str):
        raise AssertionError(f"unexpected reply_image: {message_id} {image_key}")


class _ReadReceipts:
    def __init__(self) -> None:
        self.records: list[dict[str, str | None]] = []

    def register_outbound(
        self,
        *,
        message_id: str,
        chat_id: str,
        user_id: str,
        source_message_id: str | None,
        text: str,
    ) -> None:
        self.records.append(
            {
                "message_id": message_id,
                "chat_id": chat_id,
                "user_id": user_id,
                "source_message_id": source_message_id,
                "text": text,
            }
        )


def test_feishu_service_transfers_structured_deliverables_and_card(
    tmp_path: Path,
) -> None:
    report_path = (tmp_path / "exports" / "report.txt").resolve()
    sender = _Sender()
    read_receipts = _ReadReceipts()
    backend = _Backend(report_path)
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            ack_mode="none",
        ),
        backend=backend,
        sender=sender,
        deduplicator=SimpleNamespace(),
        read_receipts=read_receipts,
        event_sink=SimpleNamespace(),
    )

    async def _scenario() -> None:
        await service._reply_to_message(
            chat_id="chat-1",
            user_id="user-1",
            text="把报告发给我",
            message_id=None,
            raw_event={},
        )

    asyncio.run(_scenario())

    assert sender.sent_texts == [
        "交付完成\n已生成 1 个文件\n- report.txt\n\n"
        "通道回执：飞书发送接口已接受 1 个文件。这不表示对方已读。"
    ]
    assert sender.uploaded_files == [str(report_path)]
    assert sender.sent_files == ["file-key-1"]
    assert "这不表示对方已读" in str(read_receipts.records[0]["text"])
    assert backend.receipts[0]["results"] == [
        {
            "path": str(report_path),
            "state": "accepted_by_transport",
            "attempt_count": 1,
        }
    ]


def test_feishu_service_does_not_transfer_files_from_plain_reply_paths(
    tmp_path: Path,
) -> None:
    class _PlainPathBackend:
        def __init__(self, report_path: Path) -> None:
            self._report_path = report_path

        async def respond(self, envelope):
            _ = envelope
            self._report_path.parent.mkdir(parents=True, exist_ok=True)
            self._report_path.write_text("report ready", encoding="utf-8")
            return SimpleNamespace(text=f"已生成文件：{self._report_path}", metadata={})

    report_path = (tmp_path / "exports" / "report.txt").resolve()
    sender = _Sender()
    read_receipts = _ReadReceipts()
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            ack_mode="none",
        ),
        backend=_PlainPathBackend(report_path),
        sender=sender,
        deduplicator=SimpleNamespace(),
        read_receipts=read_receipts,
        event_sink=SimpleNamespace(),
    )

    async def _scenario() -> None:
        await service._reply_to_message(
            chat_id="chat-1",
            user_id="user-1",
            text="帮我整理一下文件",
            message_id=None,
            raw_event={},
        )

    asyncio.run(_scenario())

    assert sender.sent_texts == [f"已生成文件：{report_path}"]
    assert sender.uploaded_files == []
    assert sender.sent_files == []


def test_feishu_client_upload_file_from_path_uses_file_handle(
    tmp_path: Path,
    monkeypatch,
) -> None:
    upload_path = tmp_path / "demo.txt"
    upload_path.write_text("hello", encoding="utf-8")

    class _Client:
        def __init__(self) -> None:
            self.file_payload = None

        async def post(self, url, headers=None, data=None, files=None):
            _ = (url, headers, data)
            self.file_payload = files["file"][1]
            assert hasattr(self.file_payload, "read")
            request = httpx.Request("POST", "https://open.feishu.cn/open-apis/im/v1/files")
            return httpx.Response(
                200,
                json={"code": 0, "data": {"file_key": "file-key-1"}},
                request=request,
            )

    def _fail_read_bytes(self):
        raise AssertionError("upload_file_from_path should not call read_bytes")

    monkeypatch.setattr(Path, "read_bytes", _fail_read_bytes)

    client = _Client()
    sender = FeishuMessageClient(
        settings=FeishuBotSettings(app_id="app-id", app_secret="app-secret"),
        http_client=client,
    )

    async def _fake_token() -> str:
        return "tenant-token"

    sender._tenant_access_token = _fake_token  # type: ignore[method-assign]

    async def _scenario() -> None:
        file_key = await sender.upload_file_from_path(file_path=str(upload_path))
        assert file_key == "file-key-1"

    asyncio.run(_scenario())
    assert client.file_payload is not None


def test_feishu_service_uses_stream_download_helper_when_available(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class _StreamingSender:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []

        async def download_message_resource_to_path(
            self,
            *,
            message_id: str,
            file_key: str,
            target_path: str | Path,
            resource_type: str = "file",
        ) -> int:
            self.calls.append((message_id, file_key, resource_type))
            destination = Path(target_path)
            destination.write_text("downloaded", encoding="utf-8")
            return destination.stat().st_size

    monkeypatch.setenv("CARDBUSH_APP_DATA_DIR", str(tmp_path / "data"))
    sender = _StreamingSender()
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            ack_mode="none",
        ),
        backend=SimpleNamespace(),
        sender=sender,  # type: ignore[arg-type]
        deduplicator=SimpleNamespace(),
        read_receipts=SimpleNamespace(),
        event_sink=SimpleNamespace(),
    )

    async def _scenario() -> str | None:
        return await service._download_and_store_file_resource(
            session_id="feishu:chat-1:user-1",
            message_id="msg-1",
            file_key="file-1",
            file_name="demo.txt",
        )

    saved_path = asyncio.run(_scenario())

    assert saved_path is not None
    assert Path(saved_path).read_text(encoding="utf-8") == "downloaded"
    assert sender.calls == [("msg-1", "file-1", "file")]


def test_feishu_service_renders_pending_interaction_reason_text() -> None:
    class _PendingBackend:
        async def respond(self, envelope):
            _ = envelope
            raise PendingInteractiveRequestError(
                {
                    "title": "继续前请确认",
                    "reason": "需要先确认为什么要访问工作区外文件。",
                    "description": "这个步骤涉及额外权限。",
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

    sender = _Sender()
    read_receipts = _ReadReceipts()
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            ack_mode="none",
        ),
        backend=_PendingBackend(),
        sender=sender,
        deduplicator=SimpleNamespace(),
        read_receipts=read_receipts,
        event_sink=SimpleNamespace(),
    )

    async def _scenario() -> None:
        await service._reply_to_message(
            chat_id="chat-1",
            user_id="user-1",
            text="继续",
            message_id=None,
            raw_event={},
        )

    asyncio.run(_scenario())

    assert sender.sent_texts
    assert "原因：需要先确认为什么要访问工作区外文件。" in sender.sent_texts[0]


def test_feishu_service_resolves_pending_interaction_reply() -> None:
    class _ResolvingBackend:
        async def resolve_pending_interaction(self, session_id, *, raw_text):
            assert session_id == "feishu:chat-1:user-1"
            assert raw_text == "2"
            return SimpleNamespace(text="已收到你的选择，正在继续处理。", metadata={})

        async def respond(self, envelope):
            raise AssertionError(f"must not open a new turn: {envelope}")

    sender = _Sender()
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            ack_mode="none",
        ),
        backend=_ResolvingBackend(),
        sender=sender,
        deduplicator=SimpleNamespace(),
        read_receipts=_ReadReceipts(),
        event_sink=SimpleNamespace(),
    )

    asyncio.run(
        service._reply_to_message(
            chat_id="chat-1",
            user_id="user-1",
            text="2",
            message_id=None,
            raw_event={},
        )
    )

    assert sender.sent_texts == ["已收到你的选择，正在继续处理。"]


def test_feishu_webhook_rejects_missing_verification_token() -> None:
    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            verification_token="expected-token",
        ),
        backend=SimpleNamespace(),
        sender=SimpleNamespace(),
        deduplicator=SimpleNamespace(),
        read_receipts=SimpleNamespace(),
        event_sink=SimpleNamespace(),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(service.handle_callback({"challenge": "challenge-1"}))

    assert exc_info.value.status_code == 403


def test_feishu_webhook_ignores_unauthorized_identity() -> None:
    class _Deduplicator:
        def should_process(self, *args, **kwargs):
            _ = (args, kwargs)
            return True

    service = FeishuBotService(
        settings=FeishuBotSettings(
            app_id="app-id",
            app_secret="app-secret",
            allowed_user_ids=("allowed-user",),
            allowed_channel_ids=("allowed-chat",),
        ),
        backend=SimpleNamespace(),
        sender=SimpleNamespace(),
        deduplicator=_Deduplicator(),
        read_receipts=SimpleNamespace(),
        event_sink=SimpleNamespace(),
    )
    payload = {
        "header": {"event_type": "im.message.receive_v1", "event_id": "event-1"},
        "event": {
            "sender": {
                "sender_type": "user",
                "sender_id": {"open_id": "denied-user"},
            },
            "message": {
                "message_id": "message-1",
                "chat_id": "denied-chat",
                "message_type": "text",
                "content": '{"text":"hello"}',
            },
        },
    }

    result = asyncio.run(service.handle_callback(payload))

    assert result == {"code": 0, "msg": "ignored unauthorized message"}
