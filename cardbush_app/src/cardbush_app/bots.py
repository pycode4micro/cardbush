from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .paths import ensure_private_directory, secure_private_path

logger = logging.getLogger("cardbush_app.bots")

BOT_PLATFORMS = ("weixin", "feishu", "telegram", "discord")
_MASK_PREFIX = "••••"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _masked(value: object) -> str:
    text = str(value or "")
    if not text:
        return ""
    return f"{_MASK_PREFIX}{text[-4:]}" if len(text) > 4 else _MASK_PREFIX


def _is_masked(value: object) -> bool:
    return str(value or "").startswith(_MASK_PREFIX)


def _env_value(value: object) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (list, tuple)):
        return ",".join(str(item) for item in value)
    return str(value or "")


@dataclass(frozen=True, slots=True)
class BotPlatformSpec:
    platform: str
    display_name: str
    module: str | None
    defaults: dict[str, object]
    env_names: dict[str, str]
    secret_fields: frozenset[str] = frozenset()
    required_fields: tuple[str, ...] = ()

    @property
    def supported(self) -> bool:
        return bool(self.module)


_SPECS: dict[str, BotPlatformSpec] = {
    "weixin": BotPlatformSpec(
        platform="weixin",
        display_name="WeChat",
        module="cardbush_app.adapters.weixin_bot.cli",
        defaults={
            "enabled": False,
            "api_base": "https://ilinkai.weixin.qq.com",
            "login_api_base": "https://ilinkai.weixin.qq.com",
            "app_id": "bot",
            "app_version": "2.1.7",
            "bot_type": "3",
            "route_tag": "",
            "allowed_user_ids": [],
            "allowed_channel_ids": [],
            "poll_timeout_seconds": 35.0,
            "api_timeout_seconds": 15.0,
            "login_timeout_seconds": 480.0,
            "proxy": "",
            "no_proxy": "",
            "disable_env_proxy": True,
            "unsupported_message_text": "当前仅支持文本消息。",
            "project_dir": "",
            "permission_mode": "task_free",
            "disabled_tools": ["computer_use"],
            "allowed_skills": [],
            "subagent_enabled": True,
        },
        env_names={
            "api_base": "WEIXIN_API_BASE",
            "login_api_base": "WEIXIN_LOGIN_API_BASE",
            "app_id": "WEIXIN_APP_ID",
            "app_version": "WEIXIN_APP_VERSION",
            "bot_type": "WEIXIN_BOT_TYPE",
            "route_tag": "WEIXIN_ROUTE_TAG",
            "allowed_user_ids": "WEIXIN_ALLOWED_USER_IDS",
            "allowed_channel_ids": "WEIXIN_ALLOWED_CHANNEL_IDS",
            "poll_timeout_seconds": "WEIXIN_POLL_TIMEOUT_SECONDS",
            "api_timeout_seconds": "WEIXIN_API_TIMEOUT_SECONDS",
            "login_timeout_seconds": "WEIXIN_LOGIN_TIMEOUT_SECONDS",
            "proxy": "WEIXIN_PROXY",
            "no_proxy": "WEIXIN_NO_PROXY",
            "disable_env_proxy": "WEIXIN_DISABLE_ENV_PROXY",
            "unsupported_message_text": "WEIXIN_UNSUPPORTED_MESSAGE_TEXT",
        },
    ),
    "feishu": BotPlatformSpec(
        platform="feishu",
        display_name="Feishu",
        module="cardbush_app.adapters.feishu_bot.cli",
        defaults={
            "enabled": False,
            "app_id": "",
            "app_secret": "",
            "verification_token": "",
            "encrypt_key": "",
            "api_base": "https://open.feishu.cn",
            "host": "127.0.0.1",
            "port": 8091,
            "mode": "long",
            "ack_mode": "reaction",
            "ack_reaction_emoji": "OK",
            "ack_placeholder_text": "⏳ 正在思考中...",
            "disable_env_proxy": True,
            "project_dir": "",
            "allowed_user_ids": [],
            "allowed_channel_ids": [],
            "permission_mode": "task_free",
            "disabled_tools": ["computer_use"],
            "allowed_skills": [],
            "subagent_enabled": True,
        },
        env_names={
            "app_id": "FEISHU_APP_ID",
            "app_secret": "FEISHU_APP_SECRET",
            "verification_token": "FEISHU_VERIFICATION_TOKEN",
            "encrypt_key": "FEISHU_ENCRYPT_KEY",
            "api_base": "FEISHU_API_BASE",
            "host": "FEISHU_BOT_HOST",
            "port": "FEISHU_BOT_PORT",
            "mode": "FEISHU_BOT_MODE",
            "ack_mode": "FEISHU_ACK_MODE",
            "ack_reaction_emoji": "FEISHU_ACK_REACTION_EMOJI",
            "ack_placeholder_text": "FEISHU_ACK_PLACEHOLDER_TEXT",
            "disable_env_proxy": "FEISHU_DISABLE_ENV_PROXY",
            "allowed_user_ids": "FEISHU_ALLOWED_USER_IDS",
            "allowed_channel_ids": "FEISHU_ALLOWED_CHANNEL_IDS",
        },
        secret_fields=frozenset(
            {"app_secret", "verification_token", "encrypt_key"}
        ),
        required_fields=("app_id", "app_secret"),
    ),
    "telegram": BotPlatformSpec(
        platform="telegram",
        display_name="Telegram",
        module=None,
        defaults={"enabled": False},
        env_names={},
        required_fields=("adapter_package",),
    ),
    "discord": BotPlatformSpec(
        platform="discord",
        display_name="Discord",
        module="cardbush_app.adapters.discord_bot.cli",
        defaults={
            "enabled": False,
            "application_id": "",
            "bot_token": "",
            "public_key": "",
            "api_base": "https://discord.com/api/v10",
            "command_name": "chat",
            "host": "127.0.0.1",
            "port": 8092,
            "guild_id": "",
            "mode": "long",
            "gateway_intents": 37377,
            "project_dir": "",
            "allowed_user_ids": [],
            "allowed_channel_ids": [],
            "permission_mode": "task_free",
            "disabled_tools": ["computer_use"],
            "allowed_skills": [],
            "subagent_enabled": True,
        },
        env_names={
            "application_id": "DISCORD_APPLICATION_ID",
            "bot_token": "DISCORD_BOT_TOKEN",
            "public_key": "DISCORD_PUBLIC_KEY",
            "api_base": "DISCORD_API_BASE",
            "command_name": "DISCORD_COMMAND_NAME",
            "host": "DISCORD_BOT_HOST",
            "port": "DISCORD_BOT_PORT",
            "guild_id": "DISCORD_GUILD_ID",
            "mode": "DISCORD_BOT_MODE",
            "gateway_intents": "DISCORD_GATEWAY_INTENTS",
            "allowed_user_ids": "DISCORD_ALLOWED_USER_IDS",
            "allowed_channel_ids": "DISCORD_ALLOWED_CHANNEL_IDS",
        },
        secret_fields=frozenset({"bot_token", "public_key"}),
        required_fields=("application_id", "bot_token"),
    ),
}


