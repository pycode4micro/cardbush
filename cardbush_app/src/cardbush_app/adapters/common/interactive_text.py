from __future__ import annotations

from typing import Any


def _normalize_text(value: object | None) -> str:
    return str(value or "").strip()


def _normalize_match_text(value: object | None) -> str:
    normalized = _normalize_text(value).lower()
    normalized = normalized.replace("：", ":")
    normalized = normalized.replace("　", " ")
    return " ".join(normalized.split())


def _question_accepts_input(question: dict[str, Any]) -> bool:
    selection_mode = _normalize_match_text(question.get("selection_mode"))
    if selection_mode == "input":
        return True
    if selection_mode in {"single_with_input", "multi_with_input"}:
        return True
    return bool(question.get("allow_input"))


def format_pending_interaction_text(
    pending: dict[str, Any],
    *,
    invalid_input: bool = False,
) -> str:
    title = _normalize_text(pending.get("title"))
    reason = _normalize_text(pending.get("reason"))
    description = _normalize_text(pending.get("description"))
    interaction_type = _normalize_text(pending.get("type"))
    reply_mode = _normalize_text(pending.get("reply_mode"))
    questions = list(pending.get("questions") or [])
    lines: list[str] = []
    is_permission_request = interaction_type == "path_permission_request"
    conversational_reply = (
        not is_permission_request
        and reply_mode == "raw_text_passthrough"
    )
    if invalid_input:
        if is_permission_request:
            lines.append("我没认出你的授权选择，你按下面回我就行。")
        elif conversational_reply:
            lines.append("我这边还差一点信息，你像聊天一样再说一遍就行。")
        else:
            lines.append("这条我没对上，你按下面补充给我就行。")
    elif is_permission_request:
        lines.append("继续之前，先帮我过一下这个权限。")
    else:
        lines.append("继续之前，我还差你一条信息。")
    if title:
        lines.append(title)
    if reason:
        lines.append(f"原因：{reason}")
    if description:
        lines.append(description)
    for question_index, raw_question in enumerate(questions, start=1):
        if not isinstance(raw_question, dict):
            continue
        question_text = _normalize_text(
            raw_question.get("question") or raw_question.get("label")
        )
        if question_text:
            lines.append("")
            lines.append(f"{question_index}. {question_text}")
        options = list(raw_question.get("options") or [])
        if conversational_reply:
            option_labels = [
                _normalize_text(raw_option.get("label") or raw_option.get("id"))
                for raw_option in options
                if isinstance(raw_option, dict)
                and _normalize_text(raw_option.get("label") or raw_option.get("id"))
            ]
            if option_labels:
                lines.append("你可以参考这些方向：" + "、".join(option_labels))
            lines.append("直接像平时聊天一样把你的想法发我就行，不用按固定格式。")
            continue
        for option_index, raw_option in enumerate(options, start=1):
            if not isinstance(raw_option, dict):
                continue
            label = _normalize_text(raw_option.get("label") or raw_option.get("id"))
            option_id = _normalize_text(raw_option.get("id"))
            option_description = _normalize_text(raw_option.get("description"))
            option_line = f"{option_index}. {label}"
            if option_id:
                option_line += f" [{option_id}]"
            if option_description:
                option_line += f" - {option_description}"
            lines.append(option_line)
        if _question_accepts_input(raw_question):
            if options:
                lines.append("可以回“选项 + 补充说明”，也可以直接回补充内容。")
            else:
                lines.append("直接把要补充的内容发我就行。")
        elif options:
            if is_permission_request:
                lines.append("直接回 1/2/3、选项名，或方括号里的 id 都可以。")
            else:
                lines.append("直接回序号、选项名，或方括号里的 id 都可以。")
    if len(questions) > 1 and not conversational_reply:
        lines.append("")
        lines.append("如果有多项，请一行写一个答案，例如：")
        lines.append("1=modern")
        lines.append("2=你的补充说明")
    lines.append("")
    if is_permission_request:
        lines.append("不想授权的话，回“取消”即可。")
    else:
        lines.append("先不继续的话，回“取消”即可。")
    return "\n".join(line for line in lines if line is not None).strip()
