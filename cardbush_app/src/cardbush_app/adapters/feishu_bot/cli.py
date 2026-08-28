from __future__ import annotations

import argparse
import logging
from dataclasses import replace

import uvicorn

from cardbush_app.adapters.common import graceful_shutdown_signals

from .config import FeishuBotSettings


def _load_adapter_runtime():
    try:
        from .app import build_service, create_app
        from .long_connection import FeishuLongConnectionRunner
    except ModuleNotFoundError as exc:
        if str(exc.name or "").split(".", 1)[0] != "lark_oapi":
            raise
        raise SystemExit(
            "Feishu support is not installed. Reinstall the cardbush_app host package."
        ) from None
    return build_service, create_app, FeishuLongConnectionRunner


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cardbush-feishu", description="Run the CardBush Feishu bot adapter")
    parser.add_argument("serve", nargs="?", default="serve")
    parser.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    parser.add_argument("--host", default=None, help="Bind host for webhook mode")
    parser.add_argument("--port", type=int, default=None, help="Bind port for webhook mode")
    parser.add_argument("--mode", choices=["long", "webhook"], default=None, help="Transport mode override")
    return parser


def main() -> None:
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("cardbush_app.adapters.common.backend").setLevel(logging.INFO)
    logging.getLogger("cardbush_app.adapters.feishu_bot.client").setLevel(logging.INFO)
    logging.getLogger("cardbush_app.adapters.feishu_bot.app").setLevel(logging.INFO)
    args = _build_parser().parse_args()
    settings = FeishuBotSettings.from_env(args.env_file)
    if args.mode:
        settings = replace(settings, mode=args.mode)
    build_service, create_app, runner_type = _load_adapter_runtime()
    if settings.mode == "webhook":
        host = args.host or settings.host
        port = args.port or settings.port
        uvicorn.run(create_app(settings), host=host, port=port)
        return
    runner = runner_type(settings=settings, service=build_service(settings))
    with graceful_shutdown_signals():
        runner.run()


if __name__ == "__main__":
    main()
