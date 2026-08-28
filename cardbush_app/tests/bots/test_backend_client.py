from __future__ import annotations

from pathlib import Path

import httpx

from cardbush_app.adapters.common.backend import (
    DEFAULT_STREAM_SERVICE_BASE_URL,
    BushServerStreamBackend,
    BushServerStreamSettings,
    InteractiveReplyValidationError,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelRateLimitError,
)
from cardbush_app.adapters.common.models import ChatEnvelope


def test_stream_settings_default_base_url_tracks_main_service_default(monkeypatch) -> None:
    monkeypatch.delenv("CARDBUSH_BOT_STREAM_BASE_URL", raising=False)

    assert DEFAULT_STREAM_SERVICE_BASE_URL == "http://127.0.0.1:51717"
    assert BushServerStreamSettings().service_base_url == DEFAULT_STREAM_SERVICE_BASE_URL
    assert (
        BushServerStreamSettings.from_env().service_base_url
        == DEFAULT_STREAM_SERVICE_BASE_URL
    )


def test_stream_settings_accepts_only_cardbush_managed_auth_token(monkeypatch) -> None:
    monkeypatch.delenv("CARDBUSH_BOT_STREAM_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("BUSH_BACKEND_AUTH_TOKEN", "removed-backend-token")
    monkeypatch.setenv("BUSH_API_AUTH_TOKEN", "removed-api-token")

    assert BushServerStreamSettings.from_env().auth_token is None

    monkeypatch.setenv("CARDBUSH_BOT_STREAM_AUTH_TOKEN", "managed-token")

    assert BushServerStreamSettings.from_env().auth_token == "managed-token"


def test_stream_settings_backend_default_model_source_ignores_env_model(
    monkeypatch,
) -> None:
    monkeypatch.setenv("CARDBUSH_BOT_STREAM_MODEL_SOURCE", "backend_default")
    monkeypatch.setenv("CARDBUSH_BOT_STREAM_API_KEY", "stale-key")
    monkeypatch.setenv("CARDBUSH_BOT_STREAM_MODEL", "stale-model")
    monkeypatch.setenv("CARDBUSH_BOT_STREAM_PROVIDER", "stale-provider")
    monkeypatch.setenv("CARDBUSH_BOT_STREAM_LLM_BASE_URL", "https://stale.example/v1")

    settings = BushServerStreamSettings.from_env()
    backend = BushServerStreamBackend(settings=settings, http_client=object())
    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert settings.api_key is None
    assert settings.model is None
    assert settings.provider is None
    assert settings.llm_base_url is None
    assert "api_key" not in payload
    assert "model" not in payload
    assert "provider" not in payload
    assert "base_url" not in payload
    assert "history_limit" not in payload


def test_stream_backend_payload_includes_project_dir(tmp_path: Path) -> None:
    project_dir = (tmp_path / "project").resolve()
    settings = BushServerStreamSettings(
        service_base_url="http://127.0.0.1:8000",
        project_dir=str(project_dir),
        workspace_mode="project",
    )
    backend = BushServerStreamBackend(settings=settings, http_client=object())

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert payload["project_dir"] == str(project_dir)
    assert payload["workspace_mode"] == "project"
    assert payload["metadata"]["deliverable_transport_channel"] == "weixin"
    assert "standard_image_input_enabled" not in payload["metadata"]
    assert (
        payload["metadata"]["deliverable_transport_mode"]
        == "tool_local_upload_send"
    )
    assert "context_window_recent_full_turns" not in payload["metadata"]
    assert "context_window_history_light_threshold" not in payload["metadata"]
    assert "context_window_history_summary_threshold" not in payload["metadata"]
    assert "context_window_history_force_truncate_threshold" not in payload["metadata"]
    assert payload["user_input"] == "hello"
    assert payload["metadata"]["deliverable_transport_constraints"] == {
        "folder_delivery_supported": False,
        "native_image_supported": True,
        "file_fallback_supported": True,
    }
    assert "web_research_intent" not in payload["metadata"]


def test_stream_backend_does_not_classify_user_text_into_web_intent() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="查一下今天金价最新行情，然后整理给我",
        )
    )

    assert "web_research_intent" not in payload["metadata"]
    assert payload["user_input"] == "查一下今天金价最新行情，然后整理给我"


