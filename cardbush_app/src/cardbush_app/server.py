from __future__ import annotations

import hashlib
import hmac
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import uvicorn
from mcp.server.mcpserver import Context, MCPServer
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .bots import BotConfigStore, BotManagementError, BotSupervisor
from .desktop.computer_use import ComputerUseTool
from .paths import ensure_private_directory, normalize_data_dir


@dataclass(frozen=True, slots=True)
class HostSettings:
    data_dir: Path
    bushserver_host: str
    bushserver_port: int
    api_auth_token: str = ""

    @property
    def host(self) -> str:
        return self.bushserver_host

    @property
    def port(self) -> int:
        return self.bushserver_port


@dataclass(slots=True)
class HostRuntime:
    settings: HostSettings
    bot_supervisor: BotSupervisor
    computer_use: ComputerUseTool


class BearerAuthMiddleware:
    def __init__(self, app: ASGIApp, *, token: str) -> None:
        self._app = app
        self._expected = f"Bearer {token}".encode("utf-8")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or scope.get("path") == "/readyz":
            await self._app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        if not hmac.compare_digest(
            headers.get(b"authorization", b""),
            self._expected,
        ):
            response = JSONResponse(
                {"error": {"code": "unauthorized", "message": "Invalid host token"}},
                status_code=401,
            )
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)


def create_app(
    *,
    data_dir: Path | str | None,
    bushserver_host: str,
    bushserver_port: int,
    bushserver_token: str,
    host_token: str,
) -> ASGIApp:
    root = normalize_data_dir(data_dir)
    ensure_private_directory(root)
    settings = HostSettings(
        data_dir=root,
        bushserver_host=str(bushserver_host or "127.0.0.1"),
        bushserver_port=int(bushserver_port),
        api_auth_token=str(bushserver_token or ""),
    )
    supervisor = BotSupervisor(
        settings=settings,
        config_store=BotConfigStore(root / "config" / "bots.json"),
    )
    runtime = HostRuntime(
        settings=settings,
        bot_supervisor=supervisor,
        computer_use=ComputerUseTool(),
    )

    @asynccontextmanager
    async def lifespan(_server: MCPServer[HostRuntime]):
        await supervisor.startup()
        try:
            yield runtime
        finally:
            await supervisor.shutdown()

    mcp = MCPServer(
        "cardbush_app",
        instructions=(
            "Host capabilities supplied by the CardBush desktop application. "
            "Files are bounded by MCP Roots and delivery success means staged only."
        ),
        lifespan=lifespan,
    )
    _register_mcp_tools(mcp, runtime)
    _register_host_routes(mcp, runtime)
    app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        host="127.0.0.1",
    )
    app.add_middleware(BearerAuthMiddleware, token=host_token)
    return app


def run_server(
    *,
    host: str,
    port: int,
    data_dir: Path | str | None,
    bushserver_host: str,
    bushserver_port: int,
    bushserver_token: str,
    host_token: str,
    log_level: str = "warning",
) -> None:
    if str(host or "").strip() not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("cardbush_app only binds to a loopback address")
    if not str(host_token or "").strip():
        raise ValueError("host_token is required")
    app = create_app(
        data_dir=data_dir,
        bushserver_host=bushserver_host,
        bushserver_port=bushserver_port,
        bushserver_token=bushserver_token,
        host_token=host_token,
    )
    uvicorn.run(
        app,
        host=str(host),
        port=int(port),
        log_level=str(log_level or "warning"),
        access_log=False,
    )


