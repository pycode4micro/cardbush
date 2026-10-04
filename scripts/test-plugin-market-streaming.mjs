import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { PluginMarketplaceService } from '../dist-electron/pluginMarketplaces.js';
import { PluginMarketDownloads } from '../dist-electron/pluginMarketDownloads.js';
import { extractPluginArchiveFile } from '../dist-electron/pluginArchives.js';

async function workspace(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'market-stream-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return root;
}
const sha = 'a'.repeat(40);
const manifest = { name: 'stream-test', version: '1.0.0', mcpServers: { echo: { type: 'http', url: 'https://fixture.invalid/mcp' } } };
const catalog = { name: 'fixture', plugins: [{ name: manifest.name, source: './plugins/stream-test', policy: { installation: 'AVAILABLE' } }] };
const until = async predicate => { for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(10); } throw Error('Fixture timed out'); };

test('metadata preview does not acquire packages; installation streams a >32 MiB repository and only extracts the pinned plugin', async t => {
  const root = await workspace(t), zip = new JSZip();
  zip.file('repo/plugins/stream-test/.codex-plugin/plugin.json', JSON.stringify(manifest));
  zip.file('repo/plugins/stream-test/keep.txt', 'plugin data');
  zip.file('repo/unrelated/video.bin', Buffer.alloc(36 * 1024 * 1024, 7));
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  let mode = 'normal', currentSha = sha, cancellations = 0;
  const requests = [];
  const fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.includes('/commits/')) return Response.json({ sha: currentSha });
    if (url.includes('codeload.github.com')) {
      if (mode === 'invalid') return new Response('not a zip');
      let offset = 0;
      const slow = mode === 'slow';
      return new Response(new ReadableStream({ async pull(controller) {
        if (slow) await delay(10);
        if (offset === archive.length) { controller.close(); return; }
        const end = Math.min(offset + 128 * 1024, archive.length);
        controller.enqueue(archive.subarray(offset, end)); offset = end;
      }, cancel() { cancellations++; } }), { headers: { 'content-length': String(archive.length) } });
    }
    if (url.endsWith('/.agents/plugins/marketplace.json')) return Response.json(catalog);
    const file = zip.file('repo/' + new URL(url).pathname.split('/').slice(4).join('/'));
    return file ? new Response(await file.async('nodebuffer')) : new Response('', { status: 404 });
  };
  const dataRoot = join(root, 'markets'), installed = join(root, 'installed');
  const service = new PluginMarketplaceService({ dataRoot, userPluginRoot: installed, bundledPluginRoot: join(root, 'bundled'), fetch });
  const source = await service.addGitHub('fixture/repository');
  const preview = await service.preview(source.id, manifest.name);
  assert.equal(preview.validation, 'metadata');
  assert.equal(preview.components[0].kind, 'mcp');
  assert.equal(requests.filter(url => url.includes('codeload.github.com')).length, 0, 'opening details never downloads the repository');
  assert.equal(await stat(join(dataRoot, 'previews')).catch(() => null), null, 'metadata previews do not create staging directories');
  currentSha = 'b'.repeat(40);
  const task = service.install(preview.token);
  await until(() => service.installProgress(preview.token)?.downloadedBytes > 0);
  assert.equal(service.installProgress(preview.token).totalBytes, archive.length);
  await task;
  assert.equal(service.installProgress(preview.token).phase, 'completed');
  assert.equal(service.cancelInstall(preview.token), false);
  assert.equal(await readFile(join(installed, manifest.name, 'keep.txt'), 'utf8'), 'plugin data');
  assert.equal(await stat(join(installed, manifest.name, 'unrelated')).catch(() => null), null);
  assert.ok(requests.includes(`https://codeload.github.com/fixture/repository/zip/${sha}`));
  assert.deepEqual(await readdir(join(dataRoot, 'previews')), [], 'successful installation removes the archive and staging tree');

  const update = await service.preview(source.id, manifest.name);
  mode = 'slow';
  const cancelled = assert.rejects(service.install(update.token), /market-cancelled/);
  await until(() => service.installProgress(update.token)?.downloadedBytes > 0);
  assert.equal(service.cancelInstall(update.token), true);
  await cancelled;
  assert.equal(service.installProgress(update.token).phase, 'cancelled');
  assert.ok(cancellations > 0);
  assert.deepEqual(await readdir(join(dataRoot, 'previews')), []);
  assert.equal(await readFile(join(installed, manifest.name, 'keep.txt'), 'utf8'), 'plugin data', 'cancellation retains the installed version');

  mode = 'invalid';
  await assert.rejects(service.install(update.token), /zip|directory/i);
  assert.deepEqual(await readdir(join(dataRoot, 'previews')), [], 'failed extraction leaves no partial package');
  assert.equal(await readFile(join(installed, manifest.name, 'keep.txt'), 'utf8'), 'plugin data');
  mode = 'normal';
  await service.install(update.token);
  assert.equal(service.installProgress(update.token).phase, 'completed', 'a cancelled preview can retry the same pinned revision');
});

