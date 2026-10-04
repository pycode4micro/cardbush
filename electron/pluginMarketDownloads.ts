import { setTimeout as delay } from 'node:timers/promises';
import { open, rm } from 'node:fs/promises';
import { requireDiskSpace } from './pluginStorage';

const cacheLifetime = 30 * 60_000;
const cacheBudget = 64 * 1024 * 1024;
type Cooldown = { until: number; status: number };
export type MarketplaceDownloadRoute = { key: string; fetch: typeof globalThis.fetch };
export type MarketplaceDownloadProgress = { downloadedBytes: number; totalBytes?: number };

export class MarketplaceRateLimitError extends Error {
  constructor(host: string, readonly retryAt: number | undefined, status: number) {
    // Electron preserves Error.message across invoke(), but drops custom properties.
    super(`${host}: Marketplace requests are temporarily rate limited (HTTP ${status}). [market-rate-limit:${retryAt ?? 'unknown'}]`);
  }
}

/** One download coordinator per marketplace service; only immutable content is cached. */
export class PluginMarketDownloads {
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly cache = new Map<string, { bytes: Buffer; expiresAt: number }>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly waiting: Array<{ start: () => void }> = [];
  private active = 0;
  constructor(private readonly fetch: typeof globalThis.fetch, private readonly now = Date.now,
    private readonly resolveRoute?: (url: string) => Promise<MarketplaceDownloadRoute>) {}

