from __future__ import annotations

from collections.abc import Iterable


def parse_identifier_allowlist(value: object | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        candidates: Iterable[object] = value.replace(";", ",").split(",")
    elif isinstance(value, Iterable):
        candidates = value
    else:
        candidates = (value,)
    ordered: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        normalized = str(item or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return tuple(ordered)


def channel_identity_is_allowed(
    *,
    user_id: object | None,
    channel_id: object | None,
    allowed_user_ids: Iterable[object] = (),
    allowed_channel_ids: Iterable[object] = (),
) -> bool:
    normalized_user_id = str(user_id or "").strip()
    normalized_channel_id = str(channel_id or "").strip()
    user_allowlist = parse_identifier_allowlist(allowed_user_ids)
    channel_allowlist = parse_identifier_allowlist(allowed_channel_ids)
    if user_allowlist and normalized_user_id not in user_allowlist:
        return False
    if channel_allowlist and normalized_channel_id not in channel_allowlist:
        return False
    return True


__all__ = ["channel_identity_is_allowed", "parse_identifier_allowlist"]
