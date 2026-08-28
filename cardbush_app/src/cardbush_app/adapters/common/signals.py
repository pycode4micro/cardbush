from __future__ import annotations

import contextlib
import signal
from collections.abc import Iterator


def _raise_keyboard_interrupt(_signum: int, _frame) -> None:
    raise KeyboardInterrupt


def _managed_shutdown_signals() -> tuple[int, ...]:
    managed = [signal.SIGINT, signal.SIGTERM]
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        managed.append(sigbreak)
    return tuple(managed)


@contextlib.contextmanager
def graceful_shutdown_signals() -> Iterator[None]:
    managed_signals = _managed_shutdown_signals()
    previous: dict[int, signal.Handlers] = {}
    try:
        for signum in managed_signals:
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, _raise_keyboard_interrupt)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
