from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import cardbush_app.adapters.common.signals as common_signals_module
import cardbush_app.adapters.weixin_bot.cli as weixin_cli_module
import cardbush_app.adapters.weixin_bot.client as weixin_client_module
import cardbush_app.adapters.weixin_bot.service as weixin_service_module
from cardbush_app.paths import session_workspace_dir
from cardbush_app.adapters.common import ChatEnvelope
from cardbush_app.adapters.common.backend import (
    BushServerStreamBackend,
    InteractiveReplyValidationError,
    ModelConnectionError,
    ModelRateLimitError,
)
from cardbush_app.adapters.weixin_bot.cli import _build_parser
from cardbush_app.adapters.weixin_bot.client import GetUpdatesResult, WeixinClient, WeixinMessage
from cardbush_app.adapters.weixin_bot.config import WeixinBotSettings, build_client_version
from cardbush_app.adapters.weixin_bot.service import (
    WeixinBotService,
    extract_message_text,
)
from cardbush_app.adapters.weixin_bot.state import WeixinAccount, WeixinStateStore


def test_build_client_version_matches_bush_weixin_encoding() -> None:
    assert build_client_version("2.1.7") == ((2 << 16) | (1 << 8) | 7)


def test_weixin_bot_settings_from_env_reads_adapter_fields(
    tmp_path: Path,
    monkeypatch,
) -> None:
    env_file = tmp_path / "test.env"
    data_dir = tmp_path / "data"
    shadow_path = tmp_path / "shadow.jsonl"
    env_file.write_text(
        "\n".join(
            [
                f"CARDBUSH_APP_DATA_DIR={data_dir}",
                "WEIXIN_ALLOWED_USER_IDS=u1,u2",
                "WEIXIN_ALLOWED_CHANNEL_IDS=account-1,account-2",
                "WEIXIN_APP_VERSION=2.1.7",
                "WEIXIN_ROUTE_TAG=route-x",
                "WEIXIN_PROXY=http://127.0.0.1:7897",
                "WEIXIN_NO_PROXY=localhost,.weixin.qq.com",
                "WEIXIN_CDN_BASE_URL=https://cdn.example.invalid/c2c",
                "WEIXIN_MEDIA_TIMEOUT_SECONDS=66",
                "WEIXIN_SHADOW_OBSERVATION_ENABLED=1",
                f"WEIXIN_SHADOW_OBSERVATION_PATH={shadow_path}",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("CARDBUSH_APP_DATA_DIR", raising=False)
    monkeypatch.delenv("WEIXIN_ALLOWED_USER_IDS", raising=False)
    monkeypatch.delenv("WEIXIN_ALLOWED_CHANNEL_IDS", raising=False)
    monkeypatch.delenv("WEIXIN_APP_VERSION", raising=False)
    monkeypatch.delenv("WEIXIN_ROUTE_TAG", raising=False)
    monkeypatch.delenv("WEIXIN_PROXY", raising=False)
    monkeypatch.delenv("WEIXIN_NO_PROXY", raising=False)
    monkeypatch.delenv("WEIXIN_CDN_BASE_URL", raising=False)
    monkeypatch.delenv("WEIXIN_MEDIA_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("WEIXIN_SHADOW_OBSERVATION_ENABLED", raising=False)
    monkeypatch.delenv("WEIXIN_SHADOW_OBSERVATION", raising=False)
    monkeypatch.delenv("WEIXIN_SHADOW_OBSERVATION_PATH", raising=False)

    settings = WeixinBotSettings.from_env(str(env_file))

    assert settings.data_dir == data_dir.resolve()
    assert settings.allowed_user_ids == ("u1", "u2")
    assert settings.allowed_channel_ids == ("account-1", "account-2")
    assert settings.route_tag == "route-x"
    assert settings.proxy == "http://127.0.0.1:7897"
    assert settings.no_proxy == "localhost,.weixin.qq.com"
    assert settings.cdn_base_url == "https://cdn.example.invalid/c2c"
    assert settings.media_timeout_seconds == 66.0
    assert settings.shadow_observation_enabled is True
    assert settings.shadow_observation_path == shadow_path.resolve()
    assert settings.client_version == ((2 << 16) | (1 << 8) | 7)
    assert settings.state_dir == data_dir.resolve() / "weixin"


def test_weixin_user_visible_backend_error_sanitizes_litellm_debug_text() -> None:
    exc = RuntimeError(
        "litellm.APIConnectionError: Give Feedback / Get Help: https://github.com/BerriAI/litellm/issues\n"
        "LiteLLM.Info: noisy internal diagnostics"
    )

    text = weixin_service_module._format_user_visible_backend_error(exc)

    assert text == "模型服务响应超时或暂时不可用，请稍后重试。"
    assert "LiteLLM" not in text
    assert "Give Feedback" not in text


def test_weixin_user_visible_backend_error_classifies_model_connection() -> None:
    exc = ModelConnectionError(
        "litellm.InternalServerError: VolcengineException - Connection error.",
        provider="volcengine",
    )

    category = weixin_service_module._backend_error_category(exc)
    text = weixin_service_module._format_user_visible_backend_error(exc)

    assert category == {
        "category": "model_connection",
        "message": "litellm.InternalServerError: VolcengineException - Connection error.",
        "provider": "volcengine",
    }
    assert text == "模型服务连接失败，请检查默认模型槽位、供应商网络或稍后重试。"


def test_weixin_backend_error_classifies_deepseek_insufficient_balance() -> None:
    message = (
        "BadRequestError: litellm.BadRequestError: DeepseekException - "
        '{"error":{"message":"Insufficient Balance","type":"unknown_error",'
        '"param":null,"code":"invalid_request_error"}}'
    )

    try:
        BushServerStreamBackend._raise_stream_error(message)
    except ModelRateLimitError as exc:
        category = weixin_service_module._backend_error_category(exc)
        text = weixin_service_module._format_user_visible_backend_error(exc)
    else:  # pragma: no cover - assertion clarity
        raise AssertionError("expected ModelRateLimitError")

    assert category == {
        "category": "model_rate_limit",
        "message": message,
        "provider": "deepseek",
    }
    assert text == "模型服务触发限流或额度不足，请切换默认模型槽位或稍后重试。"


def test_weixin_user_visible_error_notice_uses_specific_safe_title() -> None:
    title, message = weixin_service_module._user_visible_backend_error_notice(
        ModelRateLimitError("Insufficient Balance", provider="deepseek")
    )

    assert title == "模型限流或额度不足"
    assert message == "模型服务触发限流或额度不足，请切换默认模型槽位或稍后重试。"
    assert "Insufficient Balance" not in message


def test_weixin_user_visible_error_notice_distinguishes_backend_connection() -> None:
    request = httpx.Request("POST", "http://127.0.0.1:51717/v1/chat/stream")
    title, message = weixin_service_module._user_visible_backend_error_notice(
        httpx.ConnectError("connection refused", request=request)
    )

    assert title == "BushServer 连接失败"
    assert message == "无法连接 BushServer 后端，请确认服务正在运行后重试。"
    assert "connection refused" not in message


def test_weixin_client_defaults_to_no_env_proxy(
    tmp_path: Path,
    monkeypatch,
) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text("", encoding="utf-8")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
    monkeypatch.delenv("WEIXIN_DISABLE_ENV_PROXY", raising=False)
    monkeypatch.delenv("WEIXIN_PROXY", raising=False)
    monkeypatch.delenv("WEIXIN_NO_PROXY", raising=False)

    settings = WeixinBotSettings.from_env(str(env_file))
    client = WeixinClient(settings)
    http_client = client._client_for_url("https://ilinkai.weixin.qq.com")

    try:
        assert settings.disable_env_proxy is True
        assert getattr(http_client, "_trust_env") is False
    finally:
        asyncio.run(client.aclose())


def test_weixin_client_get_updates_retries_request_errors(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_client_module,
        "_GET_UPDATES_REQUEST_RETRY_DELAY_SECONDS",
        0.0,
    )
    settings = WeixinBotSettings(data_dir=tmp_path)
    client = WeixinClient(settings)
    request = httpx.Request("POST", "https://ilink.example/ilink/bot/getupdates")
    state = {"calls": 0, "resets": 0}

    async def _fake_request(*args, **kwargs):
        state["calls"] += 1
        if state["calls"] == 1:
            raise httpx.ConnectError("temporary failure", request=request)
        return httpx.Response(
            200,
            json={
                "ret": 0,
                "msgs": [],
                "get_updates_buf": "sync-2",
            },
            request=request,
        )

    async def _fake_close_owned_clients() -> None:
        state["resets"] += 1

    monkeypatch.setattr(client, "_request", _fake_request)
    monkeypatch.setattr(client, "_close_owned_clients", _fake_close_owned_clients)

    result = asyncio.run(
        client.get_updates(
            base_url="https://ilink.example",
            token="token-1",
            sync_buffer="sync-1",
            timeout_seconds=15.0,
        )
    )

    assert state == {"calls": 2, "resets": 1}
    assert result.sync_buffer == "sync-2"
    assert result.messages == []


def test_weixin_state_store_round_trip(tmp_path: Path) -> None:
    store = WeixinStateStore(tmp_path / "state")
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    store.save_account(account)
    store.save_sync_buffer("acct-1", "sync-1")
    store.set_context_token("acct-1", "user-1", "ctx-1")
    store.set_active_session_id("acct-1", "user-1", "weixin:acct-1:user-1:session-2")

    loaded = store.load_account("acct-1")

    assert loaded == account
    assert store.list_account_ids() == ["acct-1"]
    assert store.load_sync_buffer("acct-1") == "sync-1"
    assert store.get_context_token("acct-1", "user-1") == "ctx-1"
    assert (
        store.get_active_session_id("acct-1", "user-1")
        == "weixin:acct-1:user-1:session-2"
    )

    store.clear_runtime_state("acct-1")

    assert store.load_sync_buffer("acct-1") == ""
    assert store.get_context_token("acct-1", "user-1") is None
    assert store.get_active_session_id("acct-1", "user-1") is None



def test_weixin_cli_login_parser_accepts_timeout() -> None:
    parser = _build_parser()
    args = parser.parse_args(["login", "--timeout-seconds", "42"])

    assert args.command == "login"
    assert args.timeout_seconds == 42.0


def test_weixin_cli_serve_parser_accepts_parent_pid() -> None:
    parser = _build_parser()
    args = parser.parse_args(["serve", "--parent-pid", "4321"])

    assert args.command == "serve"
    assert args.parent_pid == 4321


def test_weixin_cli_build_serve_instance_lock_uses_state_dir(tmp_path: Path) -> None:
    settings = WeixinBotSettings(data_dir=tmp_path)

    instance_lock = weixin_cli_module.build_serve_instance_lock(settings)

    assert instance_lock.path == tmp_path / "weixin" / "weixin-bridge.lock"


def test_weixin_cli_serve_acquires_instance_lock(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[str] = []
    expected_backend = object()

    class _FakeLock:
        def acquire(self) -> None:
            calls.append("acquire")

        def release(self) -> None:
            calls.append("release")

    class _FakeService:
        def __init__(self, *, settings: WeixinBotSettings, backend: object) -> None:
            assert settings.data_dir == tmp_path
            assert backend is expected_backend

        async def run(self) -> None:
            calls.append("run")

    monkeypatch.setattr(
        weixin_cli_module,
        "build_serve_instance_lock",
        lambda _settings: _FakeLock(),
    )
    monkeypatch.setattr(
        weixin_cli_module,
        "load_bushserver_backend_from_env",
        lambda: expected_backend,
    )
    monkeypatch.setattr(weixin_cli_module, "WeixinBotService", _FakeService)

    status = asyncio.run(
        weixin_cli_module._run_serve(
            WeixinBotSettings(data_dir=tmp_path),
            backend_url=None,
            project_dir=None,
        )
    )

    assert status == 0
    assert calls == ["acquire", "run", "release"]


def test_weixin_cli_serve_rejects_active_instance(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    class _FakeLock:
        def acquire(self) -> None:
            raise RuntimeError("another instance is already running")

        def release(self) -> None:  # pragma: no cover - assertion clarity
            raise AssertionError("active lock should not be released")

    def _fail_load_backend() -> object:  # pragma: no cover - assertion clarity
        raise AssertionError("backend should not load when serve lock is active")

    monkeypatch.setattr(
        weixin_cli_module,
        "build_serve_instance_lock",
        lambda _settings: _FakeLock(),
    )
    monkeypatch.setattr(
        weixin_cli_module,
        "load_bushserver_backend_from_env",
        _fail_load_backend,
    )

    status = asyncio.run(
        weixin_cli_module._run_serve(
            WeixinBotSettings(data_dir=tmp_path),
            backend_url=None,
            project_dir=None,
        )
    )

    captured = capsys.readouterr()
    assert status == 2
    assert "another instance is already running" in captured.err


def test_weixin_cli_serve_stops_and_releases_lock_when_parent_exits(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    calls: list[object] = []
    service_started = asyncio.Event()

    class _FakeLock:
        def acquire(self) -> None:
            calls.append("acquire")

        def release(self) -> None:
            calls.append("release")

    class _FakeService:
        def __init__(self, *, settings: WeixinBotSettings, backend: object) -> None:
            calls.append(("service", settings.data_dir, backend))

        async def run(self) -> None:
            calls.append("run")
            service_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                calls.append("run-finally")

        async def shutdown(self) -> None:
            calls.append("shutdown")

    async def _parent_exits(_parent_pid: int) -> None:
        await service_started.wait()

    expected_backend = object()
    monkeypatch.setattr(
        weixin_cli_module,
        "build_serve_instance_lock",
        lambda _settings, *, parent_pid=None: (
            calls.append(("parent-pid", parent_pid)) or _FakeLock()
        ),
    )
    monkeypatch.setattr(
        weixin_cli_module,
        "load_bushserver_backend_from_env",
        lambda: expected_backend,
    )
    monkeypatch.setattr(weixin_cli_module, "WeixinBotService", _FakeService)
    monkeypatch.setattr(
        weixin_cli_module,
        "process_is_running",
        lambda pid: pid == 4321,
    )
    monkeypatch.setattr(
        weixin_cli_module,
        "_wait_for_parent_exit",
        _parent_exits,
    )

    status = asyncio.run(
        weixin_cli_module._run_serve(
            WeixinBotSettings(data_dir=tmp_path),
            backend_url=None,
            project_dir=None,
            parent_pid=4321,
        )
    )

    assert status == 0
    assert calls == [
        ("parent-pid", 4321),
        "acquire",
        ("service", tmp_path, expected_backend),
        "run",
        "run-finally",
        "shutdown",
        "release",
    ]
    assert "managing CardBush host exited" in capsys.readouterr().out


def test_weixin_cli_serve_ctrl_c_exits_cleanly(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_cli_module,
        "_build_parser",
        lambda: SimpleNamespace(
            parse_args=lambda: SimpleNamespace(
                command="serve",
                env_file=".env",
                data_dir=None,
                backend_url=None,
                project_dir=None,
            )
        ),
    )
    monkeypatch.setattr(
        weixin_cli_module,
        "_resolve_settings",
        lambda _args: WeixinBotSettings(data_dir=tmp_path),
    )

    def _raise_keyboard_interrupt(_coro) -> int:
        _coro.close()
        raise KeyboardInterrupt

    monkeypatch.setattr(weixin_cli_module.asyncio, "run", _raise_keyboard_interrupt)

    try:
        weixin_cli_module.main()
    except SystemExit as exc:
        assert exc.code == 130
    else:
        raise AssertionError("expected SystemExit when Ctrl+C interrupts serve")


def test_graceful_shutdown_signals_registers_sigbreak_when_available(
    monkeypatch,
) -> None:
    calls: list[tuple[str, object, object | None]] = []

    def _fake_getsignal(signum: int):
        calls.append(("get", signum, None))
        return f"previous-{signum}"

    def _fake_signal(signum: int, handler) -> None:
        calls.append(("set", signum, handler))

    monkeypatch.setattr(common_signals_module.signal, "getsignal", _fake_getsignal)
    monkeypatch.setattr(common_signals_module.signal, "signal", _fake_signal)
    monkeypatch.setattr(
        common_signals_module.signal,
        "SIGBREAK",
        21,
        raising=False,
    )

    with common_signals_module.graceful_shutdown_signals():
        pass

    configured = [
        signum
        for action, signum, handler in calls
        if action == "set"
        and handler is common_signals_module._raise_keyboard_interrupt
    ]
    restored = {
        signum: handler
        for action, signum, handler in calls
        if action == "set"
        and isinstance(handler, str)
    }

    assert configured == [
        common_signals_module.signal.SIGINT,
        common_signals_module.signal.SIGTERM,
        21,
    ]
    assert restored == {
        common_signals_module.signal.SIGINT: f"previous-{common_signals_module.signal.SIGINT}",
        common_signals_module.signal.SIGTERM: f"previous-{common_signals_module.signal.SIGTERM}",
        21: "previous-21",
    }


def test_weixin_service_retries_send_text_once_before_success(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.attempts = 0
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.attempts += 1
            if self.attempts == 1:
                raise RuntimeError("temporary send failure")
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=_Client(),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "hello"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    client = service._client
    assert client.attempts == 2
    assert client.sent_texts == ["reply:hello"]


def test_weixin_service_strips_tool_result_search_hint_from_reply(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(
                text="当前已安装 34 个工具。\n\n具体工具执行历史搜索词: 有哪些 工具"
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-strip-hint",
            "item_list": [{"type": 1, "text_item": {"text": "有哪些工具"}}],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_texts == ["当前已安装 34 个工具。"]


def test_weixin_reply_send_failure_is_scheduled_for_retry(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.attempts = 0
            self.reset_calls = 0

        async def send_text(self, **kwargs) -> None:
            self.attempts += 1
            request = httpx.Request("POST", "https://ilink.example/sendmessage")
            raise httpx.ConnectError("temporary connect failure", request=request)

        async def reset_connections(self) -> None:
            self.reset_calls += 1

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    sent = asyncio.run(
        service._try_deliver_reply_text(
            account=account,
            to_user_id="user-a",
            text="reply body",
            context_token=None,
            purpose="reply",
            message_id="msg-1",
            session_id="weixin:acct-1:user-a:session-1",
        )
    )

    assert sent is False
    assert client.attempts == weixin_service_module._SEND_TEXT_MAX_ATTEMPTS
    assert client.reset_calls == weixin_service_module._SEND_TEXT_MAX_ATTEMPTS
    jobs = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
    )
    assert len(jobs) == 1
    assert jobs[0].reply_text == "reply body"
    assert jobs[0].user_id == "user-a"
    assert jobs[0].channel_id == "acct-1"
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "send_text_scheduled_retry" in events
    assert "send_text_delivery_failure" in events


def test_weixin_interactive_request_send_failure_is_not_scheduled(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.attempts = 0

        async def send_text(self, **kwargs) -> None:
            self.attempts += 1
            request = httpx.Request("POST", "https://ilink.example/sendmessage")
            raise httpx.ConnectError("temporary connect failure", request=request)

        async def reset_connections(self) -> None:
            return None

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    sent = asyncio.run(
        service._try_deliver_reply_text(
            account=account,
            to_user_id="user-a",
            text="interaction card",
            context_token=None,
            purpose="interactive-request",
            message_id="msg-1",
            session_id="weixin:acct-1:user-a:session-1",
        )
    )

    assert sent is False
    assert client.attempts == weixin_service_module._SEND_TEXT_MAX_ATTEMPTS
    assert service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
    ) == []


def test_weixin_poll_loop_survives_send_failure_for_one_message(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self._update_calls = 0
            self.send_calls: list[tuple[str, str]] = []

        async def get_updates(self, **kwargs):
            self._update_calls += 1
            if self._update_calls == 1:
                return GetUpdatesResult(
                    ret=0,
                    errcode=None,
                    errmsg=None,
                    messages=[
                        WeixinMessage(
                            raw={
                                "from_user_id": "user-fail",
                                "message_id": "msg-fail",
                                "item_list": [
                                    {
                                        "type": 1,
                                        "text_item": {"text": "first"},
                                    }
                                ],
                            }
                        ),
                        WeixinMessage(
                            raw={
                                "from_user_id": "user-ok",
                                "message_id": "msg-ok",
                                "item_list": [
                                    {
                                        "type": 1,
                                        "text_item": {"text": "second"},
                                    }
                                ],
                            }
                        ),
                    ],
                    sync_buffer="sync-1",
                    longpolling_timeout_ms=None,
                )
            raise asyncio.CancelledError()

        async def send_text(self, **kwargs) -> None:
            user_id = str(kwargs["to_user_id"])
            text = str(kwargs["text"])
            self.send_calls.append((user_id, text))
            if user_id == "user-fail":
                raise RuntimeError("send failed")

    settings = WeixinBotSettings(data_dir=tmp_path)
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=_Client(),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    try:
        asyncio.run(service._poll_account(account))
    except asyncio.CancelledError:
        pass

    client = service._client
    assert client.send_calls == [
        *[
            ("user-fail", "reply:first")
            for _ in range(weixin_service_module._SEND_TEXT_MAX_ATTEMPTS)
        ],
        ("user-ok", "reply:second"),
    ]
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "send_text_delivery_failure" in events
    assert trace["last_forward_result"]["event"] == "forward_success"


def test_weixin_session_expiry_persists_structured_runtime_health(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text="unused")

    class _Client:
        async def get_updates(self, **kwargs):
            return GetUpdatesResult(
                ret=weixin_client_module.SESSION_EXPIRED_ERRCODE,
                errcode=weixin_client_module.SESSION_EXPIRED_ERRCODE,
                errmsg="session expired",
                messages=[],
                sync_buffer="",
                longpolling_timeout_ms=None,
            )

    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
    )
    service._accounts = {account.account_id: account}

    asyncio.run(service._poll_account(account))

    payload = json.loads(
        service._state.runtime_status_path.read_text(encoding="utf-8")
    )
    assert payload == {
        "protocol": "cardbush_app.bot_runtime_status.v1",
        "platform": "weixin",
        "service_status": "failed",
        "health_status": "authentication_expired",
        "error_code": "weixin_session_expired",
        "last_error": "Weixin login expired; reconnect the account and restart the bot.",
        "requires_reauthentication": True,
        "accounts": [
            {"account_id": "acct-1", "status": "authentication_expired"}
        ],
        "updated_at": payload["updated_at"],
    }


def test_weixin_background_interactive_notice_send_failure_is_isolated(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )
    monkeypatch.setattr(
        weixin_service_module,
        "_INTERACTION_POLL_INTERVAL_SECONDS",
        0.01,
    )

    class _Backend:
        async def get_pending_interaction(self, session_id):
            return {
                "interaction_id": "interaction-1",
                "title": "需要确认",
                "questions": [
                    {
                        "id": "confirm",
                        "label": "确认",
                        "options": [{"label": "继续", "value": "yes"}],
                    }
                ],
            }

    class _Client:
        def __init__(self) -> None:
            self.send_text_calls = 0

        async def send_text(self, **kwargs) -> None:
            self.send_text_calls += 1
            raise RuntimeError("connect failed")

    async def _run(service: WeixinBotService, account: WeixinAccount) -> None:
        async def _response() -> SimpleNamespace:
            await asyncio.sleep(0.03)
            return SimpleNamespace(text="done")

        await service._finalize_background_exchange(
            account=account,
            envelope=ChatEnvelope(
                platform="weixin",
                session_id="weixin:acct-1:user-a:session-1",
                user_id="user-a",
                channel_id="acct-1",
                text="需要确认的任务",
                message_id="msg-1",
            ),
            context_token=None,
            message_id="msg-1",
            response_task=asyncio.create_task(_response()),
        )

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    asyncio.run(_run(service, account))

    assert client.send_text_calls == weixin_service_module._SEND_TEXT_MAX_ATTEMPTS * 2
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "send_text_delivery_failure" in events
    assert "forward_failure" not in events
    assert trace["last_forward_result"]["event"] == "forward_partial_success"


def test_weixin_poll_loop_retries_getupdates_after_transient_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_POLL_EXCEPTION_RETRY_BASE_SECONDS",
        0.0,
    )
    monkeypatch.setattr(
        weixin_service_module,
        "_POLL_EXCEPTION_RETRY_MAX_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.update_calls = 0
            self.send_calls: list[str] = []

        async def get_updates(self, **kwargs):
            self.update_calls += 1
            if self.update_calls == 1:
                raise RuntimeError("temporary network failure")
            if self.update_calls == 2:
                return GetUpdatesResult(
                    ret=0,
                    errcode=None,
                    errmsg=None,
                    messages=[
                        WeixinMessage(
                            raw={
                                "from_user_id": "user-a",
                                "message_id": "msg-1",
                                "item_list": [
                                    {
                                        "type": 1,
                                        "text_item": {"text": "hello"},
                                    }
                                ],
                            }
                        )
                    ],
                    sync_buffer="sync-2",
                    longpolling_timeout_ms=None,
                )
            raise asyncio.CancelledError()

        async def send_text(self, **kwargs) -> None:
            self.send_calls.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=_Client(),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    try:
        asyncio.run(service._poll_account(account))
    except asyncio.CancelledError:
        pass

    client = service._client
    assert client.update_calls == 3
    assert client.send_calls == ["reply:hello"]


def test_weixin_poll_loop_retries_failed_message_without_replaying_successes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_MESSAGE_HANDLE_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Client:
        def __init__(self) -> None:
            self.update_calls = 0

        async def get_updates(self, **kwargs):
            self.update_calls += 1
            if self.update_calls in (1, 2):
                return GetUpdatesResult(
                    ret=0,
                    errcode=None,
                    errmsg=None,
                    messages=[
                        WeixinMessage(
                            raw={
                                "from_user_id": "user-a",
                                "message_id": "msg-1",
                                "item_list": [
                                    {
                                        "type": 1,
                                        "text_item": {"text": "first"},
                                    }
                                ],
                            }
                        ),
                        WeixinMessage(
                            raw={
                                "from_user_id": "user-a",
                                "message_id": "msg-2",
                                "item_list": [
                                    {
                                        "type": 1,
                                        "text_item": {"text": "second"},
                                    }
                                ],
                            }
                        ),
                    ],
                    sync_buffer="sync-2",
                    longpolling_timeout_ms=None,
                )
            raise asyncio.CancelledError()

        async def send_text(self, **kwargs) -> None:
            return None
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    seen_calls: list[str] = []
    original_handle_message = service._handle_message

    async def _flaky_handle_message(current_account, message):
        text = extract_message_text(message)
        seen_calls.append(text)
        if text == "second" and seen_calls.count("second") == 1:
            raise RuntimeError("handler boom")
        return await original_handle_message(current_account, message)

    service._handle_message = _flaky_handle_message  # type: ignore[method-assign]

    try:
        asyncio.run(service._poll_account(account))
    except asyncio.CancelledError:
        pass

    assert seen_calls == ["first", "second", "second"]
    assert store.load_sync_buffer("acct-1") == "sync-2"


def test_weixin_service_persists_recent_handled_message_ids_across_restart(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    service._mark_message_handled("acct-1", "msg-1")

    restarted = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    assert restarted._was_recently_handled_message_id("acct-1", "msg-1") is True


def test_weixin_service_persists_message_failure_counts_across_restart(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    assert service._record_message_handle_failure("acct-1", "msg-1") == 1

    restarted = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    assert restarted._record_message_handle_failure("acct-1", "msg-1") == 2


def test_weixin_service_startup_clears_stale_failed_and_inflight_requests(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    store.save_account(account)
    store.save_message_processing_state(
        "acct-1",
        handled={"msg-old-ok": 1.0},
        failures={"msg-old-fail": 2},
    )
    store.save_runtime_trace(
        "acct-1",
        {
            "last_forward_attempt": {
                "event": "forward_start",
                "message_id": "msg-inflight",
                "session_id": "weixin:acct-1:user-a",
            },
            "last_forward_result": {
                "event": "forward_success",
                "message_id": "msg-old-ok",
                "session_id": "weixin:acct-1:user-a",
            },
            "recent_events": [],
        },
    )

    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )

    async def _scenario() -> None:
        await service.startup()
        await service.shutdown()

    asyncio.run(_scenario())

    state = store.load_message_processing_state("acct-1")
    handled = dict(state.get("handled") or {})
    failures = dict(state.get("failures") or {})
    assert "msg-old-fail" in handled
    assert "msg-inflight" in handled
    assert failures == {}
    trace = store.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "startup_cleared_stale_requests" in events


def test_weixin_service_delivers_due_scheduled_delivery_job(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    client = _Client()
    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    deliverable = tmp_path / "ready.txt"
    deliverable.write_text("ready", encoding="utf-8")
    job = service._scheduled_delivery_store.create_job(
        session_id="weixin:acct-1:user-a:session-1",
        user_id="user-a",
        channel_id="acct-1",
        platform="weixin",
        mode="deliver_prepared",
        execute_at=datetime.now().astimezone(),
        task_text="send later",
        reply_text="scheduled text",
        deliverables=[{"path": str(deliverable), "caption": "ready"}],
        transport_channel="weixin",
    )

    async def _scenario() -> None:
        delivered = await service._drain_due_scheduled_deliveries(account)
        assert delivered == 1

    asyncio.run(_scenario())

    assert client.sent_texts == ["scheduled text"]
    assert client.sent_paths == [str(deliverable)]
    stored = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
        include_terminal=True,
    )
    assert stored[0].job_id == job.job_id
    assert stored[0].status == "completed"


def test_weixin_service_scheduled_delivery_retries_only_failed_deliverables(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_DELIVERABLE_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            path = str(kwargs["file_path"])
            self.sent_paths.append(path)
            if Path(path).name == "bad.txt":
                raise RuntimeError("upload boom")
            return "file"

    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=WeixinStateStore(tmp_path / "state"),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    ok_file = tmp_path / "ok.txt"
    bad_file = tmp_path / "bad.txt"
    ok_file.write_text("ok", encoding="utf-8")
    bad_file.write_text("bad", encoding="utf-8")
    job = service._scheduled_delivery_store.create_job(
        session_id="weixin:acct-1:user-a:session-1",
        user_id="user-a",
        channel_id="acct-1",
        platform="weixin",
        mode="deliver_prepared",
        execute_at=datetime.now().astimezone(),
        task_text="send later",
        reply_text="scheduled text",
        deliverables=[
            {"path": str(ok_file), "caption": "ok"},
            {"path": str(bad_file), "caption": "bad"},
        ],
        transport_channel="weixin",
    )

    async def _scenario() -> None:
        delivered = await service._drain_due_scheduled_deliveries(account)
        assert delivered == 0

    asyncio.run(_scenario())

    assert client.sent_paths.count(str(ok_file)) == 1
    assert client.sent_paths.count(str(bad_file)) == weixin_service_module._SEND_DELIVERABLE_MAX_ATTEMPTS
    assert client.sent_texts == []
    active_jobs = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
    )
    assert len(active_jobs) == 1
    assert active_jobs[0].job_id == job.job_id
    assert active_jobs[0].reply_text == "scheduled text"
    assert active_jobs[0].attempts == 1
    assert [Path(item.path).name for item in active_jobs[0].deliverables] == ["bad.txt"]
    stored = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
        include_terminal=True,
    )
    assert len(stored) == 1
    assert stored[0].job_id == job.job_id
    assert stored[0].status == "pending"


def test_weixin_service_scheduled_delivery_text_failure_after_files_schedules_text_retry(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_TEXT_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))
            raise RuntimeError("text boom")

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=WeixinStateStore(tmp_path / "state"),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    deliverable = tmp_path / "ready.txt"
    deliverable.write_text("ready", encoding="utf-8")
    job = service._scheduled_delivery_store.create_job(
        session_id="weixin:acct-1:user-a:session-1",
        user_id="user-a",
        channel_id="acct-1",
        platform="weixin",
        mode="deliver_prepared",
        execute_at=datetime.now().astimezone(),
        task_text="send later",
        reply_text="scheduled text",
        deliverables=[{"path": str(deliverable)}],
        transport_channel="weixin",
    )

    async def _scenario() -> None:
        delivered = await service._drain_due_scheduled_deliveries(account)
        assert delivered == 1

    asyncio.run(_scenario())

    assert client.sent_paths == [str(deliverable)]
    assert client.sent_texts == [
        "scheduled text",
    ] * weixin_service_module._SEND_TEXT_MAX_ATTEMPTS
    active_jobs = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
    )
    assert len(active_jobs) == 1
    assert active_jobs[0].reply_text == "scheduled text"
    assert active_jobs[0].deliverables == ()
    stored = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a:session-1",
        include_terminal=True,
    )
    assert any(item.job_id == job.job_id and item.status == "completed" for item in stored)


def test_weixin_service_restarts_poll_task_after_crash(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_POLL_TASK_RESTART_BASE_SECONDS",
        0.0,
    )
    monkeypatch.setattr(
        weixin_service_module,
        "_POLL_TASK_RESTART_MAX_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            return None

    store = WeixinStateStore(tmp_path / "state")
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    store.save_account(account)

    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    attempts = {"count": 0}
    restarted = asyncio.Event()

    async def _fake_poll_account(current_account):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("boom")
        restarted.set()
        await asyncio.sleep(3600)

    service._poll_account = _fake_poll_account  # type: ignore[method-assign]

    async def _scenario() -> None:
        await service.startup()
        await asyncio.wait_for(restarted.wait(), timeout=1.0)
        assert attempts["count"] == 2
        await service.shutdown()

    asyncio.run(_scenario())


def test_weixin_service_handles_pending_interaction_round_trip(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_INTERACTION_POLL_INTERVAL_SECONDS",
        0.0,
    )

    class _Backend:
        def __init__(self) -> None:
            self.pending: dict[str, object] | None = None
            self.reply_event = asyncio.Event()
            self.reply_payloads: list[str] = []

        async def respond(self, envelope):
            self.pending = {
                "interaction_id": "ix-permission",
                "type": "path_permission_request",
                "title": "允许工作区外访问",
                "description": "需要访问项目外的一个路径。",
                "questions": [
                    {
                        "id": "permission",
                        "label": "权限",
                        "question": "是否允许这次工作区外访问？",
                        "selection_mode": "single",
                        "required": True,
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "allow_session", "label": "本会话允许"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }
            await asyncio.sleep(0)
            await self.reply_event.wait()
            return SimpleNamespace(text="最终回复")

        async def get_pending_interaction(self, session_id: str):
            if session_id != "weixin:acct-1:user-a":
                return None
            if self.pending is None:
                return None
            return dict(self.pending)

        async def reply_interaction(self, interaction_id: str, *, raw_text=None, answers=None):
            assert interaction_id == "ix-permission"
            assert answers is None
            self.reply_payloads.append(str(raw_text))
            self.pending = None
            self.reply_event.set()

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=backend,
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    first_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "context_token": "ctx-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "帮我继续"},
                }
            ],
        }
    )
    second_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-2",
            "context_token": "ctx-2",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "2"},
                }
            ],
        }
    )

    async def _wait_for(predicate, *, timeout: float = 1.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if predicate():
                return
            await asyncio.sleep(0)
        raise AssertionError("condition not reached before timeout")

    async def _scenario() -> None:
        await service._handle_message(account, first_message)
        await _wait_for(lambda: bool(client.sent_texts))
        await service._handle_message(account, second_message)
        await _wait_for(lambda: "最终回复" in client.sent_texts)
        assert backend.reply_payloads == ["deny"]
        assert client.sent_texts[0].startswith("**需要你确认授权**")
        assert "**原因**：需要访问项目外的一个路径。" in client.sent_texts[0]
        assert "回复 `1` 授权，回复 `2` 拒绝。" in client.sent_texts[0]
        assert "方括号里的 id" not in client.sent_texts[0]
        assert "**已收到你的选择**\n\n继续处理中。" in client.sent_texts
        assert client.sent_texts[-1] == "最终回复"

    asyncio.run(_scenario())


def test_weixin_service_uses_announced_interaction_cache_when_pending_lookup_blips(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_INTERACTION_POLL_INTERVAL_SECONDS",
        0.0,
    )

    class _Backend:
        def __init__(self) -> None:
            self.pending: dict[str, object] | None = None
            self.reply_event = asyncio.Event()
            self.reply_payloads: list[str] = []
            self.lookup_count = 0

        async def respond(self, envelope):
            self.pending = {
                "interaction_id": "ix-permission",
                "type": "path_permission_request",
                "title": "允许工作区外访问",
                "description": "需要访问项目外的一个路径。",
                "questions": [
                    {
                        "id": "permission",
                        "label": "权限",
                        "question": "是否允许这次工作区外访问？",
                        "selection_mode": "single",
                        "required": True,
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }
            await self.reply_event.wait()
            return SimpleNamespace(text="最终回复")

        async def get_pending_interaction(self, session_id: str):
            if session_id != "weixin:acct-1:user-a" or self.pending is None:
                return None
            self.lookup_count += 1
            if self.lookup_count == 1:
                return dict(self.pending)
            return None

        async def reply_interaction(self, interaction_id: str, *, raw_text=None, answers=None):
            assert interaction_id == "ix-permission"
            assert answers is None
            self.reply_payloads.append(str(raw_text))
            self.pending = None
            self.reply_event.set()

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(settings=settings, backend=backend, client=client)
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    first_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "context_token": "ctx-1",
            "item_list": [{"type": 1, "text_item": {"text": "帮我继续"}}],
        }
    )
    second_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-2",
            "context_token": "ctx-2",
            "item_list": [{"type": 1, "text_item": {"text": "2"}}],
        }
    )

    async def _wait_for(predicate, *, timeout: float = 1.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if predicate():
                return
            await asyncio.sleep(0)
        raise AssertionError("condition not reached before timeout")

    async def _scenario() -> None:
        await service._handle_message(account, first_message)
        await _wait_for(lambda: bool(client.sent_texts))
        await service._handle_message(account, second_message)
        await _wait_for(lambda: client.sent_texts[-1] == "最终回复")

    asyncio.run(_scenario())

    assert backend.reply_payloads == ["deny"]
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "interactive_reply_using_announced_cache" in events
    assert "interactive_reply_submitted" in events


def test_weixin_service_background_exchange_can_surface_multiple_pending_interactions(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_INTERACTION_POLL_INTERVAL_SECONDS",
        0.0,
    )

    class _Backend:
        def __init__(self) -> None:
            self.pending: dict[str, object] | None = None
            self.pending_index = 0
            self.reply_payloads: list[tuple[str, str]] = []
            self._reply_events = [asyncio.Event(), asyncio.Event()]

        def _set_pending(self, index: int) -> None:
            self.pending_index = index
            self.pending = {
                "interaction_id": f"ix-permission-{index}",
                "type": "path_permission_request",
                "title": f"权限确认 {index}",
                "description": f"需要第 {index} 次确认。",
                "questions": [
                    {
                        "id": "permission",
                        "label": "权限",
                        "question": f"是否允许第 {index} 次操作？",
                        "selection_mode": "single",
                        "required": True,
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }

        async def respond(self, envelope):
            self._set_pending(1)
            await self._reply_events[0].wait()
            self._set_pending(2)
            await self._reply_events[1].wait()
            self.pending = None
            return SimpleNamespace(text="最终回复")

        async def get_pending_interaction(self, session_id: str):
            if session_id != "weixin:acct-1:user-a":
                return None
            if self.pending is None:
                return None
            return dict(self.pending)

        async def reply_interaction(
            self,
            interaction_id: str,
            *,
            raw_text=None,
            answers=None,
        ):
            assert answers is None
            self.reply_payloads.append((interaction_id, str(raw_text)))
            expected = f"ix-permission-{len(self.reply_payloads)}"
            assert interaction_id == expected
            self.pending = None
            self._reply_events[len(self.reply_payloads) - 1].set()

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=backend,
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )

    first_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "context_token": "ctx-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "帮我继续"},
                }
            ],
        }
    )
    second_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-2",
            "context_token": "ctx-2",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "1"},
                }
            ],
        }
    )
    third_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-3",
            "context_token": "ctx-3",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "1"},
                }
            ],
        }
    )

    async def _wait_for(predicate, *, timeout: float = 1.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if predicate():
                return
            await asyncio.sleep(0)
        raise AssertionError("condition not reached before timeout")

    async def _scenario() -> None:
        await service._handle_message(account, first_message)
        await _wait_for(lambda: any("权限确认 1" in text for text in client.sent_texts))
        await service._handle_message(account, second_message)
        await _wait_for(lambda: any("权限确认 2" in text for text in client.sent_texts))
        await service._handle_message(account, third_message)
        await _wait_for(lambda: client.sent_texts and client.sent_texts[-1] == "最终回复")
        assert backend.reply_payloads == [
            ("ix-permission-1", "allow_once"),
            ("ix-permission-2", "allow_once"),
        ]
        assert any("权限确认 1" in text for text in client.sent_texts)
        assert any("权限确认 2" in text for text in client.sent_texts)
        assert client.sent_texts.count("**已收到你的选择**\n\n继续处理中。") == 2

    asyncio.run(_scenario())


def test_weixin_service_reprompts_on_invalid_pending_interaction_reply(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def reply_interaction(
            self,
            interaction_id: str,
            *,
            raw_text=None,
            answers=None,
        ):
            assert interaction_id == "ix-permission"
            assert raw_text == "随便来一句"
            assert answers is None
            raise InteractiveReplyValidationError(
                "raw_text could not be matched to this interaction"
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    pending = {
        "interaction_id": "ix-permission",
        "type": "path_permission_request",
        "title": "允许工作区外访问",
        "description": "需要访问项目外的一个路径。",
        "questions": [
            {
                "id": "permission",
                "label": "权限",
                "question": "是否允许这次工作区外访问？",
                "selection_mode": "single",
                "required": True,
                "options": [
                    {"id": "allow_once", "label": "允许一次"},
                    {"id": "allow_session", "label": "本会话允许"},
                    {"id": "deny", "label": "拒绝"},
                ],
            }
        ],
    }
    envelope = SimpleNamespace(
        session_id="weixin:acct-1:user-a",
        user_id="user-a",
    )

    async def _scenario() -> None:
        handled = await service._handle_pending_interaction_message(
            account=account,
            envelope=envelope,
            pending=pending,
            text="随便来一句",
            context_token="ctx-1",
            message_id="msg-1",
        )
        assert handled is True
        assert len(client.sent_texts) == 1
        assert client.sent_texts[0].startswith("**授权没识别成功**")
        assert "**原因**：需要访问项目外的一个路径。" in client.sent_texts[0]
        assert "回复 `1` 授权，回复 `2` 拒绝。" in client.sent_texts[0]
        assert "1. 允许一次 [allow_once]" not in client.sent_texts[0]
        assert "提交确认失败" not in client.sent_texts[0]

    asyncio.run(_scenario())


def test_weixin_service_formats_generic_pending_interaction_copy() -> None:
    pending = {
        "interaction_id": "ix-generic",
        "type": "user_input",
        "reply_mode": "raw_text_passthrough",
        "title": "补充一下需求",
        "reason": "需要先确认你更偏好的风格，再继续生成交付内容。",
        "description": "我需要再确认一点信息。",
        "questions": [
            {
                "id": "style",
                "label": "风格",
                "question": "你想要什么风格？",
                "selection_mode": "single",
                "required": True,
                "options": [
                    {"id": "modern", "label": "现代简洁"},
                    {"id": "editorial", "label": "杂志感"},
                ],
            }
        ],
    }

    text = WeixinBotService._format_pending_interaction_text(pending)

    assert text.startswith("**继续之前，我还差你一条信息。**")
    assert "补充一下需求" in text
    assert "**原因**：需要先确认你更偏好的风格，再继续生成交付内容。" in text
    assert "你可以参考这些方向：现代简洁、杂志感" in text
    assert "直接像平时聊天一样把你的想法发我就行，不用按固定格式。" in text
    assert "先不继续的话，回“取消”即可。" in text
    assert "方括号里的 id" not in text
    assert "如果有多项，请一行写一个答案" not in text


def test_weixin_service_caches_attachment_and_merges_it_into_next_text(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(
                SimpleNamespace(
                    text=envelope.text,
                    raw_event=envelope.raw_event,
                    session_id=envelope.session_id,
                )
            )
            return SimpleNamespace(text="已处理")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def download_media_item(self, *, item):
            _ = item
            return SimpleNamespace(
                kind="file",
                content=b"demo-content",
                file_name="spec.txt",
                mime_type="text/plain",
            )

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(data_dir=tmp_path)
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=backend,
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    attachment_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-file",
            "item_list": [
                {
                    "type": 4,
                    "file_item": {
                        "file_name": "spec.txt",
                        "media": {"encrypt_query_param": "cipher"},
                    },
                }
            ],
        }
    )
    text_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-text",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "帮我总结一下这个附件"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, attachment_message)
        pending = await service._get_pending_attachment_context(
            session_id="weixin:acct-1:user-a"
        )
        assert len(pending) == 1
        saved_path = Path(pending[0]["path"])
        assert saved_path.exists()
        assert saved_path.name == "spec.txt"
        assert "已收到文件" in client.sent_texts[0]

        await service._handle_message(account, text_message)

        assert len(backend.envelopes) == 1
        envelope = backend.envelopes[0]
        assert "【本会话附件上下文】" in envelope.text
        assert str(saved_path) in envelope.text
        assert envelope.raw_event["cached_attachments"][0]["path"] == str(saved_path)
        assert client.sent_texts[-1] == "已处理"
        assert (
            await service._get_pending_attachment_context(
                session_id="weixin:acct-1:user-a"
            )
            == []
        )

    asyncio.run(_scenario())


def test_weixin_service_new_command_switches_to_fresh_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="fresh-session-id"),
    )

    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(
                SimpleNamespace(
                    session_id=envelope.session_id,
                    text=envelope.text,
                )
            )
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    new_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-new",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": " /new "},
                }
            ],
        }
    )
    follow_up = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-hello",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "你好"},
                }
            ],
        }
    )
    default_session_id = "weixin:acct-1:user-a"
    fresh_session_id = "weixin:acct-1:user-a:fresh-session-id"

    async def _scenario() -> None:
        await service._cache_pending_attachment(
            session_id=default_session_id,
            kind="file",
            name="spec.txt",
            path="C:/temp/spec.txt",
            message_id="msg-file",
        )

        await service._handle_message(account, new_message)

        assert backend.envelopes == []
        assert client.sent_texts == [
            "**已切换到新会话**\n\n接下来我们按一条新的对话继续。"
        ]
        assert (
            store.get_active_session_id("acct-1", "user-a")
            == fresh_session_id
        )
        assert (
            await service._get_pending_attachment_context(
                session_id=default_session_id
            )
            == []
        )

        await service._handle_message(account, follow_up)

        assert len(backend.envelopes) == 1
        assert backend.envelopes[0].session_id == fresh_session_id
        assert backend.envelopes[0].text == "你好"
        assert client.sent_texts[-1] == "reply:你好"

    asyncio.run(_scenario())


