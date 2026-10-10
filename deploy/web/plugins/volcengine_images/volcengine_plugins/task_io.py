"""Safe task diagnostics and exact signed-URL downloads, without generation retries."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .client import SeedreamError


class TaskError(SeedreamError):
    def __init__(self, message, *, stage, sent=False, request_id=None):
        self.details = {'error': message, 'stage': stage, 'paid_request_sent': sent,
            'billing': {'charged': None if sent else False, 'refunded': None,
                        'status': 'unknown; verify provider billing/task history' if sent else 'no_paid_request_sent'},
            'automatic_retry': False, 'request_id': request_id}
        super().__init__(json.dumps(self.details, ensure_ascii=False))


def observation(task):
    created = task.get('created_at')
    age = max(0, time.time()-created) if isinstance(created, (int, float)) else None
    return {'observed_at': time.time(), 'elapsed_seconds': round(age, 1) if age is not None else None,
        'provider_progress': task.get('progress'), 'provider_eta_seconds': task.get('estimated_remaining_seconds'),
        'progress_note': 'Progress/ETA are null when not supplied by the provider; elapsed time does not predict completion.',
        'suggested_poll_after_seconds': 30 if task.get('status') in {'queued', 'running'} else None,
        'billing': {'charged': None, 'refunded': None, 'status': 'not reported by task API', 'usage': task.get('usage')}}


def safe_task(task):
    result = dict(task)
    for key in ('error', 'failure_reason'):
        if result.get(key):
            from .video_client import safe_tag
            raw = result[key]
            result[key] = {'code': safe_tag(raw.get('code') if isinstance(raw, dict) else None),
                           'message': 'Provider failure; consult task history. Raw text omitted to protect signed URLs.'}
    return result


async def download(url, dest, *, transport=None, max_bytes=2*1024**3, retries=2):
    """Fetch the exact URL into an explicitly named new file. No API authorization header."""
    target = Path(dest).expanduser()
    if not target.is_absolute() or target.exists():
        raise ValueError('dest must be an absolute path to a new file (no overwrite)')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise SeedreamError('Download requires a provider HTTPS output URL without embedded credentials')
    if not 1 <= max_bytes <= 8*1024**3 or not 0 <= retries <= 3:
        raise ValueError('max_bytes must be 1..8 GiB; retries must be 0..3')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name('.' + target.name + '.' + uuid.uuid4().hex + '.part')
    last_status = None
    try:
        for attempt in range(retries+1):
            digest, size = hashlib.sha256(), 0
            try:
                # Passing url directly preserves percent escapes, query order and signatures.
                async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(60, connect=20),
                        follow_redirects=False) as client:
                    current = url
                    for redirects in range(6):
                        async with client.stream('GET', current) as response:
                            last_status = response.status_code
                            if response.is_redirect:
                                location = response.headers.get('location')
                                if not location or redirects == 5:
                                    raise SeedreamError('Download redirect limit/invalid location; no output published')
                                next_url = str(response.url.join(location))
                                p = urlsplit(next_url)
                                if p.scheme != 'https' or not p.hostname or p.username or p.password or p.fragment:
                                    raise SeedreamError('Unsafe download redirect; no output published')
                                current = next_url
                                continue
                            if response.status_code in {401, 403, 404, 410}:
                                raise SeedreamError(f'Download HTTP {response.status_code}; URL may be expired or unavailable. Query the same task; never create a replacement automatically.')
                            response.raise_for_status()
                            declared = response.headers.get('content-length')
                            if declared and int(declared) > max_bytes:
                                raise SeedreamError('Download exceeds max_bytes')
                            content_type = response.headers.get('content-type', '').split(';')[0].lower()
                            if content_type in {'text/html', 'application/json', 'text/xml', 'application/xml'}:
                                raise SeedreamError('Provider returned an error document instead of media')
                            with temporary.open('wb') as stream:
                                async for block in response.aiter_bytes():
                                    size += len(block)
                                    if size > max_bytes:
                                        raise SeedreamError('Download exceeds max_bytes')
                                    stream.write(block)
                                    digest.update(block)
                            if not size or (declared and not response.headers.get('content-encoding') and size != int(declared)):
                                raise httpx.ReadError('Incomplete download')
                            break
                    os.link(temporary, target)  # Fails if another writer created dest.
                    return {'path': str(target), 'bytes': size, 'sha256': digest.hexdigest(),
                        'content_type': content_type, 'download_attempts': attempt+1, 'paid_request_sent': False,
                        'note': 'Bytes saved unchanged; local decode/quality inspection is a separate step. Signed URL omitted.'}
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                retryable = not isinstance(exc, httpx.HTTPStatusError) or exc.response.status_code in {408, 429, 500, 502, 503, 504}
                if not retryable or attempt == retries:
                    raise SeedreamError(f'Download failed (HTTP {last_status or "unavailable"}); partial output not published. No generation request sent.') from None
                await asyncio.sleep(min(2**attempt, 4))
    finally:
        temporary.unlink(missing_ok=True)
