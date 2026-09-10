import { setTimeout as delay } from 'node:timers/promises';

const cacheLifetime = 30 * 60_000;
const cacheBudget = 64 * 1024 * 1024;
type Cooldown = { until: number; status: number; attempts: number };

export class MarketplaceRateLimitError extends Error {
  constructor(host: string, readonly retryAt: number, status: number) {
    // Electron preserves Error.message across invoke(), but drops custom properties.
    super(`${host}: Marketplace requests are temporarily rate limited (HTTP ${status}). [market-rate-limit:${retryAt}]`);
  }
}

/** One download coordinator per marketplace service; only immutable content is cached. */
export class PluginMarketDownloads {
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly cache = new Map<string, { bytes: Buffer; expiresAt: number }>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly fetch: typeof globalThis.fetch, private readonly now = Date.now) {}

  bytes(url: string, limit: number, timeout = 15_000, immutable = false): Promise<Buffer> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) {
      if (cached.bytes.length > limit) return Promise.reject(new Error('Marketplace download exceeds the size limit.'));
      this.cache.delete(url); this.cache.set(url, cached);
      return Promise.resolve(cached.bytes);
    }
    this.cache.delete(url);
    const key = JSON.stringify([url, limit, timeout, immutable]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.request(url, limit, timeout).then(bytes => {
      if (immutable) this.remember(url, bytes);
      return bytes;
    });
    this.pending.set(key, pending);
    void pending.then(() => this.pending.delete(key), () => this.pending.delete(key));
    return pending;
  }

  invalidate(url: string) { this.cache.delete(url); }

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

  private checkCooldown(host: string) {
    const cooldown = this.cooldowns.get(host);
    if (cooldown && cooldown.until > this.now()) throw new MarketplaceRateLimitError(host, cooldown.until, cooldown.status);
  }

  private async request(url: string, limit: number, timeout: number): Promise<Buffer> {
    const host = new URL(url).hostname;
    this.checkCooldown(host);
    if (this.active >= 3) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        this.checkCooldown(host);
        try { return await this.download(url, limit, timeout); }
        catch (error) {
          if (error instanceof MarketplaceRateLimitError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
          const text = error instanceof Error ? error.message : String(error);
          if (attempt === 0 && /ERR_CONNECTION_RESET|ECONNRESET|ERR_NETWORK_CHANGED|HTTP 50[234]/.test(text)) {
            await delay(250); continue;
          }
          throw new Error(`${host}: ${text}`);
        }
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }

  private async download(url: string, limit: number, timeout: number): Promise<Buffer> {
    const host = new URL(url).hostname, startedAt = this.now();
    const response = await this.fetch(url, { signal: AbortSignal.timeout(timeout),
      headers: { Accept: host === 'codeload.github.com' ? 'application/zip' : 'application/vnd.github+json', 'User-Agent': 'CardBush-Plugin-Marketplace' } });
    if (!response.ok) {
      let error: Error;
      if (response.status === 429 || (response.status === 403 &&
          (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
        const now = this.now(), prior = this.cooldowns.get(host);
        const attempts = prior && prior.until > now ? prior.attempts : Math.min((prior?.attempts ?? 0) + 1, 5);
        const until = Math.max(prior?.until ?? 0, retryAfter(response.headers, now) ?? now + Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000));
        this.cooldowns.set(host, { until, status: response.status, attempts });
        error = new MarketplaceRateLimitError(host, until, response.status);
      } else if (response.status === 404) {
        error = Object.assign(new Error('Source not found or not publicly accessible.'), { code: 'ENOENT' });
      } else error = new Error(`Marketplace download failed (HTTP ${response.status}).`);
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    // An older in-flight success must not clear a cooldown established by another request.
    if ((this.cooldowns.get(host)?.until ?? Infinity) <= startedAt) this.cooldowns.delete(host);
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
  return Math.ceil(now + Math.max(1000, duration));
}