def test_weixin_service_unknown_slash_command_returns_help_without_forwarding(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-oops",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/nwe"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**未知命令**")
    assert "未识别 `/nwe`" in client.sent_texts[0]
    assert "**当前支持的 / 命令**" in client.sent_texts[0]
    assert "`/new`" in client.sent_texts[0]
    assert "`/cancel`" in client.sent_texts[0]
    assert "`/status`" in client.sent_texts[0]
    assert "`/subagent`" in client.sent_texts[0]


def test_weixin_service_model_command_lists_models_without_forwarding(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def get_model_configs(self):
            return {
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

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-model-menu",
            "item_list": [{"type": 1, "text_item": {"text": "/model"}}],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**可选模型**")
    assert "回复序号切换默认模型" in client.sent_texts[0]
    assert "`deepseek-v4-pro`（当前）" in client.sent_texts[0]
    assert "`gpt-5-mini`" in client.sent_texts[0]
    assert "sk-primary" not in client.sent_texts[0]
    assert "sk-fallback" not in client.sent_texts[0]
    trace = store.load_runtime_trace("acct-1")
    assert trace["recent_events"][-1]["event"] == "slash_model_menu"


def test_weixin_service_model_selection_switches_default_without_forwarding(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []
            self.switch_ids: list[str] = []
            self.document = {
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

        async def get_model_configs(self):
            return dict(self.document)

        async def switch_default_model_config(self, model_config_id: str):
            self.switch_ids.append(model_config_id)
            updated = dict(self.document)
            updated["default_model_id"] = model_config_id
            updated["defaultModelId"] = model_config_id
            self.document = updated
            return dict(updated)

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    menu_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-model-menu",
            "item_list": [{"type": 1, "text_item": {"text": "/model"}}],
        }
    )
    selection_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-model-select",
            "item_list": [{"type": 1, "text_item": {"text": "2"}}],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, menu_message)
        await service._handle_message(account, selection_message)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert backend.switch_ids == ["fallback"]
    assert len(client.sent_texts) == 2
    assert client.sent_texts[-1].startswith("**已切换默认模型**")
    assert "provider: `openai`" in client.sent_texts[-1]
    assert "model: `gpt-5-mini`" in client.sent_texts[-1]
    assert "槽位: `fallback`" in client.sent_texts[-1]
    assert "sk-fallback" not in client.sent_texts[-1]
    trace = store.load_runtime_trace("acct-1")
    assert trace["recent_events"][-1]["event"] == "slash_model_switched"


def test_weixin_service_cancel_command_without_pending_returns_help(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-cancel",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/cancel"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert "当前没有等待中的确认可取消" in client.sent_texts[0]
    assert "`/new`" in client.sent_texts[0]
    assert "`/cancel`" in client.sent_texts[0]
    assert "`/status`" in client.sent_texts[0]
    assert "`/subagent`" in client.sent_texts[0]


def test_weixin_service_stop_command_without_active_request_returns_help(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-stop-none",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/stop"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert "当前没有正在处理的请求可停止" in client.sent_texts[0]
    assert "`/stop`" in client.sent_texts[0]
    assert "`/status`" in client.sent_texts[0]


def test_weixin_service_status_command_reports_active_guidance_state(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []
            self._active_turns = {
                "turn-1": {
                    "session_id": "weixin:acct-1:user-a",
                    "message_id": "msg-active",
                }
            }

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    session_id = "weixin:acct-1:user-a"
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-status",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/status"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        release = asyncio.Event()

        async def _active_request() -> None:
            await release.wait()

        active_task = asyncio.create_task(_active_request())
        service._active_backend_response_tasks[session_id] = active_task
        try:
            await service._handle_message(account, message)
        finally:
            release.set()
            await asyncio.gather(active_task, return_exceptions=True)

    asyncio.run(_scenario())

    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**当前状态**")
    assert "请求: 运行中" in client.sent_texts[0]
    assert "turn: `turn-1`" in client.sent_texts[0]
    assert "引导:" in client.sent_texts[0]
    trace = store.load_runtime_trace("acct-1")
    assert trace["recent_events"][-1]["event"] == "slash_status"


def test_weixin_service_stop_command_cancels_active_backend_task(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(text="unused")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    session_id = "weixin:acct-1:user-a"
    stop_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-stop-active",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/stop"},
                }
            ],
        }
    )

    async def _pending_task() -> None:
        await asyncio.sleep(60)

    async def _scenario() -> None:
        task = asyncio.create_task(_pending_task())
        service._active_backend_response_tasks[session_id] = task
        await service._handle_message(account, stop_message)
        assert task.cancelled()
        assert session_id not in service._active_backend_response_tasks

    asyncio.run(_scenario())

    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**已请求停止**")
    assert "当前处理中的消息正在停止" in client.sent_texts[0]


def test_weixin_service_stop_command_takes_priority_over_pending_interaction(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.reply_payloads: list[tuple[str, str]] = []

        async def get_pending_interaction(self, session_id):
            _ = session_id
            return {
                "interaction_id": "ix-1",
                "type": "path_permission_request",
                "title": "需要确认",
                "questions": [
                    {
                        "id": "permission",
                        "selection_mode": "single",
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }

        async def reply_interaction(self, interaction_id: str, *, raw_text=None, answers=None):
            _ = answers
            self.reply_payloads.append((interaction_id, str(raw_text or "")))

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=WeixinStateStore(tmp_path / "state"),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    session_id = "weixin:acct-1:user-a"
    stop_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-stop-pending",
            "item_list": [{"type": 1, "text_item": {"text": "/stop"}}],
        }
    )

    async def _pending_task() -> None:
        await asyncio.sleep(60)

    async def _scenario() -> None:
        task = asyncio.create_task(_pending_task())
        service._active_backend_response_tasks[session_id] = task
        await service._handle_message(account, stop_message)
        assert task.cancelled()

    asyncio.run(_scenario())

    assert backend.reply_payloads == []
    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**已请求停止**")


def test_weixin_service_stop_command_cancels_backgrounded_backend_task(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_INTERACTION_POLL_INTERVAL_SECONDS",
        0.01,
    )

    class _Backend:
        def __init__(self) -> None:
            self.release: asyncio.Event | None = None
            self.respond_started: asyncio.Event | None = None

        async def respond(self, envelope):
            _ = envelope
            assert self.release is not None
            assert self.respond_started is not None
            self.respond_started.set()
            await self.release.wait()
            return SimpleNamespace(text="done")

        async def get_pending_interaction(self, session_id):
            _ = session_id
            if self.respond_started is None or not self.respond_started.is_set():
                return None
            return {
                "interaction_id": "ix-1",
                "type": "path_permission_request",
                "title": "需要确认",
                "questions": [
                    {
                        "id": "permission",
                        "selection_mode": "single",
                        "options": [
                            {"id": "allow_once", "label": "允许一次"},
                            {"id": "deny", "label": "拒绝"},
                        ],
                    }
                ],
            }

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=WeixinStateStore(tmp_path / "state"),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    session_id = "weixin:acct-1:user-a"
    task_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-task",
            "item_list": [{"type": 1, "text_item": {"text": "需要慢慢处理"}}],
        }
    )
    stop_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-stop-background",
            "item_list": [{"type": 1, "text_item": {"text": "/stop"}}],
        }
    )

    async def _scenario() -> None:
        backend.release = asyncio.Event()
        backend.respond_started = asyncio.Event()
        await service._handle_message(account, task_message)
        assert session_id in service._active_backend_response_tasks
        active_task = service._active_backend_response_tasks[session_id]
        await service._handle_message(account, stop_message)
        assert active_task.cancelled()
        assert session_id not in service._active_backend_response_tasks
        if service._background_tasks:
            await asyncio.gather(*list(service._background_tasks), return_exceptions=True)

    asyncio.run(_scenario())

    assert any("需要你确认授权" in text for text in client.sent_texts)
    assert client.sent_texts[-1].startswith("**已请求停止**")


