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

for (const [permissionMode, modeLabel] of [['all_free', 'Full access'], ['ask_for_approval', 'Ask for approval'], ['task_free', 'a saved legacy approval setting']]) {
  test(`desktop project setup and two Assistant children route workspace approvals under ${modeLabel}`, { timeout: 45_000 }, async t => {
    const temporary = await realpath(tmpdir());
    const root = await realpath(await mkdtemp(join(temporary, 'assistant-workspace-approval-')));
    const workspace = join(root, 'task'), desktop = join(root, 'Desktop'), project = join(desktop, 'agent-collab-test');
    const readme = join(project, 'README.md'), source = join(desktop, 'log.md');
    const shell = windows ? 'powershell' : 'posix';
    const setupCommand = windows ? `New-Item -ItemType Directory -Path ${quote(project)} -ErrorAction Stop | Out-Null` : `mkdir ${quote(project)}`;
    const expectedRequests = {
      'setup:terminal_exec': { actions: windows ? ['execute', 'write'] : ['execute'], paths: windows ? [workspace, desktop] : [workspace] },
      'setup:write_file': { actions: ['write'], paths: [readme] },
      'setup:read_file': { actions: ['read'], paths: [source] },
      'setup:host_confirmation': { actions: ['confirm'], paths: [] },
      'editor-a:read_file': { actions: ['read'], paths: [readme] },
      'editor-a:write_file': { actions: ['write'], paths: [join(project, 'editor-a.md')] },
      'editor-b:read_file': { actions: ['read'], paths: [readme] },
      'editor-b:write_file': { actions: ['write'], paths: [join(project, 'editor-b.md')] },
    };
    await Promise.all([mkdir(workspace), mkdir(desktop)]);
    await writeFile(source, 'Existing desktop file');
    const registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
    sessions.ensureSession(sessionId);
    registry.register({ definition: { name: 'host_confirmation', inputSchema: { type: 'object' } }, visibleToChild: true,
      manifest: { effect_kind: 'observation', operation: 'fixture.confirm', risk: 'medium', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
      decodeInput: input => input, authorize: () => ({ kind: 'ask', request: { reason: 'Host requires this exact confirmation',
        actions: ['confirm'], targets: [{ kind: 'opaque', value: 'fixture:host-confirmation' }], capabilityIds: ['fixture:host-confirmation'], requiresHuman: true } }),
      execute: () => assert.fail('The host confirmation was denied') });
    const legacyRequests = [], humanRequests = new Map(), parentRequests = new Map(), attention = [], childRounds = new Map();
    let dispatched = false, editorsStarted = false;
    const delegateWorkspace = permissionMode === 'all_free';
    const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks,
      commandSandbox: { mode: windows ? 'auto' : 'off', network: 'disabled', readableRoots: [], writableRoots: [] },
      onAssistantAttention: notice => { if (notice.interaction) attention.push(notice.id); },
      requestBackgroundPermission: async request => {
        legacyRequests.push(request);
        return 'deny';
      },
      provider: { async *stream(request) {
        if (request.metadata.agentRole === 'child') {
          assert.equal(request.permissionMode, 'ask_for_approval');
          const name = request.metadata.subagentName;
          const round = (childRounds.get(name) ?? 0) + 1;
          childRounds.set(name, round);
          const isSetup = name === 'setup';
          if (isSetup && round === 2) assert.ok((await stat(project)).isDirectory(), 'the approved terminal created the project');
          const steps = isSetup ? [
            [call('terminal_exec', { shell, cwd: workspace, yield_time_ms: 10_000, command: setupCommand,
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
            parentRequests.set(notice.interactionId, notice);
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
      for (const pending of snapshot.management.permissions) {
        const child = tasks.get(sessionId, pending.subagentTaskId);
        assert.ok(child, 'the card belongs to an Assistant-owned child');
        assert.deepEqual([pending.sessionId, pending.turnId, pending.sourceSessionId, pending.sourceTurnId],
          [child.childSessionId, child.childTurnId, child.childSessionId, child.childTurnId]);
        const request = host.events(child.childSessionId, child.childTurnId).find(event =>
          event.kind === 'permission_requested' && event.payload.permissionId === pending.permissionId);
        assert.equal(request?.payload.permissionRouting, 'user', 'parent-delegated requests never appear as user cards');
        assert.equal(pending.toolCallId, request.payload.toolCallId);
        const { actions, targets, requestedCapabilityIds, reason, scope } = request.payload;
        assert.deepEqual(pending.request, { actions, targets, requestedCapabilityIds, reason, scope });
        const confirmation = actions.includes('confirm');
        assert.ok(confirmation || !delegateWorkspace, 'all_free workspace approvals must stay with the parent model');
        assert.ok(!humanRequests.has(pending.permissionId), 'an answered card does not reappear');
        humanRequests.set(pending.permissionId, request.eventId);
        await host.sendCommand({ kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1',
          permissionId: pending.permissionId, answerId: randomUUID(), decision: confirmation ? 'deny' : 'allow_once',
          grantedCapabilityIds: confirmation ? [] : pending.request.requestedCapabilityIds } });
      }
      await delay(45);
    }
    assert.deepEqual(tasks.list(sessionId).map(task => task.status), ['completed', 'completed', 'completed']);
    assert.deepEqual((await command({ action: 'read' })).management.permissions, []);
    const events = tasks.list(sessionId).flatMap(task => host.events(task.childSessionId, task.childTurnId));
    assert.equal(events.filter(event => event.kind === 'tool_returned' && event.payload.toolName === 'read_file' && !event.payload.resultError).length, 3);
    for (const [file, value] of [['README.md', 'Project ready'], ['editor-a.md', 'editor-a'], ['editor-b.md', 'editor-b']])
      assert.equal(await readFile(join(project, file), 'utf8'), value);
    const seen = [];
    for (const child of tasks.list(sessionId)) {
      const journal = host.events(child.childSessionId, child.childTurnId);
      const toolNames = new Map(journal.filter(event => event.kind === 'tool_queued').map(({ payload }) => [payload.toolCallId, payload.toolName]));
      for (const request of journal.filter(event => event.kind === 'permission_requested')) {
        const { permissionId, toolCallId, actions, targets, permissionRouting } = request.payload;
        const toolName = toolNames.get(toolCallId);
        const operation = `${child.agentName}:${toolName}`;
        const expected = expectedRequests[operation];
        assert.ok(expected, `unexpected request ${operation}`);
        seen.push(operation);
        assert.deepEqual(actions, expected.actions, operation);
        assert.deepEqual(targets.filter(target => target.kind === 'filesystem_path').map(target => target.value), expected.paths, operation);
        const additionalTargets = targets.filter(target => target.kind !== 'filesystem_path').map(({ kind, value }) => ({ kind, value }));
        const confirmation = toolName === 'host_confirmation';
        if (toolName === 'terminal_exec') {
          assert.deepEqual(additionalTargets.map(target => target.kind), ['process']);
          assert.deepEqual(JSON.parse(additionalTargets[0].value).slice(0, 3), [shell, workspace, setupCommand]);
        } else assert.deepEqual(additionalTargets, confirmation ? [{ kind: 'opaque', value: 'fixture:host-confirmation' }] : []);

        const parentOwnsRequest = delegateWorkspace && !confirmation;
        assert.equal(permissionRouting, parentOwnsRequest ? 'parent' : 'user', operation);
        assert.equal(humanRequests.get(permissionId), parentOwnsRequest ? undefined : request.eventId, operation);
        const modelNotice = parentRequests.get(permissionId);
        if (parentOwnsRequest) {
          assert.equal(modelNotice?.taskId, child.taskId);
          assert.deepEqual(modelNotice.operations, actions);
          assert.deepEqual(modelNotice.resources, targets.map(({ kind, value }) => ({ kind, value })));
        } else assert.equal(modelNotice, undefined, operation);
        const answers = journal.filter(event => ['permission_answered', 'permission_rejected'].includes(event.kind) && event.payload.permissionId === permissionId);
        assert.deepEqual(answers.map(event => event.kind), [confirmation ? 'permission_rejected' : 'permission_answered'], operation);
        assert.equal(answers[0].payload.permissionRouting, permissionRouting, operation);
        if (confirmation) {
          assert.ok(journal.some(event => event.kind === 'tool_failed' && event.payload.toolCallId === toolCallId && event.payload.error.code === 'permission_rejected'));
          assert.ok(!journal.some(event => event.kind === 'tool_running' && event.payload.toolCallId === toolCallId));
        } else assert.deepEqual(answers[0].payload.grantedCapabilityIds, request.payload.requestedCapabilityIds, operation);
      }
    }
    assert.deepEqual(seen.sort(), Object.keys(expectedRequests).sort());
    assert.equal(parentRequests.size, delegateWorkspace ? 7 : 0);
    assert.equal(humanRequests.size, delegateWorkspace ? 1 : 8);
    assert.deepEqual([...attention].sort(), [...humanRequests.values()].sort());
    assert.deepEqual(legacyRequests, []);
  });
}
