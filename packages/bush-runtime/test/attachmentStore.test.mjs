import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ModelImageStore, SessionStore } from '../dist/index.js';
import { AttachmentStore } from '../dist/attachmentStore.js';
import { imageFixture, png } from './helpers/modelImages.mjs';

const now = '2026-10-15T08:00:00Z';
const user = request => request.inputMessages.find(entry => entry.message.name === undefined);
const context = request => request.inputMessages.find(entry => entry.message.name === 'turn_runtime_context');
function request(root, id, input = {}) {
  return createProductAgentTurnRequest({ requestId: id, sessionId: 'attachments', turnId: id, messageId: `user-${id}`,
    createdAt: now, userText: 'Use these attachments.', model: 'fixture', tools: [], workspaceDir: join(root, 'workspace'),
    permissionMode: 'task_free', planEnabled: false, visionEnabled: true, maxOutputTokens: 1000, ...input });
}
function setup(root) {
  const dataRoot = join(root, 'runtime');
  const store = new AttachmentStore(dataRoot), images = new ModelImageStore(dataRoot);
  return { prepare: input => store.prepare(input, images), dataRoot, store, images };
}
function attachment(path, id = path, type = 'image') { return { id, path, type, name: path.split(/[\\/]/).at(-1) }; }

test('one Runtime path pins original files, tool paths and history before the provider runs; retries survive source deletion and restart', async t => {
  const { root, source } = await imageFixture(t);
  const document = join(root, '尺码 表.csv');
  const bytes = Buffer.from('size,chest\nS,88\nM,92\n');
  await writeFile(document, bytes);
  const facts = [], observed = [];
  const persistence = { load: () => structuredClone(facts), append: fact => facts.push(structuredClone(fact)) };
  let sourceDeleted = false;
  const provider = { async *stream(input) {
    observed.push(structuredClone(input));
    if (!sourceDeleted) { await rm(source); await rm(document); sourceDeleted = true; }
    const toolsContext = input.messages.filter(item => item.name === 'turn_runtime_context').at(-1).content;
    assert.ok(!toolsContext.includes(JSON.stringify(source)));
    assert.ok(!toolsContext.includes(JSON.stringify(document)));
    const imagePath = JSON.parse(toolsContext.match(/^1\. (.+)$/m)[1]);
    const filePath = JSON.parse(toolsContext.match(/Attached files:\n([^\n]+)/)[1]);
    assert.deepEqual(await readFile(imagePath), png);
    assert.deepEqual(await readFile(filePath), bytes);
    assert.deepEqual(await readFile(input.messages.filter(item => item.role === 'user' && item.images?.length).at(-1).images[0].url), png);
    yield { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: now, sequence: 0, kind: 'text_delta', delta: 'Read retained originals.' };
    yield { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: now, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } };
  const open = () => {
    const store = new SessionStore({ persistence });
    const host = new InMemoryRuntimeHost({ provider, sessionStore: store, dataRoot: join(root, 'runtime'), registerDefaultWorkspaceTools: false });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    return { host, store };
  };
  let { host, store } = open();
  const input = { images: [source], files: [document], attachments: [attachment(source, 'img'), attachment(document, 'csv', 'document')] };
  assert.equal((await host.runSessionTurn(request(root, 'first', input))).payload.status, 'completed');
  const before = structuredClone(store.snapshot('attachments').turns[0]);
  const retained = before.messages.find(entry => entry.messageId === 'user-first');
  assert.equal(retained.metadata.attachments.length, 2);
  assert.notEqual(retained.metadata.attachments[0].path, retained.message.images[0].url);
  assert.ok(retained.metadata.attachments.every(item => item.path.includes('.cardbush-attachments')));
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store } = open());
  // A retry of the same supplied attachment can find its retained copy, even if
  // the UI had not yet hydrated the newly committed paths before disconnecting.
  assert.equal((await host.runSessionTurn(request(root, 'retry', input))).payload.status, 'completed');
  assert.deepEqual(store.snapshot('attachments').turns[0], before);
  assert.deepEqual(observed[1].messages.slice(0, observed[0].messages.length), observed[0].messages);
  const retry = store.snapshot('attachments').turns[1].messages.find(entry => entry.messageId === 'user-retry');
  assert.deepEqual(retry.metadata.attachments, retained.metadata.attachments);
  // Ordinary UI resend uses the stored attachment paths and does not import them again.
  const replay = request(root, 'replay', { images: [retained.metadata.attachments[0].path],
    files: [retained.metadata.attachments[1].path], attachments: retained.metadata.attachments });
  assert.equal((await host.runSessionTurn(replay)).payload.status, 'completed');
  assert.equal((await readdir(join(root, 'workspace', '.cardbush-attachments', 'originals'))).length, 2);
  await host.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  for (const item of retained.metadata.attachments) assert.ok((await readFile(item.path)).length);
});