def _register_mcp_tools(mcp: MCPServer[HostRuntime], runtime: HostRuntime) -> None:
    @mcp.tool(
        name="computer_use",
        description=ComputerUseTool.description,
        meta={
            "cardbush/action_manifest": {
                "effect_kind": "desktop_control",
                "operation": "desktop.control",
                "risk": "medium",
                "owner": "cardbush_app",
                "dispatch_phase": "execution",
                "dispatch_scope": "process",
                "dispatch_side_effect": "desktop_control",
                "dispatch_mutating": True,
                "dispatch_source": "mcp_tool_metadata",
                "stage_modes": ["execute"],
                "output_kinds": ["structured_data", "artifact"],
                "handoff_exports": [],
                "evidence_hints": ["desktop_state", "screenshot"],
            }
        },
        structured_output=True,
    )
    async def computer_use(
        action: Literal[
            "observe", "screenshot", "click", "type", "key", "scroll",
            "drag", "window", "open_app",
        ],
        ctx: Context,
        x: int | None = None,
        y: int | None = None,
        to_x: int | None = None,
        to_y: int | None = None,
        width: int | None = None,
        height: int | None = None,
        button: Literal["left", "right", "middle"] | None = None,
        clicks: int | None = None,
        text: str | None = None,
        interval: float | None = None,
        key: str | None = None,
        keys: list[str] | None = None,
        delta: int | None = None,
        duration_ms: int | None = None,
        steps: int | None = None,
        title_pattern: str | None = None,
        hwnd: int | None = None,
        operation: Literal[
            "activate", "minimize", "maximize", "restore", "close", "move", "resize"
        ] | None = None,
        app: str | None = None,
        refresh: bool | None = None,
    ) -> dict[str, Any]:
        arguments = {
            key_name: value
            for key_name, value in {
                "action": action, "x": x, "y": y, "to_x": to_x, "to_y": to_y,
                "width": width, "height": height, "button": button, "clicks": clicks,
                "text": text, "interval": interval, "key": key, "keys": keys,
                "delta": delta, "duration_ms": duration_ms, "steps": steps,
                "title_pattern": title_pattern, "hwnd": hwnd, "operation": operation,
                "app": app, "refresh": refresh,
            }.items()
            if value is not None
        }
        result = await runtime.computer_use.run(
            arguments,
            request_context=_mcp_request_meta(ctx),
        )
        return _runtime_tool_result(result, _mcp_request_meta(ctx))

    @mcp.tool(
        name="transport_deliver",
        description=(
            "Stage existing files for the current CardBush transport. Success proves "
            "only that the files exist and were staged; final channel delivery is "
            "reported separately by an authoritative transport receipt."
        ),
        meta={
            "cardbush/action_manifest": {
                "effect_kind": "transport_staging",
                "operation": "transport.stage_delivery",
                "risk": "medium",
                "owner": "cardbush_app",
                "dispatch_phase": "execution",
                "dispatch_scope": "external_service",
                "dispatch_side_effect": "transport_staging",
                "dispatch_mutating": True,
                "dispatch_source": "mcp_tool_metadata",
                "stage_modes": ["execute"],
                "output_kinds": ["artifact", "delivery_receipt"],
                "handoff_exports": ["artifact"],
                "evidence_hints": ["transport_receipt"],
            }
        },
        structured_output=True,
    )
    async def transport_deliver(
        deliverables: list[dict[str, Any]],
        ctx: Context,
        channel: Literal["weixin", "feishu"] | None = None,
        card: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        meta = _mcp_request_meta(ctx)
        roots = _context_roots(meta)
        normalized = _normalize_deliverables(deliverables, roots=roots)
        session_id = str(meta.get("session_id") or "").strip()
        inferred_channel = _infer_channel(session_id, meta)
        selected_channel = str(channel or inferred_channel or "").strip().lower()
        if selected_channel not in {"weixin", "feishu"}:
            raise ValueError("transport_deliver requires a Weixin or Feishu session")
        if inferred_channel and selected_channel != inferred_channel:
            raise ValueError(
                f"transport channel `{selected_channel}` does not match `{inferred_channel}`"
            )
        delivery_id = _delivery_id(
            session_id=session_id,
            turn_id=str(meta.get("turn_id") or ""),
            tool_call_id=str(meta.get("tool_call_id") or ""),
            channel=selected_channel,
            paths=[str(item["path"]) for item in normalized],
        )
        artifacts = [
            {"type": "file", "path": item["path"], "read_only": True}
            for item in normalized
        ]
        result = {
            "protocol": "cardbush_app.transport_staging.v1",
            "outcome": {
                "semantic_success": True,
                "verification_state": "verified",
                "error_code": "",
            },
            "summary": f"Staged {len(normalized)} deliverable(s) for {selected_channel}",
            "channel": selected_channel,
            "delivery_id": delivery_id,
            "state": "staged",
            "send_confirmed": False,
            "deliverables": normalized,
            "card": _normalize_card(card),
            "artifacts": artifacts,
            "receipts": [
                {
                    "protocol": "cardbush.transport.staging_receipt.v1",
                    "delivery_id": delivery_id,
                    "channel": selected_channel,
                    "state": "staged",
                    "send_confirmed": False,
                    "file_count": len(normalized),
                }
            ],
        }
        return _runtime_tool_result(result, meta)


def _register_host_routes(mcp: MCPServer[HostRuntime], runtime: HostRuntime) -> None:
    @mcp.custom_route("/readyz", methods=["GET"])
    async def ready(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ready",
                "protocol": "cardbush_app.host.v1",
                "version": __version__,
                "mcp_path": "/mcp",
            }
        )

    @mcp.custom_route("/host/v1/bots", methods=["GET"])
    async def list_bots(_request: Request) -> JSONResponse:
        return JSONResponse(runtime.bot_supervisor.list_payload())

    @mcp.custom_route("/host/v1/bots/{platform}/config", methods=["GET", "PUT"])
    async def bot_config(request: Request) -> JSONResponse:
        platform = request.path_params["platform"]
        try:
            if request.method == "PUT":
                payload = await _json_body(request)
                runtime.bot_supervisor.config_store.write(platform, payload)
            return JSONResponse(runtime.bot_supervisor.config_store.public_payload(platform))
        except BotManagementError as exc:
            return _bot_error(exc)
        except OSError as exc:
            return JSONResponse(
                {"error": {"code": "bot_config_write_failed", "message": str(exc)}},
                status_code=500,
            )

    @mcp.custom_route("/host/v1/bots/{platform}/status", methods=["GET"])
    async def bot_status(request: Request) -> JSONResponse:
        try:
            return JSONResponse(runtime.bot_supervisor.status(request.path_params["platform"]))
        except BotManagementError as exc:
            return _bot_error(exc)

    @mcp.custom_route("/host/v1/bots/{platform}/service/{action}", methods=["POST"])
    async def bot_service(request: Request) -> JSONResponse:
        action = request.path_params["action"]
        try:
            method = {
                "start": runtime.bot_supervisor.start,
                "stop": runtime.bot_supervisor.stop,
                "restart": runtime.bot_supervisor.restart,
            }.get(action)
            if method is None:
                return JSONResponse(
                    {"error": {"code": "invalid_bot_action", "message": action}},
                    status_code=400,
                )
            return JSONResponse(await method(request.path_params["platform"]))
        except BotManagementError as exc:
            return _bot_error(exc)

    @mcp.custom_route("/host/v1/bots/{platform}/service/logs", methods=["GET"])
    async def bot_logs(request: Request) -> JSONResponse:
        try:
            tail = max(1, min(int(request.query_params.get("tail", "200")), 5000))
            return JSONResponse(
                runtime.bot_supervisor.logs(request.path_params["platform"], tail=tail)
            )
        except (TypeError, ValueError):
            return JSONResponse(
                {"error": {"code": "invalid_tail", "message": "tail must be an integer"}},
                status_code=400,
            )
        except BotManagementError as exc:
            return _bot_error(exc)

    @mcp.custom_route("/host/v1/bots/weixin/login/start", methods=["POST"])
    async def weixin_login_start(_request: Request) -> JSONResponse:
        try:
            return JSONResponse(await runtime.bot_supervisor.start_weixin_login())
        except BotManagementError as exc:
            return _bot_error(exc)

    @mcp.custom_route("/host/v1/bots/weixin/login/{login_id}/status", methods=["GET"])
    async def weixin_login_status(request: Request) -> JSONResponse:
        try:
            return JSONResponse(
                runtime.bot_supervisor.weixin_login_status(request.path_params["login_id"])
            )
        except BotManagementError as exc:
            return _bot_error(exc)

    @mcp.custom_route("/host/v1/bots/weixin/accounts/{account_id}", methods=["DELETE"])
    async def weixin_delete_account(request: Request) -> JSONResponse:
        try:
            return JSONResponse(
                await runtime.bot_supervisor.delete_weixin_account(
                    request.path_params["account_id"]
                )
            )
        except BotManagementError as exc:
            return _bot_error(exc)


