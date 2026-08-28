from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from cardbush_app.bots import BotConfigStore, BotSupervisor, platform_spec
from cardbush_app.server import HostSettings


@pytest.mark.asyncio
async def test_managed_bot_process_is_stopped_with_supervisor(tmp_path: Path) -> None:
    settings = HostSettings(
        data_dir=tmp_path,
        bushserver_host="127.0.0.1",
        bushserver_port=51999,
    )
    store = BotConfigStore(tmp_path / "config" / "bots.json")
    store.write(
        "feishu",
        {
            "enabled": True,
            "app_id": "cli_test",
            "app_secret": "secret",
        },
    )
    supervisor = BotSupervisor(settings=settings, config_store=store)
    supervisor._serve_command = lambda spec, config: [  # type: ignore[method-assign]
        sys.executable,
        "-c",
        "import time; time.sleep(60)",
    ]

    await supervisor.startup()
    started = await supervisor.start("feishu")
    pid = started["pid"]
    assert started["service_status"] == "running"
    assert isinstance(pid, int)

    await supervisor.shutdown()

    stopped = supervisor.status("feishu")
    assert stopped["service_status"] == "stopped"
    assert stopped["pid"] is None


@pytest.mark.asyncio
async def test_managed_bot_unexpected_exit_becomes_failed(tmp_path: Path) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    store = BotConfigStore(tmp_path / "config" / "bots.json")
    store.write(
        "discord",
        {
            "enabled": True,
            "application_id": "app",
            "bot_token": "secret",
        },
    )
    supervisor = BotSupervisor(settings=settings, config_store=store)
    supervisor._serve_command = lambda spec, config: [  # type: ignore[method-assign]
        sys.executable,
        "-c",
        "import sys; print('adapter startup exploded', file=sys.stderr); raise SystemExit(7)",
    ]

    failed = await supervisor.start("discord")
    await asyncio.sleep(0)

    assert failed["service_status"] == "failed"
    assert supervisor.status("discord")["return_code"] == 7
    assert supervisor.status("discord")["last_error"] == "adapter startup exploded"
    await supervisor.shutdown()


def test_adapter_exit_error_uses_only_current_redacted_log_segment(
    tmp_path: Path,
) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    store = BotConfigStore(tmp_path / "config" / "bots.json")
    store.write(
        "discord",
        {
            "enabled": True,
            "application_id": "app",
            "bot_token": "top-secret-token",
        },
    )
    supervisor = BotSupervisor(settings=settings, config_store=store)
    log_path = tmp_path / "logs" / "bots" / "discord.log"
    log_path.parent.mkdir(parents=True)
    log_path.write_text("old failure\n", encoding="utf-8")
    state = supervisor._states["discord"]
    state.log_path = log_path
    state.log_start_offset = log_path.stat().st_size

    assert supervisor._adapter_exit_error("discord", 7) == (
        "Adapter exited with code 7"
    )

    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("token=top-secret-token\n")

    assert supervisor._adapter_exit_error("discord", 7) == "token=[REDACTED]"


def test_weixin_runtime_health_overrides_live_process_false_healthy_state(
    tmp_path: Path,
) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    store = BotConfigStore(tmp_path / "config" / "bots.json")
    store.write("weixin", {"enabled": True})
    account_dir = tmp_path / "weixin" / "accounts"
    account_dir.mkdir(parents=True)
    (tmp_path / "weixin" / "accounts.json").write_text(
        '["acct-1"]', encoding="utf-8"
    )
    (account_dir / "acct-1.json").write_text(
        '{"account_id":"acct-1","token":"secret","base_url":"https://example.invalid"}',
        encoding="utf-8",
    )
    (tmp_path / "weixin" / "runtime-status.json").write_text(
        """{
          "protocol": "cardbush_app.bot_runtime_status.v1",
          "platform": "weixin",
          "service_status": "failed",
          "health_status": "authentication_expired",
          "error_code": "weixin_session_expired",
          "last_error": "Weixin login expired; reconnect the account and restart the bot.",
          "requires_reauthentication": true,
          "accounts": [{"account_id": "acct-1", "status": "authentication_expired"}]
        }""",
        encoding="utf-8",
    )
    supervisor = BotSupervisor(settings=settings, config_store=store)
    state = supervisor._states["weixin"]
    state.status = "running"
    state.process = SimpleNamespace(pid=1234, returncode=None)

    payload = supervisor.status("weixin")

    assert payload["service_status"] == "failed"
    assert payload["health_status"] == "authentication_expired"
    assert payload["error_code"] == "weixin_session_expired"
    assert payload["requires_reauthentication"] is True
    assert payload["accounts"][0]["status"] == "authentication_expired"
    assert "secret" not in str(payload)


