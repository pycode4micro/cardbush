import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PERSONAL_ASSISTANT_SESSION as sessionId, assistantProfileSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry } from '../dist/index.js';

const windows = process.platform === 'win32';
const call = (name, args) => ({ name, args });
const dispatch = name => call('subagent', { name, prompt: `Run the ${name} assignment for the fixture project.` });
const quote = text => windows ? "'" + text.replaceAll("'", "''") + "'" : "'" + text.replaceAll("'", "'\\''") + "'";

function* response(request, calls, text) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  let sequence = 0;
  yield { ...base, sequence: sequence++, kind: 'response_started' };
  for (const [index, { name, args }] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index,
    toolCallId: randomUUID(), nameDelta: name, argumentsDelta: JSON.stringify(args) };
  if (!calls.length) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}

for (const permissionMode of ['all_free', 'task_free']) {
  test(`desktop project setup and two Assistant children route workspace approvals under ${permissionMode}`, { timeout: 45_000 }, async t => {
    const temporary = await realpath(tmpdir());
    const root = await realpath(await mkdtemp(join(temporary, 'assistant-workspace-approval-')));
    const workspace = join(root, 'task'), desktop = join(root, 'Desktop'), project = join(desktop, 'agent-collab-test');
    const readme = join(project, 'README.md'), source = join(desktop, 'log.md');
    await Promise.all([mkdir(workspace), mkdir(desktop)]);
    await writeFile(source, 'Existing desktop file');
    const registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
    sessions.ensureSession(sessionId);
    registry.register({ definition: { name: 'host_confirmation', inputSchema: { type: 'object' } }, visibleToChild: true,
      manifest: { effect_kind: 'observation', operation: 'fixture.confirm', risk: 'medium', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
      decodeInput: input => input, authorize: () => ({ kind: 'ask', request: { reason: 'Host requires this exact confirmation',
        actions: ['confirm'], targets: [{ kind: 'opaque', value: 'fixture:host-confirmation' }], capabilityIds: ['fixture:host-confirmation'], requiresHuman: true } }),
      execute: () => assert.fail('The host confirmation was denied') });
    const desktopRequests = [], parentRequests = new Map(), childRounds = new Map();
    let dispatched = false, editorsStarted = false;
    const allow = permissionMode === 'all_free';
    const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks,
      commandSandbox: { mode: windows ? 'auto' : 'off', network: 'disabled', readableRoots: [], writableRoots: [] },
      requestBackgroundPermission: async request => {
        desktopRequests.push({ actions: request.actions, target: basename(request.targets.find(item => item.kind === 'filesystem_path')?.value ?? '') });
        return request.actions.includes('confirm') ? 'deny' : 'allow_once';
      },
      provider: { async *stream(request) {
        if (request.metadata.agentRole === 'child') {
          assert.equal(request.permissionMode, 'task_free');
          const name = request.metadata.subagentName;
          const round = (childRounds.get(name) ?? 0) + 1;
          childRounds.set(name, round);
          const isSetup = name === 'setup';
          if (isSetup && round === 2) assert.ok((await stat(project)).isDirectory(), 'the approved terminal created the project');
          const steps = isSetup ? [
            [call('terminal_exec', { shell: windows ? 'powershell' : 'posix', cwd: workspace, yield_time_ms: 10_000,
              command: windows ? `New-Item -ItemType Directory -Path ${quote(project)} -ErrorAction Stop | Out-Null` : `mkdir ${quote(project)}`,
              ...(windows ? { additional_permissions: { write_roots: [desktop] } } : {}) })],
            [call('write_file', { path: readme, content: 'Project ready' }), call('read_file', { path: source })],
            [call('host_confirmation', {})],
          ] : [[call('read_file', { path: readme }), call('write_file', { path: join(project, `${name}.md`), content: name })]];
          yield* response(request, steps[round - 1] ?? [], `${name} finished.`);
          return;
        }
        const notices = request.messages.filter(message => message.name === 'child_interaction')
          .map(message => JSON.parse(message.content.split('\n').at(-1)))
          .filter(item => !parentRequests.has(item.interactionId));
        if (notices.length) {
          const noticesToAnswer = notices.map(notice => {
            assert.equal(notice.authority, 'parent_delegate');
            parentRequests.set(notice.interactionId, notice.operations);
            return call('subagent', { task_id: notice.taskId, response: { kind: 'permission', interactionId: notice.interactionId,
              actionDigest: notice.actionDigest, decision: 'allow_once' } });
          });
          yield* response(request, noticesToAnswer);
        } else if (!dispatched) {
          dispatched = true;
          yield* response(request, [dispatch('setup')]);
        } else if (!editorsStarted && tasks.list(sessionId).some(task => task.agentName === 'setup' && task.status === 'completed')) {
          editorsStarted = true;
          yield* response(request, [dispatch('editor-a'), dispatch('editor-b')]);
        } else yield* response(request, [], 'Project tasks are tracked.');
      } },
    });
    t.after(async () => {
      await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
      assert.equal(dirname(root).toLowerCase(), temporary.toLowerCase());
      assert.match(basename(root), /^assistant-workspace-approval-/);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
    const content = 'Create a project on Desktop and have two children work on it.';
    await command({ action: 'turn', profile: assistantProfileSchema.parse({}), entry: { id: 'user-fixture', role: 'user',
      source: 'text', visibility: 'conversation', content, createdAt: new Date().toISOString() },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'parent-r', sessionId, turnId: 'parent-t', model: 'fixture', prefixMessages: [],
      inputMessages: [{ messageId: 'user-fixture', message: { role: 'user', content } }], tools: registry.definitions(), permissionMode,
      metadata: { workspaceDir: workspace, subagentPermissionRouting: 'parent', individuation: { habits: false, predictions: false } } } });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(tasks.list(sessionId).length === 3 && tasks.list(sessionId).every(task => task.status === 'completed'))) {
      const snapshot = await command({ action: 'read' });
      assert.equal(snapshot.error, '');
      assert.deepEqual(snapshot.management.permissions, []);
      await delay(45);
    }
    assert.deepEqual(tasks.list(sessionId).map(task => task.status), ['completed', 'completed', 'completed']);
    const events = tasks.list(sessionId).flatMap(task => host.events(task.childSessionId, task.childTurnId));
    assert.equal(events.filter(event => event.kind === 'tool_returned' && event.payload.toolName === 'read_file' && !event.payload.resultError).length, 3);
    for (const [file, value] of [['README.md', 'Project ready'], ['editor-a.md', 'editor-a'], ['editor-b.md', 'editor-b']])
      assert.equal(await readFile(join(project, file), 'utf8'), value);
    const parentActions = [...parentRequests.values()];
    assert.equal(parentActions.length, allow ? 7 : 0);
    if (allow) assert.ok(parentActions.some(actions => actions.includes('execute')));
    assert.equal(desktopRequests.filter(request => request.actions.includes('confirm')).length, 1);
    const workspaceRequests = desktopRequests.filter(request => !request.actions.includes('confirm'));
    assert.equal(workspaceRequests.length, allow ? 0 : 7);
    if (!allow) {
      assert.ok(workspaceRequests.some(request => request.actions.includes('execute')));
      assert.ok(workspaceRequests.some(request => request.target === 'log.md' && request.actions.includes('read')));
      assert.ok(workspaceRequests.some(request => request.target === 'README.md' && request.actions.includes('write')));
    }
  });
}