async def _json_body(request: Request) -> dict[str, object]:
    try:
        value = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        value = {}
    if not isinstance(value, dict):
        raise BotManagementError("invalid_json", "request body must be an object")
    return dict(value)


def _bot_error(exc: BotManagementError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": exc.code, "message": str(exc)}},
        status_code=exc.status_code,
    )


def _mcp_request_meta(ctx: Context) -> dict[str, Any]:
    raw = ctx.request_context.meta
    if raw is None:
        return {}
    if hasattr(raw, "model_dump"):
        payload = raw.model_dump(exclude_none=True)
    elif isinstance(raw, dict):
        payload = dict(raw)
    else:
        payload = {}
    return dict(payload) if isinstance(payload, dict) else {}


def _runtime_tool_result(
    payload: dict[str, Any],
    meta: dict[str, Any],
) -> dict[str, Any]:
    tool_call_id = str(meta.get("tool_call_id") or "").strip()
    receipt_id = str(meta.get("receipt_id") or "").strip()
    manifest = meta.get("action_manifest")
    if not tool_call_id or not receipt_id or not isinstance(manifest, dict):
        raise ValueError("Runtime Tool Result identities are missing from MCP metadata")
    required_manifest = (
        "manifest_id", "operation", "effect_kind", "owner", "dispatch_scope",
    )
    if any(not str(manifest.get(key) or "").strip() for key in required_manifest):
        raise ValueError("Runtime Action Manifest metadata is incomplete")
    outcome = payload.get("outcome")
    if not isinstance(outcome, dict):
        raise ValueError("MCP tool outcome must be an object")
    success = bool(outcome.get("semantic_success"))
    verification = str(outcome.get("verification_state") or "").strip()
    if verification not in {"verified", "attempted", "unverified", "failed"}:
        raise ValueError("MCP tool verification_state is invalid")
    error_code = str(outcome.get("error_code") or "").strip()
    artifacts: list[dict[str, Any]] = []
    paths: list[str] = []
    for index, item in enumerate(payload.get("artifacts") or []):
        if not isinstance(item, dict):
            raise ValueError("MCP tool artifacts must be objects")
        artifact_path = str(item.get("path") or "").strip()
        artifact_uri = str(item.get("uri") or "").strip()
        if not artifact_path and not artifact_uri:
            raise ValueError("MCP tool artifact requires path or uri")
        if artifact_path:
            paths.append(artifact_path)
        display = str(item.get("display") or "").strip()
        artifact = {
            "artifact_id": f"{receipt_id}_artifact_{index + 1}",
            "type": str(item.get("type") or "file"),
            **({"path": artifact_path} if artifact_path else {}),
            **({"uri": artifact_uri} if artifact_uri else {}),
            **({"media_type": str(item["media_type"])} if item.get("media_type") else {}),
            **({"display": display} if display in {"inline", "attachment", "hidden"} else {}),
            "metadata": {
                "read_only": bool(item.get("read_only", True)),
                "model_input": bool(item.get("model_input", False)),
            },
        }
        artifacts.append(artifact)
    result = {
        "protocol": "bush.tool_result.v1",
        "tool_call_id": tool_call_id,
        "success": success,
        "output": payload,
        "facts": [{
            "protocol": "bush.tool.execution_fact.v1",
            "receipt_id": receipt_id,
            "action_manifest_id": str(manifest["manifest_id"]),
            "status": "succeeded" if success else "failed",
            "operation": str(manifest["operation"]),
            "effect_kind": str(manifest["effect_kind"]),
            "owner": str(manifest["owner"]),
            "dispatch_scope": str(manifest["dispatch_scope"]),
            "categories": ["mcp_tool_result"],
            "paths": paths,
            "execution_success": True,
            "semantic_success": success,
            "verification_state": verification,
            "error_code": error_code,
        }],
        "artifacts": artifacts,
        "workspace_changes": [],
        "guidance": [],
    }
    if not success:
        result["error"] = {
            "code": error_code or "mcp_tool_failed",
            "message": str(payload.get("summary") or "MCP tool failed"),
            "details": {},
        }
    return result