test('original image bytes and metadata survive independently of the smaller vision snapshot', async t => {
  const { root, source } = await imageFixture(t);
  const original = await sharp({ create: { width: 3000, height: 2400, channels: 3, background: '#1283cb' } })
    .withMetadata({ exif: { IFD0: { Artist: 'Original attachment' } } }).png().toBuffer();
  await writeFile(source, original);
  const candidate = request(root, 'compressed', { images: [source], attachments: [attachment(source)] });
  await setup(root).prepare(candidate);
  const saved = user(candidate).metadata.attachments[0];
  assert.deepEqual(await readFile(saved.path), original);
  const vision = user(candidate).message.images[0].url;
  assert.notEqual(vision, saved.path);
  assert.notDeepEqual(await readFile(vision), original);
  assert.ok((await sharp(vision).metadata()).width < 3000);
  assert.ok(context(candidate).message.content.includes(JSON.stringify(saved.path)));
  assert.ok(!context(candidate).message.content.includes(vision));
  await writeFile(source, png);
  assert.deepEqual(await readFile(saved.path), original);
});

test('inline images become actual original files without base64 in history metadata or tool context', async t => {
  const { root } = await imageFixture(t);
  const candidate = request(root, 'inline', { images: [`data:image/png;base64,${png.toString('base64')}`] });
  await setup(root).prepare(candidate);
  assert.deepEqual(await readFile(user(candidate).metadata.attachments[0].path), png);
  assert.doesNotMatch(JSON.stringify(candidate), /data:image|awaiting original-file storage/);
});

test('files-only and vision-disabled callers retain images and documents with matching display metadata', async t => {
  const { root, source } = await imageFixture(t);
  const candidate = request(root, 'without-vision', { files: [source], visionEnabled: false });
  await setup(root).prepare(candidate);
  assert.equal(user(candidate).message.images, undefined);
  const saved = user(candidate).metadata.attachments[0];
  assert.equal(saved.type, 'image');
  assert.equal(saved.imageIndex, undefined);
  assert.deepEqual(await readFile(saved.path), png);
  assert.ok(context(candidate).message.content.includes(JSON.stringify(saved.path)));
});

test('identical filenames stay separate, concurrent retries are idempotent, and workspace uploads are reused', async t => {
  const { root, source } = await imageFixture(t);
  const other = join(root, 'another', 'screen.png');
  await mkdir(join(root, 'another'));
  const second = await sharp(png).resize(2, 2).png().toBuffer();
  await writeFile(other, second);
  const a = request(root, 'one', { images: [source, other], attachments: [attachment(source), attachment(other)] });
  const b = structuredClone(a);
  const { prepare } = setup(root);
  await Promise.all([prepare(a), prepare(b)]);
  const saved = user(a).metadata.attachments;
  assert.notEqual(saved[0].path, saved[1].path);
  assert.deepEqual(user(a).metadata, user(b).metadata);
  assert.deepEqual(await readFile(saved[0].path), png);
  assert.deepEqual(await readFile(saved[1].path), second);
  const upload = join(root, 'workspace', '.cardbush-attachments', 'upload', 'uploaded.png');
  await mkdir(join(upload, '..'), { recursive: true });
  await writeFile(upload, png);
  const uploaded = request(root, 'upload', { images: [upload] });
  await prepare(uploaded);
  assert.equal(user(uploaded).metadata.attachments[0].path, await realpath(upload));
  assert.equal((await readdir(join(root, 'workspace', '.cardbush-attachments', 'originals'))).length, 2);
  const files = await readdir(join(root, 'workspace', '.cardbush-attachments'), { recursive: true });
  assert.ok(!files.some(file => file.endsWith('.tmp')));
});

test('SSH workspaces keep local originals on the Runtime host and preserve remote references', async t => {
  const { root, source } = await imageFixture(t);
  const candidate = request(root, 'ssh', { workspaceDir: 'ssh://server/home/project', images: [source],
    files: ['ssh://server/home/project/remote.csv'] });
  await setup(root).prepare(candidate);
  const [saved, remote] = user(candidate).metadata.attachments;
  assert.deepEqual(await readFile(saved.path), png);
  assert.equal(remote.path, 'ssh://server/home/project/remote.csv');
  assert.match(context(candidate).message.content, /environment="local"/);
  assert.equal(candidate.metadata.workspaceDir, 'ssh://server/home/project');
  assert.ok(candidate.metadata.taskRoots.some(path => saved.path.startsWith(path)));
  assert.ok(candidate.metadata.mcpContext.filesystemRoots.some(path => saved.path.startsWith(path)));
});

