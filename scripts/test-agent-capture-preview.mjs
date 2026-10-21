import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentFilePreviews } from '../dist-electron/agentFilePreview.mjs';
import { FileToolExecutionPersistence, ToolExecutionStore } from '../packages/bush-runtime/dist/index.js';

test('persisted desktop captures preview through Agent service after restart, scoped to their conversation and real directory', async t => {
  const parent = resolve('tmp/agent-capture-preview-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'agent-'));
  let service;
  t.after(async () => {
    await service?.close();
    assert.ok(root.startsWith(parent));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  service = await AgentService.open({ dataRoot: root, name: 'Capture fixture' });
  const session = await service.call('sessions.create', { sessionId: 'captures' });
  await service.call('sessions.create', { sessionId: 'unrelated' });
  await service.close();

  const captureRoot = join(root, 'desktop-bridge', 'captures');
  const runtimeCaptureRoot = join(root, 'runtime-state', 'captures');
  const browserCaptureRoot = join(root, 'browser-connector', 'artifacts');
  const outside = join(root, 'private');
  for (const directory of [captureRoot, runtimeCaptureRoot, browserCaptureRoot, outside]) await mkdir(directory, { recursive: true });
  const path = join(captureRoot, 'window.png'), legacy = join(runtimeCaptureRoot, 'browser.png');
  const bytes = Buffer.alloc(1_100_000, 42);
  await writeFile(path, bytes); await writeFile(legacy, 'legacy capture');
  const browserImage = join(browserCaptureRoot, 'page.png'); await writeFile(browserImage, 'browser capture');
  await writeFile(join(captureRoot, 'unrecorded.png'), 'not in this conversation');
  await writeFile(join(outside, 'secret.png'), 'private');
  await symlink(outside, join(captureRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = join(captureRoot, 'escape', 'secret.png');

  // Seed the existing journal format, as if a native MCP capture had completed.
  // No provider, model, desktop action or external plugin is invoked.
  const persistence = new FileToolExecutionPersistence({ root: join(root, 'runtime-state', 'tool-executions') });
  const store = new ToolExecutionStore({ persistence });
  const artifacts = [path, legacy, browserImage, escaped, join(outside, 'secret.png')].map(path => ({ type: 'image', path }));
  store.record({ protocol: 'bush.tool_call.v1', id: 'capture-1', name: 'mcp__fixture__capture', argumentsText: '{}' },
    { requestId: 'capture-request', sessionId: 'captures', turnId: 'capture-turn', round: 1, ordinal: 0 },
    { kind: 'returned', result: { structuredContent: { artifacts } }, workspaceChanges: [] });
  persistence.close();

  service = await AgentService.open({ dataRoot: root, name: 'Capture fixture' });
  const preview = new AgentFilePreviews(async (_connectionId, input) => service.call('files.read', input), () => 'image/png');
  const { url } = preview.create(1, 'agent', 'captures', path);
  const response = await preview.respond(new Request(url));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, 'all chunks survive the preview transport');
  const range = await preview.respond(new Request(url, { headers: { range: 'bytes=524200-524400' } }));
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(524200, 524401));
  assert.equal(Buffer.from((await service.call('files.read', { sessionId: 'captures', path: legacy })).content, 'base64').toString(), 'legacy capture');
  assert.equal(Buffer.from((await service.call('files.read', { sessionId: 'captures', path: browserImage })).content, 'base64').toString(), 'browser capture');

  for (const [sessionId, deniedPath] of [
    ['unrelated', path], ['captures', join(captureRoot, 'unrecorded.png')],
    ['captures', escaped], ['captures', join(outside, 'secret.png')],
    ['captures', join(captureRoot, '..', '..', 'agent.json')],
  ]) await assert.rejects(service.call('files.read', { sessionId, path: deniedPath }), /outside/, deniedPath);
  await assert.rejects(service.call('files.read', { sessionId: 'missing', path }));
  await assert.rejects(service.call('files.list', { sessionId: 'captures', directoryPath: captureRoot }), /outside|workspace/i);
  const localFile = join(session.metadata.runtimeWorkspace.workspaceDir, 'normal.txt');
  await writeFile(localFile, 'workspace remains readable');
  assert.equal(Buffer.from((await service.call('files.read', { sessionId: 'captures', path: localFile })).content, 'base64').toString(), 'workspace remains readable');
});
