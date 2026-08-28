from .config import FeishuBotSettings
from .dedup import FeishuMessageDeduplicator
from .read_receipts import FeishuReadReceiptStore

__all__ = [
    "build_service",
    "create_app",
    "FeishuBotSettings",
    "FeishuLongConnectionRunner",
    "FeishuMessageDeduplicator",
    "FeishuReadReceiptStore",
]


def __getattr__(name: str):
    if name in {"build_service", "create_app"}:
        from . import app

        return getattr(app, name)
    if name == "FeishuLongConnectionRunner":
        from .long_connection import FeishuLongConnectionRunner

        return FeishuLongConnectionRunner
    raise AttributeError(name)
