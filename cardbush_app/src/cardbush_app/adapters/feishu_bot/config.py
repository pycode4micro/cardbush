from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from cardbush_app.adapters.common.access_control import parse_identifier_allowlist


def _as_bool(value: str | None, *, default: bool) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return bool(default)
    return text not in {"0", "false", "no", "off"}


@dataclass(slots=True)
class FeishuBotSettings:
    app_id: str
    app_secret: str
    verification_token: str | None = None
    encrypt_key: str | None = None
    api_base: str = "https://open.feishu.cn"
    host: str = "127.0.0.1"
    port: int = 8091
    mode: str = "long"
    dedup_ttl_seconds: float = 28800.0
    dedup_max_entries: int = 4096
    dedup_sqlite_path: str | None = None
    dedup_persistent_ttl_seconds: float = 28800.0
    ack_mode: str = "reaction"
    ack_reaction_emoji: str = "OK"
    ack_placeholder_text: str = "⏳ 正在思考中..."
    disable_env_proxy: bool = True
    allowed_user_ids: tuple[str, ...] = ()
    allowed_channel_ids: tuple[str, ...] = ()

    @classmethod
    def from_env(cls, env_file: str | None = ".env") -> "FeishuBotSettings":
        if env_file:
            env_path = Path(env_file)
            if env_path.exists():
                # CLI passes an explicit env file. It should take priority over
                # inherited shell variables so adapter-level ACK settings are deterministic.
                load_dotenv(env_path, override=True)
        app_id = str(os.getenv("FEISHU_APP_ID", "") or "").strip()
        app_secret = str(os.getenv("FEISHU_APP_SECRET", "") or "").strip()
        if not app_id or not app_secret:
            raise ValueError("FEISHU_APP_ID and FEISHU_APP_SECRET are required")
        mode = str(os.getenv("FEISHU_BOT_MODE", "long") or "long").strip().lower()
        if mode not in {"long", "webhook"}:
            raise ValueError("FEISHU_BOT_MODE must be 'long' or 'webhook'")
        ack_mode = str(os.getenv("FEISHU_ACK_MODE", "reaction") or "reaction").strip().lower()
        if ack_mode not in {"reaction", "placeholder", "none"}:
            raise ValueError("FEISHU_ACK_MODE must be 'reaction', 'placeholder', or 'none'")
        verification_token = str(os.getenv("FEISHU_VERIFICATION_TOKEN", "") or "").strip() or None
        encrypt_key = str(os.getenv("FEISHU_ENCRYPT_KEY", "") or "").strip() or None
        return cls(
            app_id=app_id,
            app_secret=app_secret,
            verification_token=verification_token,
            encrypt_key=encrypt_key,
            api_base=str(os.getenv("FEISHU_API_BASE", "https://open.feishu.cn") or "https://open.feishu.cn").rstrip("/"),
            host=str(os.getenv("FEISHU_BOT_HOST", "127.0.0.1") or "127.0.0.1"),
            port=int(os.getenv("FEISHU_BOT_PORT", "8091") or "8091"),
            mode=mode,
            dedup_ttl_seconds=float(os.getenv("FEISHU_DEDUP_TTL_SECONDS", "28800") or "28800"),
            dedup_max_entries=int(os.getenv("FEISHU_DEDUP_MAX_ENTRIES", "4096") or "4096"),
            dedup_sqlite_path=str(os.getenv("FEISHU_DEDUP_SQLITE_PATH", "") or "").strip() or None,
            dedup_persistent_ttl_seconds=float(
                os.getenv("FEISHU_DEDUP_PERSISTENT_TTL_SECONDS", "28800") or "28800"
            ),
            ack_mode=ack_mode,
            ack_reaction_emoji=str(os.getenv("FEISHU_ACK_REACTION_EMOJI", "OK") or "OK").strip() or "OK",
            ack_placeholder_text=str(
                os.getenv("FEISHU_ACK_PLACEHOLDER_TEXT", "⏳ 正在思考中...") or "⏳ 正在思考中..."
            ).strip()
            or "⏳ 正在思考中...",
            disable_env_proxy=_as_bool(
                os.getenv("FEISHU_DISABLE_ENV_PROXY"),
                default=True,
            ),
            allowed_user_ids=parse_identifier_allowlist(
                os.getenv("FEISHU_ALLOWED_USER_IDS")
            ),
            allowed_channel_ids=parse_identifier_allowlist(
                os.getenv("FEISHU_ALLOWED_CHANNEL_IDS")
            ),
        )
