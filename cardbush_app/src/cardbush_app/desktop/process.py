from __future__ import annotations

import ctypes
import os
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_NAME_FALLBACK = "unknown"
_WINDOW_TEXT_LIMIT = 4096
_SW_RESTORE = 9

_BLOCKED_PROCESS_NAMES = frozenset(
    {
        "regedit.exe",
        "reg.exe",
    }
)
_ELEVATED_PROCESS_NAMES = frozenset(
    {
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "powershell_ise.exe",
        "mmc.exe",
        "taskmgr.exe",
        "control.exe",
        "msconfig.exe",
        "wt.exe",
        "windowsterminal.exe",
        "conhost.exe",
    }
)


class ProcessTier(str, Enum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    BLOCKED = "blocked"


@dataclass(frozen=True, slots=True)
class ForegroundProcessInfo:
    hwnd: int | None
    pid: int | None
    proc_name: str
    exe_path: str
    window_title: str
    permission_path: str
    available: bool = True
    error: str | None = None


def desktop_control_supported() -> bool:
    return os.name == "nt" and sys.platform.startswith("win")


def build_process_permission_path(proc_name: str | None) -> str:
    normalized_name = str(proc_name or _PROCESS_NAME_FALLBACK).strip().lower()
    return f"process://{normalized_name or _PROCESS_NAME_FALLBACK}"


def get_process_tier(proc_name: str | None) -> ProcessTier:
    normalized_name = str(proc_name or "").strip().lower()
    if normalized_name in _BLOCKED_PROCESS_NAMES:
        return ProcessTier.BLOCKED
    if normalized_name in _ELEVATED_PROCESS_NAMES:
        return ProcessTier.ELEVATED
    return ProcessTier.NORMAL


def get_foreground_process_info() -> ForegroundProcessInfo:
    if not desktop_control_supported():
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error="desktop_control is only available on Windows",
        )

    try:
        from ctypes import wintypes
    except Exception as exc:
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error=f"failed to load Windows types: {exc}",
        )

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    get_foreground_window = user32.GetForegroundWindow
    get_foreground_window.argtypes = []
    get_foreground_window.restype = wintypes.HWND

    hwnd = int(get_foreground_window() or 0)
    return _resolve_window_process_info(user32, kernel32, hwnd)


def get_window_process_info(hwnd: int | None) -> ForegroundProcessInfo:
    if not desktop_control_supported():
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error="desktop_control is only available on Windows",
        )
    hwnd_value = int(hwnd or 0)
    if hwnd_value <= 0:
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error="failed to resolve window handle",
        )
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    return _resolve_window_process_info(user32, kernel32, hwnd_value)


def find_windows_by_title(
    title_pattern: str | None,
    *,
    max_results: int = 20,
) -> tuple[ForegroundProcessInfo, ...]:
    if not desktop_control_supported():
        return ()
    normalized_pattern = str(title_pattern or "").strip().lower()
    if not normalized_pattern:
        return ()
    try:
        from ctypes import wintypes
    except Exception:
        return ()

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    enum_windows = user32.EnumWindows
    is_window_visible = user32.IsWindowVisible

    _WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    enum_windows.argtypes = [_WNDENUMPROC, wintypes.LPARAM]
    enum_windows.restype = wintypes.BOOL
    is_window_visible.argtypes = [wintypes.HWND]
    is_window_visible.restype = wintypes.BOOL

    limit = max(1, min(int(max_results), 100))
    matches: list[ForegroundProcessInfo] = []

    @_WNDENUMPROC
    def _callback(hwnd: wintypes.HWND, _lparam: wintypes.LPARAM) -> bool:
        hwnd_value = int(hwnd or 0)
        if hwnd_value <= 0:
            return True
        if not bool(is_window_visible(wintypes.HWND(hwnd_value))):
            return True
        process_info = _resolve_window_process_info(user32, kernel32, hwnd_value)
        title = str(process_info.window_title or "").strip()
        if not title or normalized_pattern not in title.lower():
            return True
        matches.append(process_info)
        return len(matches) < limit

    try:
        enum_windows(_callback, 0)
    except Exception:
        return tuple(matches)
    return tuple(matches)


