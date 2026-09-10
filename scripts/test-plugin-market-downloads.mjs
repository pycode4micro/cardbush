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
  assert.match(error.message, new RegExp(`\\[market-rate-limit:${until}\\]`));
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
    [{ 'retry-after': 'invalid' }, 429, epoch + 60_000],
    [{ 'retry-after': '-1' }, 429, epoch + 60_000],
    [{ 'retry-after': '0' }, 429, epoch + 1000],
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

test('missing Retry-After backs off across repeated rate limits and resets after recovery', async () => {
  let now = epoch, limited = true;
  const client = new PluginMarketDownloads(async () => new Response('ok', { status: limited ? 429 : 200 }), () => now);
  await assert.rejects(client.bytes(archive('a'), 100), rateLimit(now + 60_000));
  now += 60_000;
  await assert.rejects(client.bytes(archive('a'), 100), rateLimit(now + 120_000));
  now += 120_000; limited = false; await client.bytes(archive('a'), 100);
  limited = true;
  await assert.rejects(client.bytes(archive('b'), 100), rateLimit(now + 60_000));
});

test('queued downloads check the cooldown before fetching, and an older success cannot clear it', async () => {
  const releases = [], reads = [];
  const client = new PluginMarketDownloads(async input => {
    reads.push(String(input));
    return new Promise(resolve => releases.push(resolve));
  }, () => epoch);
  const requests = Array.from({ length: 8 }, (_, index) => client.bytes(archive(String(index)), 100));
  const outcomes = Promise.allSettled(requests);
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

test('archive cache has a 64 MiB budget and evicts the least recently used entry', async () => {
  let reads = 0;
  const client = new PluginMarketDownloads(async () => { reads++; return new Response(Buffer.alloc(16 * 1024 * 1024)); });
  for (const revision of ['a', 'b', 'c', 'd']) await client.bytes(archive(revision), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('a'), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('e'), 32 * 1024 * 1024, 1000, true);
  await client.bytes(archive('a'), 32 * 1024 * 1024, 1000, true); assert.equal(reads, 5);
  await client.bytes(archive('b'), 32 * 1024 * 1024, 1000, true); assert.equal(reads, 6);
});
