from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import replace

import uvicorn

from cardbush_app.adapters.common import (
    graceful_shutdown_signals,
    load_bushserver_backend_from_env,
)

from .config import DiscordBotSettings


def _load_adapter_runtime():
    try:
        from .app import create_app
        from .client import DiscordCommandClient, DiscordMessageClient
        from .gateway import DiscordGatewayRunner
    except ModuleNotFoundError as exc:
        if str(exc.name or "").split(".", 1)[0] != "aiohttp":
            raise
        raise SystemExit(
            "Discord support is not installed. Reinstall the cardbush_app host package."
        ) from None
    return create_app, DiscordCommandClient, DiscordMessageClient, DiscordGatewayRunner


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cardbush-discord", description="Run the CardBush Discord bot adapter")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Run the Discord bot adapter")
    serve.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    serve.add_argument("--host", default=None, help="Bind host for webhook mode")
    serve.add_argument("--port", type=int, default=None, help="Bind port for webhook mode")
    serve.add_argument("--mode", choices=["long", "webhook"], default=None, help="Transport mode override")

    sync = subparsers.add_parser("sync-commands", help="Register the Discord slash command")
    sync.add_argument("--env-file", default=".env", help="Path to env file, default: .env")

    return parser


async def _run_sync(env_file: str) -> int:
    _, command_client_type, _, _ = _load_adapter_runtime()
    settings = DiscordBotSettings.from_env(env_file)
    client = command_client_type(settings)
    try:
        commands = await client.sync_chat_command()
    finally:
        await client.aclose()
    print(json.dumps(commands, ensure_ascii=False, indent=2))
    return 0


async def _run_gateway(settings: DiscordBotSettings) -> int:
    _, _, message_client_type, gateway_runner_type = _load_adapter_runtime()
    runner = gateway_runner_type(
        settings=settings,
        backend=load_bushserver_backend_from_env(),
        sender=message_client_type(settings),
    )
    await runner.run()
    return 0


def main() -> None:
    try:
        args = _build_parser().parse_args()
        if args.command == "sync-commands":
            raise SystemExit(asyncio.run(_run_sync(args.env_file)))

        settings = DiscordBotSettings.from_env(args.env_file)
        if args.mode:
            settings = replace(settings, mode=args.mode)
        if settings.mode == "webhook":
            create_app, _, _, _ = _load_adapter_runtime()
            host = args.host or settings.host
            port = args.port or settings.port
            uvicorn.run(create_app(settings), host=host, port=port)
            return
        with graceful_shutdown_signals():
            raise SystemExit(asyncio.run(_run_gateway(settings)))
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
