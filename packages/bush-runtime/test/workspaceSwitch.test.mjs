import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import test from 'node:test';
import { InMemoryRuntimeHost, TaskWorkspaceManager, SessionStore, FileSessionEventPersistence } from '../dist/index.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-switch-')));
  t.after(async () => {
    const delta = relative(await realpath(tmpdir()), root);
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const a = join(root, 'a'), b = join(root, 'b'), task = join(root, 'task');
  for (const path of [a, b, task]) await mkdir(path);
  for (const path of [a, b]) {
    const git = (...args) => execFileSync('git', ['-C', path, ...args], { windowsHide: true, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'file.txt'), path === a ? 'original a' : 'original b');
    git('add', '.'); git('commit', '-qm', 'fixture');
  }
  return { root, a, b, task, storage: join(root, 'runtime') };
}
const command = (host, kind, payload) => host.sendCommand({ kind: `runtime.${kind}`, payload });
const snapshot = host => command(host, 'get_session', { sessionId: 'task' });
async function switchTo(host, projectDir, taskDir) {
  const before = await snapshot(host);
  return command(host, 'switch_workspace', { sessionId: 'task', expectedRevision: before.revision, projectDir, projectId: projectDir ? 'target' : null, taskDir });
}
const turn = (turnId, metadata = {}, sessionId = 'task') => ({ protocol: 'bush.session_turn_request.v1', requestId: `request-${turnId}`,
  sessionId, turnId, model: 'fixture', tools: [], metadata,
  inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: 'Write into the current workspace.' } }] });
function provider(gate) {
  return { async *stream(request) {
    if (gate) await gate;
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done.' };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } };
}

test('switch changes real tool cwd, preserves history/files, detaches cleanly, and survives reopening', async t => {
  const { a, b, task, storage } = await fixture(t);
  const requests = [], called = new Map();
  const sessionStore = () => new SessionStore({ persistence: new FileSessionEventPersistence({ root: join(storage, 'sessions') }) });
  const host = new InMemoryRuntimeHost({ dataRoot: storage, sessionStore: sessionStore(), provider: { async *stream(request) {
    requests.push(request);
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    const step = called.get(request.turnId) ?? 0;
    called.set(request.turnId, step + 1);
    if (step < 2) {
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `${step ? 'write' : 'read'}-${request.turnId}`,
        nameDelta: step ? 'write_file' : 'read_file', argumentsDelta: JSON.stringify(step ? { path: 'file.txt', content: request.turnId } : { path: 'file.txt' }) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
    }
  } } });
  await command(host, 'create_session', { sessionId: 'task', workspace: { sourceDir: a, mode: 'direct' }, metadata: { title: 'Keep this chat', project_id: 'a', workspace_mode: 'project', project_path_aliases: [{ from: '/old', to: a }] } });
  const tools = (await command(host, 'get_tool_catalog', {})).filter(tool => ['read_file', 'write_file'].includes(tool.name));
  await host.runSessionTurn({ ...turn('before', { workspaceDir: a, projectDir: a }), tools });
  const before = await snapshot(host);
  const switched = await switchTo(host, b);
  assert.deepEqual(switched.turns, before.turns);
  assert.equal(switched.metadata.title, 'Keep this chat');
  assert.equal(switched.metadata.runtimeWorkspace.workspaceDir, b);
  assert.deepEqual(switched.metadata.project_path_aliases, []);
  // Even a stale caller cannot override the Runtime's new project binding.
  await host.runSessionTurn({ ...turn('after', { workspaceDir: a, projectDir: a }), tools });
  assert.equal(await readFile(join(a, 'file.txt'), 'utf8'), 'before');
  assert.equal(await readFile(join(b, 'file.txt'), 'utf8'), 'after');
  assert.equal(requests.at(-1).metadata.workspaceDir, b);
  assert.equal((await command(host, 'get_workspace', { sessionId: 'task', view: 'history' })).checkpoints.length, 1);
  const detached = await switchTo(host, null, task);
  for (const key of ['project_id', 'projectId', 'projectDir', 'project_dir', 'userProjectDir', 'user_project_dir', 'runtimeWorkspace']) assert.equal(detached.metadata[key], null, key);
  assert.equal(detached.metadata.workspace_dir, task);
  assert.equal(detached.metadata.workspace_mode, 'task');
  await host.runSessionTurn({ ...turn('independent', { workspaceDir: b, projectDir: b, taskRoots: [b] }), tools });
  assert.equal(await readFile(join(task, 'file.txt'), 'utf8'), 'independent');
  assert.equal(await readFile(join(b, 'file.txt'), 'utf8'), 'after');
  await switchTo(host, a);
  const reopened = new InMemoryRuntimeHost({ dataRoot: storage, sessionStore: sessionStore(), provider: provider() });
  assert.equal((await command(reopened, 'get_workspace', { sessionId: 'task' })).workspace.workspaceDir, a);
  assert.equal((await snapshot(reopened)).metadata.projectDir, a);
  assert.equal((await snapshot(reopened)).turns.length, 3);
});

test('invalid destinations and stale revisions leave the committed binding unchanged', async t => {
  const { a, b, storage } = await fixture(t);
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: provider() });
  await command(host, 'create_session', { sessionId: 'task', workspace: { sourceDir: a, mode: 'direct' }, metadata: {} });
  const before = await snapshot(host);
  await assert.rejects(switchTo(host, join(b, 'missing')));
  await assert.rejects(switchTo(host, join(b, 'file.txt')));
  await assert.rejects(command(host, 'switch_workspace', { sessionId: 'task', expectedRevision: before.revision + 1, projectDir: b, projectId: 'b' }));
  assert.deepEqual(await snapshot(host), before);
  assert.equal((await command(host, 'get_workspace', { sessionId: 'task' })).workspace.sourceDir, a);
});

test('running turns and asynchronous admissions block their workspace switch; unrelated sessions can move', async t => {
  const { a, b, storage } = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) { entered(); yield* provider(gate).stream(request); } } });
  for (const sessionId of ['task', 'other']) await command(host, 'create_session', { sessionId, metadata: {}, workspace: { sourceDir: a, mode: 'direct' } });
  const before = await snapshot(host);
  const running = host.runSessionTurn(turn('busy'));
  try {
    await assert.rejects(switchTo(host, b), /before switching workspaces/);
    await started;
    await assert.rejects(switchTo(host, b), /before switching workspaces/);
    const other = await command(host, 'get_session', { sessionId: 'other' });
    await command(host, 'switch_workspace', { sessionId: 'other', expectedRevision: other.revision, projectDir: b, projectId: 'b' });
    assert.equal((await snapshot(host)).metadata.projectDir, before.metadata.projectDir);
  } finally { release(); await running; }
  assert.equal((await switchTo(host, b)).metadata.projectDir, b);
});

test('worktree copies and incomplete checkpoints cannot be silently abandoned', async t => {
  const { a, b, storage } = await fixture(t);
  const manager = new TaskWorkspaceManager(storage);
  const copy = await manager.create('copy', a, 'worktree');
  await writeFile(join(copy.workspaceDir, 'file.txt'), 'keep my changes');
  await assert.rejects(manager.rebind('copy', b), { code: 'workspace_copy_active' });
  assert.equal(await readFile(join(copy.workspaceDir, 'file.txt'), 'utf8'), 'keep my changes');
  await manager.create('pending', a, 'direct');
  await manager.beginTurn('pending', 'unfinished');
  await assert.rejects(new TaskWorkspaceManager(storage).rebind('pending', b), { code: 'workspace_checkpoint_pending' });
});
