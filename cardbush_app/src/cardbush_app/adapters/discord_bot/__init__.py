from .config import DiscordBotSettings
from .dedup import DiscordMessageDeduplicator

__all__ = [
    "build_service",
    "create_app",
    "DiscordBotSettings",
    "DiscordGatewayRunner",
    "DiscordMessageDeduplicator",
]


def __getattr__(name: str):
    if name in {"build_service", "create_app"}:
        from . import app

        return getattr(app, name)
    if name == "DiscordGatewayRunner":
        from .gateway import DiscordGatewayRunner

        return DiscordGatewayRunner
    raise AttributeError(name)