class BotManagementError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        self.code = str(code)
        self.status_code = int(status_code)
        super().__init__(str(message))


class BotConfigStore:
    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve(strict=False)

    def _environment_config(self, spec: BotPlatformSpec) -> dict[str, object]:
        config = dict(spec.defaults)
        enabled_env = os.getenv(f"CARDBUSH_BOT_{spec.platform.upper()}_ENABLED")
        if enabled_env is not None:
            config["enabled"] = enabled_env.strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        for key, env_name in spec.env_names.items():
            value = os.getenv(env_name)
            if value is None:
                continue
            default = spec.defaults.get(key)
            if isinstance(default, bool):
                config[key] = value.strip().lower() in {"1", "true", "yes", "on"}
            elif isinstance(default, int):
                try:
                    config[key] = int(value)
                except ValueError:
                    pass
            elif isinstance(default, float):
                try:
                    config[key] = float(value)
                except ValueError:
                    pass
            elif isinstance(default, list):
                config[key] = [
                    item.strip()
                    for item in value.replace(";", ",").split(",")
                    if item.strip()
                ]
            else:
                config[key] = value
        return config

    def _read_document(self) -> dict[str, object]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def read(self, platform: str) -> dict[str, object]:
        spec = platform_spec(platform)
        config = self._environment_config(spec)
        document = self._read_document()
        platforms = document.get("platforms")
        if isinstance(platforms, dict):
            saved = platforms.get(spec.platform)
            if isinstance(saved, dict):
                for key, value in saved.items():
                    if key in spec.defaults:
                        config[key] = value
        return config

    def write(self, platform: str, update: dict[str, object]) -> dict[str, object]:
        spec = platform_spec(platform)
        unknown = sorted(set(update) - set(spec.defaults))
        if unknown:
            raise BotManagementError(
                "invalid_bot_config",
                f"Unsupported {platform} config field(s): {', '.join(unknown)}",
            )
        current = self.read(platform)
        for key, value in update.items():
            if key in spec.secret_fields:
                if _is_masked(value) or value == "":
                    continue
                current[key] = "" if value is None else str(value)
                continue
            if key == "enabled":
                if not isinstance(value, bool):
                    raise BotManagementError(
                        "invalid_bot_config",
                        "`enabled` must be a JSON boolean",
                    )
                current[key] = value
                continue
            if key == "subagent_enabled":
                if not isinstance(value, bool):
                    raise BotManagementError(
                        "invalid_bot_config",
                        "`subagent_enabled` must be a JSON boolean",
                    )
                current[key] = value
                continue
            if key in {
                "allowed_user_ids",
                "allowed_channel_ids",
                "disabled_tools",
                "allowed_skills",
            }:
                if not isinstance(value, list) or any(
                    not isinstance(item, str) for item in value
                ):
                    raise BotManagementError(
                        "invalid_bot_config",
                        f"`{key}` must be a JSON array of strings",
                    )
                current[key] = list(
                    dict.fromkeys(
                        item.strip() for item in value if str(item).strip()
                    )
                )
                continue
            if key == "permission_mode":
                normalized_mode = str(value or "").strip().lower()
                if normalized_mode not in {"task_free", "user_free", "all_free"}:
                    raise BotManagementError(
                        "invalid_bot_config",
                        "`permission_mode` must be task_free, user_free, or all_free",
                    )
                current[key] = normalized_mode
                continue
            current[key] = value

        document = self._read_document()
        platforms = document.get("platforms")
        if not isinstance(platforms, dict):
            platforms = {}
        platforms[spec.platform] = current
        payload = {"version": 1, "platforms": platforms}
        ensure_private_directory(self.path.parent)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        secure_private_path(temporary, is_dir=False)
        temporary.replace(self.path)
        secure_private_path(self.path, is_dir=False)
        return current

    def public_payload(self, platform: str) -> dict[str, object]:
        spec = platform_spec(platform)
        config = self.read(platform)
        public = dict(config)
        secrets: dict[str, object] = {}
        for key in spec.secret_fields:
            value = str(config.get(key) or "")
            public[key] = _masked(value)
            secrets[key] = {
                "configured": bool(value),
                "masked": _masked(value),
            }
        missing = self.missing_required_fields(platform, config=config)
        return {
            "protocol": "cardbush_app.bot_config.v1",
            "platform": spec.platform,
            "enabled": bool(config.get("enabled")),
            "configured": not missing,
            "config": public,
            "secrets": secrets,
            "missing_required_fields": missing,
        }

    def missing_required_fields(
        self,
        platform: str,
        *,
        config: dict[str, object] | None = None,
    ) -> list[str]:
        spec = platform_spec(platform)
        values = config or self.read(platform)
        if not spec.supported:
            return ["adapter_package"]
        missing = [key for key in spec.required_fields if not values.get(key)]
        if spec.platform == "discord" and values.get("mode") == "webhook":
            if not values.get("public_key"):
                missing.append("public_key")
        return missing


