"""Transport-neutral helpers for text projected to external channels."""

from __future__ import annotations

import re

_TURN_SEARCH_HINT_RE = re.compile(
    r"(?:\n|\r\n){2}(?:具体工具执行历史搜索词: |Tool result history search phrase: ).*$",
    re.DOTALL,
)


def strip_turn_search_hint(text: str) -> str:
    """Remove the internal search locator appended to assistant text."""

    content = str(text or "").strip()
    if not content:
        return ""
    return _TURN_SEARCH_HINT_RE.sub("", content).strip()


__all__ = ["strip_turn_search_hint"]
