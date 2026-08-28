from __future__ import annotations

import argparse
import os
from pathlib import Path

from .server import run_server


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cardbush-app")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="Run the CardBush host MCP service")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, required=True)
    serve.add_argument("--data-dir", default=None)
    serve.add_argument("--bushserver-host", default="127.0.0.1")
    serve.add_argument("--bushserver-port", type=int, default=51717)
    serve.add_argument("--host-token", default=None)
    serve.add_argument("--bushserver-token", default=None)
    serve.add_argument("--log-level", default="warning")
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.command != "serve":
        raise SystemExit(2)
    host_token = str(args.host_token or os.getenv("CARDBUSH_APP_HOST_TOKEN") or "").strip()
    bushserver_token = str(
        args.bushserver_token or os.getenv("BUSH_API_AUTH_TOKEN") or ""
    ).strip()
    run_server(
        host=args.host,
        port=args.port,
        data_dir=Path(args.data_dir).expanduser() if args.data_dir else None,
        bushserver_host=args.bushserver_host,
        bushserver_port=args.bushserver_port,
        bushserver_token=bushserver_token,
        host_token=host_token,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()


__all__ = ["main"]
