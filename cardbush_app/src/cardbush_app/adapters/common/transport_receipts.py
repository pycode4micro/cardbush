from __future__ import annotations


def format_transport_receipt_notice(
    *,
    channel_label: str,
    accepted_count: int,
    failed_count: int,
) -> str:
    accepted = max(0, int(accepted_count))
    failed = max(0, int(failed_count))
    return (
        f"通道回执：{str(channel_label or '').strip()}发送接口已接受 {accepted} 个文件"
        + (f"，{failed} 个发送失败" if failed else "")
        + "。这不表示对方已读。"
    )


__all__ = ["format_transport_receipt_notice"]