def list_visible_windows(*, max_results: int = 100) -> tuple[ForegroundProcessInfo, ...]:
    """Return visible titled top-level windows without relying on a search term."""
    if not desktop_control_supported():
        return ()
    try:
        from ctypes import wintypes
    except Exception:
        return ()
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    limit = max(1, min(int(max_results), 500))
    windows: list[ForegroundProcessInfo] = []

    @callback_type
    def callback(hwnd: wintypes.HWND, _lparam: wintypes.LPARAM) -> bool:
        hwnd_value = int(hwnd or 0)
        if hwnd_value <= 0 or not bool(user32.IsWindowVisible(hwnd)):
            return True
        info = _resolve_window_process_info(user32, kernel32, hwnd_value)
        if str(info.window_title or "").strip():
            windows.append(info)
        return len(windows) < limit

    try:
        user32.EnumWindows(callback, 0)
    except Exception:
        pass
    return tuple(windows)


def window_action(
    hwnd: int | None,
    action: str,
    *,
    x: int | None = None,
    y: int | None = None,
    width: int | None = None,
    height: int | None = None,
) -> bool:
    """Apply a bounded native action to an already-resolved top-level window."""
    if not desktop_control_supported() or int(hwnd or 0) <= 0:
        return False
    from ctypes import wintypes

    hwnd_value = wintypes.HWND(int(hwnd or 0))
    normalized = str(action or "").strip().lower()
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    if normalized == "activate":
        return focus_window(int(hwnd or 0))
    show_codes = {"minimize": 6, "maximize": 3, "restore": 9}
    if normalized in show_codes:
        user32.ShowWindow(hwnd_value, show_codes[normalized])
        return True
    if normalized == "close":
        return bool(user32.PostMessageW(hwnd_value, 0x0010, 0, 0))
    if normalized in {"move", "resize"}:
        rect = wintypes.RECT()
        if not bool(user32.GetWindowRect(hwnd_value, ctypes.byref(rect))):
            return False
        next_x = int(x) if x is not None else int(rect.left)
        next_y = int(y) if y is not None else int(rect.top)
        next_width = int(width) if width is not None else int(rect.right - rect.left)
        next_height = int(height) if height is not None else int(rect.bottom - rect.top)
        if next_width <= 0 or next_height <= 0:
            return False
        return bool(user32.MoveWindow(hwnd_value, next_x, next_y, next_width, next_height, True))
    return False


def focus_window(hwnd: int | None) -> bool:
    if not desktop_control_supported():
        return False
    hwnd_value = int(hwnd or 0)
    if hwnd_value <= 0:
        return False
    try:
        from ctypes import wintypes
    except Exception:
        return False

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    get_foreground_window = user32.GetForegroundWindow
    get_foreground_window.argtypes = []
    get_foreground_window.restype = wintypes.HWND

    get_window_thread_process_id = user32.GetWindowThreadProcessId
    get_window_thread_process_id.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    get_window_thread_process_id.restype = wintypes.DWORD

    is_iconic = user32.IsIconic
    is_iconic.argtypes = [wintypes.HWND]
    is_iconic.restype = wintypes.BOOL

    show_window = user32.ShowWindow
    show_window.argtypes = [wintypes.HWND, ctypes.c_int]
    show_window.restype = wintypes.BOOL

    bring_window_to_top = user32.BringWindowToTop
    bring_window_to_top.argtypes = [wintypes.HWND]
    bring_window_to_top.restype = wintypes.BOOL

    set_foreground_window = user32.SetForegroundWindow
    set_foreground_window.argtypes = [wintypes.HWND]
    set_foreground_window.restype = wintypes.BOOL

    set_active_window = user32.SetActiveWindow
    set_active_window.argtypes = [wintypes.HWND]
    set_active_window.restype = wintypes.HWND

    set_focus = user32.SetFocus
    set_focus.argtypes = [wintypes.HWND]
    set_focus.restype = wintypes.HWND

    attach_thread_input = user32.AttachThreadInput
    attach_thread_input.argtypes = [
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.BOOL,
    ]
    attach_thread_input.restype = wintypes.BOOL

    get_current_thread_id = kernel32.GetCurrentThreadId
    get_current_thread_id.argtypes = []
    get_current_thread_id.restype = wintypes.DWORD

    foreground_hwnd = int(get_foreground_window() or 0)
    current_pid = wintypes.DWORD()
    target_pid = wintypes.DWORD()
    foreground_thread_id = int(
        get_window_thread_process_id(wintypes.HWND(foreground_hwnd), ctypes.byref(current_pid))
        or 0
    )
    target_thread_id = int(
        get_window_thread_process_id(wintypes.HWND(hwnd_value), ctypes.byref(target_pid))
        or 0
    )
    current_thread_id = int(get_current_thread_id() or 0)

    attached_threads: list[int] = []
    try:
        if bool(is_iconic(wintypes.HWND(hwnd_value))):
            show_window(wintypes.HWND(hwnd_value), _SW_RESTORE)
        for thread_id in (foreground_thread_id, target_thread_id):
            if (
                thread_id > 0
                and thread_id != current_thread_id
                and thread_id not in attached_threads
            ):
                if bool(
                    attach_thread_input(
                        wintypes.DWORD(current_thread_id),
                        wintypes.DWORD(thread_id),
                        True,
                    )
                ):
                    attached_threads.append(thread_id)
        bring_window_to_top(wintypes.HWND(hwnd_value))
        set_active_window(wintypes.HWND(hwnd_value))
        set_focus(wintypes.HWND(hwnd_value))
        focused = bool(set_foreground_window(wintypes.HWND(hwnd_value)))
    finally:
        for thread_id in reversed(attached_threads):
            attach_thread_input(
                wintypes.DWORD(current_thread_id),
                wintypes.DWORD(thread_id),
                False,
            )

    active_hwnd = int(get_foreground_window() or 0)
    return focused or active_hwnd == hwnd_value


