import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginMarketDownloads, MarketplaceRateLimitError } from '../dist-electron/pluginMarketDownloads.js';

const archive = sha => `https://codeload.github.com/fixture/plugins/zip/${sha.repeat(40)}`;
const epoch = Date.UTC(2026, 8, 9);
const rateLimit = (until, status = 429) => error => {
  assert.ok(error instanceof MarketplaceRateLimitError);
  assert.equal(error.retryAt, until);
  assert.match(error.message, new RegExp(`HTTP ${status}`));
  assert.match(error.message, new RegExp(`\\[market-rate-limit:${until ?? 'unknown'}\\]`));
  return true;
};

test('immutable downloads share in-flight work and cached bytes, with revision and expiry boundaries', async () => {
  let now = epoch, reads = 0;
  const client = new PluginMarketDownloads(async () => { reads++; await delay(5); return new Response('zip'); }, () => now);
  const results = await Promise.all(Array.from({ length: 8 }, () => client.bytes(archive('a'), 100, 1000, true)));
  assert.equal(reads, 1); assert.ok(results.every(bytes => bytes.toString() === 'zip'));
  await client.bytes(archive('a'), 100, 1000, true); assert.equal(reads, 1);
  await assert.rejects(client.bytes(archive('a'), 2), /size limit/);
  await client.bytes(archive('b'), 100, 1000, true); assert.equal(reads, 2);
  now += 30 * 60_000;
  await client.bytes(archive('a'), 100, 1000, true); assert.equal(reads, 3);
  client.invalidate(archive('a'));
  await client.bytes(archive('a'), 100, 1000, true); assert.equal(reads, 4);
  await client.bytes('https://api.github.com/repos/fixture/plugins/commits/main', 100);
  await client.bytes('https://api.github.com/repos/fixture/plugins/commits/main', 100);
  assert.equal(reads, 6, 'mutable branch lookups are never cached');
});

test('429 cancels the response and pauses its host, while cached content and other hosts stay usable', async () => {
  let now = epoch, reads = 0, cancelled = false, limited = false;
  const client = new PluginMarketDownloads(async input => {
    reads++;
    if (limited && String(input).includes('codeload')) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429, headers: { 'Retry-After': '120' } });
    return new Response('ok');
  }, () => now);
  await client.bytes(archive('a'), 100, 1000, true);
  limited = true;
  await assert.rejects(client.bytes(archive('b'), 100), rateLimit(epoch + 120_000));
  assert.equal(cancelled, true); assert.equal(reads, 2, '429 is not retried immediately');
  await assert.rejects(client.bytes(archive('c'), 100), rateLimit(epoch + 120_000));
  await client.bytes(archive('a'), 100, 1000, true); assert.equal(reads, 2);
  await client.bytes('https://raw.githubusercontent.com/fixture/file', 100); assert.equal(reads, 3);
  now += 119_999;
  await assert.rejects(client.bytes(archive('b'), 100), rateLimit(epoch + 120_000));
  now++; limited = false;
  await client.bytes(archive('b'), 100); assert.equal(reads, 4, 'explicit retry works at the deadline');
});

test('server dates, long Retry-After values, API reset headers and plain 403 are handled separately', async () => {
  const cases = [
    [{ 'retry-after': '3600' }, 429, epoch + 3_600_000],
    [{ date: new Date(epoch + 30_000).toUTCString(), 'retry-after': new Date(epoch + 150_000).toUTCString() }, 429, epoch + 120_000],
    [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(epoch / 1000 + 300) }, 403, epoch + 300_000],
    [{ 'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(epoch / 1000 + 300) }, 403, epoch + 60_000],
    [{ 'retry-after': 'invalid' }, 429, undefined],
    [{ 'retry-after': '-1' }, 429, undefined],
    [{ 'retry-after': '0' }, 429, epoch],
  ];
  for (const [headers, status, until] of cases) {
    const client = new PluginMarketDownloads(async () => new Response('', { status, headers }), () => epoch);
    await assert.rejects(client.bytes(archive('a'), 100), rateLimit(until, status));
  }
  let reads = 0;
  const forbidden = new PluginMarketDownloads(async () => { reads++; return new Response('', { status: 403 }); }, () => epoch);
  await assert.rejects(forbidden.bytes(archive('a'), 100), /HTTP 403/);
  await assert.rejects(forbidden.bytes(archive('a'), 100), /HTTP 403/);
  assert.equal(reads, 2, 'permission failures do not invent a rate limit');
});

test('missing server deadlines never invent or accumulate a client penalty or trigger automatic retries', async () => {
  let reads = 0;
  const client = new PluginMarketDownloads(async () => { reads++; return new Response('', { status: 429 }); }, () => epoch);
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(client.bytes(archive('a'), 100), rateLimit(undefined));
    assert.equal(reads, attempt + 1);
  }
});

