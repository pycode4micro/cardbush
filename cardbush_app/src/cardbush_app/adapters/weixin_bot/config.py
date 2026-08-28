from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from cardbush_app.network import OutboundProxySettings
from cardbush_app.paths import default_app_data_dir
from cardbush_app.adapters.common.access_control import parse_identifier_allowlist

from .media import WEIXIN_CDN_BASE_URL


def _as_float(value: str | None, default: float) -> float:
    try:
        return float((value or "").strip() or str(default))
    except ValueError:
        return default


def _as_bool(value: str | None, *, default: bool) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return bool(default)
    return text not in {"0", "false", "no", "off"}


def _as_optional_path(value: str | None) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    return Path(text).expanduser().resolve(strict=False)


def _resolve_data_dir() -> Path:
    configured = str(os.getenv("CARDBUSH_APP_DATA_DIR", "") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve(strict=False)
    return default_app_data_dir().resolve(strict=False)


def build_client_version(version: str) -> int:
    parts = str(version or "").strip().split(".")
    try:
        major = int(parts[0]) if len(parts) > 0 else 0
    except ValueError:
        major = 0
    try:
        minor = int(parts[1]) if len(parts) > 1 else 0
    except ValueError:
        minor = 0
    try:
        patch = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        patch = 0
    return ((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)


@dataclass(slots=True)
class WeixinBotSettings:
    data_dir: Path
    base_url: str = "https://ilinkai.weixin.qq.com"
    login_base_url: str = "https://ilinkai.weixin.qq.com"
    app_id: str = "bot"
    app_version: str = "2.1.7"
    bot_type: str = "3"
    route_tag: str | None = None
    allowed_user_ids: tuple[str, ...] = ()
    allowed_channel_ids: tuple[str, ...] = ()
    poll_timeout_seconds: float = 35.0
    api_timeout_seconds: float = 15.0
    login_timeout_seconds: float = 480.0
    unsupported_message_text: str = "当前仅支持文本消息。"
    cdn_base_url: str = WEIXIN_CDN_BASE_URL
    media_timeout_seconds: float = 120.0
    proxy: str | None = None
    no_proxy: str | None = None
    disable_env_proxy: bool = True
    shadow_observation_enabled: bool = False
    shadow_observation_path: Path | None = None

    @property
    def state_dir(self) -> Path:
        return self.data_dir / "weixin"

    @property
    def client_version(self) -> int:
        return build_client_version(self.app_version)

    @property
    def proxy_settings(self) -> OutboundProxySettings:
        return OutboundProxySettings.from_values(
            proxy=self.proxy,
            no_proxy=self.no_proxy,
        )

    @classmethod
    def from_env(cls, env_file: str | None = ".env") -> "WeixinBotSettings":
        if env_file:
            env_path = Path(env_file)
            if env_path.exists():
                load_dotenv(env_path, override=True)
        shadow_observation_enabled = os.getenv("WEIXIN_SHADOW_OBSERVATION_ENABLED")
        if shadow_observation_enabled is None:
            shadow_observation_enabled = os.getenv("WEIXIN_SHADOW_OBSERVATION")
        return cls(
            data_dir=_resolve_data_dir(),
            base_url=str(
                os.getenv("WEIXIN_API_BASE", "https://ilinkai.weixin.qq.com")
                or "https://ilinkai.weixin.qq.com"
            ).rstrip("/"),
            login_base_url=str(
                os.getenv("WEIXIN_LOGIN_API_BASE", "https://ilinkai.weixin.qq.com")
                or "https://ilinkai.weixin.qq.com"
            ).rstrip("/"),
            app_id=str(os.getenv("WEIXIN_APP_ID", "bot") or "bot").strip() or "bot",
            app_version=(
                str(os.getenv("WEIXIN_APP_VERSION", "2.1.7") or "2.1.7").strip()
                or "2.1.7"
            ),
            bot_type=str(os.getenv("WEIXIN_BOT_TYPE", "3") or "3").strip() or "3",
            route_tag=str(os.getenv("WEIXIN_ROUTE_TAG", "") or "").strip() or None,
            allowed_user_ids=parse_identifier_allowlist(
                os.getenv("WEIXIN_ALLOWED_USER_IDS")
            ),
            allowed_channel_ids=parse_identifier_allowlist(
                os.getenv("WEIXIN_ALLOWED_CHANNEL_IDS")
            ),
            poll_timeout_seconds=max(
                5.0,
                _as_float(os.getenv("WEIXIN_POLL_TIMEOUT_SECONDS"), 35.0),
            ),
            api_timeout_seconds=max(
                1.0,
                _as_float(os.getenv("WEIXIN_API_TIMEOUT_SECONDS"), 15.0),
            ),
            login_timeout_seconds=max(
                5.0,
                _as_float(os.getenv("WEIXIN_LOGIN_TIMEOUT_SECONDS"), 480.0),
            ),
            unsupported_message_text=(
                str(os.getenv("WEIXIN_UNSUPPORTED_MESSAGE_TEXT", "") or "").strip()
                or "当前仅支持文本消息。"
            ),
            cdn_base_url=str(
                os.getenv("WEIXIN_CDN_BASE_URL", WEIXIN_CDN_BASE_URL)
                or WEIXIN_CDN_BASE_URL
            ).rstrip("/"),
            media_timeout_seconds=max(
                5.0,
                _as_float(os.getenv("WEIXIN_MEDIA_TIMEOUT_SECONDS"), 120.0),
            ),
            proxy=str(os.getenv("WEIXIN_PROXY", "") or "").strip() or None,
            no_proxy=str(os.getenv("WEIXIN_NO_PROXY", "") or "").strip() or None,
            disable_env_proxy=_as_bool(
                os.getenv("WEIXIN_DISABLE_ENV_PROXY"),
                default=True,
            ),
            shadow_observation_enabled=_as_bool(
                shadow_observation_enabled,
                default=False,
            ),
            shadow_observation_path=_as_optional_path(
                os.getenv("WEIXIN_SHADOW_OBSERVATION_PATH")
            ),
        )