def _context_roots(meta: dict[str, Any]) -> tuple[Path, ...]:
    raw = meta.get("filesystem_roots")
    if not isinstance(raw, list):
        return ()
    roots: list[Path] = []
    for value in raw:
        text = str(value or "").strip()
        if not text or "://" in text:
            continue
        roots.append(Path(text).expanduser().resolve(strict=False))
    return tuple(roots)


def _normalize_deliverables(
    raw_deliverables: object,
    *,
    roots: tuple[Path, ...],
) -> list[dict[str, str]]:
    if not isinstance(raw_deliverables, list) or not raw_deliverables:
        raise ValueError("deliverables must be a non-empty array")
    if len(raw_deliverables) > 6:
        raise ValueError("transport_deliver accepts at most 6 files")
    if not roots:
        raise ValueError("transport_deliver requires at least one MCP filesystem Root")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, raw_item in enumerate(raw_deliverables, start=1):
        if not isinstance(raw_item, dict):
            raise ValueError(f"deliverables[{index}] must be an object")
        raw_path = str(raw_item.get("path") or "").strip()
        if not raw_path:
            raise ValueError(f"deliverables[{index}].path is required")
        resolved = _resolve_root_file(raw_path, roots=roots)
        resolved_text = str(resolved)
        if resolved_text in seen:
            continue
        seen.add(resolved_text)
        item = {"path": resolved_text}
        for key in ("caption", "label"):
            value = str(raw_item.get(key) or "").strip()
            if value:
                item[key] = value
        normalized.append(item)
    if not normalized:
        raise ValueError("transport_deliver did not contain a unique file")
    return normalized