test('streaming downloads remove partial files on cancellation and report disk exhaustion without reading a whole response', async t => {
  const root = await workspace(t), target = join(root, 'archive.zip'), abort = new AbortController();
  const downloads = new PluginMarketDownloads(async () => new Response(new ReadableStream({
    async pull(controller) { await delay(10); controller.enqueue(new Uint8Array(64 * 1024)); },
  })));
  await assert.rejects(downloads.file('https://fixture.invalid/archive', target, { signal: abort.signal,
    onProgress: value => { if (value.downloadedBytes >= 128 * 1024) abort.abort(new Error('fixture cancelled')); } }), /fixture cancelled/);
  assert.equal(await stat(target).catch(() => null), null);
  const huge = new PluginMarketDownloads(async () => new Response('unused', { headers: { 'content-length': String(2 ** 50) } }));
  await assert.rejects(huge.file('https://fixture.invalid/archive', target), /market-disk-space/);
  assert.equal(await stat(target).catch(() => null), null);
  await writeFile(target, 'existing');
  const normal = new PluginMarketDownloads(async () => new Response('replacement'));
  await assert.rejects(normal.file('https://fixture.invalid/archive', target), /EEXIST/);
  assert.equal(await readFile(target, 'utf8'), 'existing', 'failed file creation never removes an existing file');
});

test('disk ZIP reader retains path, symlink and selected-output validation', async t => {
  const root = await workspace(t);
  for (const [name, data, permissions] of [['../escape', 'outside'], ['CON.txt', 'alias'], ['link', '/outside', 0o120777], ['large', Buffer.alloc(17 * 1024 * 1024)]]) {
    const zip = new JSZip(); zip.file(`repo/plugin/${name}`, data, { unixPermissions: permissions });
    const file = join(root, `archive-${Math.random()}.zip`), destination = join(root, `out-${Math.random()}`);
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }));
    await assert.rejects(extractPluginArchiveFile(file, 'plugin', destination));
    assert.equal(await stat(destination).catch(() => null), null);
  }
});

test('file retries start from an empty file and a stalled body stops at the fixed deadline', async t => {
  const root = await workspace(t), target = join(root, 'download.zip');
  let attempts = 0;
  const progress = [];
  const downloads = new PluginMarketDownloads(async () => {
    if (++attempts > 1) return new Response('complete');
    let chunks = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (chunks++) controller.error(new Error('ECONNRESET'));
      else controller.enqueue(Buffer.from('partial'));
    } }));
  });
  await downloads.file('https://fixture.invalid/retry', target, { onProgress: value => progress.push(value.downloadedBytes) });
  assert.equal(attempts, 2);
  assert.equal(progress.filter(value => value === 0).length, 2, 'each attempt resets its progress');
  assert.equal(await readFile(target, 'utf8'), 'complete', 'partial bytes must not be appended to a retried response');
  const stalled = join(root, 'stalled.zip');
  const blocked = new PluginMarketDownloads(async () => new Response(new ReadableStream()));
  await assert.rejects(blocked.file('https://fixture.invalid/stalled', stalled, { timeoutMs: 100 }), /timeout|timed out/i);
  assert.equal(await stat(stalled).catch(() => null), null, 'timeout removes the partial file even if the body is stalled');
});