test('directory references and provider-owned HTTP images are not silently copied or downloaded', async t => {
  const { root } = await imageFixture(t);
  const candidate = request(root, 'references', { images: ['https://example.invalid/image.png'], files: [root] });
  await setup(root).prepare(candidate);
  assert.equal(user(candidate).message.images[0].url, 'https://example.invalid/image.png');
  assert.equal(user(candidate).metadata.attachments[1].type, 'folder');
  assert.equal(user(candidate).metadata.attachments[1].path, await realpath(root));
});

test('missing sources and cancellation fail before any provider request, with no partial original published', async t => {
  const { root, source } = await imageFixture(t);
  const { store, images, dataRoot } = setup(root);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(store.prepare(request(root, 'cancelled', { images: [source] }), images, aborted.signal), { name: 'AbortError' });
  let calls = 0;
  const host = new InMemoryRuntimeHost({ dataRoot, provider: { async *stream() { calls++; } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  await assert.rejects(host.runSessionTurn(request(root, 'missing', { files: [join(root, 'missing.pdf')] })), /Cannot retain attachment.*missing\.pdf/);
  assert.equal(calls, 0);
  const files = await readdir(join(root, 'workspace'), { recursive: true });
  assert.ok(!files.some(file => file.endsWith('.tmp') || file.endsWith('.pdf')));
});

test('imports refuse a storage junction that resolves outside the chosen workspace', async t => {
  const { root, source } = await imageFixture(t);
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await symlink(outside, join(workspace, '.cardbush-attachments'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(setup(root).prepare(request(root, 'junction', { images: [source] })), /outside the workspace/);
  assert.deepEqual(await readdir(outside), []);
});

test('invalid visual files are not published as originals and a corrected source can be resubmitted', async t => {
  const { root, source } = await imageFixture(t);
  const candidate = request(root, 'repair', { images: [source] });
  const { prepare } = setup(root);
  await writeFile(source, png.subarray(0, 48));
  await assert.rejects(prepare(structuredClone(candidate)), /Cannot decode model image/);
  const files = await readdir(join(root, 'workspace'), { recursive: true });
  assert.ok(!files.some(file => file.endsWith('.png') || file.endsWith('.tmp')));
  await writeFile(source, png);
  await prepare(candidate);
  assert.deepEqual(await readFile(user(candidate).metadata.attachments[0].path), png);
});

test('repeated visual sources keep every image slot and its corresponding tool path', async t => {
  const { root, source } = await imageFixture(t);
  const candidate = request(root, 'repeated', { images: [source, source] });
  await setup(root).prepare(candidate);
  await rm(source);
  assert.deepEqual(user(candidate).metadata.attachments.map(item => item.imageIndex), [0, 1]);
  for (const image of user(candidate).message.images) assert.deepEqual(await readFile(image.url), png);
  for (const item of user(candidate).metadata.attachments) {
    assert.deepEqual(await readFile(item.path), png);
    assert.ok(context(candidate).message.content.includes(`${item.imageIndex + 1}. ${JSON.stringify(item.path)}`));
  }
});

test('read-only source files can be retained without modifying their content', async t => {
  const { root, source } = await imageFixture(t);
  await chmod(source, 0o400);
  try {
    const candidate = request(root, 'read-only', { images: [source] });
    await setup(root).prepare(candidate);
    assert.deepEqual(await readFile(user(candidate).metadata.attachments[0].path), png);
    assert.deepEqual(await readFile(source), png);
  } finally { await chmod(source, 0o600); }
});

test('the personal assistant retains originals and remote execution locators while pinning its visual input separately', async t => {
  const { root, source } = await imageFixture(t);
  let received;
  const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), provider: { async *stream(input) {
    received = input;
    await rm(source);
    yield { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: now, sequence: 0, kind: 'text_delta', delta: 'Received.' };
    yield { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: now, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const sessionId = PERSONAL_ASSISTANT_SESSION;
  await host.sendCommand({ kind: 'runtime.create_session', payload: { sessionId } });
  const remote = { connectionId: 'remote-agent', path: '/workspace/uploads/screen.png' };
  await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'turn', sessionId,
    entry: { id: 'assistant-upload', role: 'user', source: 'text', content: 'Inspect image', createdAt: now,
      attachments: [{ ...attachment(source), execution: remote }] },
    parent: request(root, 'assistant', { sessionId }), profile: assistantProfileSchema.parse({}) } });
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'read', sessionId } });
    if (!state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.error, '');
  assert.ok(received);
  const saved = state.entries[0].attachments[0];
  assert.deepEqual(saved.execution, remote);
  assert.deepEqual(await readFile(saved.path), png);
  const image = received.messages.find(message => message.images?.length).images[0];
  assert.deepEqual(await readFile(image.url), png);
  assert.notEqual(image.url, saved.path);
  assert.ok(received.messages.some(message => message.content.includes(JSON.stringify(saved.path))));
});
