from __future__ import annotations

from cardbush_app.adapters.common.access_control import (
    channel_identity_is_allowed,
    parse_identifier_allowlist,
)


def test_parse_identifier_allowlist_normalizes_and_deduplicates() -> None:
    assert parse_identifier_allowlist(" user-1, user-2;user-1 ") == (
        "user-1",
        "user-2",
    )


def test_empty_allowlists_allow_authenticated_platform_identity() -> None:
    assert channel_identity_is_allowed(user_id="user-1", channel_id="channel-1")


def test_user_and_channel_allowlists_are_both_enforced() -> None:
    assert channel_identity_is_allowed(
        user_id="user-1",
        channel_id="channel-1",
        allowed_user_ids=("user-1",),
        allowed_channel_ids=("channel-1",),
    )
    assert not channel_identity_is_allowed(
        user_id="user-2",
        channel_id="channel-1",
        allowed_user_ids=("user-1",),
        allowed_channel_ids=("channel-1",),
    )
    assert not channel_identity_is_allowed(
        user_id="user-1",
        channel_id="channel-2",
        allowed_user_ids=("user-1",),
        allowed_channel_ids=("channel-1",),
    )
