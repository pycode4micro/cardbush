from __future__ import annotations

import asyncio
import contextlib
import threading
from typing import Any, Coroutine


class AsyncBridge:
    def __init__(self) -> None:
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_ready = threading.Event()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="other-guis-async-bridge",
            daemon=True,
        )
        self._thread.start()
        self._loop_ready.wait()

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._loop_ready.set()
        try:
            loop.run_forever()
        finally:
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                with contextlib.suppress(Exception):  # noqa: BLE001
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            with contextlib.suppress(Exception):  # noqa: BLE001
                loop.run_until_complete(loop.shutdown_asyncgens())
            with contextlib.suppress(Exception):  # noqa: BLE001
                loop.run_until_complete(loop.shutdown_default_executor())
            loop.close()

    def run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        if self._closed:
            coro.close()
            raise RuntimeError("AsyncBridge is closed")
        loop = self._loop
        if loop is None or loop.is_closed():
            coro.close()
            raise RuntimeError("AsyncBridge event loop is unavailable")
        try:
            future = asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            coro.close()
            raise
        return future.result()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        loop = self._loop
        if loop is not None and not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(loop.stop)
        if self._thread.is_alive():
            self._thread.join(timeout=5.0)
        self._loop = None