def platform_spec(platform: str) -> BotPlatformSpec:
    normalized = str(platform or "").strip().lower()
    spec = _SPECS.get(normalized)
    if spec is None:
        raise BotManagementError(
            "bot_platform_not_found",
            f"Unsupported bot platform: {normalized or platform}",
            status_code=404,
        )
    return spec


@dataclass(slots=True)
class _ProcessState:
    process: asyncio.subprocess.Process | None = None
    status: str = "stopped"
    started_at: str | None = None
    stopped_at: str | None = None
    return_code: int | None = None
    last_error: str = ""
    log_path: Path | None = None
    log_start_offset: int = 0
    log_handle: Any | None = None
    watcher: asyncio.Task[None] | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass(slots=True)
class _LoginState:
    login_id: str
    qrcode_url: str = ""
    status: str = "waiting"
    expires_at: str | None = None
    account: dict[str, object] | None = None
    message: str = ""
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    qr_ready: asyncio.Event = field(default_factory=asyncio.Event)


class BotSupervisor:
    def __init__(self, *, settings: Any, config_store: BotConfigStore) -> None:
        self.settings = settings
        self.config_store = config_store
        self.log_root = Path(settings.data_dir) / "logs" / "bots"
        self._states = {platform: _ProcessState() for platform in BOT_PLATFORMS}
        self._autostart_task: asyncio.Task[None] | None = None
        self._login: _LoginState | None = None
        self._login_lock = asyncio.Lock()
        self._shutdown = False

    async def startup(self) -> None:
        ensure_private_directory(self.log_root)
        self._shutdown = False
        if any(
            bool(self.config_store.read(platform).get("enabled"))
            for platform in BOT_PLATFORMS
        ):
            self._autostart_task = asyncio.create_task(
                self._autostart(),
                name="cardbush-app-bot-autostart",
            )

    async def shutdown(self) -> None:
        self._shutdown = True
        task = self._autostart_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._autostart_task = None
        await self._stop_login()
        await asyncio.gather(
            *(self.stop(platform) for platform in reversed(BOT_PLATFORMS)),
            return_exceptions=True,
        )

    async def _autostart(self) -> None:
        base_url = self._backend_base_url()
        try:
            async with httpx.AsyncClient(timeout=0.5, trust_env=False) as client:
                for _ in range(60):
                    if self._shutdown:
                        return
                    try:
                        response = await client.get(f"{base_url}/healthz")
                        if response.status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.25)
                else:
                    logger.warning("Bot autostart skipped: BushServer health check timed out")
                    return
            for platform in BOT_PLATFORMS:
                if self._shutdown:
                    return
                if not self.config_store.read(platform).get("enabled"):
                    continue
                try:
                    await self.start(platform)
                except BotManagementError as exc:
                    logger.warning("Bot autostart failed platform=%s: %s", platform, exc)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Bot autostart failed", exc_info=True)

    def list_payload(self) -> dict[str, object]:
        return {
            "protocol": "cardbush_app.bots.v1",
            "bots": [self.overview(platform) for platform in BOT_PLATFORMS],
        }

    def overview(self, platform: str) -> dict[str, object]:
        status = self.status(platform)
        return {
            key: status[key]
            for key in (
                "platform",
                "display_name",
                "enabled",
                "configured",
                "service_status",
                "account_count",
                "last_error",
                "missing_required_fields",
                "health_status",
                "error_code",
                "requires_reauthentication",
            )
        }

    def status(self, platform: str) -> dict[str, object]:
        spec = platform_spec(platform)
        state = self._states[spec.platform]
        process = state.process
        if process is not None and process.returncode is not None:
            state.return_code = process.returncode
            if state.status not in {"stopped", "failed"}:
                state.status = "failed"
                state.last_error = self._adapter_exit_error(
                    spec.platform,
                    process.returncode,
                )
                state.stopped_at = state.stopped_at or _utc_now()
        config = self.config_store.read(spec.platform)
        missing = self._missing_fields(spec.platform, config=config)
        accounts = self._weixin_accounts() if spec.platform == "weixin" else []
        service_status = state.status
        last_error = state.last_error
        health_status = "healthy" if service_status == "running" else service_status
        error_code = ""
        requires_reauthentication = False
        runtime_status: dict[str, object] = {}
        if process is not None and process.returncode is None:
            runtime_status = self._adapter_runtime_status(spec.platform)
        if runtime_status:
            reported_status = str(runtime_status.get("service_status") or "").strip()
            if state.status == "running" and reported_status in {"running", "failed"}:
                service_status = reported_status
            health_status = str(runtime_status.get("health_status") or health_status).strip()
            last_error = str(runtime_status.get("last_error") or last_error).strip()
            error_code = str(runtime_status.get("error_code") or "").strip()
            requires_reauthentication = bool(
                runtime_status.get("requires_reauthentication")
            )
            raw_account_statuses = runtime_status.get("accounts")
            if not isinstance(raw_account_statuses, list):
                raw_account_statuses = []
            account_statuses = {
                str(item.get("account_id") or "").strip(): str(
                    item.get("status") or ""
                ).strip()
                for item in raw_account_statuses
                if isinstance(item, dict)
            }
            accounts = [
                {
                    **account,
                    "status": account_statuses.get(
                        str(account.get("account_id") or "").strip(),
                        "",
                    ),
                }
                for account in accounts
            ]
        return {
            "protocol": "cardbush_app.bot_status.v1",
            "platform": spec.platform,
            "display_name": spec.display_name,
            "enabled": bool(config.get("enabled")),
            "configured": not missing,
            "service_status": service_status,
            "pid": process.pid if process is not None and process.returncode is None else None,
            "return_code": state.return_code,
            "started_at": state.started_at,
            "stopped_at": state.stopped_at,
            "log_path": str(state.log_path) if state.log_path else "",
            "account_count": len(accounts),
            "accounts": accounts,
            "last_error": last_error,
            "missing_required_fields": missing,
            "health_status": health_status,
            "error_code": error_code,
            "requires_reauthentication": requires_reauthentication,
        }

    def _adapter_runtime_status(self, platform: str) -> dict[str, object]:
        if platform != "weixin":
            return {}
        path = Path(self.settings.data_dir) / "weixin" / "runtime-status.json"
        try:
            if path.stat().st_size > 128 * 1024:
                return {}
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        if not isinstance(payload, dict):
            return {}
        if payload.get("protocol") != "cardbush_app.bot_runtime_status.v1":
            return {}
        if str(payload.get("platform") or "").strip() != platform:
            return {}
        return dict(payload)

    def _missing_fields(
        self,
        platform: str,
        *,
        config: dict[str, object] | None = None,
    ) -> list[str]:
        missing = self.config_store.missing_required_fields(platform, config=config)
        if platform == "weixin" and not self._weixin_accounts():
            missing.append("weixin_account")
        return missing

    async def start(self, platform: str) -> dict[str, object]:
        spec = platform_spec(platform)
        state = self._states[spec.platform]
        async with state.lock:
            config = self.config_store.read(spec.platform)
            if not config.get("enabled"):
                raise BotManagementError(
                    "bot_disabled",
                    f"{spec.platform} bot is disabled",
                    status_code=409,
                )
            missing = self._missing_fields(spec.platform, config=config)
            if missing:
                message = (
                    "weixin bot has no logged-in account"
                    if missing == ["weixin_account"]
                    else f"Missing required field(s): {', '.join(missing)}"
                )
                raise BotManagementError(
                    "bot_not_configured",
                    message,
                    status_code=409,
                )
            if state.process is not None and state.process.returncode is None:
                return self.status(spec.platform)

            ensure_private_directory(self.log_root)
            log_path = self.log_root / f"{spec.platform}.log"
            if spec.platform == "weixin":
                try:
                    (
                        Path(self.settings.data_dir)
                        / "weixin"
                        / "runtime-status.json"
                    ).unlink()
                except FileNotFoundError:
                    pass
            log_handle = log_path.open("ab", buffering=0)
            log_handle.seek(0, os.SEEK_END)
            log_start_offset = int(log_handle.tell())
            secure_private_path(log_path, is_dir=False)
            command = self._serve_command(spec, config)
            try:
                process = await self._spawn_process(
                    command,
                    env=self._child_env(spec, config),
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                )
            except Exception as exc:
                log_handle.close()
                state.status = "failed"
                state.last_error = f"{type(exc).__name__}: {exc}"
                state.stopped_at = _utc_now()
                raise BotManagementError(
                    "bot_start_failed",
                    state.last_error,
                    status_code=500,
                ) from exc
            state.process = process
            state.status = "starting"
            state.started_at = _utc_now()
            state.stopped_at = None
            state.return_code = None
            state.last_error = ""
            state.log_path = log_path
            state.log_start_offset = log_start_offset
            state.log_handle = log_handle
            state.watcher = asyncio.create_task(
                self._watch_process(spec.platform, process),
                name=f"cardbush-app-bot-{spec.platform}-watcher",
            )
            await asyncio.sleep(0.35)
            if process.returncode is not None:
                state.return_code = process.returncode
                state.status = "failed"
                state.stopped_at = _utc_now()
                state.last_error = self._adapter_exit_error(
                    spec.platform,
                    process.returncode,
                )
            else:
                state.status = "running"
            return self.status(spec.platform)

    async def stop(self, platform: str) -> dict[str, object]:
        spec = platform_spec(platform)
        state = self._states[spec.platform]
        async with state.lock:
            process = state.process
            if process is None:
                state.status = "stopped"
                state.stopped_at = state.stopped_at or _utc_now()
                self._close_log(state)
                return self.status(spec.platform)
            if process.returncode is not None:
                await self._terminate_process_tree(
                    process,
                    platform=spec.platform,
                )
                state.status = "stopped"
                state.stopped_at = state.stopped_at or _utc_now()
                state.last_error = ""
                self._close_log(state)
                return self.status(spec.platform)
            state.status = "stopping"
            await self._terminate_process_tree(process, platform=spec.platform)
            state.return_code = process.returncode
            state.status = "stopped"
            state.stopped_at = _utc_now()
            state.last_error = ""
            watcher = state.watcher
            if watcher is not None and not watcher.done():
                watcher.cancel()
            state.watcher = None
            self._close_log(state)
            return self.status(spec.platform)

    async def restart(self, platform: str) -> dict[str, object]:
        await self.stop(platform)
        return await self.start(platform)

    async def _watch_process(
        self,
        platform: str,
        process: asyncio.subprocess.Process,
    ) -> None:
        return_code = await process.wait()
        if os.name == "nt":
            await asyncio.to_thread(
                self._taskkill_process_trees,
                self._managed_windows_tree_pids(
                    platform=platform,
                    root_pid=process.pid,
                ),
            )
        state = self._states[platform]
        async with state.lock:
            if state.process is not process:
                return
            was_stopping = state.status == "stopping" or self._shutdown
            state.return_code = return_code
            state.stopped_at = _utc_now()
            if was_stopping:
                state.status = "stopped"
                state.last_error = ""
            else:
                state.status = "failed"
                state.last_error = self._adapter_exit_error(
                    platform,
                    return_code,
                )
            self._close_log(state)

    def _adapter_exit_error(self, platform: str, return_code: int | None) -> str:
        fallback = f"Adapter exited with code {return_code}"
        if return_code in (None, 0):
            return fallback
        state = self._states[platform]
        path = state.log_path or self.log_root / f"{platform}.log"
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                end_offset = int(handle.tell())
                start_offset = max(
                    int(state.log_start_offset),
                    end_offset - (256 * 1024),
                )
                handle.seek(start_offset, os.SEEK_SET)
                output = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return fallback
        lines = self._redact_log_lines(platform, output.splitlines())
        for raw_line in reversed(lines):
            line = str(raw_line or "").strip()
            if line:
                return line[:1000]
        return fallback

    @staticmethod
    def _close_log(state: _ProcessState) -> None:
        handle = state.log_handle
        state.log_handle = None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    async def _spawn_process(
        self,
        command: list[str],
        *,
        env: dict[str, str],
        stdout: Any,
        stderr: Any,
    ) -> asyncio.subprocess.Process:
        kwargs: dict[str, object] = {
            "env": env,
            "stdin": subprocess.DEVNULL,
            "stdout": stdout,
            "stderr": stderr,
        }
        if os.name == "nt":
            kwargs["creationflags"] = int(
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
            ) | int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        else:
            kwargs["start_new_session"] = True
        return await asyncio.create_subprocess_exec(*command, **kwargs)

    @staticmethod
    def _request_process_stop(process: asyncio.subprocess.Process) -> None:
        if os.name == "nt":
            ctrl_break = getattr(signal, "CTRL_BREAK_EVENT", None)
            if ctrl_break is not None:
                try:
                    process.send_signal(ctrl_break)
                    return
                except (ProcessLookupError, OSError, ValueError):
                    pass
        elif process.pid:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                return
            except (ProcessLookupError, OSError):
                pass
        try:
            process.terminate()
        except ProcessLookupError:
            pass

    async def _terminate_process_tree(
        self,
        process: asyncio.subprocess.Process,
        *,
        platform: str | None = None,
        grace_seconds: float = 8.0,
    ) -> None:
        if process.returncode is not None:
            if os.name == "nt":
                await asyncio.to_thread(
                    self._taskkill_process_trees,
                    self._managed_windows_tree_pids(
                        platform=platform,
                        root_pid=process.pid,
                    ),
                )
            return
        windows_pids = (
            self._managed_windows_tree_pids(
                platform=platform,
                root_pid=process.pid,
            )
            if os.name == "nt"
            else ()
        )
        self._request_process_stop(process)
        effective_grace_seconds = max(0.1, float(grace_seconds))
        if os.name == "nt":
            # Console control delivery is not guaranteed for windowless
            # packaged processes. Keep shutdown bounded before the tree-level
            # fallback takes ownership.
            effective_grace_seconds = min(effective_grace_seconds, 1.5)
        timed_out = False
        try:
            await asyncio.wait_for(
                asyncio.shield(process.wait()),
                timeout=effective_grace_seconds,
            )
        except asyncio.TimeoutError:
            timed_out = True
        if os.name == "nt":
            await asyncio.to_thread(self._taskkill_process_trees, windows_pids)
        elif timed_out and process.pid:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
        else:
            return
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            logger.warning(
                "Managed bot process did not exit after tree termination pid=%s",
                process.pid,
            )

    def _managed_windows_tree_pids(
        self,
        *,
        platform: str | None,
        root_pid: int,
    ) -> tuple[int, ...]:
        normalized_root_pid = int(root_pid or 0)
        pids = {normalized_root_pid} if normalized_root_pid > 0 else set()
        if platform != "weixin":
            return tuple(sorted(pids))
        lock_path = (
            Path(self.settings.data_dir) / "weixin" / "weixin-bridge.lock"
        )
        try:
            payload = json.loads(lock_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return tuple(sorted(pids))
        if not isinstance(payload, dict):
            return tuple(sorted(pids))
        try:
            adapter_pid = int(payload.get("pid") or 0)
            parent_pid = int(payload.get("parent_pid") or 0)
        except (TypeError, ValueError):
            return tuple(sorted(pids))
        if parent_pid == os.getpid() and adapter_pid > 0:
            pids.add(adapter_pid)
        return tuple(sorted(pids))

    @staticmethod
    def _taskkill_process_trees(pids: tuple[int, ...]) -> None:
        for pid in pids:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                    creationflags=int(
                        getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    ),
                )
            except (OSError, subprocess.TimeoutExpired):
                continue

    def _serve_command(
        self,
        spec: BotPlatformSpec,
        config: dict[str, object],
    ) -> list[str]:
        assert spec.module is not None
        command = [
            sys.executable,
            "-m",
            spec.module,
            "serve",
            "--env-file",
            str(Path(self.settings.data_dir) / "config" / ".managed-bot.env"),
        ]
        if spec.platform == "weixin":
            command.extend(["--data-dir", str(self.settings.data_dir)])
            command.extend(["--backend-url", self._backend_base_url()])
            command.extend(["--parent-pid", str(os.getpid())])
            project_dir = str(config.get("project_dir") or "").strip()
            if project_dir:
                command.extend(["--project-dir", project_dir])
        return command

    def _child_env(
        self,
        spec: BotPlatformSpec,
        config: dict[str, object],
    ) -> dict[str, str]:
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONUTF8"] = "1"
        env["CARDBUSH_APP_DATA_DIR"] = str(self.settings.data_dir)
        env["CARDBUSH_BOT_STREAM_BASE_URL"] = self._backend_base_url()
        env["CARDBUSH_BOT_STREAM_MODEL_SOURCE"] = "backend_default"
        if getattr(self.settings, "api_auth_token", None):
            env["CARDBUSH_BOT_STREAM_AUTH_TOKEN"] = str(
                self.settings.api_auth_token
            )
        project_dir = str(config.get("project_dir") or "").strip()
        if project_dir:
            env["CARDBUSH_BOT_STREAM_PROJECT_DIR"] = str(
                Path(project_dir).expanduser().resolve(strict=False)
            )
            env["CARDBUSH_BOT_STREAM_WORKSPACE_MODE"] = "project"
        env["CARDBUSH_BOT_STREAM_PERMISSION_MODE"] = _env_value(
            config.get("permission_mode") or "task_free"
        )
        env["CARDBUSH_BOT_STREAM_DISABLED_TOOLS"] = _env_value(
            config.get("disabled_tools") or []
        )
        env["CARDBUSH_BOT_STREAM_ALLOWED_SKILLS"] = _env_value(
            config.get("allowed_skills") or []
        )
        env["CARDBUSH_BOT_STREAM_SUBAGENT_ENABLED"] = _env_value(
            bool(config.get("subagent_enabled", True))
        )
        for key, env_name in spec.env_names.items():
            env[env_name] = _env_value(config.get(key))
        return env

    def _backend_base_url(self) -> str:
        host = str(getattr(self.settings, "host", "127.0.0.1") or "127.0.0.1")
        if host in {"0.0.0.0", "::", "[::]"}:
            host = "127.0.0.1"
        return f"http://{host}:{int(self.settings.port)}"

    def logs(self, platform: str, *, tail: int = 200) -> dict[str, object]:
        spec = platform_spec(platform)
        state = self._states[spec.platform]
        path = state.log_path or self.log_root / f"{spec.platform}.log"
        limit = max(1, min(int(tail), 5000))
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                lines = list(deque((line.rstrip("\r\n") for line in handle), maxlen=limit))
        except FileNotFoundError:
            lines = []
        lines = self._redact_log_lines(spec.platform, lines)
        return {
            "protocol": "cardbush_app.bot_logs.v1",
            "platform": spec.platform,
            "lines": lines,
            "log_path": str(path),
        }

    def _redact_log_lines(
        self,
        platform: str,
        lines: list[str],
    ) -> list[str]:
        spec = platform_spec(platform)
        config = self.config_store.read(spec.platform)
        sensitive_values = [
            str(config.get(key) or "")
            for key in spec.secret_fields
            if str(config.get(key) or "")
        ]
        api_auth_token = str(getattr(self.settings, "api_auth_token", None) or "")
        if api_auth_token:
            sensitive_values.append(api_auth_token)
        redacted = list(lines)
        for secret in sensitive_values:
            redacted = [line.replace(secret, "[REDACTED]") for line in redacted]
        return redacted

    def _weixin_accounts(self) -> list[dict[str, object]]:
        root = Path(self.settings.data_dir) / "weixin"
        index_path = root / "accounts.json"
        try:
            raw_ids = json.loads(index_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []
        if not isinstance(raw_ids, list):
            return []
        accounts: list[dict[str, object]] = []
        for raw_id in raw_ids:
            account_id = str(raw_id or "").strip()
            if not account_id or Path(account_id).name != account_id:
                continue
            try:
                payload = json.loads(
                    (root / "accounts" / f"{account_id}.json").read_text(
                        encoding="utf-8"
                    )
                )
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                continue
            if not isinstance(payload, dict) or not payload.get("token"):
                continue
            accounts.append(
                {
                    "account_id": account_id,
                    "user_id": str(payload.get("user_id") or ""),
                    "base_url": str(payload.get("base_url") or ""),
                    "saved_at": str(payload.get("saved_at") or ""),
                }
            )
        return accounts

    async def start_weixin_login(self) -> dict[str, object]:
        async with self._login_lock:
            if (
                self._login is not None
                and self._login.task is not None
                and not self._login.task.done()
                and self._login.qrcode_url
            ):
                return self._login_start_payload(self._login)
            await self._stop_login()
            login_id = f"wx-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
            timeout_seconds = max(
                5.0,
                float(
                    self.config_store.read("weixin").get("login_timeout_seconds")
                    or 480.0
                ),
            )
            login = _LoginState(
                login_id=login_id,
                expires_at=(
                    datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
                ).isoformat(timespec="seconds"),
            )
            self._login = login
            login.task = asyncio.create_task(
                self._run_weixin_login(login, timeout_seconds=timeout_seconds),
                name=f"cardbush-weixin-login-{login_id}",
            )
        try:
            await asyncio.wait_for(login.qr_ready.wait(), timeout=20.0)
        except asyncio.TimeoutError as exc:
            await self._stop_login()
            raise BotManagementError(
                "weixin_login_start_failed",
                "Weixin login did not return a QR code within 20 seconds",
                status_code=504,
            ) from exc
        if not login.qrcode_url:
            raise BotManagementError(
                "weixin_login_start_failed",
                login.message or "Weixin login failed before returning a QR code",
                status_code=502,
            )
        return self._login_start_payload(login)

    @staticmethod
    def _login_start_payload(login: _LoginState) -> dict[str, object]:
        return {
            "protocol": "cardbush_app.weixin_login.v1",
            "login_id": login.login_id,
            "qrcode_url": login.qrcode_url,
            "expires_at": login.expires_at,
        }

    async def _run_weixin_login(
        self,
        login: _LoginState,
        *,
        timeout_seconds: float,
    ) -> None:
        spec = platform_spec("weixin")
        config = self.config_store.read("weixin")
        command = [
            sys.executable,
            "-m",
            str(spec.module),
            "login",
            "--env-file",
            str(Path(self.settings.data_dir) / "config" / ".managed-bot.env"),
            "--data-dir",
            str(self.settings.data_dir),
            "--timeout-seconds",
            str(timeout_seconds),
        ]
        log_path = self.log_root / "weixin.log"
        try:
            process = await self._spawn_process(
                command,
                env=self._child_env(spec, config),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            login.process = process
            assert process.stdout is not None
            ensure_private_directory(log_path.parent)
            with log_path.open("ab", buffering=0) as log_handle:
                secure_private_path(log_path, is_dir=False)
                output_lines: list[str] = []
                while True:
                    raw = await process.stdout.readline()
                    if not raw:
                        break
                    log_handle.write(raw)
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    output_lines.append(line)
                    if line.startswith(("http://", "https://")) and not login.qrcode_url:
                        login.qrcode_url = line
                        login.qr_ready.set()
                return_code = await process.wait()
            joined = "\n".join(output_lines)
            if return_code == 0:
                accounts = self._weixin_accounts()
                login.account = accounts[-1] if accounts else None
                login.status = "confirmed"
                login.message = "Weixin account connected"
            elif "过期" in joined or "expired" in joined.lower():
                login.status = "expired"
                login.message = "Weixin login QR code expired"
            else:
                login.status = "failed"
                login.message = output_lines[-1] if output_lines else (
                    f"Weixin login exited with code {return_code}"
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            login.status = "failed"
            login.message = f"{type(exc).__name__}: {exc}"
            logger.warning("Weixin login worker failed", exc_info=True)
        finally:
            login.qr_ready.set()

    def weixin_login_status(self, login_id: str) -> dict[str, object]:
        login = self._login
        if login is None or login.login_id != str(login_id):
            raise BotManagementError(
                "weixin_login_not_found",
                f"Unknown Weixin login: {login_id}",
                status_code=404,
            )
        return {
            "protocol": "cardbush_app.weixin_login.v1",
            "login_id": login.login_id,
            "status": login.status,
            "account": login.account,
            "message": login.message,
        }

    async def _stop_login(self) -> None:
        login = self._login
        if login is None:
            return
        process = login.process
        task = login.task
        was_active = bool(
            (process is not None and process.returncode is None)
            or (task is not None and not task.done())
        )
        if process is not None and process.returncode is None:
            await self._terminate_process_tree(
                process,
                platform="weixin-login",
                grace_seconds=3.0,
            )
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if was_active:
            login.status = "failed"
            login.message = "Weixin login cancelled"
            login.qr_ready.set()

    async def delete_weixin_account(self, account_id: str) -> dict[str, object]:
        normalized = str(account_id or "").strip()
        if not normalized or Path(normalized).name != normalized:
            raise BotManagementError("invalid_weixin_account", "Invalid account id")
        if not any(
            item.get("account_id") == normalized for item in self._weixin_accounts()
        ):
            raise BotManagementError(
                "weixin_account_not_found",
                f"Unknown Weixin account: {normalized}",
                status_code=404,
            )
        await self._stop_login()
        await self.stop("weixin")
        root = Path(self.settings.data_dir) / "weixin"
        index_path = root / "accounts.json"
        try:
            raw_ids = json.loads(index_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw_ids = []
        remaining = [item for item in raw_ids if str(item) != normalized]
        temporary = index_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(remaining, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        secure_private_path(temporary, is_dir=False)
        temporary.replace(index_path)
        for suffix in (
            "accounts/{account}.json",
            "accounts/{account}.sync.json",
            "accounts/{account}.context-tokens.json",
            "accounts/{account}.active-sessions.json",
            "accounts/{account}.session-flags.json",
            "accounts/{account}.message-processing.json",
            "accounts/{account}.runtime-trace.json",
        ):
            try:
                (root / suffix.format(account=normalized)).unlink()
            except FileNotFoundError:
                pass
        return {"account_id": normalized, "deleted": True}
