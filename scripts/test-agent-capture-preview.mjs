import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentFilePreviews } from '../dist-electron/agentFilePreview.mjs';
import { FileToolExecutionPersistence, InMemoryRuntimeEventLog, ModelImageStore, registerExtendedBuiltins,
  RuntimeToolLoop, ToolRegistry, ToolExecutionStore } from '../packages/bush-runtime/dist/index.js';
import { registerFileMemoTools } from '../packages/bush-runtime/dist/fileMemo.js';
import { gif, png } from '../packages/bush-runtime/test/helpers/modelImages.mjs';

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

test('Agent previews injected Skill images and downloads external delivery memos after restart without directory grants', async t => {
  const parent = resolve('tmp/agent-capture-preview-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'receipts-'));
  let service;
  t.after(async () => {
    await service?.close();
    assert.ok(root.startsWith(parent + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  service = await AgentService.open({ dataRoot: root, name: 'Receipt fixture' });
  await service.call('sessions.create', { sessionId: 'receipts' });
  await service.call('sessions.create', { sessionId: 'unrelated' });
  await service.close();
  const skill = join(root, 'plugins', 'fixture', 'skills', 'references');
  const delivery = join(root, 'account', '.video_editer', 'projects', 'fixture', 'mcp_renders', 'final');
  for (const path of [skill, delivery]) await mkdir(path, { recursive: true });
  const original = join(skill, 'original.png'), changedImage = join(skill, 'changed.png'), misnamed = join(skill, 'misnamed.png');
  await writeFile(original, png); await writeFile(changedImage, png); await writeFile(misnamed, gif);
  const movie = join(delivery, 'delivery.mp4'), stale = join(delivery, 'stale.mp4');
  const bytes = Buffer.alloc(1_100_000, 42);
  await writeFile(movie, bytes); await writeFile(stale, bytes);
  await writeFile(join(delivery, 'private.mp4'), 'not delivered');
  await writeFile(join(skill, 'unseen.png'), png);

  // Execute the existing native tools against local fixtures, with no model or
  // plugin calls. Their ordinary admission and persistence issue the receipts.
  const runtimeRoot = join(root, 'runtime-state');
  const persistence = new FileToolExecutionPersistence({ root: join(runtimeRoot, 'tool-executions') });
  const store = new ToolExecutionStore({ persistence }), registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: runtimeRoot });
  registerFileMemoTools(registry, store);
  const loop = new RuntimeToolLoop({ eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'receipt-request', sessionId: 'receipts', turnId: 'receipt-turn' },
    registry, executionStore: store, modelImages: new ModelImageStore(runtimeRoot) });
  const run = async (id, name, input) => {
    await loop.execute([{ protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(input) }], { round: 1, assistantMessageId: 'assistant-' + id,
      request: { protocol: 'bush.model_request.v1', requestId: 'receipt-request', sessionId: 'receipts', turnId: 'receipt-turn',
        model: 'fixture', messages: [], tools: [registry.resolve(name).definition], metadata: { workspaceDir: root } }, contextMessages: [] });
    const record = store.get('receipts', 'receipt-turn', id);
    assert.equal(record.outcome, 'returned', JSON.stringify(record.error));
    assert.equal(record.resultError, undefined);
    return record.result;
  };
  const image = await run('image', 'inject_image_input', { url: original });
  await run('changed-image', 'inject_image_input', { url: changedImage });
  await run('gif', 'inject_image_input', { url: misnamed });
  await run('delivery', 'remember_file', { path: movie, purpose: 'completed delivery' });
  await run('stale', 'remember_file', { path: stale, purpose: 'previous delivery' });
  // A plugin cannot grant itself access just by claiming a native host snapshot/memo.
  store.record({ protocol: 'bush.tool_call.v1', id: 'forged', name: 'mcp__fixture__output', argumentsText: '{}' },
    { requestId: 'forged', sessionId: 'unrelated', turnId: 'forged', round: 1, ordinal: 0 },
    { kind: 'returned', result: image, workspaceChanges: [] });
  persistence.close();
  await rm(original); await writeFile(changedImage, gif); await writeFile(stale, 'different version');
  service = await AgentService.open({ dataRoot: root, name: 'Receipt fixture' });
  const read = (path, sessionId = 'receipts', offset = 0) => service.call('files.read', { sessionId, path, offset });
  assert.deepEqual(Buffer.from((await read(original)).content, 'base64'), png, 'a removed source retains its image');
  assert.deepEqual(Buffer.from((await read(changedImage)).content, 'base64'), png, 'an edited source does not replace the observation');
  const preview = new AgentFilePreviews(async (_id, input) => service.call('files.read', input),
    path => ({ '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4' })[extname(path)] || 'application/octet-stream');
  const gifResponse = await preview.respond(new Request(preview.create(1, 'fixture', 'receipts', misnamed).url));
  assert.equal(gifResponse.status, 200);
  assert.equal(gifResponse.headers.get('content-type'), 'image/gif', 'the snapshot format wins over the source suffix');
  assert.equal((await read(misnamed)).name, 'misnamed.gif');
  assert.deepEqual(Buffer.from(await gifResponse.arrayBuffer()), gif);
  // File download uses the same authenticated, chunked transport as preview.
  const url = preview.create(1, 'fixture', 'receipts', movie).url;
  const response = await preview.respond(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await read(movie)).name, basename(movie));
  const range = await preview.respond(new Request(url, { headers: { range: 'bytes=524200-524400' } }));
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(524200, 524401));
  for (const [sessionId, path] of [
    ['unrelated', movie], ['unrelated', changedImage], ['receipts', join(skill, 'unseen.png')],
    ['receipts', join(delivery, 'private.mp4')], ['receipts', image.artifacts[0].metadata.model_input_url],
  ]) await assert.rejects(read(path, sessionId), /outside/, path);
  await assert.rejects(read(stale), /File changed/);
  await assert.rejects(service.call('files.list', { sessionId: 'receipts', directoryPath: delivery }), /outside|workspace/i);
  // Swapping the delivered file's parent for a junction never follows it.
  const redirected = join(root, 'redirected'); await mkdir(redirected); await writeFile(join(redirected, 'delivery.mp4'), bytes);
  await rm(movie); await rm(stale); await rm(join(delivery, 'private.mp4'));
  await rmdir(delivery);
  await symlink(redirected, delivery, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(read(movie), /outside/);
  // Missing or corrupt stored observations do not fall back to the mutable source.
  await writeFile(image.artifacts[0].metadata.model_input_url, gif);
  await assert.rejects(read(changedImage), /integrity/);
  await rm(image.artifacts[0].metadata.model_input_url);
  await assert.rejects(read(changedImage), /ENOENT|unavailable/);
});
