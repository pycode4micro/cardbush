from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

_SESSION_TOKEN_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def default_app_data_dir() -> Path:
    override = str(os.getenv("CARDBUSH_APP_DATA_DIR") or "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if sys.platform.startswith("win"):
        root = os.getenv("APPDATA") or os.getenv("LOCALAPPDATA")
        if root:
            return (Path(root) / "CardBush").resolve(strict=False)
    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "CardBush").resolve(
            strict=False
        )
    root = os.getenv("XDG_DATA_HOME")
    if root:
        return (Path(root) / "cardbush").resolve(strict=False)
    return (Path.home() / ".local" / "share" / "cardbush").resolve(strict=False)


def normalize_data_dir(value: Path | str | None) -> Path:
    if value in (None, ""):
        return default_app_data_dir()
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return candidate.resolve(strict=False)


def sanitize_session_token(value: object | None) -> str:
    text = _SESSION_TOKEN_RE.sub("_", str(value or "session").strip()).strip("._")
    return text[:160] or "session"


def session_workspace_dir(data_dir: Path | str | None, session_id: object | None) -> Path:
    return (
        normalize_data_dir(data_dir)
        / "bot-workspaces"
        / sanitize_session_token(session_id)
    ).resolve(strict=False)


def secure_private_path(path: Path, *, is_dir: bool) -> Path:
    target = path.expanduser()
    if os.name == "posix":
        try:
            target.chmod(0o700 if is_dir else 0o600)
        except OSError:
            pass
        return target
    if os.name != "nt":
        return target
    icacls = shutil.which("icacls")
    username = str(os.getenv("USERNAME") or "").strip()
    if not icacls or not username:
        return target
    grant = f"{username}:(OI)(CI)(F)" if is_dir else f"{username}:(F)"
    try:
        subprocess.run(
            [icacls, str(target), "/inheritance:r", "/grant:r", grant],
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
        )
    except OSError:
        pass
    return target


def ensure_private_directory(path: Path) -> Path:
    target = path.expanduser()
    existed = target.exists()
    target.mkdir(parents=True, exist_ok=True)
    if not existed or os.name == "posix":
        secure_private_path(target, is_dir=True)
    return target