  bytes(url: string, limit: number, timeout = 15_000, immutable = false): Promise<Buffer> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) {
      if (cached.bytes.length > limit) return Promise.reject(new Error('Marketplace download exceeds the size limit.'));
      this.cache.delete(url); this.cache.set(url, cached);
      return Promise.resolve(cached.bytes);
    }
    this.cache.delete(url);
    const signal = AbortSignal.timeout(timeout);
    return this.resolveRoute
      ? beforeAbort(this.resolveRoute(url), signal).then(route => this.onRoute(route, url, limit, timeout, immutable, signal))
      : this.onRoute({ key: '', fetch: this.fetch }, url, limit, timeout, immutable, signal);
  }

  private onRoute(route: MarketplaceDownloadRoute, url: string, limit: number, timeout: number, immutable: boolean, signal: AbortSignal) {
    const key = JSON.stringify([route.key, url, limit, timeout, immutable]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.request(route, url, signal, response => this.readBytes(response, limit)).then(bytes => {
      if (immutable) this.remember(url, bytes);
      return bytes;
    });
    this.pending.set(key, pending);
    void pending.then(() => this.pending.delete(key), () => this.pending.delete(key));
    return pending;
  }

  invalidate(url: string) { this.cache.delete(url); }

  /** Large packages stay on disk. Only the small metadata path uses the memory cache. */
  async file(url: string, destination: string, options: { signal?: AbortSignal; timeoutMs?: number;
    onProgress?: (progress: MarketplaceDownloadProgress) => void } = {}): Promise<void> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const route = this.resolveRoute ? await beforeAbort(this.resolveRoute(url), signal) : { key: '', fetch: this.fetch };
    await this.request(route, url, signal, async response => {
      if (!response.body) throw new Error('Empty marketplace response.');
      const declared = Number(response.headers.get('content-length'));
      const totalBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : undefined;
      await requireDiskSpace(destination, totalBytes ?? 0);
      const output = await open(destination, 'wx');
      const reader = response.body.getReader();
      let downloadedBytes = 0, checkedAt = 0, complete = false;
      try {
        options.onProgress?.({ downloadedBytes, totalBytes });
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await beforeAbort(reader.read(), signal);
          if (done) break;
          if (downloadedBytes === 0 || downloadedBytes - checkedAt >= 8 * 1024 * 1024) {
            await requireDiskSpace(destination, Math.max(value.length, (totalBytes ?? 0) - downloadedBytes));
            checkedAt = downloadedBytes;
          }
          await output.writeFile(value);
          downloadedBytes += value.length;
          options.onProgress?.({ downloadedBytes, totalBytes });
        }
        signal.throwIfAborted();
        complete = true;
      } finally {
        await reader.cancel().catch(() => undefined);
        await output.close();
        if (!complete) await rm(destination, { force: true });
      }
    });
  }

  private remember(url: string, bytes: Buffer) {
    const now = this.now();
    for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key);
    this.cache.delete(url);
    this.cache.set(url, { bytes, expiresAt: now + cacheLifetime });
    let size = [...this.cache.values()].reduce((sum, value) => sum + value.bytes.length, 0);
    for (const [key, value] of this.cache) {
      if (size <= cacheBudget && this.cache.size <= 256) break;
      this.cache.delete(key); size -= value.bytes.length;
    }
  }

  private checkCooldown(key: string, host: string) {
    const cooldown = this.cooldowns.get(key);
    if (cooldown && cooldown.until > this.now()) throw new MarketplaceRateLimitError(host, cooldown.until, cooldown.status);
    this.cooldowns.delete(key);
  }

  private async request<T>(route: MarketplaceDownloadRoute, url: string, signal: AbortSignal, consume: (response: Response) => Promise<T>): Promise<T> {
    const host = new URL(url).hostname;
    const key = JSON.stringify([route.key, host]);
    this.checkCooldown(key, host);
    await this.acquire(signal);
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        this.checkCooldown(key, host);
        try {
          const response = await this.response(route.fetch, key, url, signal);
          try { return await consume(response); }
          finally { await response.body?.cancel().catch(() => undefined); }
        }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof MarketplaceRateLimitError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
          const text = error instanceof Error ? error.message : String(error);
          if (attempt === 0 && /ERR_CONNECTION_RESET|ECONNRESET|ERR_NETWORK_CHANGED|HTTP 50[234]/.test(text)) {
            await delay(250, undefined, { signal }).catch(error => { throw signal.aborted ? signal.reason : error; }); continue;
          }
          throw new Error(`${host}: ${text}`);
        }
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next.start(); else this.active--;
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < 3) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { start: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(entry);
    });
  }

  private async response(fetch: typeof globalThis.fetch, key: string, url: string, signal: AbortSignal): Promise<Response> {
    const host = new URL(url).hostname, startedAt = this.now();
    const response = await fetch(url, { signal,
      headers: { Accept: host === 'codeload.github.com' ? 'application/zip' : 'application/vnd.github+json', 'User-Agent': 'CardBush-Plugin-Marketplace' } });
    if (!response.ok) {
      let error: Error;
      if (response.status === 429 || (response.status === 403 &&
          (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
        const now = this.now(), until = retryAfter(response.headers, now);
        // Only the server can set a retry deadline. Missing headers end this
        // attempt without an automatic retry or a fabricated growing penalty.
        if (until !== undefined && until > now) this.cooldowns.set(key, { until, status: response.status });
        error = new MarketplaceRateLimitError(host, until, response.status);
      } else if (response.status === 404) {
        error = Object.assign(new Error('Source not found or not publicly accessible.'), { code: 'ENOENT' });
      } else error = new Error(`Marketplace download failed (HTTP ${response.status}).`);
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    // An older in-flight success must not clear a cooldown established by another request.
    if ((this.cooldowns.get(key)?.until ?? Infinity) <= startedAt) this.cooldowns.delete(key);
    return response;
  }

  private async readBytes(response: Response, limit: number): Promise<Buffer> {
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Marketplace download exceeds the size limit.');
    }
    if (!response.body) throw new Error('Empty marketplace response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) throw new Error('Marketplace download exceeds the size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
  }
}

function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after')?.trim();
  const serverTime = Date.parse(headers.get('date') ?? '');
  const reference = Number.isFinite(serverTime) ? serverTime : now;
  let duration: number | undefined;
  if (value && /^\d+$/.test(value)) duration = Number(value) * 1000;
  else if (value && /^[A-Za-z]{3,9}[, ]/.test(value) && Number.isFinite(Date.parse(value))) duration = Date.parse(value) - reference;
  if (duration === undefined && headers.get('x-ratelimit-remaining') === '0') {
    const reset = headers.get('x-ratelimit-reset');
    if (reset && /^\d+$/.test(reset)) duration = Number(reset) * 1000 - reference;
  }
  if (duration === undefined || !Number.isFinite(duration) || now + duration > 8.64e15) return undefined;
  return Math.ceil(now + Math.max(0, duration));
}