def test_weixin_service_subagent_command_enables_current_session_without_forwarding(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.envelopes: list[SimpleNamespace] = []

        async def respond(self, envelope):
            self.envelopes.append(SimpleNamespace(text=envelope.text))
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    backend = _Backend()
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=backend,
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-subagent",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/subagent"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    session_id = "weixin:acct-1:user-a"
    assert backend.envelopes == []
    assert len(client.sent_texts) == 1
    assert client.sent_texts[0].startswith("**Subagent 已开启**")
    assert "已为当前会话开启 subagent" in client.sent_texts[0]
    assert store.get_session_flag(
        "acct-1",
        session_id,
        key="subagent_enabled",
    ) is True
    trace = store.load_runtime_trace("acct-1")
    assert trace["recent_events"][-1]["event"] == "subagent_enabled_for_session"


def test_weixin_service_runtime_trace_records_new_session_switch(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="fresh-session-id"),
    )

    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(text="unused")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-new",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "/new"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    trace = store.load_runtime_trace("acct-1")
    assert trace["last_received"]["event"] == "received"
    assert trace["last_received"]["message_id"] == "msg-new"
    assert trace["last_received"]["session_id"] == "weixin:acct-1:user-a"
    assert trace["last_session_switch"]["event"] == "new_session_switched"
    assert trace["last_session_switch"]["previous_session_id"] == "weixin:acct-1:user-a"
    assert (
        trace["last_session_switch"]["session_id"]
        == "weixin:acct-1:user-a:fresh-session-id"
    )
    assert trace["recent_events"][-1]["event"] == "new_session_ack_sent"