def test_stream_backend_does_not_mark_current_local_code_as_web_research() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="帮我检查当前项目代码并修复 bug",
        )
    )

    assert "web_research_intent" not in payload["metadata"]


def test_stream_backend_cross_platform_payload_contracts(tmp_path: Path) -> None:
    project_dir = (tmp_path / "project").resolve()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
            project_dir=str(project_dir),
            workspace_mode="project",
        ),
        http_client=object(),
    )

    for platform in ("weixin", "feishu", "discord", "telegram", "bush_gui"):
        payload = backend._build_payload(
            ChatEnvelope(
                platform=platform,
                session_id=f"{platform}:test:user",
                user_id="user",
                channel_id="channel",
                text="帮我检查并修复这个项目",
                message_id="msg-1",
                thread_id="thread-1",
            )
        )
        metadata = payload["metadata"]

        assert payload["stream"] is True
        assert payload["tool_calling_enabled"] is True
        assert payload["project_dir"] == str(project_dir)
        assert payload["workspace_mode"] == "project"
        assert "api_key" not in payload
        assert "model" not in payload
        assert "provider" not in payload
        assert "base_url" not in payload
        assert metadata["source_platform"] == platform
        assert metadata["source_user_id"] == "user"
        assert metadata["source_channel_id"] == "channel"
        assert metadata["source_message_id"] == "msg-1"
        assert metadata["source_thread_id"] == "thread-1"
        assert "standard_image_input_enabled" not in metadata
        if platform != "bush_gui":
            assert metadata["subagent_enabled"] is True
        else:
            assert "subagent_enabled" not in metadata
        if platform == "weixin":
            assert metadata["deliverable_transport_channel"] == "weixin"
            assert metadata["deliverable_transport_mode"] == "tool_local_upload_send"
            assert metadata["deliverable_transport_constraints"] == {
                "folder_delivery_supported": False,
                "native_image_supported": True,
                "file_fallback_supported": True,
            }
            assert "context_window_recent_full_turns" not in metadata
            assert "context_window_history_force_truncate_threshold" not in metadata
        elif platform == "feishu":
            assert metadata["deliverable_transport_channel"] == "feishu"
            assert metadata["deliverable_transport_mode"] == "tool_local_upload_send"
            assert "deliverable_transport_constraints" not in metadata
        else:
            assert "deliverable_transport_channel" not in metadata
            assert "deliverable_transport_mode" not in metadata


def test_stream_backend_payload_supports_workspace_dir_alias(tmp_path: Path) -> None:
    workspace_dir = (tmp_path / "workspace").resolve()
    settings = BushServerStreamSettings(
        service_base_url="http://127.0.0.1:8000",
        workspace_dir=str(workspace_dir),
    )
    backend = BushServerStreamBackend(settings=settings, http_client=object())

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert payload["workspace_dir"] == str(workspace_dir)
    assert payload["project_dir"] == str(workspace_dir)
    assert payload["workspace_mode"] == "workspace"


def test_stream_backend_payload_supports_explicit_task_workspace_mode() -> None:
    settings = BushServerStreamSettings(
        service_base_url="http://127.0.0.1:8000",
        workspace_mode="task",
    )
    backend = BushServerStreamBackend(settings=settings, http_client=object())

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert "project_dir" not in payload
    assert payload["workspace_mode"] == "task"


def test_stream_backend_payload_applies_bot_permission_profile() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
            permission_mode="task_free",
            disabled_tools=["computer_use", "terminal_exec"],
            allowed_skills=["code", "documents"],
            subagent_enabled=False,
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="discord",
            session_id="discord:channel:user",
            user_id="user",
            channel_id="channel",
            text="hello",
        )
    )

    assert payload["permission_mode"] == "task_free"
    assert payload["disabled_tools"] == ["computer_use", "terminal_exec"]
    assert payload["allowed_skills"] == ["code", "documents"]
    assert payload["metadata"]["subagent_enabled"] is False


