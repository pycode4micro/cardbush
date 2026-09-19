import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { BrowserArtifacts, exportedImage } from '../dist/imageArtifacts.js';
import { createCardbushChromeServer } from '../dist/index.js';
import { ChromeConnectorError } from '../dist/bridgeClient.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cardbush-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, artifacts: new BrowserArtifacts(root) };
}

test('complete images are validated, saved without rewriting and isolated by session', async t => {
  const { root, artifacts } = await fixture(t);
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await sharp({ create: { width: 120, height: 60, channels: 3, background: '#175fb5' } }).toFormat(format).toBuffer();
    const input = exportedImage(JSON.stringify({ url: `data:image/${format};base64,${bytes.toString('base64')}` }));
    const a = await artifacts.image('a', input), repeat = await artifacts.image('a', input), b = await artifacts.image('b', input);
    assert.equal(a.width, 120); assert.equal(a.height, 60);
    assert.equal(a.artifact.path, repeat.artifact.path); assert.notEqual(a.artifact.path, b.artifact.path);
    assert.deepEqual(await readFile(a.artifact.path), bytes);
    assert.equal(a.image.mimeType, `image/${format}`);
  }
  assert.ok(!(await readdir(root, { recursive: true })).some(file => file.endsWith('.tmp')));
  const incomplete = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  await assert.rejects(artifacts.image('a', { data: incomplete.toString('base64'), mimeType: 'image/png' }), { code: 'image_export_invalid' });
  assert.throws(() => exportedImage({ data: 'not-an-image', mimeType: 'application/json' }), { code: 'image_export_invalid' });
});

test('completed downloads are copied once and remain available after the original is removed', async t => {
  const { root, artifacts } = await fixture(t);
  const source = path.join(root, 'report.pdf'); await writeFile(source, 'a completed download');
  const a = await artifacts.download('scope-a', 'task', source);
  assert.notEqual(a.path, source);
  await rm(source);
  const repeat = await artifacts.download('scope-a', 'task', source);
  assert.equal(repeat.path, a.path); assert.equal(await readFile(repeat.path, 'utf8'), 'a completed download');
});

test('MCP download tools deduplicate request keys and publish artifacts only on complete', async t => {
  const { root } = await fixture(t);
  const source = path.join(root, 'saved.pdf'); await writeFile(source, 'complete');
  const calls = []; let complete = false;
  const server = createCardbushChromeServer({ artifactsDirectory: root, connector: async (method, params) => {
    if (method === 'tabs.list') return [{ id: 7, active: true }];
    calls.push({ method, ...params });
    return { taskId: 'task-one', state: complete ? 'complete' : 'starting', filename: source };
  } });
  const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'a', cardbush_turn_id: 'turn' } } };
  const start = () => server._registeredTools.download_file.handler({ url: 'https://example.test/report.pdf' }, context);
  assert.equal((await start()).structuredContent.artifacts, undefined);
  await start(); assert.equal(calls[0].requestKey, calls[1].requestKey);
  assert.equal(calls[0].scopeId, 'a');
  const status = () => server._registeredTools.download_status.handler({ taskId: 'task-one', waitMs: 0 }, context);
  assert.equal((await status()).structuredContent.artifacts, undefined);
  complete = true;
  const ready = await status();
  assert.equal(ready.structuredContent.artifacts.length, 1);
  assert.equal(await readFile(ready.structuredContent.path, 'utf8'), 'complete');
});

test('old extensions and missing completed files give actionable errors without restarting a download', async t => {
  const { root } = await fixture(t);
  let outdated = true;
  const server = createCardbushChromeServer({ artifactsDirectory: root, connector: async () => {
    if (outdated) throw new ChromeConnectorError('unsupported_method', 'Unsupported connector method: downloads.status');
    return { taskId: 'done', state: 'complete', filename: path.join(root, 'removed.pdf') };
  } });
  const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'a' } } };
  const status = () => server._registeredTools.download_status.handler({ taskId: 'done', waitMs: 0 }, context);
  assert.equal((await status()).structuredContent.error.code, 'extension_update_required');
  outdated = false;
  const failed = await status();
  assert.equal(failed.structuredContent.error.code, 'download_artifact_unavailable');
  assert.equal(failed.structuredContent.error.details.taskId, 'done');
  assert.equal(failed.structuredContent.error.details.state, 'complete');
});
