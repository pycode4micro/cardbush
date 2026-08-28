from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from cardbush_app.adapters.common.access_control import parse_identifier_allowlist

DEFAULT_DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)


@dataclass(slots=True)
class DiscordBotSettings:
    application_id: str
    bot_token: str
    public_key: str | None = None
    api_base: str = "https://discord.com/api/v10"
    command_name: str = "chat"
    host: str = "127.0.0.1"
    port: int = 8092
    guild_id: str | None = None
    mode: str = "long"
    gateway_intents: int = DEFAULT_DISCORD_GATEWAY_INTENTS
    dedup_ttl_seconds: float = 600.0
    dedup_max_entries: int = 4096
    allowed_user_ids: tuple[str, ...] = ()
    allowed_channel_ids: tuple[str, ...] = ()

    @classmethod
    def from_env(cls, env_file: str | None = ".env") -> "DiscordBotSettings":
        if env_file:
            env_path = Path(env_file)
            if env_path.exists():
                load_dotenv(env_path, override=False)
        application_id = str(os.getenv("DISCORD_APPLICATION_ID", "") or "").strip()
        bot_token = str(os.getenv("DISCORD_BOT_TOKEN", "") or "").strip()
        public_key = str(os.getenv("DISCORD_PUBLIC_KEY", "") or "").strip() or None
        mode = str(os.getenv("DISCORD_BOT_MODE", "long") or "long").strip().lower()
        if mode not in {"long", "webhook"}:
            raise ValueError("DISCORD_BOT_MODE must be 'long' or 'webhook'")
        if not application_id or not bot_token:
            raise ValueError("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required")
        if mode == "webhook" and not public_key:
            raise ValueError("DISCORD_PUBLIC_KEY is required in webhook mode")
        guild_id = str(os.getenv("DISCORD_GUILD_ID", "") or "").strip() or None
        return cls(
            application_id=application_id,
            bot_token=bot_token,
            public_key=public_key,
            api_base=str(os.getenv("DISCORD_API_BASE", "https://discord.com/api/v10") or "https://discord.com/api/v10").rstrip("/"),
            command_name=str(os.getenv("DISCORD_COMMAND_NAME", "chat") or "chat").strip() or "chat",
            host=str(os.getenv("DISCORD_BOT_HOST", "127.0.0.1") or "127.0.0.1"),
            port=int(os.getenv("DISCORD_BOT_PORT", "8092") or "8092"),
            guild_id=guild_id,
            mode=mode,
            gateway_intents=int(os.getenv("DISCORD_GATEWAY_INTENTS", str(DEFAULT_DISCORD_GATEWAY_INTENTS)) or str(DEFAULT_DISCORD_GATEWAY_INTENTS)),
            dedup_ttl_seconds=float(os.getenv("DISCORD_DEDUP_TTL_SECONDS", "600") or "600"),
            dedup_max_entries=int(os.getenv("DISCORD_DEDUP_MAX_ENTRIES", "4096") or "4096"),
            allowed_user_ids=parse_identifier_allowlist(
                os.getenv("DISCORD_ALLOWED_USER_IDS")
            ),
            allowed_channel_ids=parse_identifier_allowlist(
                os.getenv("DISCORD_ALLOWED_CHANNEL_IDS")
            ),
        )