def test_stream_backend_project_dir_without_project_mode_stays_in_task_workspace(tmp_path: Path) -> None:
    settings = BushServerStreamSettings(
        service_base_url="http://127.0.0.1:8000",
        project_dir=str((tmp_path / "project").resolve()),
    )
    backend = BushServerStreamBackend(settings=settings, http_client=object())

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert "project_dir" not in payload
    assert payload["workspace_mode"] == "task"


def test_stream_backend_does_not_bind_skills_from_user_text() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    code_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="帮我写代码实现一个网页",
        )
    )
    skill_meta_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="你看看你当前的代码的skill，这些skill能不能帮助你完成任务",
        )
    )
    capability_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="你写代码能力咋样",
        )
    )
    flutter_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="帮我这个能支持接受短信转发的flutter应用",
        )
    )

    assert code_payload["tool_calling_enabled"] is True
    assert "allowed_skills" not in code_payload
    assert flutter_payload["tool_calling_enabled"] is True
    assert "allowed_skills" not in flutter_payload
    assert skill_meta_payload["tool_calling_enabled"] is True
    assert "allowed_skills" not in skill_meta_payload
    assert capability_payload["tool_calling_enabled"] is True
    assert "allowed_skills" not in capability_payload


def test_stream_backend_explicit_skill_scope_is_preserved() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
            allowed_skills=["code"],
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="帮我写代码实现一个网页",
        )
    )

    assert payload["tool_calling_enabled"] is True
    assert payload["allowed_skills"] == ["code"]


def test_stream_backend_allows_explicit_global_tool_disclosure_disable() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
            tool_calling_enabled=False,
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="帮我写代码实现一个网页",
        )
    )

    assert payload["tool_calling_enabled"] is False
    assert "allowed_skills" not in payload


def test_stream_backend_composite_code_init_task_uses_normal_skill_search() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text=(
                "用node做一个设计师网站，要有粒子效果，具体的参考谷歌的各种实现，"
                "完成后我需要截图发给我网站页面，最后整理成ppt给我说明网站设计和技术栈"
            ),
        )
    )

    assert payload["tool_calling_enabled"] is True
    assert "allowed_skills" not in payload


def test_stream_backend_keeps_weixin_delivery_constraint_out_of_user_input() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    weixin_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="把文件夹发给我",
        )
    )
    feishu_payload = backend._build_payload(
        ChatEnvelope(
            platform="feishu",
            session_id="feishu:test:user",
            user_id="user",
            channel_id="test",
            text="把文件夹发给我",
        )
    )

    assert weixin_payload["user_input"] == "把文件夹发给我"
    assert weixin_payload["metadata"]["deliverable_transport_constraints"] == {
        "folder_delivery_supported": False,
        "native_image_supported": True,
        "file_fallback_supported": True,
    }
    assert feishu_payload["user_input"] == "把文件夹发给我"


def test_stream_backend_enables_subagent_by_default_for_non_bush_gui() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    weixin_payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )
    feishu_payload = backend._build_payload(
        ChatEnvelope(
            platform="feishu",
            session_id="feishu:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert weixin_payload["metadata"]["subagent_enabled"] is True
    assert feishu_payload["metadata"]["subagent_enabled"] is True


def test_stream_backend_can_disable_default_subagent_for_non_bush_gui() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(
            service_base_url="http://127.0.0.1:8000",
            subagent_enabled=False,
        ),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
        )
    )

    assert payload["metadata"]["subagent_enabled"] is False


def test_stream_backend_bridge_flag_can_disable_subagent_with_string_value() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
            raw_event={"_bridge_subagent_enabled": "0"},
        )
    )

    assert payload["metadata"]["subagent_enabled"] is False


def test_stream_backend_enables_subagent_when_bridge_flag_is_set() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )

    payload = backend._build_payload(
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
            raw_event={"_bridge_subagent_enabled": True},
        )
    )

    assert payload["metadata"]["subagent_enabled"] is True


