from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from cardbush_app.adapters.common import (
    graceful_shutdown_signals,
    load_bushserver_backend_from_env,
)
from cardbush_app.process_lock import ManagedProcessLock, process_is_running

from .client import WeixinClient
from .config import WeixinBotSettings
from .service import WeixinBotService
from .state import WeixinAccount, WeixinStateStore

_SERVE_LOCK_FILENAME = "weixin-bridge.lock"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cardbush-weixin",
        description="Run the CardBush Weixin adapter",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Run the Weixin long-poll bridge")
    serve.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    serve.add_argument("--data-dir", default=None, help="App data root directory")
    serve.add_argument("--backend-url", default=None, help="BushServer HTTP base URL")
    serve.add_argument("--project-dir", default=None, help="Absolute project directory for forwarded sessions")
    serve.add_argument(
        "--parent-pid",
        type=int,
        default=None,
        help="Exit when the managing CardBush host process is no longer running",
    )

    login = subparsers.add_parser("login", help="Scan QR code and save Weixin credentials")
    login.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    login.add_argument("--data-dir", default=None, help="App data root directory")
    login.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="QR login timeout in seconds",
    )

    status = subparsers.add_parser("status", help="Show stored Weixin account state")
    status.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    status.add_argument("--data-dir", default=None, help="App data root directory")

    clear = subparsers.add_parser("clear", help="Remove stored Weixin account state")
    clear.add_argument("--env-file", default=".env", help="Path to env file, default: .env")
    clear.add_argument("--data-dir", default=None, help="App data root directory")
    clear.add_argument("--account-id", default=None, help="Only clear one account")

    return parser


def _resolve_settings(args: argparse.Namespace) -> WeixinBotSettings:
    settings = WeixinBotSettings.from_env(getattr(args, "env_file", ".env"))
    data_dir = str(getattr(args, "data_dir", "") or "").strip()
    if data_dir:
        settings = replace(
            settings,
            data_dir=Path(data_dir).expanduser().resolve(strict=False),
        )
    return settings


def build_serve_instance_lock(
    settings: WeixinBotSettings,
    *,
    parent_pid: int | None = None,
) -> ManagedProcessLock:
    return ManagedProcessLock(
        settings.state_dir / _SERVE_LOCK_FILENAME,
        parent_pid=parent_pid,
    )


async def _wait_for_parent_exit(parent_pid: int) -> None:
    while process_is_running(parent_pid):
        await asyncio.sleep(0.5)


async def _run_login(settings: WeixinBotSettings, timeout_seconds: float | None) -> int:
    client = WeixinClient(settings)
    store = WeixinStateStore(settings.state_dir)
    try:
        qr = await client.start_qr_login()
        print("使用微信扫描以下链接完成连接：")
        print()
        print(qr.qrcode_url)
        print()
        print("等待连接结果...")
        current_base_url = settings.login_base_url
        deadline = asyncio.get_running_loop().time() + max(
            5.0,
            float(timeout_seconds or settings.login_timeout_seconds),
        )
        while asyncio.get_running_loop().time() < deadline:
            status = await client.get_qr_status(
                qrcode=qr.qrcode,
                base_url=current_base_url,
            )
            if status.status == "scaned_but_redirect" and status.redirect_host:
                current_base_url = f"https://{status.redirect_host}"
                continue
            if status.status == "confirmed":
                account_id = str(status.account_id or "").strip()
                bot_token = str(status.bot_token or "").strip()
                base_url = str(status.base_url or settings.base_url).strip() or settings.base_url
                if not account_id or not bot_token:
                    print("登录成功，但返回字段不完整。", flush=True)
                    return 2
                store.remove_accounts_for_user(
                    status.user_id,
                    except_account_id=account_id,
                )
                store.clear_runtime_state(account_id)
                store.save_account(
                    WeixinAccount(
                        account_id=account_id,
                        token=bot_token,
                        base_url=base_url,
                        user_id=str(status.user_id or "").strip() or None,
                        saved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    )
                )
                print("与微信连接成功。")
                print(f"account_id: {account_id}")
                if status.user_id:
                    print(f"user_id: {status.user_id}")
                print(f"base_url: {base_url}")
                return 0
            if status.status == "expired":
                print("二维码已过期，请重新运行 login。", flush=True)
                return 2
            await asyncio.sleep(1.0)
        print("登录超时，请重试。", flush=True)
        return 2
    finally:
        await client.aclose()