def test_weixin_service_new_session_command_cancels_previous_active_forward(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="fresh-session-id"),
    )
    release = asyncio.Event()

    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            await release.wait()
            return SimpleNamespace(text="reply-after-release")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    old_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-old",
            "item_list": [
                {"type": 1, "text_item": {"text": "old task"}},
            ],
        }
    )
    new_message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-new-switch",
            "item_list": [
                {"type": 1, "text_item": {"text": "/new"}},
            ],
        }
    )

    async def _scenario() -> None:
        old_task = asyncio.create_task(service._handle_message(account, old_message))
        while not service._active_backend_response_tasks:
            await asyncio.sleep(0)
        await service._handle_message(account, new_message)
        release.set()
        await asyncio.gather(old_task, return_exceptions=True)

    asyncio.run(_scenario())

    trace = store.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "new_session_cancelled_previous_forward" in events
    assert trace["last_session_switch"]["session_id"] == "weixin:acct-1:user-a:fresh-session-id"
    assert trace["recent_events"][-1]["event"] == "new_session_ack_sent"


def test_weixin_service_runtime_trace_records_forward_success(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"reply:{envelope.text}")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "你好"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    trace = store.load_runtime_trace("acct-1")
    assert trace["last_forward_attempt"]["event"] == "forward_start"
    assert trace["last_forward_attempt"]["session_id"] == "weixin:acct-1:user-a"
    assert trace["last_forward_attempt"]["text_preview"] == "你好"
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert trace["last_forward_result"]["reply_preview"] == "reply:你好"