def test_stream_backend_reply_interaction_maps_validation_error() -> None:
    class _Client:
        async def post(self, url, json, headers):
            _ = (json, headers)
            request = httpx.Request("POST", url)
            return httpx.Response(
                400,
                json={"detail": "raw_text could not be matched to this interaction"},
                request=request,
            )

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        try:
            await backend.reply_interaction("ix-1", raw_text="随便来一句")
        except InteractiveReplyValidationError as exc:
            assert str(exc) == "raw_text could not be matched to this interaction"
            return
        raise AssertionError("InteractiveReplyValidationError was not raised")

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_resolves_pending_interaction_without_new_turn() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=object(),
    )
    submitted: list[tuple[str, str]] = []

    async def _get_pending(session_id: str):
        assert session_id == "feishu:chat:user"
        return {
            "interaction_id": "ix-1",
            "type": "path_permission_request",
            "questions": [
                {
                    "id": "permission",
                    "options": [
                        {"id": "allow_once", "label": "允许一次"},
                        {"id": "allow_session", "label": "本次对话允许"},
                        {"id": "deny", "label": "拒绝"},
                    ],
                }
            ],
        }

    async def _reply(interaction_id: str, *, raw_text: str):
        submitted.append((interaction_id, raw_text))
        return {"status": "answered"}

    backend.get_pending_interaction = _get_pending  # type: ignore[method-assign]
    backend.reply_interaction = _reply  # type: ignore[method-assign]

    async def _scenario() -> None:
        reply = await backend.resolve_pending_interaction(
            "feishu:chat:user",
            raw_text="2",
        )
        assert reply is not None
        assert reply.metadata["interaction_resolved"] is True
        assert "继续处理" in reply.text

    import asyncio

    asyncio.run(_scenario())
    assert submitted == [("ix-1", "2")]


def test_stream_backend_stop_turn_calls_stop_endpoint() -> None:
    class _Client:
        def __init__(self) -> None:
            self.url = None
            self.headers = None

        async def post(self, url, headers):
            self.url = url
            self.headers = headers
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                json={"turn_id": "turn-1", "stopped": True},
                request=request,
            )

    client = _Client()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=client,
    )

    async def _scenario() -> None:
        payload = await backend.stop_turn("turn-1")
        assert payload == {"turn_id": "turn-1", "stopped": True}

    import asyncio

    asyncio.run(_scenario())

    assert client.url == "http://127.0.0.1:8000/v1/turns/turn-1/stop"
    assert isinstance(client.headers, dict)


def test_stream_backend_switch_default_model_config_updates_default_only() -> None:
    class _Client:
        def __init__(self) -> None:
            self.get_url = None
            self.put_url = None
            self.put_payload = None
            self.document = {
                "version": 1,
                "default_model_id": "primary",
                "models": [
                    {
                        "id": "primary",
                        "provider": "deepseek",
                        "model": "deepseek-v4-pro",
                        "api_key": "sk-primary",
                    },
                    {
                        "id": "fallback",
                        "provider": "openai",
                        "model": "gpt-5-mini",
                        "api_key": "sk-fallback",
                    },
                ],
            }

        async def get(self, url, headers):
            _ = headers
            self.get_url = url
            request = httpx.Request("GET", url)
            return httpx.Response(200, json=self.document, request=request)

        async def put(self, url, json, headers):
            _ = headers
            self.put_url = url
            self.put_payload = dict(json)
            request = httpx.Request("PUT", url)
            return httpx.Response(200, json=self.put_payload, request=request)

    client = _Client()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=client,
    )

    async def _scenario() -> None:
        payload = await backend.switch_default_model_config("fallback")
        assert payload["default_model_id"] == "fallback"
        assert payload["defaultModelId"] == "fallback"
        assert payload["models"][0]["api_key"] == "sk-primary"
        assert payload["models"][1]["api_key"] == "sk-fallback"

    import asyncio

    asyncio.run(_scenario())

    assert client.get_url == "http://127.0.0.1:8000/v1/model-configs"
    assert client.put_url == "http://127.0.0.1:8000/v1/model-configs"
    assert client.put_payload["default_model_id"] == "fallback"
    assert client.put_payload["models"] == client.document["models"]


