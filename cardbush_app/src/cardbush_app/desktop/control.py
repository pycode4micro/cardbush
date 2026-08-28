from __future__ import annotations

import ctypes
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from cardbush_app.paths import (
    default_app_data_dir,
    ensure_private_directory,
    normalize_data_dir,
    sanitize_session_token,
)
from cardbush_app.desktop.process import (
    ForegroundProcessInfo,
    desktop_control_supported,
    find_windows_by_title,
    focus_window,
    get_foreground_process_info,
    get_process_tier,
    get_window_process_info,
    list_visible_windows,
)

_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_UNICODE = 0x0004

_INPUT_MOUSE = 0
_INPUT_KEYBOARD = 1

_MOUSEEVENTF_MOVE = 0x0001
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_MOUSEEVENTF_RIGHTDOWN = 0x0008
_MOUSEEVENTF_RIGHTUP = 0x0010
_MOUSEEVENTF_MIDDLEDOWN = 0x0020
_MOUSEEVENTF_MIDDLEUP = 0x0040
_MOUSEEVENTF_ABSOLUTE = 0x8000
_MOUSEEVENTF_VIRTUALDESK = 0x4000
_MOUSEEVENTF_WHEEL = 0x0800

_WHEEL_DELTA = 120
_TOP_LEFT_FAILSAFE_THRESHOLD = 3
_SM_XVIRTUALSCREEN = 76
_SM_YVIRTUALSCREEN = 77
_SM_CXVIRTUALSCREEN = 78
_SM_CYVIRTUALSCREEN = 79
_SM_CXSCREEN = 0
_SM_CYSCREEN = 1
_MAX_NORMALIZED_MOUSE_COORD = 65535
_DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
_DPI_AWARENESS_INIT_LOCK = threading.Lock()
_DPI_AWARENESS_INITIALIZED = False
_DESKTOP_PRELOAD_LOCK = threading.Lock()
_DESKTOP_PRELOAD_CACHE: dict[str, Any] = {}
_DESKTOP_PRELOAD_TTL_SECONDS = 15.0

_BLOCKED_TEXT_PATTERNS: tuple[tuple[str, str], ...] = (
    ("shutdown", "dangerous shutdown text is blocked"),
    ("rm -rf", "destructive delete text is blocked"),
    ("remove-item", "destructive delete text is blocked"),
    ("format ", "disk format text is blocked"),
    ("reg delete", "registry deletion text is blocked"),
    ("rmdir /s", "recursive directory deletion text is blocked"),
    ("rd /s", "recursive directory deletion text is blocked"),
)

_BLOCKED_HOTKEYS: dict[frozenset[str], str] = {
    frozenset({"alt", "f4"}): "Alt+F4 is blocked",
    frozenset({"win", "d"}): "Win+D is blocked",
    frozenset({"win", "r"}): "Win+R is blocked",
    frozenset({"win", "x"}): "Win+X is blocked",
    frozenset({"win", "i"}): "Win+I is blocked",
    frozenset({"win", "l"}): "Win+L is blocked",
    frozenset({"ctrl", "shift", "esc"}): "Ctrl+Shift+Esc is blocked",
    frozenset({"ctrl", "alt", "delete"}): "Ctrl+Alt+Delete is blocked",
    frozenset({"alt", "tab"}): "Alt+Tab is blocked",
}

_VK_NAME_MAP: dict[str, int] = {
    "backspace": 0x08,
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "shift": 0x10,
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "pause": 0x13,
    "capslock": 0x14,
    "esc": 0x1B,
    "escape": 0x1B,
    "space": 0x20,
    "pageup": 0x21,
    "pagedown": 0x22,
    "end": 0x23,
    "home": 0x24,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "printscreen": 0x2C,
    "insert": 0x2D,
    "delete": 0x2E,
    "win": 0x5B,
    "meta": 0x5B,
    "super": 0x5B,
    "apps": 0x5D,
    "numlock": 0x90,
    "scrolllock": 0x91,
    ";": 0xBA,
    "=": 0xBB,
    ",": 0xBC,
    "-": 0xBD,
    ".": 0xBE,
    "/": 0xBF,
    "`": 0xC0,
    "[": 0xDB,
    "\\": 0xDC,
    "]": 0xDD,
    "'": 0xDE,
}
for _index in range(1, 25):
    _VK_NAME_MAP[f"f{_index}"] = 0x6F + _index


class DesktopControlError(RuntimeError):
    pass


class DesktopControlBlockedError(DesktopControlError):
    pass


class DesktopControlPermissionError(DesktopControlBlockedError):
    pass


class DesktopControlPlatformError(DesktopControlError):
    pass


class DesktopControlFailsafeError(DesktopControlBlockedError):
    pass


class DesktopControlNotFoundError(DesktopControlError):
    pass


def _process_permission_is_allowed(
    permission_path: str,
    allowed_permissions: list[object],
) -> bool:
    """Match an explicit write grant for an elevated process URI."""

    requested = str(permission_path or "").strip().lower()
    if not requested:
        return False
    for item in allowed_permissions:
        if not isinstance(item, dict):
            continue
        granted = str(item.get("path") or "").strip().lower()
        access = str(item.get("access_kind") or "read").strip().lower()
        if granted == requested and access in {"write", "read_write"}:
            return True
    return False


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    )


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    )


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = (
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_short),
        ("wParamH", ctypes.c_ushort),
    )


class _INPUT_UNION(ctypes.Union):
    _fields_ = (
        ("mi", _MOUSEINPUT),
        ("ki", _KEYBDINPUT),
        ("hi", _HARDWAREINPUT),
    )


class _INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = (
        ("type", ctypes.c_ulong),
        ("union", _INPUT_UNION),
    )


