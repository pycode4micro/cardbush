"""Read only this plugin's configuration; never copy credentials into os.environ.

Precedence: explicitly present process env (including empty) > Windows HKCU
Environment > caller default. User variables are read on demand, not cached.
No HKLM, .env, project config, other user's hive, or arbitrary registry lookup.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field

CONFIG_NAMES = frozenset({
    "ARK_API_KEY", "ARK_BASE_URL", "SEEDREAM_MODEL", "SEEDREAM_OUTPUT_DIR",
    "SEEDREAM_TIMEOUT_SECONDS", "SEEDANCE_MODEL", "SEEDANCE_TIMEOUT_SECONDS",
    "MEDIAKIT_API_KEY", "MEDIAKIT_BASE_URL", "MEDIAKIT_TIMEOUT_SECONDS",
    "VOLCENGINE_ACCESS_KEY_ID", "VOLCENGINE_SECRET_ACCESS_KEY", "VOLCENGINE_SESSION_TOKEN",
    "VOLCENGINE_MUSIC_TIMEOUT_SECONDS",
})
USER_ENV_SWITCH = "ARK_READ_USER_ENV"


@dataclass(frozen=True)
class ConfigValue:
    value: str | None = field(repr=False)
    source: str


def user_env_enabled() -> bool:
    # Only process env controls fallback. Empty or unrecognized switch values
    # disable it rather than unexpectedly enabling access to stored credentials.
    return os.environ.get(USER_ENV_SWITCH, "1").strip().lower() in {"1", "true", "yes", "on"}


def _read_windows_user(name: str) -> ConfigValue:
    if name not in CONFIG_NAMES:
        raise ValueError("Configuration name is not in the plugin allowlist")
    if sys.platform != "win32":
        return ConfigValue(None, "not_windows")
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ) as key:
            value, value_type = winreg.QueryValueEx(key, name)
        if value_type not in {winreg.REG_SZ, winreg.REG_EXPAND_SZ} or not isinstance(value, str):
            return ConfigValue(None, "windows_user_invalid_type")
        # API keys are literal secrets, never expansion templates.
        if value_type == winreg.REG_EXPAND_SZ and name not in {
                "ARK_API_KEY", "MEDIAKIT_API_KEY", "VOLCENGINE_ACCESS_KEY_ID",
                "VOLCENGINE_SECRET_ACCESS_KEY", "VOLCENGINE_SESSION_TOKEN"}:
            value = os.path.expandvars(value)
        return ConfigValue(value, "windows_user")
    except FileNotFoundError:
        return ConfigValue(None, "windows_user_missing")
    except (OSError, ImportError):
        # No exception text: registry errors can contain paths or values.
        return ConfigValue(None, "windows_user_unavailable")


def resolve_config(name: str) -> ConfigValue:
    if name not in CONFIG_NAMES:
        raise ValueError("Configuration name is not in the plugin allowlist")
    if name in os.environ:
        return ConfigValue(os.environ[name], "process")
    if not user_env_enabled():
        return ConfigValue(None, "windows_user_disabled")
    return _read_windows_user(name)


def get_config(name: str, default: str = "") -> str:
    resolved = resolve_config(name)
    return default if resolved.value is None else resolved.value


def configuration_status() -> dict:
    """Safe diagnostics: no values, key lengths, fingerprints or registry dumps."""
    variables = {}
    for name in sorted(CONFIG_NAMES):
        resolved = resolve_config(name)
        variables[name] = {"configured": bool(resolved.value and resolved.value.strip()), "source": resolved.source}
    return {"variables": variables, "windows_user_fallback_enabled": user_env_enabled(),
            "precedence": "present process env (including empty) > current Windows user env > built-in default",
            "note": "Reads on demand; does not modify environment or registry. configured means present, not API authorization verified. ARK_READ_USER_ENV=0 disables user-registry fallback."}