def test_stream_backend_shutdown_stops_active_turns() -> None:
    class _Client:
        def __init__(self) -> None:
            self.urls: list[str] = []

        async def post(self, url, headers):
            _ = headers
            self.urls.append(url)
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                json={"turn_id": "turn-shutdown", "stopped": True},
                request=request,
            )

    client = _Client()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=client,
    )
    backend._remember_active_turn(
        "turn-shutdown",
        ChatEnvelope(
            platform="weixin",
            session_id="weixin:test:user",
            user_id="user",
            channel_id="test",
            text="hello",
            message_id="msg-1",
        ),
    )

    async def _scenario() -> None:
        payloads = await backend.stop_active_turns(reason="test")
        assert payloads == [{"turn_id": "turn-shutdown", "stopped": True}]
        assert backend._active_turns == {}

    import asyncio

    asyncio.run(_scenario())

    assert client.urls == ["http://127.0.0.1:8000/v1/turns/turn-shutdown/stop"]


def test_stream_backend_routes_active_session_input_to_turn_guidance() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            lines = [
                "event: start",
                'data: {"turn_id":"turn-1","control":"turn_guidance"}',
                "",
                "event: done",
                'data: {"accepted":true,"turn_id":"turn-1","assistant_message":""}',
                "",
            ]
            for line in lines:
                yield line

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def __init__(self) -> None:
            self.get_url = None
            self.stream_url = None
            self.stream_json = None

        async def get(self, url, headers):
            _ = headers
            self.get_url = url
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"session_id": "weixin:test:user", "active": True, "turn_id": "turn-1"},
                request=request,
            )

        def stream(self, method, url, json, headers, timeout):
            _ = (method, headers, timeout)
            self.stream_url = url
            self.stream_json = json
            return _StreamResponse()

    client = _Client()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=client,
    )

    async def _scenario() -> None:
        reply = await backend.respond(
            ChatEnvelope(
                platform="weixin",
                session_id="weixin:test:user",
                user_id="user",
                channel_id="test",
                text="补充：先不要截图",
                message_id="msg-1",
            )
        )
        assert reply.text == "已收到，我会把这条补充并入当前正在执行的任务。"
        assert reply.metadata["guidance_delivered"] is True
        assert reply.metadata["turn_id"] == "turn-1"

    import asyncio

    asyncio.run(_scenario())

    assert client.get_url == "http://127.0.0.1:8000/v1/sessions/weixin%3Atest%3Auser/active-turn"
    assert client.stream_url == "http://127.0.0.1:8000/v1/turns/turn-1/guidance"
    assert client.stream_json == {
        "session_id": "weixin:test:user",
        "guidance": "补充：先不要截图",
        "mode": "append_context",
        "source": "weixin",
        "message_id": "msg-1",
    }


