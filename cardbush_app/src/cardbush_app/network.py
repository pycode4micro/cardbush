from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

import httpx

DEFAULT_HTTP_SERVICE_PORT = 51717
LOCAL_REQUEST_KEY_HEADER = "X-Bush-Local-Key"


def is_loopback_url(value: str | None) -> bool:
    host = str(urlparse(str(value or "")).hostname or "").strip().lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def build_local_api_base_url(*, host: str = "127.0.0.1", port: int = 51717) -> str:
    if not is_loopback_url(f"http://{host}"):
        raise ValueError("CardBush Bot backend endpoint must be loopback")
    return f"http://{host}:{int(port)}"


def _local_request_secret() -> str:
    direct = str(os.getenv("BUSH_LOCAL_REQUEST_SECRET") or "").strip()
    if direct:
        return direct
    override = str(os.getenv("BUSH_LOCAL_REQUEST_SECRET_PATH") or "").strip()
    if override:
        path = Path(override).expanduser()
    elif os.name == "nt":
        root = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA")
        path = Path(root or Path.home()) / "bushserver" / "config" / "local_request_secret"
    else:
        path = Path.home() / ".local" / "share" / "bushserver" / "config" / "local_request_secret"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def apply_service_auth_headers(
    url: str,
    headers: Mapping[str, str] | None = None,
    *,
    bearer_token: str | None = None,
) -> dict[str, str] | None:
    result = dict(headers or {})
    token = str(bearer_token or "").strip()
    if token:
        result["Authorization"] = f"Bearer {token}"
    if is_loopback_url(url):
        secret = _local_request_secret()
        if secret:
            result[LOCAL_REQUEST_KEY_HEADER] = secret
    return result or None


@dataclass(slots=True)
class OutboundProxySettings:
    proxy: str | None = None
    no_proxy: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(str(self.proxy or "").strip())

    @classmethod
    def from_values(
        cls,
        proxy: str | None = None,
        no_proxy: str | None = None,
    ) -> "OutboundProxySettings":
        return cls(
            proxy=str(proxy or "").strip() or None,
            no_proxy=str(no_proxy or "").strip() or None,
        )

    def should_bypass(self, url: str) -> bool:
        if is_loopback_url(url):
            return True
        host = str(urlparse(url).hostname or "").lower()
        rules = [item.strip().lower() for item in str(self.no_proxy or "").split(",")]
        return any(rule == "*" or host == rule or host.endswith(f".{rule}") for rule in rules if rule)


def build_httpx_async_client(
    target_url: str,
    proxy_settings: OutboundProxySettings | None = None,
    *,
    timeout: float | httpx.Timeout | None = None,
    headers: dict[str, str] | None = None,
    auth: httpx.Auth | None = None,
    limits: httpx.Limits | None = None,
    http2: bool | None = None,
    follow_redirects: bool | None = None,
) -> httpx.AsyncClient:
    settings = proxy_settings or OutboundProxySettings()
    kwargs: dict[str, Any] = {
        "trust_env": False,
        "headers": apply_service_auth_headers(target_url, headers),
    }
    if timeout is not None:
        kwargs["timeout"] = timeout
    if auth is not None:
        kwargs["auth"] = auth
    if limits is not None:
        kwargs["limits"] = limits
    if http2 is not None:
        kwargs["http2"] = bool(http2)
    if follow_redirects is not None:
        kwargs["follow_redirects"] = bool(follow_redirects)
    if settings.proxy and not settings.should_bypass(target_url):
        kwargs["proxy"] = settings.proxy
    return httpx.AsyncClient(**kwargs)
