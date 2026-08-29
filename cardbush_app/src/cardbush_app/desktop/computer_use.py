from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .control import DesktopControlTool
from .process import (
    find_windows_by_title,
    get_window_process_info,
    list_visible_windows,
    window_action,
)


class ComputerUseTool:
    """Host-owned computer interaction exposed through ``cardbush_app`` MCP."""

    name = "computer_use"
    description = (
        "Observe and interact with the user's computer through guarded native UI "
        "actions. Use file tools for file contents. Window close and elevated-process "
        "control require an explicit permission grant."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "observe", "screenshot", "click", "type", "key", "scroll",
                    "drag", "window", "open_app",
                ],
            },
            "x": {"type": "integer"},
            "y": {"type": "integer"},
            "to_x": {"type": "integer"},
            "to_y": {"type": "integer"},
            "width": {"type": "integer", "minimum": 1},
            "height": {"type": "integer", "minimum": 1},
            "button": {"type": "string", "enum": ["left", "right", "middle"]},
            "clicks": {"type": "integer", "minimum": 1, "maximum": 5},
            "text": {"type": "string"},
            "interval": {"type": "number", "minimum": 0, "maximum": 2},
            "key": {"type": "string"},
            "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "delta": {"type": "integer", "minimum": -20, "maximum": 20},
            "duration_ms": {"type": "integer", "minimum": 0, "maximum": 5000},
            "steps": {"type": "integer", "minimum": 1, "maximum": 120},
            "title_pattern": {"type": "string"},
            "hwnd": {"type": "integer"},
            "operation": {
                "type": "string",
                "enum": ["activate", "minimize", "maximize", "restore", "close", "move", "resize"],
            },
            "app": {"type": "string"},
            "refresh": {"type": "boolean"},
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    def __init__(self) -> None:
        self._control = DesktopControlTool()

    async def ensure_runtime(self) -> dict[str, Any]:
        return await self._control.ensure_runtime()

    async def run(
        self,
        arguments: dict[str, Any],
        *,
        request_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        action = str(arguments.get("action") or "").strip().lower()
        context = dict(request_context or {})
        if action == "window":
            return self._window(arguments, context=context)
        if action == "open_app":
            return await self._open_app(arguments, context=context)

        mapped_action = {
            "observe": "preload" if bool(arguments.get("refresh")) else "inspect",
            "screenshot": "screenshot",
            "click": "mouse_click",
            "type": "typewrite",
            "key": "hotkey" if isinstance(arguments.get("keys"), list) else "press",
            "scroll": "scroll",
            "drag": "mouse_drag",
        }.get(action)
        if mapped_action is None:
            return _failure(f"unsupported computer_use action: {action}", "invalid_action")

        forwarded: dict[str, Any] = {"action": mapped_action, "_bush_context": context}
        for key in (
            "x", "y", "to_x", "to_y", "width", "height", "button", "clicks",
            "text", "interval", "key", "keys", "delta", "duration_ms", "steps",
            "title_pattern",
        ):
            if arguments.get(key) is not None:
                forwarded[key] = arguments[key]
        payload = _json_object(await self._control.run(forwarded))
        ok = payload.get("status") == "ok"
        artifacts: list[dict[str, Any]] = []
        path = str(payload.get("path") or payload.get("screenshot_path") or "").strip()
        if path:
            artifacts.append({
                "type": "image", "path": path, "display": "inline",
                "read_only": True, "model_input": True,
            })
        return _result(
            ok=ok,
            summary=f"computer_use {action} {'completed' if ok else 'failed'}",
            details={"action": action, "result": payload},
            artifacts=artifacts,
            error_code="" if ok else str(payload.get("status") or "computer_use_failed"),
        )

    def _window(
        self,
        arguments: dict[str, Any],
        *,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        operation = str(arguments.get("operation") or "activate").strip().lower()
        hwnd = arguments.get("hwnd")
        if isinstance(hwnd, int):
            matches = tuple(item for item in list_visible_windows() if int(item.hwnd or 0) == hwnd)
        else:
            pattern = str(arguments.get("title_pattern") or "").strip()
            matches = find_windows_by_title(pattern) if pattern else ()
        if not matches:
            return _failure("No matching visible window was found", "window_not_found")
        target = matches[0]
        permission_path = (
            f"window://{int(target.hwnd or 0)}/close"
            if operation == "close"
            else str(target.permission_path or "")
        )
        if operation == "close" and not _has_write_grant(permission_path, context):
            return _permission_required(
                path=permission_path,
                reason=(
                    f"Closing '{target.window_title}' may discard unsaved state and "
                    "requires explicit user authorization."
                ),
            )
        process_info = get_window_process_info(target.hwnd)
        if process_info.permission_path and not _process_control_allowed(process_info, context):
            return _permission_required(
                path=process_info.permission_path,
                reason=f"Controlling elevated process '{process_info.proc_name}' requires authorization.",
            )
        ok = window_action(
            target.hwnd,
            operation,
            x=arguments.get("x"), y=arguments.get("y"),
            width=arguments.get("width"), height=arguments.get("height"),
        )
        return _result(
            ok=ok,
            summary=f"Window action {operation} {'completed' if ok else 'failed'}",
            details={
                "action": "window", "operation": operation,
                "target": {
                    "hwnd": int(target.hwnd or 0), "pid": target.pid,
                    "title": target.window_title, "process_name": target.proc_name,
                },
            },
            error_code="" if ok else "window_action_failed",
        )

    async def _open_app(
        self,
        arguments: dict[str, Any],
        *,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        target = str(arguments.get("app") or "").strip()
        if not target:
            return _failure("app is required", "invalid_arguments")
        lowered = target.casefold()
        if any(marker in lowered for marker in ("uninstall", "installer", "setup.exe", "msiexec")):
            return _permission_required(
                path=f"app-launch://{target}",
                reason="Installer and uninstaller launches require explicit user authorization.",
            )
        if "://" in target or any(char in target for char in "|;&><`\n\r"):
            return _failure("URLs and shell syntax are not valid app targets", "invalid_app_target")
        preload = _json_object(
            await self._control.run({"action": "preload", "_bush_context": context})
        )
        apps = list(dict(preload.get("result") or {}).get("apps") or [])
        resolved = _resolve_app_target(target, apps=apps)
        if resolved is None:
            return _failure(f"Installed app '{target}' was not found", "app_not_found")
        os.startfile(str(resolved))  # type: ignore[attr-defined]
        return _result(
            ok=True,
            summary=f"Launched {resolved.stem}",
            details={"action": "open_app", "app": {"name": resolved.stem, "path": str(resolved)}},
        )


def _json_object(value: object) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {"status": "error", "reason": "computer host returned invalid JSON"}
    return dict(parsed) if isinstance(parsed, dict) else {"status": "error", "reason": "invalid result"}


def _allowed_permissions(context: dict[str, Any]) -> list[object]:
    value = context.get("allowed_permissions")
    if not isinstance(value, list):
        value = context.get("_resource_manager_allowed_permissions")
    return list(value) if isinstance(value, list) else []


def _has_write_grant(path: str, context: dict[str, Any]) -> bool:
    requested = str(path or "").strip().casefold()
    return any(
        isinstance(item, dict)
        and str(item.get("path") or "").strip().casefold() == requested
        and str(item.get("access_kind") or "").strip().casefold() in {"write", "read_write"}
        for item in _allowed_permissions(context)
    )


def _process_control_allowed(process_info: Any, context: dict[str, Any]) -> bool:
    from .process import get_process_tier

    tier = get_process_tier(process_info.proc_name).value
    if tier == "blocked":
        return False
    return tier != "elevated" or _has_write_grant(process_info.permission_path, context)


def _resolve_app_target(target: str, *, apps: list[Any]) -> Path | None:
    candidate = Path(target).expanduser()
    if candidate.is_file() and candidate.suffix.casefold() in {".exe", ".lnk"}:
        return candidate.resolve(strict=False)
    matches = [
        dict(item) for item in apps
        if isinstance(item, dict) and target.casefold() in str(item.get("name") or "").casefold()
    ]
    exact = next(
        (item for item in matches if str(item.get("name") or "").casefold() == target.casefold()),
        None,
    )
    selected = exact or (matches[0] if len(matches) == 1 else None)
    return Path(str(selected.get("path"))) if isinstance(selected, dict) else None


def _result(
    *,
    ok: bool,
    summary: str,
    details: dict[str, Any] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    error_code: str = "",
) -> dict[str, Any]:
    return {
        "protocol": "cardbush_app.computer_result.v1",
        "outcome": {
            "semantic_success": bool(ok),
            "verification_state": "verified" if ok else "failed",
            "error_code": str(error_code or ""),
        },
        "summary": summary,
        "details": dict(details or {}),
        "artifacts": list(artifacts or []),
        "receipts": [],
    }


def _failure(message: str, code: str) -> dict[str, Any]:
    return _result(ok=False, summary=message, error_code=code)


def _permission_required(*, path: str, reason: str) -> dict[str, Any]:
    payload = _result(ok=False, summary=reason, error_code="permission_required")
    payload["outcome"]["verification_state"] = "unverified"
    payload["permission_request"] = {
        "path": path,
        "access_kind": "write",
        "reason": reason,
    }
    return payload


__all__ = ["ComputerUseTool"]
