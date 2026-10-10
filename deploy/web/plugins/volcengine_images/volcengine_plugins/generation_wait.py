"""Read-only bounded task waits. Provider polling stays outside model turns."""
from __future__ import annotations

import asyncio
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GenerationTask(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['seedream', 'seedance', 'music', 'enhance', 'subtitle']
    task_id: str = Field(min_length=1, max_length=220, pattern=r'^[A-Za-z0-9_-]+$')


PENDING = {'queued', 'pending', 'running', 'processing', 'in_progress'}
TERMINAL = {'succeeded', 'completed', 'failed', 'cancelled', 'expired', 'unknown', 'interrupted'}
INTERVALS = {'seedream': 1, 'seedance': 30, 'music': 10, 'enhance': 30, 'subtitle': 30}


async def wait_tasks(tasks: list[GenerationTask], query, *, timeout_seconds=60, mode='any',
                     clock=time.monotonic, sleep=asyncio.sleep):
    """Query at most four IDs concurrently; never recreate/download or retry errors."""
    if not 1 <= len(tasks) <= 32 or not 0 <= timeout_seconds <= 120 or mode not in {'any', 'all'}:
        raise ValueError('Use 1..32 tasks, timeout_seconds 0..120 and mode any/all')
    tasks = list({(t.kind, t.task_id): t for t in tasks}.values())
    deadline = clock() + timeout_seconds
    results = [{'kind': t.kind, 'task_id': t.task_id, 'ready': False, 'status': 'unobserved'} for t in tasks]
    next_query = [0.0] * len(tasks)
    semaphore = asyncio.Semaphore(4)

    async def observe(index):
        task = tasks[index]
        async with semaphore:
            try:
                value = await query(task)
                native = value['task']
                status = native.get('status')
                if status not in PENDING | TERMINAL:
                    raise ValueError('Unrecognized task state')
                returned_id = native.get('id', native.get('task_id'))
                if returned_id is not None and returned_id != task.task_id:
                    raise ValueError('Mismatched task ID')
                results[index] = {'kind': task.kind, 'task_id': task.task_id, 'ready': status in TERMINAL,
                                  'status': status, 'observation': value}
                # Respect provider hints; never let callers request a busy poll.
                hint = value.get('suggested_poll_after_seconds')
                interval = max(INTERVALS[task.kind], hint) if type(hint) in (int, float) and 0 < hint < 3600 else INTERVALS[task.kind]
                next_query[index] = clock() + interval
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed read is not a failed generation. Surface it once, do not renew.
                results[index] = {'kind': task.kind, 'task_id': task.task_id, 'ready': True,
                                  'status': 'query_error', 'message': 'Task status could not be verified. Check the task kind, ID and service configuration; query the same ID again when resolved. No generation was submitted or retried.'}

    while True:
        due = [i for i, result in enumerate(results) if not result['ready'] and next_query[i] <= clock()]
        if due:
            async def observe_batch():
                pending = {asyncio.create_task(observe(i)) for i in due}
                try:
                    while pending:
                        _, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                        if timeout_seconds > 0 and mode == 'any' and any(result['ready'] for result in results):
                            break
                finally:
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)

            observations = observe_batch()
            try:
                if timeout_seconds == 0:
                    await observations  # One snapshot, with each HTTP client's normal timeout.
                else:
                    await asyncio.wait_for(observations, max(0.001, deadline - clock()))
            except TimeoutError:
                pass  # Preserve completed siblings and last observations of pending IDs.
        ready = [result['ready'] for result in results]
        satisfied = any(ready) if mode == 'any' else all(ready)
        if satisfied or timeout_seconds == 0 or clock() >= deadline:
            return {'status': 'ready' if satisfied else 'timeout', 'items': results,
                    'all_ready': all(ready), 'paid_request_sent': False,
                    'note': 'ready means a terminal state or query error, not necessarily success. timeout only ends this wait; it does not cancel generation. Wait again only for pending IDs.'}
        await sleep(max(0, min(deadline, min(next_query[i] for i, result in enumerate(results) if not result['ready'])) - clock()))