def _resolve_root_file(raw_path: str, *, roots: tuple[Path, ...]) -> Path:
    candidate = Path(raw_path).expanduser()
    candidates = [candidate] if candidate.is_absolute() else [root / candidate for root in roots]
    for value in candidates:
        resolved = value.resolve(strict=False)
        if not any(resolved == root or root in resolved.parents for root in roots):
            continue
        if resolved.is_dir():
            raise ValueError(f"transport_deliver only supports files: {resolved}")
        if resolved.is_file():
            return resolved
    raise ValueError(f"deliverable is outside MCP Roots or is not a file: {raw_path}")


def _infer_channel(session_id: str, meta: dict[str, Any]) -> str:
    direct = str(meta.get("transport_channel") or "").strip().lower()
    if direct in {"weixin", "feishu"}:
        return direct
    lowered = str(session_id or "").strip().lower()
    if lowered.startswith("weixin"):
        return "weixin"
    if lowered.startswith("feishu"):
        return "feishu"
    return ""


def _delivery_id(
    *,
    session_id: str,
    turn_id: str,
    tool_call_id: str,
    channel: str,
    paths: list[str],
) -> str:
    material = "\n".join([session_id, turn_id, tool_call_id, channel, *sorted(paths)])
    return "delivery_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def _normalize_card(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    allowed = {"title", "summary", "body", "footer", "bullets"}
    return {key: item for key, item in value.items() if key in allowed and item not in (None, "", [])}


__all__ = ["HostSettings", "create_app", "run_server"]