test('repeated server deadlines use the latest response without increasing the delay', async () => {
  let now = epoch;
  const client = new PluginMarketDownloads(async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }), () => now);
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(client.bytes(archive('a'), 100), rateLimit(now + 2000));
    now += 2000;
  }
});

test('changing the network exit does not reuse a previous route cooldown or pending request', async () => {
  let route = 'old'; const reads = [], release = Promise.withResolvers();
  const client = new PluginMarketDownloads(() => assert.fail('route-bound fetch expected'), () => epoch, async () => {
    const key = route;
    return { key, fetch: async () => {
      reads.push(key);
      if (key === 'old') { await release.promise; return new Response('', { status: 403, headers: { 'retry-after': '3600' } }); }
      return new Response('new exit');
    } };
  });
  const old = assert.rejects(client.bytes(archive('a'), 100), rateLimit(epoch + 3_600_000, 403));
  await delay(0); route = 'new';
  assert.equal((await client.bytes(archive('a'), 100)).toString(), 'new exit');
  release.resolve(); await old;
  assert.equal((await client.bytes(archive('b'), 100)).toString(), 'new exit');
  route = 'old'; await assert.rejects(client.bytes(archive('b'), 100), rateLimit(epoch + 3_600_000, 403));
  assert.deepEqual(reads, ['old', 'new', 'new']);
});

test('queueing and the bounded transient retry share one deadline', async () => {
  const release = Promise.withResolvers(); let reads = 0;
  const client = new PluginMarketDownloads(async () => { reads++; await release.promise; return new Response('ok'); });
  const active = ['a', 'b', 'c'].map(id => client.bytes(archive(id), 100));
  const releaseTimer = setTimeout(() => release.resolve(), 500);
  try {
    await assert.rejects(client.bytes(archive('d'), 100, 40), /timeout/i);
    assert.equal(reads, 3, 'timed out queue entries must never start a download');
  } finally { clearTimeout(releaseTimer); release.resolve(); await Promise.all(active); }
  let retries = 0;
  const retry = new PluginMarketDownloads(async () => { retries++; return new Response('', { status: 503 }); });
  await assert.rejects(retry.bytes(archive('a'), 100, 40), /abort|timeout/i);
  assert.equal(retries, 1, 'backoff cannot extend the original request deadline');
});

test('resolving a network route is covered by the same timeout', async () => {
  const client = new PluginMarketDownloads(() => assert.fail('never fetch after route timeout'), Date.now,
    async () => { await delay(80); return { key: '', fetch }; });
  await assert.rejects(client.bytes(archive('a'), 100, 20), /timeout/i);
});

test('queued downloads check the cooldown before fetching, and an older success cannot clear it', async () => {
  const releases = [], reads = [];
  const client = new PluginMarketDownloads(async input => {
    reads.push(String(input));
    return new Promise(resolve => releases.push(resolve));
  }, () => epoch);
  const requests = Array.from({ length: 8 }, (_, index) => client.bytes(archive(String(index)), 100));
  const outcomes = Promise.allSettled(requests);
  await delay(0);
  assert.equal(reads.length, 3, 'only three requests can run concurrently');
  releases[0](new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await delay(0);
  releases[1](new Response('ok')); releases[2](new Response('ok'));
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(reads.length, 3, 'queued requests never reach the limited service');
  await assert.rejects(client.bytes(archive('f'), 100), rateLimit(epoch + 60_000));
});

test('failures, truncated bodies and oversized responses never become cached successes', async () => {
  let reads = 0;
  const client = new PluginMarketDownloads(async () => {
    reads++;
    if (reads === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken body')); } }));
    if (reads === 2) return new Response('too large', { headers: { 'content-length': '999' } });
    if (reads === 3) return new Response('123456');
    return new Response('ok');
  });
  await assert.rejects(client.bytes(archive('a'), 5, 1000, true), /broken body/);
  await assert.rejects(client.bytes(archive('a'), 5, 1000, true), /size limit/);
  await assert.rejects(client.bytes(archive('a'), 5, 1000, true), /size limit/);
  assert.equal((await client.bytes(archive('a'), 5, 1000, true)).toString(), 'ok');
  await client.bytes(archive('a'), 5, 1000, true); assert.equal(reads, 4);
});

test('metadata byte cache has a 64 MiB budget and evicts the least recently used entry', async () => {
  let reads = 0;
  const client = new PluginMarketDownloads(async () => { reads++; return new Response(Buffer.alloc(16 * 1024 * 1024)); });
  for (const revision of ['a', 'b', 'c', 'd']) await client.bytes(archive(revision), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('a'), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('e'), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('a'), 32 * 1024 * 1024, 1000, true); assert.equal(reads, 5);
  await client.bytes(archive('b'), 32 * 1024 * 1024, 1000, true); assert.equal(reads, 6);
});