def _resolve_window_process_info(
    user32: ctypes.WinDLL,
    kernel32: ctypes.WinDLL,
    hwnd: int,
) -> ForegroundProcessInfo:
    try:
        from ctypes import wintypes
    except Exception as exc:
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error=f"failed to load Windows types: {exc}",
        )

    hwnd_value = int(hwnd or 0)
    if hwnd_value <= 0:
        return ForegroundProcessInfo(
            hwnd=None,
            pid=None,
            proc_name=_PROCESS_NAME_FALLBACK,
            exe_path="",
            window_title="",
            permission_path=build_process_permission_path(_PROCESS_NAME_FALLBACK),
            available=False,
            error="failed to resolve foreground window",
        )

    get_window_thread_process_id = user32.GetWindowThreadProcessId
    get_window_thread_process_id.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    get_window_thread_process_id.restype = wintypes.DWORD

    pid = wintypes.DWORD()
    get_window_thread_process_id(wintypes.HWND(hwnd_value), ctypes.byref(pid))
    pid_value = int(pid.value or 0)
    exe_path = _query_process_image_path(kernel32, pid_value)
    proc_name = (
        Path(exe_path).name.strip().lower()
        if str(exe_path or "").strip()
        else _PROCESS_NAME_FALLBACK
    )
    window_title = _query_window_title(user32, hwnd_value)
    permission_path = build_process_permission_path(proc_name)
    available = bool(pid_value > 0 and proc_name != _PROCESS_NAME_FALLBACK)
    error = None if available else "failed to resolve foreground process"
    return ForegroundProcessInfo(
        hwnd=hwnd_value,
        pid=pid_value if pid_value > 0 else None,
        proc_name=proc_name or _PROCESS_NAME_FALLBACK,
        exe_path=exe_path,
        window_title=window_title,
        permission_path=permission_path,
        available=available,
        error=error,
    )


def _query_window_title(user32: ctypes.WinDLL, hwnd: int) -> str:
    try:
        from ctypes import wintypes
    except Exception:
        return ""

    get_window_text = user32.GetWindowTextW
    get_window_text.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    get_window_text.restype = ctypes.c_int

    buffer = ctypes.create_unicode_buffer(_WINDOW_TEXT_LIMIT)
    copied = int(get_window_text(wintypes.HWND(hwnd), buffer, len(buffer)) or 0)
    if copied <= 0:
        return ""
    return str(buffer.value or "").strip()


def _query_process_image_path(kernel32: ctypes.WinDLL, pid: int) -> str:
    if int(pid) <= 0:
        return ""
    try:
        from ctypes import wintypes
    except Exception:
        return ""

    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE

    query_full_process_image_name = kernel32.QueryFullProcessImageNameW
    query_full_process_image_name.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    query_full_process_image_name.restype = wintypes.BOOL

    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    handle = open_process(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ""
    try:
        buffer_size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(int(buffer_size.value))
        ok = bool(
            query_full_process_image_name(
                handle,
                0,
                buffer,
                ctypes.byref(buffer_size),
            )
        )
        if not ok:
            return ""
        return str(buffer.value or "").strip()
    finally:
        close_handle(handle)


__all__ = [
    "ForegroundProcessInfo",
    "ProcessTier",
    "build_process_permission_path",
    "desktop_control_supported",
    "find_windows_by_title",
    "focus_window",
    "get_foreground_process_info",
    "get_process_tier",
    "get_window_process_info",
    "list_visible_windows",
    "window_action",
]