def test_stream_backend_accepts_transport_directives_without_text() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            lines = [
                'event: start',
                'data: {"turn_id":"turn-1"}',
                "",
                'event: done',
                (
                    'data: {"assistant_message":"","turn_id":"turn-1",'
                    '"transport_directives":{"channel":"weixin","deliverables":['
                    '{"path":"C:/demo/report.txt"}]}}'
                ),
                "",
            ]
            for line in lines:
                yield line

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        reply = await backend.respond(
            ChatEnvelope(
                platform="weixin",
                session_id="weixin:test:user",
                user_id="user",
                channel_id="test",
                text="send report",
            )
        )
        assert reply.text == ""
        assert reply.metadata["turn_id"] == "turn-1"
        assert reply.metadata["transport_directives"]["channel"] == "weixin"
        assert reply.metadata["transport_directives"]["deliverables"][0]["path"] == "C:/demo/report.txt"

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_ignores_error_event_after_done_reply() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            lines = [
                "event: start",
                'data: {"turn_id":"turn-limit"}',
                "",
                "event: done",
                (
                    'data: {"assistant_message":"系统出现了问题,对话被中断了",'
                    '"turn_id":"turn-limit","stopped":true}'
                ),
                "",
                "event: error",
                'data: {"message":"TurnLimitExceeded: turn-runtime-timeout","turn_id":"turn-limit"}',
                "",
            ]
            for line in lines:
                yield line

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        reply = await backend.respond(
            ChatEnvelope(
                platform="weixin",
                session_id="weixin:test:user",
                user_id="user",
                channel_id="test",
                text="long task",
            )
        )
        assert reply.text == "系统出现了问题,对话被中断了"
        assert reply.metadata["turn_id"] == "turn-limit"
        assert reply.metadata["stopped"] is True
        assert reply.metadata["stream_error"] == "TurnLimitExceeded: turn-runtime-timeout"

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_still_raises_error_without_reply_payload() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield "event: error"
            yield 'data: {"message":"boom"}'
            yield ""

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        try:
            await backend.respond(
                ChatEnvelope(
                    platform="weixin",
                    session_id="weixin:test:user",
                    user_id="user",
                    channel_id="test",
                    text="hello",
                )
            )
        except RuntimeError as exc:
            assert str(exc) == "BushServer stream error: boom"
            return
        raise AssertionError("RuntimeError was not raised")

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_classifies_model_authentication_error_event() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield "event: error"
            yield 'data: {"message":"DeepSeek API key is invalid"}'
            yield ""

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        try:
            await backend.respond(
                ChatEnvelope(
                    platform="weixin",
                    session_id="weixin:test:user",
                    user_id="user",
                    channel_id="test",
                    text="hello",
                )
            )
        except ModelAuthenticationError as exc:
            assert exc.category == "model_authentication"
            assert exc.provider == "deepseek"
            assert "DeepSeek API key is invalid" in str(exc)
            return
        raise AssertionError("ModelAuthenticationError was not raised")

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_classifies_model_connection_error_event() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield "event: error"
            yield (
                'data: {"message":"litellm.InternalServerError: '
                'VolcengineException - Connection error."}'
            )
            yield ""

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        try:
            await backend.respond(
                ChatEnvelope(
                    platform="weixin",
                    session_id="weixin:test:user",
                    user_id="user",
                    channel_id="test",
                    text="hello",
                )
            )
        except ModelConnectionError as exc:
            assert exc.category == "model_connection"
            assert exc.provider == "volcengine"
            assert "Connection error" in str(exc)
            return
        raise AssertionError("ModelConnectionError was not raised")

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_classifies_model_rate_limit_error_event() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield "event: error"
            yield 'data: {"message":"DeepSeek RateLimitError: rate limit exceeded"}'
            yield ""

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def stream(self, *args, **kwargs):
            _ = (args, kwargs)
            return _StreamResponse()

    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        try:
            await backend.respond(
                ChatEnvelope(
                    platform="weixin",
                    session_id="weixin:test:user",
                    user_id="user",
                    channel_id="test",
                    text="hello",
                )
            )
        except ModelRateLimitError as exc:
            assert exc.category == "model_rate_limit"
            assert exc.provider == "deepseek"
            assert "rate limit" in str(exc).lower()
            return
        raise AssertionError("ModelRateLimitError was not raised")

    import asyncio

    asyncio.run(_scenario())


def test_stream_backend_disables_sse_read_timeout() -> None:
    class _StreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield 'event: done'
            yield 'data: {"assistant_message":"ok"}'
            yield ""

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class _Client:
        def __init__(self) -> None:
            self.timeout = None

        def stream(self, *args, **kwargs):
            self.timeout = kwargs.get("timeout")
            return _StreamResponse()

    client = _Client()
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
        http_client=client,
    )

    async def _scenario() -> None:
        reply = await backend.respond(
            ChatEnvelope(
                platform="weixin",
                session_id="weixin:test:user",
                user_id="user",
                channel_id="test",
                text="hello",
            )
        )
        assert reply.text == "ok"

    import asyncio

    asyncio.run(_scenario())
    assert isinstance(client.timeout, httpx.Timeout)
    assert client.timeout.read is None


def test_stream_backend_owned_loopback_client_disables_env_proxy() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="http://127.0.0.1:8000"),
    )

    client = backend._client()

    assert isinstance(client, httpx.AsyncClient)
    assert client._trust_env is False

    import asyncio

    asyncio.run(client.aclose())


def test_stream_backend_owned_remote_client_keeps_default_env_behavior() -> None:
    backend = BushServerStreamBackend(
        settings=BushServerStreamSettings(service_base_url="https://example.com"),
    )

    client = backend._client()

    assert isinstance(client, httpx.AsyncClient)
    assert client._trust_env is True

    import asyncio

    asyncio.run(client.aclose())