async def _run_serve(
    settings: WeixinBotSettings,
    *,
    backend_url: str | None,
    project_dir: str | None,
    parent_pid: int | None = None,
) -> int:
    normalized_parent_pid = int(parent_pid or 0)
    instance_lock = (
        build_serve_instance_lock(
            settings,
            parent_pid=normalized_parent_pid,
        )
        if normalized_parent_pid
        else build_serve_instance_lock(settings)
    )
    try:
        instance_lock.acquire()
    except RuntimeError as exc:
        print(f"[Weixin Bot] {exc}", file=sys.stderr, flush=True)
        return 2

    if backend_url:
        os.environ["CARDBUSH_BOT_STREAM_BASE_URL"] = backend_url
    if project_dir:
        os.environ["CARDBUSH_BOT_STREAM_PROJECT_DIR"] = str(
            Path(project_dir).expanduser().resolve(strict=False)
        )
        os.environ.setdefault("CARDBUSH_BOT_STREAM_WORKSPACE_MODE", "project")
    backend = load_bushserver_backend_from_env()
    service = WeixinBotService(settings=settings, backend=backend)
    service_task: asyncio.Task[None] | None = None
    parent_task: asyncio.Task[None] | None = None
    try:
        if normalized_parent_pid and not process_is_running(normalized_parent_pid):
            print(
                f"[Weixin Bot] managing CardBush host process is not running "
                f"(parent_pid={normalized_parent_pid}); stopping",
                flush=True,
            )
            return 0
        service_task = asyncio.create_task(
            service.run(),
            name="weixin-bot-service",
        )
        if not normalized_parent_pid:
            await service_task
            return 0
        parent_task = asyncio.create_task(
            _wait_for_parent_exit(normalized_parent_pid),
            name="weixin-bot-parent-watchdog",
        )
        done, _pending = await asyncio.wait(
            {service_task, parent_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if service_task in done:
            await service_task
            return 0
        print(
            f"[Weixin Bot] managing CardBush host exited "
            f"(parent_pid={normalized_parent_pid}); shutting down",
            flush=True,
        )
        service_task.cancel()
        await asyncio.gather(service_task, return_exceptions=True)
        await service.shutdown()
        return 0
    finally:
        if parent_task is not None and not parent_task.done():
            parent_task.cancel()
            await asyncio.gather(parent_task, return_exceptions=True)
        if service_task is not None and not service_task.done():
            service_task.cancel()
            await asyncio.gather(service_task, return_exceptions=True)
        instance_lock.release()


def _run_status(settings: WeixinBotSettings) -> int:
    store = WeixinStateStore(settings.state_dir)
    accounts = store.list_accounts()
    print(f"state_dir: {settings.state_dir}")
    if not accounts:
        print("accounts: none")
        return 0
    for account in accounts:
        print(
            "\t".join(
                [
                    account.account_id,
                    account.base_url,
                    account.user_id or "",
                    account.saved_at or "",
                ]
            )
        )
    return 0


def _run_clear(settings: WeixinBotSettings, account_id: str | None) -> int:
    store = WeixinStateStore(settings.state_dir)
    normalized_account_id = str(account_id or "").strip()
    if normalized_account_id:
        store.remove_account(normalized_account_id)
        print(f"cleared\t{normalized_account_id}")
        return 0
    store.clear_all()
    print("cleared\tall")
    return 0


def main() -> None:
    try:
        args = _build_parser().parse_args()
        settings = _resolve_settings(args)

        if args.command == "login":
            raise SystemExit(
                asyncio.run(
                    _run_login(
                        settings,
                        getattr(args, "timeout_seconds", None),
                    )
                )
            )

        if args.command == "status":
            raise SystemExit(_run_status(settings))

        if args.command == "clear":
            raise SystemExit(_run_clear(settings, getattr(args, "account_id", None)))

        with graceful_shutdown_signals():
            raise SystemExit(
                asyncio.run(
                    _run_serve(
                        settings,
                        backend_url=getattr(args, "backend_url", None),
                        project_dir=getattr(args, "project_dir", None),
                        parent_pid=getattr(args, "parent_pid", None),
                    )
                )
            )
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
