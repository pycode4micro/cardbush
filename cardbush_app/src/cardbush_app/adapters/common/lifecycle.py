from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


async def _maybe_await(result: Any) -> None:
    if inspect.isawaitable(result):
        await result


async def startup_resource(resource: Any) -> None:
    if resource is None:
        return
    startup = getattr(resource, "startup", None)
    if callable(startup):
        await _maybe_await(startup())


async def shutdown_resource(resource: Any) -> None:
    if resource is None:
        return
    for name in ("shutdown", "aclose", "close"):
        hook = getattr(resource, name, None)
        if callable(hook):
            await _maybe_await(hook())
            return


@dataclass(slots=True)
class LifecycleHook:
    name: str
    startup: Callable[[], Awaitable[None]]
    shutdown: Callable[[], Awaitable[None]] | None = None


class LifecycleManager:
    """Manage ordered startup/shutdown hooks with rollback on failure."""

    def __init__(self) -> None:
        self._hooks: list[LifecycleHook] = []
        self._started: list[LifecycleHook] = []
        self._is_started = False
        self._is_shutdown = False

    def add(
        self,
        *,
        name: str,
        startup: Callable[[], Awaitable[None]],
        shutdown: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._hooks.append(
            LifecycleHook(
                name=name,
                startup=startup,
                shutdown=shutdown,
            )
        )

    def add_resource(self, *, name: str, resource: Any) -> None:
        async def _startup(resource: Any = resource) -> None:
            await startup_resource(resource)

        async def _shutdown(resource: Any = resource) -> None:
            await shutdown_resource(resource)

        self.add(name=name, startup=_startup, shutdown=_shutdown)

    async def startup(self) -> None:
        if self._is_started:
            return
        self._is_shutdown = False
        started: list[LifecycleHook] = []
        try:
            for hook in self._hooks:
                await hook.startup()
                started.append(hook)
        except Exception:
            await self._shutdown_hooks(reversed(started))
            raise
        self._started = started
        self._is_started = True

    async def shutdown(self) -> None:
        if self._is_shutdown:
            return
        hooks = self._started if self._is_started else self._hooks
        await self._shutdown_hooks(reversed(hooks))
        self._started = []
        self._is_started = False
        self._is_shutdown = True

    async def _shutdown_hooks(self, hooks: Iterable[LifecycleHook]) -> None:
        for lifecycle_hook in hooks:
            if lifecycle_hook.shutdown is None:
                continue
            try:
                await lifecycle_hook.shutdown()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Lifecycle shutdown hook failed: %s (%s)",
                    lifecycle_hook.name,
                    exc,
                )