class DesktopControlAuditLogger:
    def __init__(self) -> None:
        self._init_lock = threading.Lock()
        self._ready_paths: set[str] = set()

    def log(
        self,
        *,
        app_data_dir: str | None,
        action: str,
        arguments: dict[str, Any],
        process_info: ForegroundProcessInfo,
        status: str,
        reason: str = "",
    ) -> None:
        db_path = self._resolve_db_path(app_data_dir)
        if db_path is None:
            return
        self._ensure_schema(db_path)
        payload = {
            "action": action,
            "arguments": _audit_arguments(arguments),
            "process_name": process_info.proc_name,
            "window_title": process_info.window_title,
            "permission_path": process_info.permission_path,
            "exe_path": process_info.exe_path,
            "status": status,
            "reason": reason,
            "created_at": time.time(),
        }
        try:
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    (
                        "INSERT INTO desktop_control_audit "
                        "(created_at, action, process_name, window_title, permission_path, exe_path, status, reason, payload_json) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    ),
                    (
                        float(payload["created_at"]),
                        str(action),
                        str(process_info.proc_name or ""),
                        str(process_info.window_title or ""),
                        str(process_info.permission_path or ""),
                        str(process_info.exe_path or ""),
                        str(status),
                        str(reason or ""),
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
        except Exception:
            return

    def _resolve_db_path(self, app_data_dir: str | None) -> Path | None:
        try:
            root = normalize_data_dir(app_data_dir)
        except Exception:
            return None
        db_path = root / "logs" / "desktop_control_audit.sqlite3"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return db_path

    def _ensure_schema(self, db_path: Path) -> None:
        key = str(db_path)
        if key in self._ready_paths:
            return
        with self._init_lock:
            if key in self._ready_paths:
                return
            try:
                with sqlite3.connect(db_path) as conn:
                    conn.execute(
                        (
                            "CREATE TABLE IF NOT EXISTS desktop_control_audit ("
                            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                            "created_at REAL NOT NULL,"
                            "action TEXT NOT NULL,"
                            "process_name TEXT NOT NULL,"
                            "window_title TEXT NOT NULL,"
                            "permission_path TEXT NOT NULL,"
                            "exe_path TEXT NOT NULL,"
                            "status TEXT NOT NULL,"
                            "reason TEXT NOT NULL,"
                            "payload_json TEXT NOT NULL"
                            ")"
                        )
                    )
            except Exception:
                return
            self._ready_paths.add(key)


class DesktopControlTool:
    """Internal Windows input adapter used by the public ``computer_use`` tool."""

    input_schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "preload",
                    "press",
                    "hotkey",
                    "typewrite",
                    "mouse_click",
                    "mouse_move",
                    "mouse_drag",
                    "scroll",
                    "window_focus",
                    "screenshot",
                    "wait",
                    "sequence",
                    "inspect",
                ],
                "description": "Desktop control action to execute.",
            },
            "key": {
                "type": "string",
                "description": "Single key name for `press`.",
            },
            "keys": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "Ordered hotkey key names for `hotkey`.",
            },
            "text": {
                "type": "string",
                "description": "Unicode text for `typewrite`.",
            },
            "interval": {
                "type": "number",
                "minimum": 0,
                "maximum": 2,
                "description": "Optional per-character delay for `typewrite`.",
            },
            "button": {
                "type": "string",
                "enum": ["left", "right", "middle"],
                "description": "Mouse button for `mouse_click`.",
            },
            "clicks": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5,
                "description": "Click count for `mouse_click`.",
            },
            "x": {
                "type": "integer",
                "description": "Screen X coordinate for `mouse_move`, `mouse_drag`, or screenshot regions.",
            },
            "y": {
                "type": "integer",
                "description": "Screen Y coordinate for `mouse_move`, `mouse_drag`, or screenshot regions.",
            },
            "to_x": {
                "type": "integer",
                "description": "Destination screen X coordinate for `mouse_drag`.",
            },
            "to_y": {
                "type": "integer",
                "description": "Destination screen Y coordinate for `mouse_drag`.",
            },
            "duration_ms": {
                "type": "integer",
                "minimum": 0,
                "maximum": 5000,
                "default": 350,
                "description": "Human-paced drag duration for `mouse_drag`.",
            },
            "steps": {
                "type": "integer",
                "minimum": 1,
                "maximum": 120,
                "default": 12,
                "description": "Interpolated mouse movement steps for `mouse_drag`.",
            },
            "delta": {
                "type": "integer",
                "minimum": -20,
                "maximum": 20,
                "description": "Wheel steps for `scroll`.",
            },
            "title_pattern": {
                "type": "string",
                "description": "Visible window title substring for `window_focus` or optional `inspect` target matching.",
            },
            "width": {
                "type": "integer",
                "minimum": 1,
                "description": "Capture width for `screenshot` regions.",
            },
            "height": {
                "type": "integer",
                "minimum": 1,
                "description": "Capture height for `screenshot` regions.",
            },
            "pause_ms": {
                "type": "integer",
                "minimum": 0,
                "maximum": 5000,
                "default": 250,
                "description": "For `wait` or sequence child steps, human-paced pause after the action.",
            },
            "actions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "items": {"type": "object"},
                "description": "For `sequence`, ordered child desktop_control actions. Child actions may include press, hotkey, typewrite, mouse_click, mouse_move, mouse_drag, scroll, window_focus, screenshot, inspect, or wait, but not sequence.",
            },
            "force_refresh": {
                "type": "boolean",
                "description": "Force `preload` to refresh instead of using the short runtime cache.",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    def __init__(self) -> None:
        self._audit = DesktopControlAuditLogger()

    async def ensure_runtime(self) -> dict[str, Any]:
        if desktop_control_supported():
            preload = _preload_desktop_targets(force=False)
            return {
                "available": True,
                "preloaded_window_count": len(list(preload.get("windows") or [])),
                "preloaded_app_count": len(list(preload.get("apps") or [])),
            }
        return {
            "available": False,
            "error": "desktop_control is only available on Windows hosts",
        }

    async def run(self, arguments: dict[str, Any]) -> str:
        request_metadata = _request_metadata(arguments)
        action = str(arguments.get("action") or "").strip().lower()
        process_info = get_foreground_process_info()
        matched_windows = 0
        status = "error"
        reason = ""
        payload: dict[str, Any]
        try:
            self._ensure_supported()
            preload = _preload_desktop_targets(
                force=bool(arguments.get("force_refresh", False)) if action == "preload" else False
            )
            self._validate_arguments(action, arguments)
            self._check_blacklist(action, arguments)
            if action not in {"preload", "inspect", "wait"}:
                self._check_failsafe()
            process_info, matched_windows = self._resolve_target_process_info(
                action,
                arguments,
            )
            if action not in {"preload", "inspect", "wait"}:
                self._ensure_process_permission(process_info, request_metadata=request_metadata)
            result = self._execute(
                action,
                arguments,
                target_process_info=process_info,
                matched_windows=matched_windows,
                request_metadata=request_metadata,
            )
            if action == "window_focus" and isinstance(result.get("hwnd"), int):
                focused_process = get_window_process_info(result["hwnd"])
                if focused_process.available:
                    process_info = focused_process
            status = "ok"
            payload = {
                "status": "ok",
                "action": action,
                "target": _process_payload(process_info),
                "result": result,
            }
            if action == "preload":
                payload["preload"] = preload
            if action == "screenshot":
                for key in (
                    "path",
                    "screenshot_path",
                    "model_input",
                    "width",
                    "height",
                    "note",
                ):
                    if key in result:
                        payload[key] = result[key]
        except DesktopControlNotFoundError as exc:
            status = "not_found"
            reason = str(exc)
            payload = {
                "status": "not_found",
                "action": action or "",
                "reason": reason,
                "target": _process_payload(process_info),
            }
        except DesktopControlBlockedError as exc:
            status = "blocked"
            reason = str(exc)
            payload = {
                "status": "blocked",
                "action": action or "",
                "reason": reason,
                "target": _process_payload(process_info),
            }
        except Exception as exc:  # noqa: BLE001
            status = "error"
            reason = f"{type(exc).__name__}: {exc}"
            payload = {
                "status": "error",
                "action": action or "",
                "reason": reason,
                "target": _process_payload(process_info),
            }
        self._audit.log(
            app_data_dir=str(request_metadata.get("app_data_dir") or "").strip() or None,
            action=action or "",
            arguments=arguments,
            process_info=process_info,
            status=status,
            reason=reason,
        )
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def _ensure_supported() -> None:
        if desktop_control_supported():
            return
        raise DesktopControlPlatformError("desktop_control is only available on Windows")

    def _validate_arguments(self, action: str, arguments: dict[str, Any]) -> None:
        if action not in {
            "preload",
            "press",
            "hotkey",
            "typewrite",
            "mouse_click",
            "mouse_move",
            "mouse_drag",
            "scroll",
            "window_focus",
            "screenshot",
            "wait",
            "sequence",
            "inspect",
        }:
            raise ValueError(
                "`action` must be one of preload, press, hotkey, typewrite, mouse_click, mouse_move, mouse_drag, scroll, window_focus, screenshot, wait, sequence, inspect"
            )
        if action == "preload":
            return
        if action == "sequence":
            actions = arguments.get("actions")
            if not isinstance(actions, list) or not actions:
                raise ValueError("`actions` is required for `sequence`")
            if len(actions) > 20:
                raise ValueError("`sequence` accepts at most 20 child actions")
            for index, raw_step in enumerate(actions):
                if not isinstance(raw_step, dict):
                    raise ValueError(f"`actions[{index}]` must be an object")
                child_action = str(raw_step.get("action") or "").strip().lower()
                if child_action == "sequence":
                    raise ValueError("nested `sequence` actions are not allowed")
                pause_ms = raw_step.get("pause_ms")
                if pause_ms is not None and (
                    not isinstance(pause_ms, int) or pause_ms < 0 or pause_ms > 5000
                ):
                    raise ValueError(
                        f"`actions[{index}].pause_ms` must be an integer between 0 and 5000"
                    )
                self._validate_arguments(child_action, raw_step)
            return
        if action == "wait":
            pause_ms = arguments.get("pause_ms", 250)
            if not isinstance(pause_ms, int):
                raise ValueError("`pause_ms` must be an integer for `wait`")
            if pause_ms < 0 or pause_ms > 5000:
                raise ValueError("`pause_ms` must be between 0 and 5000")
            return
        if action == "press" and not str(arguments.get("key") or "").strip():
            raise ValueError("`key` is required for `press`")
        if action == "hotkey":
            keys = arguments.get("keys")
            if not isinstance(keys, list) or not [str(item).strip() for item in keys if str(item).strip()]:
                raise ValueError("`keys` is required for `hotkey`")
        if action == "typewrite" and str(arguments.get("text") or "") == "":
            raise ValueError("`text` is required for `typewrite`")
        if action == "mouse_move":
            if not isinstance(arguments.get("x"), int) or not isinstance(arguments.get("y"), int):
                raise ValueError("`x` and `y` are required integers for `mouse_move`")
        if action == "mouse_drag":
            if (
                not isinstance(arguments.get("x"), int)
                or not isinstance(arguments.get("y"), int)
                or not isinstance(arguments.get("to_x"), int)
                or not isinstance(arguments.get("to_y"), int)
            ):
                raise ValueError(
                    "`x`, `y`, `to_x`, and `to_y` are required integers for `mouse_drag`"
                )
        if action == "scroll" and not isinstance(arguments.get("delta"), int):
            raise ValueError("`delta` is required for `scroll`")
        if action == "window_focus" and not str(arguments.get("title_pattern") or "").strip():
            raise ValueError("`title_pattern` is required for `window_focus`")
        if action == "screenshot":
            region_keys = ("x", "y", "width", "height")
            provided = [key for key in region_keys if arguments.get(key) is not None]
            if provided and len(provided) != len(region_keys):
                raise ValueError("`x`, `y`, `width`, and `height` must all be provided for `screenshot` regions")
            if provided and (
                not isinstance(arguments.get("x"), int)
                or not isinstance(arguments.get("y"), int)
                or not isinstance(arguments.get("width"), int)
                or not isinstance(arguments.get("height"), int)
            ):
                raise ValueError("`x`, `y`, `width`, and `height` must be integers for `screenshot` regions")
            if provided and (
                int(arguments.get("width") or 0) <= 0
                or int(arguments.get("height") or 0) <= 0
            ):
                raise ValueError("`width` and `height` must be positive for `screenshot` regions")

    def _check_blacklist(self, action: str, arguments: dict[str, Any]) -> None:
        if action == "sequence":
            for raw_step in list(arguments.get("actions") or []):
                if isinstance(raw_step, dict):
                    self._check_blacklist(
                        str(raw_step.get("action") or "").strip().lower(),
                        raw_step,
                    )
            return
        if action == "hotkey":
            keys = [self._normalize_key_name(item) for item in list(arguments.get("keys") or [])]
            reason = _BLOCKED_HOTKEYS.get(frozenset(keys))
            if reason:
                raise DesktopControlBlockedError(reason)
            return
        if action == "typewrite":
            lowered = str(arguments.get("text") or "").strip().lower()
            for pattern, reason in _BLOCKED_TEXT_PATTERNS:
                if pattern in lowered:
                    raise DesktopControlBlockedError(reason)

    def _resolve_target_process_info(
        self,
        action: str,
        arguments: dict[str, Any],
    ) -> tuple[ForegroundProcessInfo, int]:
        if action == "inspect":
            title_pattern = str(arguments.get("title_pattern") or "").strip()
            if not title_pattern:
                return get_foreground_process_info(), 0
            matches = find_windows_by_title(title_pattern)
            if not matches:
                raise DesktopControlNotFoundError(
                    f"no visible window matched `{title_pattern}`"
                )
            return matches[0], len(matches)
        if action != "window_focus":
            return get_foreground_process_info(), 0
        title_pattern = str(arguments.get("title_pattern") or "").strip()
        matches = find_windows_by_title(title_pattern)
        if not matches:
            raise DesktopControlNotFoundError(
                f"no visible window matched `{title_pattern}`"
            )
        return matches[0], len(matches)

    def _ensure_process_permission(
        self,
        process_info: ForegroundProcessInfo,
        *,
        request_metadata: dict[str, Any],
    ) -> None:
        if not process_info.available or process_info.proc_name == "unknown":
            raise DesktopControlBlockedError(
                process_info.error or "failed to resolve target process"
            )
        tier = get_process_tier(process_info.proc_name)
        if tier.value == "blocked":
            raise DesktopControlBlockedError(
                f"target process `{process_info.proc_name}` is blocked"
            )
        if tier.value != "elevated":
            return
        allowed_permissions = list(
            request_metadata.get("_resource_manager_allowed_permissions") or []
        )
        if _process_permission_is_allowed(
            process_info.permission_path,
            allowed_permissions,
        ):
            return
        raise DesktopControlPermissionError(
            f"desktop_control permission denied for `{process_info.permission_path}`"
        )

    @staticmethod
    def _check_failsafe() -> None:
        if not desktop_control_supported():
            return
        try:
            position = _cursor_position()
        except Exception:
            return
        if position[0] <= _TOP_LEFT_FAILSAFE_THRESHOLD and position[1] <= _TOP_LEFT_FAILSAFE_THRESHOLD:
            raise DesktopControlFailsafeError(
                "failsafe triggered because the mouse is in the top-left corner"
            )

    def _execute(
        self,
        action: str,
        arguments: dict[str, Any],
        *,
        target_process_info: ForegroundProcessInfo | None = None,
        matched_windows: int = 0,
        request_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if action == "sequence":
            return self._execute_sequence(
                arguments,
                request_metadata=request_metadata,
            )
        if action == "preload":
            return _preload_desktop_targets(force=bool(arguments.get("force_refresh", False)))
        if action == "wait":
            pause_ms = int(arguments.get("pause_ms") or 250)
            time.sleep(max(0, pause_ms) / 1000.0)
            return {"pause_ms": max(0, pause_ms)}
        if action == "inspect":
            target = target_process_info or get_foreground_process_info()
            return _desktop_control_profile(
                target,
                matched_windows=matched_windows,
            )
        if action == "press":
            key = str(arguments.get("key") or "").strip()
            self._send_press(key)
            return {"key": key}
        if action == "hotkey":
            keys = [str(item).strip() for item in list(arguments.get("keys") or []) if str(item).strip()]
            self._send_hotkey(keys)
            return {"keys": keys}
        if action == "typewrite":
            text = str(arguments.get("text") or "")
            interval = float(arguments.get("interval") or 0.0)
            self._send_text(text, interval=max(0.0, interval))
            return {"length": len(text)}
        if action == "mouse_click":
            button = str(arguments.get("button") or "left").strip().lower() or "left"
            clicks = int(arguments.get("clicks") or 1)
            x = arguments.get("x")
            y = arguments.get("y")
            result = {"button": button, "clicks": clicks}
            if isinstance(x, int) and isinstance(y, int):
                self._move_mouse(x=x, y=y)
                result["x"] = x
                result["y"] = y
            self._click_mouse(button=button, clicks=max(1, clicks))
            return result
        if action == "mouse_move":
            x = int(arguments.get("x"))
            y = int(arguments.get("y"))
            self._move_mouse(x=x, y=y)
            return {"x": x, "y": y}
        if action == "mouse_drag":
            x = int(arguments.get("x"))
            y = int(arguments.get("y"))
            to_x = int(arguments.get("to_x"))
            to_y = int(arguments.get("to_y"))
            button = str(arguments.get("button") or "left").strip().lower() or "left"
            duration_ms = int(arguments.get("duration_ms") or 350)
            steps = int(arguments.get("steps") or 12)
            self._drag_mouse(
                x=x,
                y=y,
                to_x=to_x,
                to_y=to_y,
                button=button,
                duration_ms=max(0, duration_ms),
                steps=max(1, steps),
            )
            return {
                "x": x,
                "y": y,
                "to_x": to_x,
                "to_y": to_y,
                "button": button,
                "duration_ms": max(0, duration_ms),
                "steps": max(1, steps),
            }
        if action == "scroll":
            delta = int(arguments.get("delta"))
            self._scroll(delta=delta)
            return {"delta": delta}
        if action == "window_focus":
            target = target_process_info
            if target is None or not target.available or int(target.hwnd or 0) <= 0:
                raise DesktopControlNotFoundError(
                    f"no visible window matched `{str(arguments.get('title_pattern') or '').strip()}`"
                )
            focused = focus_window(target.hwnd)
            if not focused:
                raise DesktopControlError(
                    f"failed to focus window `{target.window_title or arguments.get('title_pattern') or ''}`"
                )
            return {
                "title_pattern": str(arguments.get("title_pattern") or "").strip(),
                "hwnd": int(target.hwnd or 0),
                "matched": max(1, int(matched_windows or 1)),
                "focused": True,
                "window_title": target.window_title,
                "process_name": target.proc_name,
            }
        if action == "screenshot":
            region = _coerce_screenshot_region(arguments)
            return _capture_desktop_screenshot(
                raw_context=request_metadata,
                region=region,
            )
        raise ValueError(f"unsupported desktop_control action: {action}")

    def _execute_sequence(
        self,
        arguments: dict[str, Any],
        *,
        request_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw_actions = list(arguments.get("actions") or [])
        results: list[dict[str, Any]] = []
        for index, raw_step in enumerate(raw_actions):
            step = dict(raw_step or {})
            child_action = str(step.get("action") or "").strip().lower()
            try:
                self._validate_arguments(child_action, step)
                self._check_blacklist(child_action, step)
                if child_action not in {"inspect", "wait"}:
                    self._check_failsafe()
                process_info, matched_windows = self._resolve_target_process_info(
                    child_action,
                    step,
                )
                if child_action not in {"inspect", "wait"}:
                    self._ensure_process_permission(
                        process_info,
                        request_metadata=dict(request_metadata or {}),
                    )
                result = self._execute(
                    child_action,
                    step,
                    target_process_info=process_info,
                    matched_windows=matched_windows,
                    request_metadata=request_metadata,
                )
                if child_action == "window_focus" and isinstance(result.get("hwnd"), int):
                    focused_process = get_window_process_info(result["hwnd"])
                    if focused_process.available:
                        process_info = focused_process
            except (DesktopControlBlockedError, DesktopControlNotFoundError):
                raise
            except Exception as exc:
                raise DesktopControlError(
                    f"sequence step {index} `{child_action or 'unknown'}` failed: {exc}"
                ) from exc
            results.append(
                {
                    "index": index,
                    "action": child_action,
                    "target": _process_payload(process_info),
                    "result": result,
                }
            )
            pause_ms = step.get("pause_ms")
            if child_action != "wait" and isinstance(pause_ms, int) and pause_ms > 0:
                time.sleep(min(5000, pause_ms) / 1000.0)
        return {
            "step_count": len(raw_actions),
            "completed_count": len(results),
            "steps": results,
            "suggested_next_step": (
                "Inspect or screenshot the UI state before deciding the next "
                "human-like action sequence."
            ),
        }

    def _send_press(self, key: str) -> None:
        vk = self._key_to_vk(key)
        _send_input_batch(
            (
                _build_virtual_key_payload(vk, keyup=False),
                _build_virtual_key_payload(vk, keyup=True),
            )
        )

    def _send_hotkey(self, keys: list[str]) -> None:
        virtual_keys = [self._key_to_vk(item) for item in keys]
        payloads = [
            _build_virtual_key_payload(vk, keyup=False)
            for vk in virtual_keys
        ]
        payloads.extend(
            _build_virtual_key_payload(vk, keyup=True)
            for vk in reversed(virtual_keys)
        )
        _send_input_batch(payloads)

    def _send_text(self, text: str, interval: float) -> None:
        for character in text:
            _send_unicode_character(character)
            if interval > 0:
                time.sleep(interval)

    def _click_mouse(self, *, button: str, clicks: int) -> None:
        down_flag, up_flag = self._mouse_button_flags(button)
        for _ in range(max(1, int(clicks))):
            _send_mouse_flags(down_flag)
            _send_mouse_flags(up_flag)

    def _drag_mouse(
        self,
        *,
        x: int,
        y: int,
        to_x: int,
        to_y: int,
        button: str,
        duration_ms: int,
        steps: int,
    ) -> None:
        down_flag, up_flag = self._mouse_button_flags(button)
        total_steps = max(1, min(120, int(steps)))
        sleep_seconds = max(0.0, float(duration_ms) / 1000.0) / total_steps
        self._move_mouse(x=x, y=y)
        _send_mouse_flags(down_flag)
        try:
            for index in range(1, total_steps + 1):
                ratio = index / total_steps
                next_x = round(x + (to_x - x) * ratio)
                next_y = round(y + (to_y - y) * ratio)
                self._move_mouse(x=next_x, y=next_y)
                if sleep_seconds > 0:
                    time.sleep(sleep_seconds)
        finally:
            _send_mouse_flags(up_flag)

    @staticmethod
    def _mouse_button_flags(button: str) -> tuple[int, int]:
        button_name = str(button or "left").strip().lower() or "left"
        if button_name == "left":
            return _MOUSEEVENTF_LEFTDOWN, _MOUSEEVENTF_LEFTUP
        if button_name == "right":
            return _MOUSEEVENTF_RIGHTDOWN, _MOUSEEVENTF_RIGHTUP
        if button_name == "middle":
            return _MOUSEEVENTF_MIDDLEDOWN, _MOUSEEVENTF_MIDDLEUP
        raise ValueError("`button` must be left, right, or middle")

    @staticmethod
    def _move_mouse(*, x: int, y: int) -> None:
        _send_mouse_move_absolute(x=int(x), y=int(y))

    @staticmethod
    def _scroll(*, delta: int) -> None:
        _send_mouse_flags(_MOUSEEVENTF_WHEEL, mouse_data=int(delta) * _WHEEL_DELTA)

    @staticmethod
    def _normalize_key_name(raw_key: object | None) -> str:
        value = str(raw_key or "").strip().lower()
        aliases = {
            "control": "ctrl",
            "escape": "esc",
            "return": "enter",
            "meta": "win",
            "super": "win",
        }
        return aliases.get(value, value)

    def _key_to_vk(self, raw_key: object | None) -> int:
        key = self._normalize_key_name(raw_key)
        if not key:
            raise ValueError("key cannot be empty")
        if key in _VK_NAME_MAP:
            return int(_VK_NAME_MAP[key])
        if len(key) == 1:
            if key.isalpha():
                return ord(key.upper())
            if key.isdigit():
                return ord(key)
        raise ValueError(f"unsupported key name: {raw_key}")


def _request_metadata(arguments: dict[str, Any]) -> dict[str, Any]:
    context = arguments.get("_bush_context")
    return dict(context) if isinstance(context, dict) else {}


def _preload_desktop_targets(*, force: bool) -> dict[str, Any]:
    """Warm a short-lived catalog of app targets and their automation strategies."""
    now = time.monotonic()
    with _DESKTOP_PRELOAD_LOCK:
        cached_at = float(_DESKTOP_PRELOAD_CACHE.get("cached_at_monotonic") or 0.0)
        if (
            not force
            and _DESKTOP_PRELOAD_CACHE
            and now - cached_at <= _DESKTOP_PRELOAD_TTL_SECONDS
        ):
            return dict(_DESKTOP_PRELOAD_CACHE)

        windows: list[dict[str, Any]] = []
        frameworks: dict[str, int] = {}
        for process_info in list_visible_windows(max_results=100):
            profile = _desktop_control_profile(process_info, matched_windows=1)
            framework = str(profile.get("framework_guess") or "unknown")
            frameworks[framework] = frameworks.get(framework, 0) + 1
            windows.append(
                {
                    "hwnd": int(process_info.hwnd or 0),
                    "pid": process_info.pid,
                    "process_name": process_info.proc_name,
                    "window_title": process_info.window_title,
                    "exe_path": process_info.exe_path,
                    "framework_guess": framework,
                    "uia_expectation": profile.get("uia_expectation"),
                    "strategy_order": list(profile.get("strategy_order") or []),
                }
            )

        apps: list[dict[str, str]] = []
        seen_apps: set[str] = set()
        for env_name in ("APPDATA", "PROGRAMDATA"):
            root_value = str(os.environ.get(env_name) or "").strip()
            if not root_value:
                continue
            root = Path(root_value) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
            if not root.is_dir():
                continue
            try:
                shortcuts = root.rglob("*.lnk")
                for shortcut in shortcuts:
                    name = shortcut.stem.strip()
                    key = name.casefold()
                    if not name or key in seen_apps:
                        continue
                    seen_apps.add(key)
                    apps.append({"name": name, "path": str(shortcut)})
                    if len(apps) >= 500:
                        break
            except OSError:
                continue

        payload = {
            "status": "ready",
            "cached_at_monotonic": now,
            "ttl_seconds": _DESKTOP_PRELOAD_TTL_SECONDS,
            "windows": windows,
            "apps": apps,
            "framework_counts": frameworks,
            "strategy": "visible-window capability prewarm",
        }
        _DESKTOP_PRELOAD_CACHE.clear()
        _DESKTOP_PRELOAD_CACHE.update(payload)
        return dict(payload)


def _process_payload(process_info: ForegroundProcessInfo) -> dict[str, Any]:
    return {
        "pid": process_info.pid,
        "process_name": process_info.proc_name,
        "window_title": process_info.window_title,
        "permission_path": process_info.permission_path,
        "exe_path": process_info.exe_path,
        "available": process_info.available,
        "error": process_info.error,
    }


def _desktop_control_profile(
    process_info: ForegroundProcessInfo,
    *,
    matched_windows: int = 0,
) -> dict[str, Any]:
    app_stack = _classify_desktop_app_stack(process_info)
    strategy = _desktop_control_strategy(app_stack)
    return {
        "matched_windows": max(0, int(matched_windows or 0)),
        "target": _process_payload(process_info),
        "framework_guess": app_stack,
        "uia_expectation": strategy["uia_expectation"],
        "strategy_order": strategy["strategy_order"],
        "notes": strategy["notes"],
        "control_contract": (
            "Use stable app bridges or accessibility trees when available; fall back to "
            "screenshot/OCR plus guarded keyboard and mouse only when the target app does "
            "not expose a reliable control tree."
        ),
    }


def _classify_desktop_app_stack(process_info: ForegroundProcessInfo) -> str:
    joined = " ".join(
        [
            str(process_info.proc_name or ""),
            str(process_info.window_title or ""),
            str(process_info.exe_path or ""),
            str(process_info.permission_path or ""),
        ]
    ).lower()
    proc_name = str(process_info.proc_name or "").strip().lower()
    exe_path = str(process_info.exe_path or "").strip()
    if not process_info.available:
        return "unknown"
    if (
        proc_name in {"electron.exe", "code.exe", "slack.exe", "discord.exe", "teams.exe"}
        or "electron" in joined
        or "app.asar" in joined
    ):
        return "electron"
    if "msedgewebview2" in proc_name or "webview2" in joined:
        return "webview2"
    if "flutter" in joined or _near_executable_marker(exe_path, ("data/flutter_assets", "flutter_assets")):
        return "flutter"
    if proc_name in {"java.exe", "javaw.exe", "eclipse.exe"} or "swt" in joined:
        return "java_swt"
    if "qt" in joined or proc_name in {"designer.exe", "assistant.exe", "linguist.exe"}:
        return "qt"
    return "win32_native"


def _near_executable_marker(exe_path: str, markers: tuple[str, ...]) -> bool:
    text = str(exe_path or "").strip()
    if not text:
        return False
    try:
        base = Path(text).resolve(strict=False).parent
    except Exception:
        return False
    for marker in markers:
        marker_path = base / Path(marker)
        try:
            if marker_path.exists():
                return True
        except Exception:
            continue
    return False


def _desktop_control_strategy(app_stack: str) -> dict[str, Any]:
    if app_stack in {"electron", "webview2"}:
        return {
            "uia_expectation": "conditional",
            "strategy_order": [
                "app_bridge_or_cdp_when_target_app_supports_it",
                "uia_accessibility_tree_if_enabled",
                "screenshot_ocr_coordinate_control",
                "keyboard_shortcuts",
            ],
            "notes": [
                "Chromium/Electron apps often expose incomplete UIA trees unless accessibility is enabled.",
                "For owned apps, prefer a local app bridge, Playwright/CDP, or renderer IPC hook over raw UIA.",
            ],
        }
    if app_stack == "qt":
        return {
            "uia_expectation": "conditional",
            "strategy_order": [
                "uia_if_qt_accessibility_plugin_enabled",
                "win32_keyboard_mouse",
                "screenshot_ocr_coordinate_control",
            ],
            "notes": [
                "Qt accessibility depends on the app and deployed accessibility plugin.",
                "When the control tree is sparse, use shortcut-first flows and visual verification.",
            ],
        }
    if app_stack == "flutter":
        return {
            "uia_expectation": "weak",
            "strategy_order": [
                "semantics_tree_if_accessibility_enabled",
                "screenshot_ocr_coordinate_control",
                "keyboard_shortcuts",
            ],
            "notes": [
                "Flutter desktop controls are often custom-rendered, so UIA may be shallow.",
                "A debug/app bridge is preferred for owned Flutter apps.",
            ],
        }
    if app_stack == "java_swt":
        return {
            "uia_expectation": "conditional",
            "strategy_order": [
                "java_access_bridge_if_enabled",
                "uia_or_win32_fallback",
                "screenshot_ocr_coordinate_control",
            ],
            "notes": [
                "SWT/Java apps are more reliable through Java Access Bridge when enabled.",
            ],
        }
    if app_stack == "win32_native":
        return {
            "uia_expectation": "good",
            "strategy_order": [
                "uia_or_win32_control_tree",
                "keyboard_shortcuts",
                "screenshot_ocr_coordinate_control",
            ],
            "notes": [
                "Native Win32 apps are the best candidates for UIA/control-tree automation.",
            ],
        }
    return {
        "uia_expectation": "unknown",
        "strategy_order": [
            "inspect_accessibility_tree_if_available",
            "screenshot_ocr_coordinate_control",
            "keyboard_shortcuts",
        ],
        "notes": [
            "The desktop stack could not be classified from process metadata.",
        ],
    }


def _audit_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(arguments or {})
    redacted.pop("_bush_context", None)
    if "text" in redacted:
        redacted["text"] = {
            "length": len(str(redacted.get("text") or "")),
        }
    return redacted


def _coerce_screenshot_region(arguments: dict[str, Any]) -> dict[str, int] | None:
    if any(arguments.get(key) is not None for key in ("x", "y", "width", "height")):
        return {
            "x": int(arguments.get("x")),
            "y": int(arguments.get("y")),
            "width": int(arguments.get("width")),
            "height": int(arguments.get("height")),
        }
    return None


def _resolve_desktop_artifact_dir(
    raw_context: Any,
    *,
    session_id: object | None = None,
) -> Path:
    context = raw_context if isinstance(raw_context, dict) else {}
    resolved_session_id = (
        session_id
        if session_id not in (None, "")
        else context.get("session_id") or context.get("_session_id")
    )
    session_root = (
        normalize_data_dir(context.get("app_data_dir"))
        if context.get("app_data_dir")
        else default_app_data_dir()
    ) / "artifacts" / sanitize_session_token(resolved_session_id)
    return ensure_private_directory(session_root / "desktop" / "web_screen")


def _build_desktop_screenshot_path(raw_context: Any) -> Path:
    context = raw_context if isinstance(raw_context, dict) else {}
    artifact_dir = _resolve_desktop_artifact_dir(context)
    turn_id = sanitize_session_token(
        context.get("turn_id") or context.get("_turn_id") or "snapshot"
    )
    filename = f"{turn_id}-{int(time.time() * 1000)}-{uuid4().hex[:8]}.png"
    return artifact_dir / filename


def _capture_desktop_screenshot(
    *,
    raw_context: Any,
    region: dict[str, int] | None = None,
) -> dict[str, Any]:
    try:
        from PIL import ImageGrab
    except Exception as exc:  # pragma: no cover
        raise DesktopControlPlatformError(
            f"desktop screenshot unavailable: {exc}"
        ) from exc

    target_path = _build_desktop_screenshot_path(raw_context)
    bbox: tuple[int, int, int, int] | None = None
    if region is not None:
        bbox = (
            int(region["x"]),
            int(region["y"]),
            int(region["x"]) + int(region["width"]),
            int(region["y"]) + int(region["height"]),
        )
    try:
        image = ImageGrab.grab(bbox=bbox, all_screens=True)
    except TypeError:
        image = ImageGrab.grab(bbox=bbox)
    except Exception as exc:
        raise DesktopControlError(f"failed to capture screenshot: {exc}") from exc
    image.save(target_path, format="PNG")
    result: dict[str, Any] = {
        "path": str(target_path),
        "screenshot_path": str(target_path),
        "model_input": True,
        "width": int(image.width),
        "height": int(image.height),
        "note": (
            "Use this exact saved screenshot path for any follow-up "
            "transport_deliver call. Do not switch "
            "to transient desktop-session screenshot paths."
        ),
    }
    if region is not None:
        result["region"] = dict(region)
    return result


def _cursor_position() -> tuple[int, int]:
    class _POINT(ctypes.Structure):
        _fields_ = (
            ("x", ctypes.c_long),
            ("y", ctypes.c_long),
        )

    point = _POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return int(point.x), int(point.y)



def _build_virtual_key_payload(vk: int, *, keyup: bool) -> _INPUT:
    scan_code = int(ctypes.windll.user32.MapVirtualKeyW(int(vk), 0) or 0)
    flags = _KEYEVENTF_KEYUP if keyup else 0
    return _INPUT(
        type=_INPUT_KEYBOARD,
        ki=_KEYBDINPUT(
            wVk=int(vk),
            wScan=scan_code,
            dwFlags=flags,
            time=0,
            dwExtraInfo=None,
        ),
    )


def _send_unicode_character(character: str) -> None:
    if not character:
        return
    for code_unit in _unicode_utf16_code_units(character):
        _send_unicode_code_unit(code_unit, keyup=False)
        _send_unicode_code_unit(code_unit, keyup=True)


def _send_unicode_code_unit(code_unit: int, *, keyup: bool) -> None:
    flags = _KEYEVENTF_UNICODE | (_KEYEVENTF_KEYUP if keyup else 0)
    payload = _INPUT(
        type=_INPUT_KEYBOARD,
        ki=_KEYBDINPUT(
            wVk=0,
            wScan=int(code_unit),
            dwFlags=flags,
            time=0,
            dwExtraInfo=None,
        ),
    )
    _send_input(payload)


def _unicode_utf16_code_units(character: str) -> tuple[int, ...]:
    if not character:
        return ()
    code_point = ord(character)
    if code_point <= 0xFFFF:
        return (code_point,)
    code_point -= 0x10000
    return (
        0xD800 + (code_point >> 10),
        0xDC00 + (code_point & 0x3FF),
    )


def _send_mouse_flags(flags: int, *, mouse_data: int = 0) -> None:
    payload = _INPUT(
        type=_INPUT_MOUSE,
        mi=_MOUSEINPUT(
            dx=0,
            dy=0,
            mouseData=int(mouse_data),
            dwFlags=int(flags),
            time=0,
            dwExtraInfo=None,
        ),
    )
    _send_input(payload)


def _send_mouse_move_absolute(*, x: int, y: int) -> None:
    normalized_x, normalized_y = _pixels_to_normalized(x=int(x), y=int(y))
    payload = _INPUT(
        type=_INPUT_MOUSE,
        mi=_MOUSEINPUT(
            dx=normalized_x,
            dy=normalized_y,
            mouseData=0,
            dwFlags=(
                _MOUSEEVENTF_MOVE
                | _MOUSEEVENTF_ABSOLUTE
                | _MOUSEEVENTF_VIRTUALDESK
            ),
            time=0,
            dwExtraInfo=None,
        ),
    )
    _send_input(payload)


def _get_virtual_screen_bounds() -> tuple[int, int, int, int]:
    user32 = ctypes.windll.user32
    left = int(user32.GetSystemMetrics(_SM_XVIRTUALSCREEN) or 0)
    top = int(user32.GetSystemMetrics(_SM_YVIRTUALSCREEN) or 0)
    width = int(user32.GetSystemMetrics(_SM_CXVIRTUALSCREEN) or 0)
    height = int(user32.GetSystemMetrics(_SM_CYVIRTUALSCREEN) or 0)
    if width > 0 and height > 0:
        return left, top, width, height
    return (
        0,
        0,
        int(user32.GetSystemMetrics(_SM_CXSCREEN) or 0),
        int(user32.GetSystemMetrics(_SM_CYSCREEN) or 0),
    )



def _pixels_to_normalized(*, x: int, y: int) -> tuple[int, int]:
    left, top, width, height = _get_virtual_screen_bounds()
    relative_x = int(x) - left
    relative_y = int(y) - top
    normalized_x = _normalize_absolute_coordinate(relative_x, width)
    normalized_y = _normalize_absolute_coordinate(relative_y, height)
    return normalized_x, normalized_y


def _normalize_absolute_coordinate(position: int, span: int) -> int:
    if int(span) <= 1:
        return 0
    normalized = int(int(position) * _MAX_NORMALIZED_MOUSE_COORD / (int(span) - 1))
    return max(0, min(_MAX_NORMALIZED_MOUSE_COORD, normalized))


def _init_dpi_awareness() -> None:
    global _DPI_AWARENESS_INITIALIZED
    if _DPI_AWARENESS_INITIALIZED or not desktop_control_supported():
        return
    with _DPI_AWARENESS_INIT_LOCK:
        if _DPI_AWARENESS_INITIALIZED:
            return
        try:
            set_dpi_awareness_context = getattr(
                ctypes.windll.user32,
                "SetProcessDpiAwarenessContext",
                None,
            )
            if set_dpi_awareness_context is not None:
                set_dpi_awareness_context(_DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            else:
                ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
        _DPI_AWARENESS_INITIALIZED = True


def _send_input(payload: _INPUT) -> None:
    _send_input_batch((payload,))


def _send_input_batch(payloads: list[_INPUT] | tuple[_INPUT, ...]) -> None:
    items = tuple(payloads)
    if not items:
        return
    input_array_type = _INPUT * len(items)
    input_array = input_array_type(*items)
    sent = int(
        ctypes.windll.user32.SendInput(
            len(items),
            input_array,
            ctypes.sizeof(_INPUT),
        )
        or 0
    )
    if sent == len(items):
        return
    raise DesktopControlError("SendInput failed")


if desktop_control_supported():
    _init_dpi_awareness()


__all__ = ["DesktopControlTool"]
