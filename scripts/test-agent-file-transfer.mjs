import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { transferFile, deliveredFilePaths } from '../dist-electron/agentFileTransfer.mjs';
import { agentFileRead, agentFileUpload } from '../dist-electron/agentFiles.mjs';
import { AgentWebFiles } from '../dist-electron/agentWebFiles.mjs';
import { fileRange } from '../dist-electron/webFileResponse.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cb-transfer-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, force: true, maxRetries: 4 }); });
  for (const directory of ['source', 'destination', 'web/workspaces']) await mkdir(join(root, directory), { recursive: true });
  return { root, source: join(root, 'source'), destination: join(root, 'destination') };
}

test('large binary files transfer both ways with SHA-256, retries and no whole-file RPC', async t => {
  const f = await fixture(t), path = join(f.source, 'test-video.mp4');
  const bytes = Buffer.alloc(65 * 1024 * 1024 + 17, 31); bytes.write('ftyp', 4);
  await writeFile(path, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let peak = 0;
  const copy = () => transferFile('roundtrip', (offset, version) => agentFileRead(f.source, { path, offset, version }), value => {
    peak = Math.max(peak, value.content.length);
    return agentFileUpload(f.destination, value);
  });
  const first = await copy(), again = await copy();
  assert.deepEqual(again, first);
  assert.equal(first.size, bytes.length); assert.equal(first.sha256, hash); assert.ok(peak <= 699052);
  const web = new AgentWebFiles(join(f.root, 'web'));
  const back = await transferFile('return', (offset, version) => agentFileRead(f.destination, { path: first.path, offset, version }), value => web.call({ action: 'import', ...value }));
  assert.equal(back.sha256, hash); assert.equal((await web.describe(back.path)).mime, 'video/mp4');
  assert.equal((await stat(back.path)).size, bytes.length);
  await assert.rejects(web.describe(path), /outside personal files/);
});

test('version changes, corrupted acknowledgements and traversal cannot deliver a file', async t => {
  const f = await fixture(t), path = join(f.source, 'sample.txt'); await writeFile(path, 'hello');
  const first = await agentFileRead(f.source, { path, offset: 0 });
  await writeFile(path, 'changed');
  await assert.rejects(agentFileRead(f.source, { path, offset: 1, version: first.version }), /source_changed/);
  await assert.rejects(transferFile('wrong-offset', () => Promise.resolve(first), () => Promise.resolve({ path: 'bad', nextOffset: 0 })), /invalid_receipt/);
  await assert.rejects(agentFileUpload(f.destination, { uploadId: crypto.randomUUID(), name: '../private.key', offset: 0, content: '' }));
  await assert.rejects(agentFileRead(f.destination, { path, offset: 0 }), /outside this conversation/);
  const uploadId = crypto.randomUUID();
  await agentFileUpload(f.destination, { uploadId, name: 'bad.bin', offset: 0, content: Buffer.from('bad').toString('base64') });
  await assert.rejects(agentFileUpload(f.destination, { uploadId, name: 'bad.bin', offset: 3, content: '', size: 3, sha256: '0'.repeat(64) }), /verification_failed/);
});

test('only final delivery links are candidates; Windows, Unicode and reference links are supported', () => {
  const text = '[成片](<D:/workspace/测试 视频.mp4>)\n![image](/data/result.png)\n[audio][a]\n\n[a]: file:///D:/workspace/a.wav\n`/secret/key`\n[site](https://example.com/file.mp4)';
  assert.deepEqual(deliveredFilePaths(text), ['D:/workspace/测试 视频.mp4', '/data/result.png', 'D:/workspace/a.wav']);
});

test('media ranges support seek, suffix, HEAD metadata and reject invalid/multiple ranges', () => {
  assert.deepEqual(fileRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(fileRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(fileRange('bytes=98-', 100), { start: 98, end: 99, partial: true });
  for (const value of ['bytes=100-', 'bytes=-0', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-']) assert.equal(fileRange(value, 100), null);
});