def test_weixin_managed_command_tracks_bushserver_parent(tmp_path: Path) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    store = BotConfigStore(tmp_path / "config" / "bots.json")
    supervisor = BotSupervisor(settings=settings, config_store=store)

    command = supervisor._serve_command(platform_spec("weixin"), {})

    parent_index = command.index("--parent-pid")
    assert command[parent_index + 1] == str(os.getpid())


def test_managed_bot_child_env_contains_permission_profile(tmp_path: Path) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    supervisor = BotSupervisor(
        settings=settings,
        config_store=BotConfigStore(tmp_path / "config" / "bots.json"),
    )
    config = {
        **platform_spec("discord").defaults,
        "permission_mode": "task_free",
        "disabled_tools": ["computer_use", "terminal_exec"],
        "allowed_skills": ["code"],
        "subagent_enabled": False,
    }

    env = supervisor._child_env(platform_spec("discord"), config)

    assert env["CARDBUSH_BOT_STREAM_PERMISSION_MODE"] == "task_free"
    assert env["CARDBUSH_BOT_STREAM_DISABLED_TOOLS"] == (
        "computer_use,terminal_exec"
    )
    assert env["CARDBUSH_BOT_STREAM_ALLOWED_SKILLS"] == "code"
    assert env["CARDBUSH_BOT_STREAM_SUBAGENT_ENABLED"] == "0"


@pytest.mark.asyncio
async def test_managed_bot_spawn_uses_isolated_process_group(
    tmp_path: Path,
    monkeypatch,
) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    supervisor = BotSupervisor(
        settings=settings,
        config_store=BotConfigStore(tmp_path / "config" / "bots.json"),
    )
    captured: dict[str, object] = {}
    expected_process = object()

    async def _fake_spawn(*command: str, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return expected_process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_spawn)

    process = await supervisor._spawn_process(
        ["python", "-m", "adapter"],
        env={"A": "1"},
        stdout=None,
        stderr=None,
    )

    assert process is expected_process
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    if os.name == "nt":
        assert int(kwargs["creationflags"]) & int(
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    else:
        assert kwargs["start_new_session"] is True


def test_windows_tree_cleanup_includes_only_owned_weixin_lock_pid(
    tmp_path: Path,
) -> None:
    settings = HostSettings(tmp_path, "127.0.0.1", 51999)
    supervisor = BotSupervisor(
        settings=settings,
        config_store=BotConfigStore(tmp_path / "config" / "bots.json"),
    )
    lock_path = tmp_path / "weixin" / "weixin-bridge.lock"
    lock_path.parent.mkdir(parents=True)
    lock_path.write_text(
        f'{{"pid": 2222, "parent_pid": {os.getpid()}}}',
        encoding="utf-8",
    )

    assert supervisor._managed_windows_tree_pids(
        platform="weixin",
        root_pid=1111,
    ) == (1111, 2222)

    lock_path.write_text(
        '{"pid": 3333, "parent_pid": 999999}',
        encoding="utf-8",
    )
    assert supervisor._managed_windows_tree_pids(
        platform="weixin",
        root_pid=1111,
    ) == (1111,)
