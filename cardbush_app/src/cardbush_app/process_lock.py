from __future__ import annotations

import ctypes
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_LOCK_STARTUP_GRACE_SECONDS = 10.0
_WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WINDOWS_STILL_ACTIVE = 259
_WINDOWS_ERROR_ACCESS_DENIED = 5


@dataclass(slots=True)
class ManagedProcessLock:
    path: Path
    parent_pid: int | None = None
    acquired: bool = False

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        attempts = 0
        while True:
            attempts += 1
            try:
                fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                if attempts > 2 or not self._clear_if_stale():
                    raise RuntimeError(self._active_instance_message())
                continue
            try:
                os.write(fd, self._payload().encode("utf-8"))
            finally:
                os.close(fd)
            self.acquired = True
            return

    def release(self) -> None:
        if not self.acquired:
            return
        self.acquired = False
        try:
            self.path.unlink()
        except OSError:
            pass

    def _clear_if_stale(self) -> bool:
        payload = self._read_payload()
        if payload is not None:
            pid = self._payload_pid(payload)
            if pid is not None and process_is_running(pid):
                parent_pid = self._payload_pid(payload, key="parent_pid")
                if parent_pid is None or process_is_running(parent_pid):
                    return False
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline and process_is_running(pid):
                    time.sleep(0.1)
                if process_is_running(pid):
                    return False
                refreshed = self._read_payload()
                if refreshed is not None:
                    refreshed_pid = self._payload_pid(refreshed)
                    if refreshed_pid not in (None, pid):
                        return False
        try:
            age_seconds = max(0.0, time.time() - self.path.stat().st_mtime)
        except FileNotFoundError:
            return True
        if payload is None and age_seconds < _LOCK_STARTUP_GRACE_SECONDS:
            return False
        try:
            self.path.unlink()
        except FileNotFoundError:
            return True
        except OSError:
            return False
        return True

    def _active_instance_message(self) -> str:
        payload = self._read_payload() or {}
        pid = self._payload_pid(payload)
        parent_pid = self._payload_pid(payload, key="parent_pid")
        parent = f", parent_pid={parent_pid}" if parent_pid is not None else ""
        return (
            "another managed process instance is already running "
            f"(pid={pid if pid is not None else 'unknown'}{parent}, lock={self.path})"
        )

    @staticmethod
    def _payload_pid(payload: dict[str, Any], *, key: str = "pid") -> int | None:
        try:
            pid = int(payload.get(key))
        except (TypeError, ValueError):
            return None
        return pid if pid > 0 else None

    def _read_payload(self) -> dict[str, Any] | None:
        try:
            text = self.path.read_text(encoding="utf-8").strip()
            payload = json.loads(text)
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _payload(self) -> str:
        payload: dict[str, object] = {
            "pid": os.getpid(),
            "started_at": time.time(),
            "cwd": str(Path.cwd()),
            "python": sys.executable,
        }
        if self.parent_pid is not None and self.parent_pid > 0:
            payload["parent_pid"] = self.parent_pid
        return json.dumps(payload, ensure_ascii=False)


def process_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_is_running(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _windows_pid_is_running(pid: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(
        _WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION,
        False,
        pid,
    )
    if not handle:
        return ctypes.get_last_error() == _WINDOWS_ERROR_ACCESS_DENIED
    exit_code = ctypes.c_ulong()
    try:
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return ctypes.get_last_error() == _WINDOWS_ERROR_ACCESS_DENIED
        return int(exit_code.value) == _WINDOWS_STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


__all__ = ["ManagedProcessLock", "process_is_running"]