def test_weixin_service_runtime_trace_records_guidance_delivery(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(
                text="已收到，我会把这条补充并入当前正在执行的任务。",
                metadata={
                    "guidance_delivered": True,
                    "turn_id": "turn-1",
                    "session_id": envelope.session_id,
                },
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-guidance",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "补充：先不要截图"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    assert client.sent_texts == ["已收到，我会把这条补充并入当前正在执行的任务。"]
    trace = store.load_runtime_trace("acct-1")
    assert trace["last_forward_attempt"]["event"] == "forward_start"
    assert trace["last_forward_result"]["event"] == "guidance_delivered"
    assert trace["last_forward_result"]["turn_id"] == "turn-1"
    assert trace["last_forward_result"]["guidance_delivered"] is True
    assert trace["last_forward_result"]["reply_preview"] == "已收到，我会把这条补充并入当前正在执行的任务。"


def test_weixin_service_shadow_observation_records_success_without_extra_send(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(
                text=f"reply:{envelope.text}",
                metadata={"turn_id": "turn-1"},
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(
        data_dir=tmp_path,
        shadow_observation_enabled=True,
    )
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "帮我继续优化提示词"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_texts == ["reply:帮我继续优化提示词"]
    observation_path = tmp_path / "weixin" / "shadow_observations.jsonl"
    records = [
        json.loads(line)
        for line in observation_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(records) == 1
    record = records[0]
    assert record["schema"] == "weixin_shadow_observation_v2"
    assert record["observation_mode"] == "facts_only"
    assert record["phase"] == "completed"
    assert record["message_id"] == "msg-1"
    assert record["input"]["preview"] == "帮我继续优化提示词"
    assert record["input"]["length"] == len("帮我继续优化提示词")
    assert len(record["input"]["sha256_12"]) == 12
    assert "shadow" not in record
    assert record["outcome"]["turn_id"] == "turn-1"
    assert record["outcome"]["reply_text_sent"] is True


def test_weixin_service_runtime_trace_records_forward_failure(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            raise RuntimeError("backend boom")

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    store = WeixinStateStore(tmp_path / "state")
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "你好"},
                }
            ],
        }
    )

    async def _scenario() -> None:
        await service._handle_message(account, message)

    asyncio.run(_scenario())

    trace = store.load_runtime_trace("acct-1")
    assert trace["last_forward_attempt"]["event"] == "forward_start"
    assert trace["last_forward_result"]["event"] == "forward_failure"
    assert "backend boom" in trace["last_forward_result"]["error"]


def test_weixin_service_runtime_trace_records_model_connection_failure(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            raise ModelConnectionError(
                "litellm.InternalServerError: VolcengineException - Connection error.",
                provider="volcengine",
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    store = WeixinStateStore(tmp_path / "state")
    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
        state_store=store,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "你好"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    trace = store.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_failure"
    assert trace["last_forward_result"]["category"] == "model_connection"
    assert trace["last_forward_result"]["provider"] == "volcengine"
    assert client.sent_texts == [
        "**模型连接失败**\n\n模型服务连接失败，请检查默认模型槽位、供应商网络或稍后重试。"
    ]


def test_weixin_service_shadow_observation_sanitizes_backend_failure(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            raise RuntimeError(
                "litellm.APIConnectionError: Give Feedback / Get Help\n"
                "LiteLLM.Info: internal diagnostics"
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

    settings = WeixinBotSettings(
        data_dir=tmp_path,
        shadow_observation_enabled=True,
    )
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "最新会话超时了"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_texts == [
        "**模型服务暂时不可用**\n\n模型服务响应超时或暂时不可用，请稍后重试。"
    ]
    observation_path = tmp_path / "weixin" / "shadow_observations.jsonl"
    raw_observations = observation_path.read_text(encoding="utf-8")
    assert "LiteLLM.Info" not in raw_observations
    assert "Give Feedback" not in raw_observations
    record = json.loads(raw_observations)
    assert record["phase"] == "failed"
    assert record["outcome"]["error_type"] == "RuntimeError"
    assert record["outcome"]["model_service_error"] is True
    assert record["outcome"]["user_visible_error_sanitized"] is True
    assert (
        record["outcome"]["user_visible_error"]
        == "模型服务响应超时或暂时不可用，请稍后重试。"
    )



def test_weixin_client_upload_media_from_path_avoids_read_bytes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    media_path = tmp_path / "report.txt"
    media_path.write_text("hello weixin", encoding="utf-8")

    class _Response:
        status_code = 200
        headers: dict[str, str] = {}
        text = ""

        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    def _fail_read_bytes(self):
        raise AssertionError("_upload_media_from_path should not call read_bytes")

    monkeypatch.setattr(Path, "read_bytes", _fail_read_bytes)

    client = WeixinClient(WeixinBotSettings(data_dir=tmp_path))

    async def _fake_request(*args, **kwargs):
        _ = (args, kwargs)
        return _Response(
            {
                "upload_full_url": "https://cdn.example.invalid/upload",
                "upload_param": "",
            }
        )

    uploaded: dict[str, object] = {}

    async def _fake_upload_file(**kwargs):
        uploaded.update(kwargs)
        path = Path(str(kwargs["ciphertext_path"]))
        assert path.exists()
        assert path.stat().st_size > 0
        return "encrypted-param"

    client._request = _fake_request  # type: ignore[method-assign]
    client._upload_cdn_ciphertext_file = _fake_upload_file  # type: ignore[method-assign]

    async def _scenario() -> None:
        result = await client._upload_media_from_path(
            base_url="https://ilink.example",
            token="token-1",
            to_user_id="user-1",
            file_path=media_path,
        )
        assert result.download_encrypted_query_param == "encrypted-param"
        assert result.file_size == media_path.stat().st_size

    asyncio.run(_scenario())
    assert uploaded["filekey"]


def test_weixin_client_upload_cdn_ciphertext_file_buffers_normal_sized_payload(
    tmp_path: Path,
) -> None:
    ciphertext_path = tmp_path / "cipher.bin"
    ciphertext_path.write_bytes(b"abcdef123456")

    class _Client:
        def __init__(self) -> None:
            self.uploaded = b""

        async def request(self, method, url, **kwargs):
            assert method == "POST"
            assert url == "https://cdn.example.invalid/upload"
            content = kwargs["content"]
            assert isinstance(content, bytes)
            assert kwargs["headers"]["Content-Length"] == str(len(content))
            self.uploaded += content
            return SimpleNamespace(
                status_code=200,
                headers={"x-encrypted-param": "encrypted-param"},
                text="",
            )

    client = WeixinClient(
        WeixinBotSettings(data_dir=tmp_path),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        result = await client._upload_cdn_ciphertext_file(
            ciphertext_path=ciphertext_path,
            upload_full_url="https://cdn.example.invalid/upload",
            upload_param=None,
            filekey="file-key-1",
        )
        assert result == "encrypted-param"

    asyncio.run(_scenario())
    assert client._http_client.uploaded == b"abcdef123456"


def test_weixin_client_upload_cdn_ciphertext_file_streams_large_payload(
    tmp_path: Path,
    monkeypatch,
) -> None:
    ciphertext_path = tmp_path / "cipher.bin"
    ciphertext_path.write_bytes(b"abcdef123456")
    monkeypatch.setattr(weixin_client_module, "_BUFFERED_CDN_UPLOAD_MAX_BYTES", 4)

    class _Client:
        def __init__(self) -> None:
            self.uploaded = b""

        async def request(self, method, url, **kwargs):
            assert method == "POST"
            assert url == "https://cdn.example.invalid/upload"
            content = kwargs["content"]
            assert hasattr(content, "__aiter__")
            assert kwargs["headers"]["Content-Length"] == str(ciphertext_path.stat().st_size)
            async for chunk in content:
                self.uploaded += chunk
            return SimpleNamespace(
                status_code=200,
                headers={"x-encrypted-param": "encrypted-param"},
                text="",
            )

    client = WeixinClient(
        WeixinBotSettings(data_dir=tmp_path),
        http_client=_Client(),
    )

    async def _scenario() -> None:
        result = await client._upload_cdn_ciphertext_file(
            ciphertext_path=ciphertext_path,
            upload_full_url="https://cdn.example.invalid/upload",
            upload_param=None,
            filekey="file-key-1",
        )
        assert result == "encrypted-param"

    asyncio.run(_scenario())
    assert client._http_client.uploaded == b"abcdef123456"


def test_weixin_client_download_media_item_uses_temp_path_for_file(
    tmp_path: Path,
) -> None:
    plaintext = b"downloaded-file-content"
    ciphertext_path = tmp_path / "cipher.bin"
    plaintext_path = tmp_path / "plain.bin"
    ciphertext_path.write_bytes(b"ciphertext")
    plaintext_path.write_bytes(plaintext)

    client = WeixinClient(WeixinBotSettings(data_dir=tmp_path))

    async def _fake_download_to_temp_path(**kwargs):
        _ = kwargs
        return ciphertext_path

    def _fake_decrypt_to_temp_path(**kwargs):
        _ = kwargs
        return plaintext_path

    client._download_cdn_payload_to_temp_path = _fake_download_to_temp_path  # type: ignore[method-assign]
    client._decrypt_temp_file_to_temp_path = _fake_decrypt_to_temp_path  # type: ignore[method-assign]

    item = {
        "type": 4,
        "file_item": {
            "file_name": "spec.txt",
            "media": {
                "encrypt_query_param": "cipher",
                "aes_key": "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
            },
        },
    }

    async def _scenario() -> None:
        downloaded = await client.download_media_item(item=item)
        assert downloaded is not None
        assert downloaded.content == b""
        assert downloaded.temp_path == str(plaintext_path)
        assert downloaded.file_name == "spec.txt"
        assert downloaded.mime_type == "text/plain"

    asyncio.run(_scenario())
    assert not ciphertext_path.exists()


def test_weixin_service_moves_temp_attachment_into_workspace(
    tmp_path: Path,
) -> None:
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=SimpleNamespace(),
        client=SimpleNamespace(),
    )
    message = WeixinMessage(raw={"message_id": "msg-1"})
    temp_attachment = tmp_path / "temp-download.bin"
    temp_attachment.write_text("temp-data", encoding="utf-8")
    attachment = SimpleNamespace(
        kind="file",
        content=b"",
        temp_path=str(temp_attachment),
        file_name="spec.txt",
        mime_type="text/plain",
    )

    saved_path = service._save_downloaded_attachment(
        session_id="weixin:acct-1:user-a",
        message=message,
        attachment=attachment,
        index=1,
    )

    saved_file = Path(saved_path)
    assert saved_file.exists()
    assert saved_file.read_text(encoding="utf-8") == "temp-data"
    assert not temp_attachment.exists()


def test_weixin_service_does_not_transfer_files_from_plain_reply_paths(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            report_path = session_workspace_dir(
                tmp_path,
                envelope.session_id,
            ) / "artifacts" / "report.txt"
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text("report ready", encoding="utf-8")
            return SimpleNamespace(text=f"已生成文件：{report_path}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "生成一个报告"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert len(client.sent_texts) == 1
    assert "已生成文件：" in client.sent_texts[0]
    assert client.sent_paths == []


def test_weixin_service_does_not_guess_delivery_from_session_files(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            workspace = session_workspace_dir(tmp_path, envelope.session_id)
            workbook = workspace / "artifacts" / "market.xlsx"
            deck = workspace / "artifacts" / "market.pptx"
            workbook.parent.mkdir(parents=True, exist_ok=True)
            workbook.write_bytes(b"xlsx-ready")
            deck.write_bytes(b"pptx-ready")
            return SimpleNamespace(
                text=(
                    "可以！我现在就执行完整链路：生成 Excel + PPT -> "
                    "用 `transport_deliver` 转发给你。"
                )
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {
                        "text": "你不能通过这个 transport_deliver 转发给我么"
                    },
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_paths == []
    assert client.sent_texts == [
        "可以！我现在就执行完整链路：生成 Excel + PPT -> "
        "用 `transport_deliver` 转发给你。"
    ]
    trace = service._state.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert trace["last_forward_result"]["deliverable_sent_count"] == 0
    assert "delivery_repair_attempted" not in trace["last_forward_result"]


def test_weixin_service_does_not_treat_resend_text_as_local_transport_command(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            workspace = session_workspace_dir(tmp_path, envelope.session_id)
            image = workspace / "artifacts" / "screen.png"
            report = workspace / "artifacts" / "report.xlsx"
            image.parent.mkdir(parents=True, exist_ok=True)
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            report.write_bytes(b"xlsx-ready")
            return SimpleNamespace(text="已经生成，稍后用 transport_deliver 发给你。")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []
            self.captions: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            self.captions.append(str(kwargs.get("caption") or ""))
            return "image" if str(kwargs["file_path"]).endswith(".png") else "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-resend",
            "item_list": [{"type": 1, "text_item": {"text": "补发一下文件"}}],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_paths == []
    assert client.captions == []
    assert client.sent_texts == ["已经生成，稍后用 transport_deliver 发给你。"]


def test_weixin_service_forwards_bare_missing_receipt_to_backend(
    tmp_path: Path,
) -> None:
    session_id = "weixin:acct-1:user-a"
    workspace = session_workspace_dir(tmp_path, session_id)
    artifacts = workspace / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    image = artifacts / "screen.png"
    page = artifacts / "index.html"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    page.write_text("<!doctype html><title>Apex</title>", encoding="utf-8")

    class _Backend:
        async def respond(self, envelope):
            return SimpleNamespace(text=f"backend:{envelope.text}")

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-missing",
            "item_list": [{"type": 1, "text_item": {"text": "我没收到啊"}}],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_paths == []
    assert client.sent_texts == ["backend:我没收到啊"]
    trace = service._state.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert "local_delivery_repair" not in trace["last_forward_result"]


def test_weixin_service_has_no_local_delivery_repair_scanner(
    tmp_path: Path,
) -> None:
    session_id = "weixin:acct-1:user-a"
    workspace = session_workspace_dir(tmp_path, session_id)
    artifacts = workspace / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    report = artifacts / "report.xlsx"
    image = artifacts / "screen.png"
    note = artifacts / "note.txt"
    resource_cache = workspace / "weixin_resource_data"
    resource_cache.mkdir(parents=True, exist_ok=True)
    cached_upload = resource_cache / "incoming.png"
    report.write_bytes(b"xlsx-ready")
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    note.write_text("not a deliverable", encoding="utf-8")
    cached_upload.write_bytes(b"\x89PNG\r\n\x1a\n")

    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=SimpleNamespace(),
        client=SimpleNamespace(),
    )

    assert not hasattr(service, "_discover_delivery_repair_deliverables")
    assert report.exists() and image.exists() and note.exists() and cached_upload.exists()


def test_weixin_service_does_not_repair_delivery_for_predelivery_diagnostic(
    tmp_path: Path,
) -> None:
    session_id = "weixin:acct-1:user-a"
    workspace = session_workspace_dir(tmp_path, session_id)
    workspace.mkdir(parents=True, exist_ok=True)
    first_image = workspace / "b1fe7dd0a29b4a549000fffd4e5a977f.png"
    second_image = workspace / "cfbd0aec160346339fd22b403a56fa50.png"
    first_image.write_bytes(b"\x89PNG\r\n\x1a\n")
    second_image.write_bytes(b"\x89PNG\r\n\x1a\n")

    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(
                text=(
                    "`predelivery is not confirmed_scene` "
                    "表示预交付状态未确认，不是补发文件请求。"
                )
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-predelivery",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {
                        "text": "`predelivery is not confirmed_scene` 这是什么"
                    },
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_paths == []
    assert len(client.sent_texts) == 1
    assert "预交付状态未确认" in client.sent_texts[0]
    trace = service._state.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert "delivery_repair_attempted" not in trace["last_forward_result"]
    assert trace["last_forward_result"]["deliverable_sent_count"] == 0


def test_weixin_service_marks_stream_error_without_deliverables_partial(
    tmp_path: Path,
) -> None:
    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(
                text="模型输出流中断，已保留当前进度。",
                metadata={"stream_error": True},
            )

    class _Client:
        async def send_text(self, **kwargs) -> None:
            _ = kwargs

    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=_Client(),
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-stream-error",
            "item_list": [{"type": 1, "text_item": {"text": "继续"}}],
        }
    )

    asyncio.run(service._handle_message(account, message))

    trace = service._state.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_partial_success"
    assert trace["last_forward_result"]["stream_error"] is True
    assert trace["last_forward_result"]["deliverable_count"] == 0


def test_weixin_service_transfers_structured_deliverables_and_card(
    tmp_path: Path,
) -> None:
    class _Backend:
        def __init__(self) -> None:
            self.receipts: list[dict] = []

        async def respond(self, envelope):
            report_path = (tmp_path / "exports" / "report.txt").resolve()
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text("report ready", encoding="utf-8")
            return SimpleNamespace(
                text="",
                metadata={
                    "turn_id": "turn-weixin-delivery",
                    "transport_directives": {
                        "delivery_id": "delivery:weixin-test",
                        "channel": "weixin",
                        "card": {
                            "title": "交付完成",
                            "summary": "已生成 1 个文件",
                            "bullets": ["report.txt"],
                        },
                        "deliverables": [
                            {
                                "path": str(report_path),
                                "caption": "报告文件",
                            }
                        ],
                    }
                },
            )

        async def record_transport_delivery_receipts(self, **kwargs):
            self.receipts.append(kwargs)
            return {"items": kwargs["results"]}

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.sent_paths: list[str] = []
            self.sent_captions: list[str] = []
            self.send_events: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))
            self.send_events.append("text")

        async def send_path(self, **kwargs) -> str:
            self.sent_paths.append(str(kwargs["file_path"]))
            self.sent_captions.append(str(kwargs.get("caption") or ""))
            self.send_events.append("path")
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    backend = _Backend()
    service = WeixinBotService(
        settings=settings,
        backend=backend,
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "把报告发给我"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_texts == [
        "**交付完成**\n已生成 1 个文件\n- report.txt\n\n"
        "通道回执：微信发送接口已接受 1 个文件。这不表示对方已读。"
    ]
    assert len(client.sent_paths) == 1
    assert Path(client.sent_paths[0]).name == "report.txt"
    assert client.sent_captions == [""]
    assert client.send_events == ["path", "text"]
    assert backend.receipts[0]["results"][0]["state"] == "accepted_by_transport"
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "structured_deliverable_transfer_success" in events
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert trace["last_forward_result"]["deliverable_sent_count"] == 1
    assert trace["last_forward_result"]["deliverable_failed_count"] == 0


def test_weixin_service_preserves_assistant_reply_when_deliverables_exist(
    tmp_path: Path,
) -> None:
    report_path = (tmp_path / "exports" / "report.txt").resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("report ready", encoding="utf-8")
    assistant_text = "报告已完成，校验通过。\n\n本地绝对路径：`C:/demo/report.txt`"

    class _Backend:
        async def respond(self, envelope):
            _ = envelope
            return SimpleNamespace(
                text=assistant_text,
                metadata={
                    "transport_directives": {
                        "channel": "weixin",
                        "card": {"title": "不应覆盖正文"},
                        "deliverables": [{"path": str(report_path)}],
                    }
                },
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            _ = kwargs
            return "file"

    client = _Client()
    service = WeixinBotService(
        settings=WeixinBotSettings(data_dir=tmp_path),
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-rich-reply",
            "item_list": [{"type": 1, "text_item": {"text": "把报告发给我"}}],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.sent_texts == [
        assistant_text
        + "\n\n通道回执：微信发送接口已接受 1 个文件。这不表示对方已读。"
    ]


def test_weixin_service_records_structured_deliverable_transfer_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_DELIVERABLE_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            report_path = (tmp_path / "exports" / "report.txt").resolve()
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text("report ready", encoding="utf-8")
            return SimpleNamespace(
                text="",
                metadata={
                    "transport_directives": {
                        "channel": "weixin",
                        "card": {"title": "交付完成"},
                        "deliverables": [{"path": str(report_path)}],
                    }
                },
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.send_path_calls = 0

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            self.send_path_calls += 1
            raise RuntimeError("upload boom")

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "把报告发给我"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.send_path_calls == weixin_service_module._SEND_DELIVERABLE_MAX_ATTEMPTS
    assert all("交付完成" not in text for text in client.sent_texts)
    assert "文件发送未完成" in client.sent_texts[-1]
    assert "系统已安排后台自动重试" in client.sent_texts[-1]
    assert "upload boom" in client.sent_texts[-1]
    jobs = service._scheduled_delivery_store.list_jobs(
        session_id="weixin:acct-1:user-a"
    )
    assert len(jobs) == 1
    assert jobs[0].deliverables
    assert Path(jobs[0].deliverables[0].path).name == "report.txt"
    trace = service._state.load_runtime_trace("acct-1")
    events = [event.get("event") for event in trace.get("recent_events", [])]
    assert "structured_deliverable_transfer_failure" in events
    assert "structured_deliverable_scheduled_retry" in events
    assert trace["last_forward_result"]["event"] == "forward_partial_success"
    assert trace["last_forward_result"]["deliverable_sent_count"] == 0
    assert trace["last_forward_result"]["deliverable_failed_count"] == 1


def test_weixin_service_falls_back_to_file_after_native_image_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        weixin_service_module,
        "_SEND_DELIVERABLE_RETRY_DELAY_SECONDS",
        0.0,
    )

    class _Backend:
        async def respond(self, envelope):
            image_path = (tmp_path / "exports" / "screen.png").resolve()
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            return SimpleNamespace(
                text="",
                metadata={
                    "transport_directives": {
                        "channel": "weixin",
                        "card": {"title": "交付完成"},
                        "deliverables": [{"path": str(image_path)}],
                    }
                },
            )

    class _Client:
        def __init__(self) -> None:
            self.sent_texts: list[str] = []
            self.force_file_flags: list[bool] = []

        async def send_text(self, **kwargs) -> None:
            self.sent_texts.append(str(kwargs["text"]))

        async def send_path(self, **kwargs) -> str:
            force_file_kind = bool(kwargs.get("force_file_kind"))
            self.force_file_flags.append(force_file_kind)
            if not force_file_kind:
                raise RuntimeError("local image send is prohibited")
            return "file"

    settings = WeixinBotSettings(data_dir=tmp_path)
    client = _Client()
    service = WeixinBotService(
        settings=settings,
        backend=_Backend(),
        client=client,
    )
    account = WeixinAccount(
        account_id="acct-1",
        token="token-1",
        base_url="https://ilink.example",
        user_id="user-1",
        saved_at="2026-04-08T00:00:00+00:00",
    )
    message = WeixinMessage(
        raw={
            "from_user_id": "user-a",
            "message_id": "msg-1",
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": "把截图发给我"},
                }
            ],
        }
    )

    asyncio.run(service._handle_message(account, message))

    assert client.force_file_flags == [False, True]
    assert client.sent_texts == [
        "**交付完成**\n\n通道回执：微信发送接口已接受 1 个文件。这不表示对方已读。"
    ]
    trace = service._state.load_runtime_trace("acct-1")
    assert trace["last_forward_result"]["event"] == "forward_success"
    assert trace["last_forward_result"]["deliverable_sent_count"] == 1
    events = trace.get("recent_events", [])
    success_events = [
        event
        for event in events
        if event.get("event") == "structured_deliverable_transfer_success"
    ]
    assert success_events[-1]["media_kind"] == "file"
    assert success_events[-1]["force_file_kind"] is True


def test_weixin_blank_transfer_error_format_is_actionable() -> None:
    class _BlankTransferError(Exception):
        def __str__(self) -> str:
            return ""

    formatted = weixin_service_module._format_exception_brief(_BlankTransferError())

    assert formatted == "_BlankTransferError"
