import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry, ToolExecutionStore, AutomationScheduler,
  CoordinationStore, FileCoordinationPersistence, registerSkillTools } from '../dist/index.js';
import { PERSONAL_ASSISTANT_SESSION as id, ASSISTANT_MANAGEMENT_TOOLS, assistantProfileSchema } from '@cardbush/bush-protocol';
import { BridgePluginTools } from '../dist/botMessaging.js';
import { ConversationJournal } from '../dist/conversationJournal.js';

const until = async check => { for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
const manifest = { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false };
async function fixture(t, now) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-management-')), registry = new ToolRegistry(), sessions = new SessionStore(), executions = new ToolExecutionStore();
  sessions.ensureSession(id);
  await mkdir(join(root, 'skills', 'sheets'), { recursive: true });
  await writeFile(join(root, 'skills', 'sheets', 'SKILL.md'), '---\nname: sheets\ndescription: Build spreadsheet reports\n---\n# Instructions');
  registerSkillTools(registry, [join(root, 'skills')]);
  let executed = 0, batch = [], sequence = 0;
  for (const visible of [true, false]) registry.register({ definition: { name: `mcp__fixture__${visible ? 'report' : 'hidden'}`, description: 'Read report data', inputSchema: { type: 'object', properties: {} } },
    manifest, decodeInput: x => x, execute: () => { executed++; return {}; }, mcpHook: { server: 'fixture', tool: visible ? 'report' : 'hidden', modelVisible: visible, call: async () => ({}) } });
  const runs = [], requests = [], results = new Map(), hooks = [], faults = {}, persistence = new FileCoordinationPersistence({ root: join(root, 'coordination') });
  const coordination = new CoordinationStore({ persistence });
  const scheduler = new AutomationScheduler({ path: join(root, 'automations.json'), now, canRun: () => true, sessionExists: key => key === id,
    run: async (job, run, ctx) => { runs.push({ job, run, ctx }); return { status: 'completed', reason: 'done', summary: 'Saved report' }; } });
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, toolRegistry: registry, toolExecutionStore: executions, coordinationStore: coordination, automation: scheduler,
    loadPluginExtensions: async () => ({ commands: [{ id: 'fixture:report', name: 'report', description: 'Prepare a report', path: join(root, 'command.md'), pluginId: 'fixture', userInvocable: true }], skills: [], agents: [], hooks }),
    provider: { async *stream(request) {
      requests.push(request);
      for (const message of request.messages) if (message.role === 'tool') results.set(message.toolCallId, JSON.parse(message.content));
      const calls = batch; batch = [];
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() }; let sequence = 0;
      yield { ...base, sequence: sequence++, kind: 'response_started' };
      if (!calls.length && faults.reply) { faults.reply = false; yield { ...base, sequence: sequence++, kind: 'response_failed', code: 'fixture_failure', message: 'Fixture reply interrupted', retryable: false }; return; }
      for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index, toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
      if (!calls.length) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: 'Done.' };
      yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
    } } });
  const parent = () => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${sequence}`, sessionId: id, turnId: `t-${sequence}`, model: 'fixture-model',
    prefixMessages: [], inputMessages: [{ messageId: `input-${sequence}`, message: { role: 'user', content: 'Manage the requested work.' } }],
    tools: registry.definitions(), metadata: { workspaceDir: root, planEnabled: true, mcpToolDiscovery: true }, permissionMode: 'task_free', requestCapabilities: { interactiveRequests: true, vision: false } });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  const read = () => command({ action: 'read' });
  const events = payload => host.sendCommand({ kind: 'runtime.friends', payload });
  const configureEvents = () => events({ action: 'configure', parent: parent(), assistant: assistantProfileSchema.parse({}),
    profile: { name: 'Assistant', recognition: {}, language: 'en', timeZone: 'Asia/Shanghai', confirmedAt: new Date(0).toISOString() } });
  const begin = async (name, args, patch = {}) => {
    sequence++; const callId = `call-${sequence}`; batch = [{ id: callId, name, args }];
    await command({ action: 'turn', entry: { id: `input-${sequence}`, content: 'Manage the requested work.', role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
      parent: { ...parent(), ...patch }, profile: assistantProfileSchema.parse({}) }); return callId;
  };
  const complete = async callId => { await until(async () => !(await read()).busy); assert.equal((await read()).error, ''); return results.get(callId); };
  t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await scheduler.close(); persistence.close?.();
    assert.ok(root.startsWith(join(tmpdir(), 'assistant-management-'))); await rm(root, { recursive: true, force: true }); });
  return { root, registry, scheduler, runs, requests, results, hooks, faults, executions, coordination, persistence, read, command, begin, complete, parent, configureEvents,
    readEvents: () => events({ action: 'read' }),
    environment: () => host.readEnvironment(id),
    executed: () => executed, invoke: async (name, args, patch) => complete(await begin(name, args, patch)),
    answer: (permission, decision) => host.sendCommand({ kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1', permissionId: permission.permissionId,
      answerId: randomUUID(), decision, ...(['allow_once', 'allow_session'].includes(decision) ? { grantedCapabilityIds: permission.request.requestedCapabilityIds } : {}) } }) };
}
const schedule = { action: 'create', name: 'Report', prompt: 'Read the fixture project and save report.html; return its path.', time_zone: 'Asia/Shanghai', trigger: { kind: 'once', at: '2099-10-30T10:00:00+08:00' } };
const reminder = { action: 'create', text: 'Remind me to review the report.', at: schedule.trigger.at };

for (const { routing = 'parent', mode = 'text', ordinary = false, report = false, count = 1, decision = 'allow_once' } of [
  { count: 3 }, { routing: 'user' }, { mode: 'voice' }, { report: true }, { decision: 'deny' },
  { ordinary: true, count: 4 }, { ordinary: true, report: true }, { ordinary: true, routing: 'user' },
]) {
  test(`${ordinary ? 'Ordinary conversation' : 'Assistant'} background child ${routing} approval (${mode}, ${report ? 'report requested' : `${count} ${decision} requests`})`, { timeout: 12000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-approval-'));
    const registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
    const startChild = Promise.withResolvers(), finishChild = Promise.withResolvers(), attention = [], approvalIds = new Set(), requests = [];
    let childRounds = 0, manualRequests = 0, executions = 0;
    const allowed = routing === 'parent' && decision === 'allow_once';
    const sessionId = ordinary ? 'ordinary-approval' : id;
    sessions.ensureSession(sessionId);
    registry.register({
      definition: { name: 'edit_home_component', description: 'Edit the protected Home component fixture.', inputSchema: { type: 'object' } },
      manifest, visibleToChild: true, decodeInput: value => value,
      authorize: () => ({ kind: 'ask', request: { reason: 'Edit the LCQ component fixture', actions: ['external_tool_call'],
        targets: [{ kind: 'mcp_resource', value: 'mcp://fixture/tools/edit_home_component' }], capabilityIds: ['fixture:edit'] } }),
      execute: () => { executions++; return { edited: true }; },
    });
    function* response(request, output, preamble) {
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      let sequence = 1;
      if (preamble) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: preamble };
      if (typeof output === 'string') yield { ...base, sequence: sequence++, kind: 'text_delta', delta: output };
      else yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index: 0, toolCallId: randomUUID(),
        nameDelta: output.name, argumentsDelta: JSON.stringify(output.args) };
      yield { ...base, sequence, kind: 'response_completed', finishReason: typeof output === 'string' ? 'stop' : 'tool_calls' };
    }
    const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, toolRegistry: registry, subagentTaskStore: tasks,
      onAssistantAttention: notice => attention.push(notice),
      requestBackgroundPermission: async () => { manualRequests++; return false; },
      ...(ordinary ? { loadPluginExtensions: async () => ({ skills: [], agents: [], hooks: [] }) } : {}),
      provider: { async *stream(request) {
        if (request.metadata.agentRole === 'child') {
          assert.equal(request.metadata.pluginBackground, true);
          assert.equal(request.metadata.permissionRouting, routing);
          if (++childRounds === 1) await startChild.promise;
          else assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content,
            allowed ? /"edited":true/ : /permission_rejected/);
          if (childRounds <= count) yield* response(request, { name: 'edit_home_component', args: {} });
          else {
            await finishChild.promise;
            yield* response(request, 'Fixture child settled.');
          }
          return;
        }
        requests.push(request);
        if (requests.length === 1) {
          yield* response(request, { name: 'subagent', args: { prompt: 'Edit the LCQ component.', ...(ordinary ? { run_in_background: true } : {}) } });
          return;
        }
        const notices = request.messages.filter(message => message.name === 'child_interaction').map(message => JSON.parse(message.content.split('\n').at(-1)));
        const interaction = notices.find(item => !approvalIds.has(item.interactionId));
        if (interaction) {
          assert.equal(routing, 'parent');
          assert.equal(interaction.authority, 'parent_delegate');
          assert.equal(interaction.resources[0].value, 'mcp://fixture/tools/edit_home_component');
          assert.ok(request.messages.find(message => message.name === 'child_interaction').content.includes('report_approval=true'));
          assert.equal(request.tools.find(tool => tool.name === 'subagent').inputSchema.properties.report_approval.type, 'boolean');
          approvalIds.add(interaction.interactionId);
          yield* response(request, { name: 'subagent', args: { task_id: interaction.taskId,
            ...(report ? { report_approval: true } : {}),
            response: { kind: 'permission', interactionId: interaction.interactionId, actionDigest: interaction.actionDigest, decision } } }, 'Routine approval narration.');
          return;
        }
        const completed = request.messages.some(message => message.name === 'background_task_result' || (message.name === 'plugin_hook_feedback' && message.content.includes('Fixture child settled.')));
        if (completed) yield* response(request, 'Fixture completion delivered.');
        else if (report && approvalIds.size && request.messages.some(message => message.role === 'tool' && /"decision":"allow_once"/.test(message.content))) {
          yield* response(request, 'I approved the component edit.');
        } else yield* response(request, requests.length === 2 ? 'Fixture dispatched.' : 'Unexpected approval follow-up.');
      } },
    });
    t.after(async () => {
      startChild.resolve(); finishChild.resolve();
      await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
      await rm(root, { recursive: true, force: true });
    });
    const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
    const content = `Edit the LCQ component.${report ? ' Tell me after you approve the edit.' : ''}`;
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'fixture-request', sessionId, turnId: 'fixture-turn',
        model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: 'user-fixture', message: { role: 'user', content } }],
        tools: registry.definitions(), permissionMode: 'task_free', metadata: { subagentPermissionRouting: routing,
          assistantOutputMode: mode, individuation: { habits: false, predictions: false } } };
    if (ordinary) assert.equal((await host.runSessionTurn(parent)).payload.status, 'completed');
    else {
      await command({ action: 'turn', parent, entry: { id: 'user-fixture', role: 'user', source: mode, visibility: 'conversation', content,
        createdAt: new Date().toISOString() }, profile: assistantProfileSchema.parse({}) });
      await until(async () => !(await command({ action: 'read' })).busy);
    }
    assert.equal(requests.length, 2);
    startChild.resolve();
    await until(() => childRounds === count + 1);
    if (ordinary && routing === 'parent') {
      const approvalTurns = () => sessions.snapshot(sessionId).turns.filter(turn => turn.turnId.startsWith('peer_turn_'));
      await until(() => approvalTurns().length === count);
      if (!report) {
        assert.ok(approvalTurns().every(turn => !turn.messages.some(({ message }) => message.role === 'assistant' && message.content)));
        for (const turn of approvalTurns()) {
          const events = host.events(sessionId, turn.turnId);
          assert.equal(events.at(-1).payload.reason, 'child_approval_completed');
          assert.ok(events.every(event => !event.kind.startsWith('assistant_segment_')));
        }
      }
    } else if (!ordinary) await until(async () => !(await command({ action: 'read' })).busy);
    assert.equal(requests.length, 2 + (routing === 'parent' ? count : 0) + Number(report), 'approval adds one decision request and only an explicitly requested reply');
    const task = tasks.list(sessionId)[0];
    const events = host.events(task.childSessionId, task.childTurnId);
    assert.equal(approvalIds.size, routing === 'parent' ? count : 0);
    assert.equal(manualRequests, routing === 'user' ? 1 : 0);
    assert.equal(executions, allowed ? count : 0);
    assert.equal(events.filter(event => event.kind === 'permission_requested').length, approvalIds.size);
    assert.equal(events.filter(event => event.kind === (allowed ? 'permission_answered' : 'permission_rejected')).length, approvalIds.size);
    assert.ok(attention.every(notice => !notice.interaction), 'model approvals must not ask the desktop user');
    const visible = async () => ordinary ? sessions.snapshot(sessionId).turns.flatMap(turn => turn.messages.map(fact => fact.message))
      .filter(message => message.role === 'assistant' && message.content).map(message => message.content)
      : (await command({ action: 'read' })).entries.filter(entry => entry.role === 'assistant' && entry.visibility === 'conversation').map(entry => entry.content);
    const before = ['Fixture dispatched.', ...(report ? ['I approved the component edit.'] : [])];
    assert.deepEqual(await visible(), before);
    finishChild.resolve();
    if (ordinary) {
      await until(() => tasks.get(sessionId, task.taskId).status === 'completed');
      await host.runSessionTurn({ ...parent, requestId: 'next-request', turnId: 'next-turn', inputMessages: [{ messageId: 'next-user',
        message: { role: 'user', content: 'How did it go?' } }] });
    }
    await until(async () => (await visible()).includes('Fixture completion delivered.'));
    assert.deepEqual(await visible(), [...before, 'Fixture completion delivered.']);
    assert.equal(requests.length, 3 + (routing === 'parent' ? count : 0) + Number(report));
  });
}

test('Assistant reads pre-checkpoint evidence through its real management tool', async t => {
  const f = await fixture(t);
  const history = new ConversationJournal(join(f.root, 'conversation-journal')).modelHistory(id);
  history.append([{ role: 'user', content: 'Use X-29 instead.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'inspect', name: 'tasks', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'inspect', content: '{"status":"interrupted","job":"Q819"}' }]);
  history.checkpoint(3, 'Previous job was interrupted.', [], 2000);
  const locator = history.read().memory.match(/conversation-history:\/\/[^\n]+/)[0];
  const result = await f.invoke('read_conversation_history', { locator });
  assert.equal(result.session_id, id, JSON.stringify(result));
  assert.match(result.text, /Use X-29 instead/);
  assert.match(result.text, /Q819/);
});
test('Assistant loads and invokes an owned bridge directly with normal file/source admission', async t => {
  const f = await fixture(t), calls = [], connectionId = '11111111-1111-4111-8111-111111111111';
  const file = join(f.root, 'screenshot.png'); await writeFile(file, 'fixture bytes');
  let connected = true;
  const source = { sourceRef: 'webhook:fixture', connectionId, available: true, capabilities: { text: true, files: true } };
  const bridge = new BridgePluginTools(f.registry, {
    catalog: async () => connected ? [{ connectionId, sessionId: id, expiresAt: Date.now() + 60000, revision: 'a'.repeat(64), plugin: {
      id: 'fixture', name: 'Fixture', version: '1', description: 'Fixture bridge', tools: [{ name: 'send_file', description: 'Send file', fileArguments: ['file'],
        inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false } }] } }] : [],
    context: async () => ({ available: true, targets: [source] }),
    call: async (session, input, signal, files) => { calls.push({ session, input, files }); return { status: 'accepted' }; },
  }, session => session);
  await bridge.sync(id);
  const name = f.registry.definitions().find(tool => tool.name.startsWith('mcp__bridge_')).name;
  const schema = await f.invoke('get_tool_schema', { name });
  assert.equal(schema.matches[0].name, name);
  assert.equal((await f.invoke('call_tool', { name, arguments: { file } })).status, 'accepted');
  assert.equal(calls.length, 1); assert.equal(calls[0].session, id); assert.equal(calls[0].input.sourceRef, source.sourceRef);
  assert.equal(calls[0].files.length, 1, 'file identity admission was not bypassed');
  const narrow = join(f.root, 'narrow'); await mkdir(narrow);
  const denied = await f.begin(name, { file }, { metadata: { ...f.parent().metadata, workspaceDir: narrow } });
  await until(async () => { const current = await f.read(); if (!current.busy) assert.fail(JSON.stringify(f.results.get(denied))); return current.management.permissions.length === 1; });
  await f.answer((await f.read()).management.permissions[0], 'deny');
  assert.equal((await f.complete(denied)).status, 'failed'); assert.equal(calls.length, 1);
  assert.equal((await f.invoke(name, { file }, { metadata: { ...f.parent().metadata, botDeliveryLocalOnly: true } })).status, 'failed');
  assert.equal((await f.invoke(name, { file }, { metadata: { ...f.parent().metadata, toolExecutionPolicy: 'web_restricted' } })).status, 'failed');
  assert.equal((await f.invoke(name, { file, source_ref: 'another-source' }, { metadata: { ...f.parent().metadata, botSourceRef: source.sourceRef } })).status, 'failed');
  assert.equal(calls.length, 1);
  connected = false; await bridge.sync(id);
  assert.equal((await f.invoke('get_tool_schema', { name })).status, 'failed');
});
async function seedExistingSchedule(f) {
  await f.scheduler.remember(f.parent());
  return f.scheduler.manage({ action: 'create', definition: {
    name: schedule.name, sessionId: id, prompt: schedule.prompt, trigger: schedule.trigger, timeZone: schedule.time_zone,
  } });
}

test('assistant manages existing schedules using saved execution settings, reads results and preserves them across context reset', async t => {
  const f = await fixture(t);
  const created = await seedExistingSchedule(f);
  assert.equal(created.state, 'active', JSON.stringify(created));
  assert.equal((await f.invoke('schedule_task', { action: 'list' })).jobs[0].id, created.id);
  const schemas = f.requests[0].tools.map(tool => tool.name);
  for (const name of ASSISTANT_MANAGEMENT_TOOLS) assert.ok(schemas.includes(name), name);
  for (const name of ['call_tool', 'get_tool_schema']) assert.ok(schemas.includes(name), name);
  for (const name of ['mcp_search', 'search_skills', 'mcp__fixture__report', 'terminal_exec', 'update_goal']) assert.ok(!schemas.includes(name), name);
  const saved = JSON.parse(await readFile(join(f.root, 'automations.json'), 'utf8')).jobContexts[created.id];
  assert.equal(saved.model, 'fixture-model'); assert.equal(saved.permissionMode, 'task_free'); assert.equal(saved.metadata.workspaceDir, f.root);
  assert.ok(saved.tools.some(tool => tool.name === 'mcp__fixture__report'), 'timer retains execution tools');
  assert.equal(saved.messages, undefined, 'timer does not inherit the conversational history');
  assert.equal((await f.invoke('schedule_task', { action: 'get', job_id: created.id })).prompt, schedule.prompt);
  assert.equal((await f.invoke('schedule_task', { action: 'pause', job_id: created.id })).state, 'paused');
  assert.equal((await f.invoke('schedule_task', { action: 'resume', job_id: created.id })).state, 'active');
  const current = (await f.scheduler.list()).jobs[0];
  const updated = await f.invoke('schedule_task', { ...schedule, action: 'update', job_id: created.id, expected_revision: current.revision, name: 'Updated report' });
  assert.equal(updated.name, 'Updated report');
  assert.equal((await f.invoke('schedule_task', { ...schedule, action: 'update', job_id: created.id, expected_revision: 1 })).status, 'failed');
  await f.invoke('schedule_task', { action: 'run', job_id: created.id });
  await until(async () => (await f.scheduler.list()).jobs[0].runs.at(-1)?.status === 'completed');
  assert.equal(f.runs.length, 1); assert.notEqual(f.runs[0].run.sessionId, id);
  const inbox = await f.invoke('scheduled_results', {});
  assert.equal(inbox.results.length, 1); assert.equal(inbox.results[0].status, 'completed');
  await f.command({ action: 'reset' });
  assert.equal((await f.scheduler.list()).jobs.length, 1, 'resetting conversation does not delete scheduled work');
  const foreign = await f.scheduler.manage({ action: 'create', definition: { name: 'Other', sessionId: id, prompt: 'Other task', timeZone: 'Asia/Shanghai', trigger: schedule.trigger } });
  assert.equal((await f.invoke('schedule_task', { action: 'delete', job_id: 'foreign-or-missing' })).status, 'failed');
  await f.invoke('schedule_task', { action: 'delete', job_id: created.id });
  assert.deepEqual((await f.scheduler.list()).jobs.map(job => job.id), [foreign.id]);
});

test('a foreground Assistant registration can trigger on its own successful tool receipt without a timer or inference', async t => {
  const f = await fixture(t); await f.configureEvents();
  const receipt = await f.invoke('assistant_event', { action: 'create', text: 'Report the next successful event tool receipt',
    destination: 'here', reminderText: 'Received.',
    trigger: { source: 'runtime', code: "return Number(observation.kind === 'tool_returned' && observation.toolName === 'assistant_event' && observation.status === 'completed')" } });
  await until(async () => (await f.read()).entries.some(entry => entry.eventId === receipt.eventId && entry.content === 'Received.'));
  const event = await f.invoke('assistant_event', { action: 'read', eventId: receipt.eventId });
  assert.equal(event.status, 'completed'); assert.equal(event.nextAt, null); assert.equal(event.result.text, 'Received.');
  assert.equal(f.requests.filter(request => request.metadata.friendsExecution).length, 0);
});

test('new assistant reminders and subscriptions register only as events while a pre-existing timer still fires once', async t => {
  let time = Date.parse('2099-10-29T00:00:00Z');
  const f = await fixture(t, () => time);
  await f.configureEvents();
  const old = await seedExistingSchedule(f);
  const blocked = await f.invoke('schedule_task', schedule);
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.error, /assistant_event/);
  const actions = f.requests[0].tools.find(tool => tool.name === 'schedule_task').inputSchema.properties.action.enum;
  assert.ok(!actions.includes('create'));
  assert.ok(!f.registry.resolve('schedule_task').definition.inputSchema.properties.action.enum.includes('create'), 'all new registrations use events');

  const once = await f.invoke('assistant_event', reminder);
  const recurring = { action: 'subscribe', text: 'Remind me to review the report every Friday at 10:00 Asia/Shanghai.', topic: 'Friday report', at: '2099-10-30T10:00:00+08:00' };
  const subscription = await f.invoke('assistant_event', recurring);
  assert.equal((await f.invoke('assistant_event', recurring)).eventId, subscription.eventId);
  const state = await f.readEvents();
  assert.deepEqual(state.events.map(event => [event.id, Boolean(event.subscription), event.status]),
    [[once.eventId, false, 'watching'], [subscription.eventId, true, 'watching'], ['session-event:' + old.id, false, 'watching']]);
  assert.deepEqual(state.detections.map(detection => Date.parse(detection.at)), [reminder.at, recurring.at, old.nextRunAt].map(Date.parse));
  assert.deepEqual((await f.scheduler.list()).jobs.map(job => job.id), [old.id]);

  time = Date.parse(old.nextRunAt);
  await f.scheduler.tick(); await until(async () => (await f.scheduler.list()).jobs[0].state === 'completed');
  await f.scheduler.tick();
  assert.deepEqual(f.runs.map(run => run.job.id), [old.id]);
  assert.equal(f.runs[0].ctx.metadata.workspaceDir, f.root);
  assert.equal((await f.invoke('scheduled_results', {})).results[0].jobId, old.id);
});

test('assistant registers and edits a local calendar rule through ordinary tool admission', async t => {
  const f = await fixture(t); await f.configureEvents();
  const recurrence = { unit: 'week', interval: 1, startLocal: '2099-04-06T09:00', timeZone: 'Asia/Shanghai' };
  const registration = { action: 'subscribe', text: 'Send the weekly report.', topic: 'Reports', recurrence };
  const receipt = await f.invoke('assistant_event', registration);
  assert.equal(receipt.nextAt, '2099-04-06T01:00:00.000Z', JSON.stringify(receipt));
  const revised = { ...recurrence, timeZone: '+05:30' };
  const edit = { action: 'continue', eventId: receipt.eventId, text: 'Use the new time zone.', recurrence: revised };
  assert.equal((await f.invoke('assistant_event', edit)).nextAt, '2099-04-06T03:30:00.000Z');
  assert.equal((await f.invoke('assistant_event', { ...edit, recurrence: { ...revised, interval: Number.MAX_SAFE_INTEGER } })).status, 'failed');
  assert.equal((await f.invoke('assistant_event', { ...registration, at: schedule.trigger.at })).status, 'failed');
  const snapshot = await f.readEvents();
  assert.deepEqual(snapshot.events.map(event => event.recurrence), [revised]);
  assert.equal(snapshot.detections.length, 1);
  assert.equal((await f.scheduler.list()).jobs.length, 0);
});

test('capability discovery respects enabled tools and visibility without executing or delegating catalog entries', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke('search_plugins', { mode: 'skill', query: 'spreadsheet' })).matches[0].name, 'sheets');
  assert.equal((await f.invoke('list_plugin_commands', {})).commands[0].id, 'fixture:report');
  const found = await f.invoke('search_plugins', { mode: 'mcp', query: '*' });
  assert.deepEqual(found.matches.map(item => item.name), ['mcp__fixture__report']); assert.equal(found._page, undefined);
  assert.equal((await f.invoke('call_tool', { name: 'mcp__fixture__report', arguments: {} })).code, 'tool_not_exposed');
  assert.equal(f.executed(), 0);
  const metadata = { ...f.parent().metadata, disabledSkills: ['sheets'], builtinPluginCommandsAvailable: false };
  assert.deepEqual((await f.invoke('search_plugins', { mode: 'skill', query: '*' }, { metadata })).matches, []);
  assert.equal((await f.invoke('list_plugin_commands', {}, { metadata })).code, 'tool_unavailable');
  assert.equal((await f.invoke('schedule_task', schedule, { tools: [] })).code, 'tool_unavailable');
  assert.equal((await f.invoke('schedule_task', schedule, { metadata: { toolExecutionPolicy: 'none' } })).code, 'tool_unavailable');
  assert.equal((await f.invoke('schedule_task', schedule, { metadata: { agentRole: 'child' } })).code, 'tool_unavailable');
  assert.equal((await f.scheduler.list()).jobs.length, 0);
});

test('overall plan uses revision checks and durable projection, then clears durably on assistant reset', async t => {
  const f = await fixture(t);
  const first = await f.invoke('update_task_plan', { nodes: [{ step: 'Prepare report', status: 'in_progress' }, { step: 'Deliver report', status: 'pending' }] });
  assert.equal(first.revision, 1);
  assert.equal((await f.read()).management.plan.plan.nodes.length, 2);
  const updated = await f.invoke('update_task_plan', { action: 'patch', expected_revision: 1, updates: [{ id: first.plan.nodes[0].id, status: 'completed' }] });
  assert.equal(updated.revision, 2);
  assert.equal((await f.invoke('update_task_plan', { action: 'patch', expected_revision: 1, explanation: 'Stale' })).status, 'failed');
  const reloaded = () => new CoordinationStore({ persistence: f.persistence }).getPlan(id);
  assert.equal(reloaded().revision, 2);
  await f.command({ action: 'reset' });
  assert.equal((await f.read()).management.plan, undefined); assert.equal(reloaded(), undefined);
  const replacement = await f.invoke('update_task_plan', { nodes: [{ step: 'New task', status: 'in_progress' }] });
  assert.equal(replacement.revision, 1); assert.notEqual(replacement.plan.plan_id, first.plan.plan_id);
});

test('Assistant uses the local plugin lifecycle tool through its existing permission and receipt pipeline', async t => {
  const f = await fixture(t), performed = [];
  const name = 'mcp__cardbush_management__uninstall_plugin';
  f.registry.register({
    definition: { name, description: 'Uninstall a local fixture plugin', inputSchema: { type: 'object',
      properties: { plugin_id: { type: 'string' } }, required: ['plugin_id'], additionalProperties: false } },
    registrationOwner: 'runtime_mcp',
    manifest: { effect_kind: 'external_mcp', operation: 'mcp.cardbush_management.uninstall_plugin',
      risk: 'requires_user_permission', owner: 'mcp:cardbush_management', dispatch_scope: 'external', mutating: true },
    mcpHook: { server: 'cardbush_management', tool: 'uninstall_plugin', modelVisible: true, call: async () => ({}) },
    decodeInput: input => input,
    authorize: () => ({ kind: 'ask', request: { reason: 'Uninstall requires approval', actions: ['external_tool_call'],
      targets: [{ kind: 'mcp_resource', value: name }], capabilityIds: ['uninstall-fixture'] } }),
    execute: ({ input }) => { performed.push(input.plugin_id); return { status: 'uninstalled', plugin_id: input.plugin_id }; },
  });
  const schema = await f.invoke('get_tool_schema', { name });
  assert.equal(schema.matches[0].name, name);
  assert.ok(!f.requests.at(-1).tools.some(tool => tool.name === name), 'marketplace tool schemas are loaded on demand');
  const requested = await f.begin('call_tool', { name, arguments: { plugin_id: 'isolated-test' } });
  await until(async () => {
    const current = await f.read();
    if (!current.busy) assert.fail(JSON.stringify({ receipt: f.results.get(requested), error: current.error, performed }));
    return current.management.permissions.length === 1;
  });
  assert.deepEqual(performed, []);
  await f.answer((await f.read()).management.permissions[0], 'allow_once');
  assert.equal((await f.complete(requested)).status, 'uninstalled');
  assert.deepEqual(performed, ['isolated-test']);
  const restricted = await f.invoke(name, { plugin_id: 'isolated-test' }, { metadata: { toolExecutionPolicy: 'web_restricted' } });
  assert.equal(restricted.code, 'tool_unavailable');
  assert.deepEqual(performed, ['isolated-test']);
});

for (const decision of ['deny', 'cancel', 'allow_once', 'allow_session', 'reset']) test(`management permission ${decision} follows the host broker and records the actual outcome`, async t => {
  const f = await fixture(t); await f.configureEvents();
  f.registry.resolve('assistant_event').authorize = () => ({ kind: 'ask', request: { reason: 'Reminder needs approval', actions: ['event.create'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['event.create'] } });
  const call = await f.begin('assistant_event', reminder);
  await until(async () => { const state = await f.read(); if (!state.busy) assert.fail(JSON.stringify(f.results.get(call))); return state.management.permissions.length === 1; });
  assert.equal((await f.readEvents()).events.length, 0);
  const permission = (await f.read()).management.permissions[0];
  assert.equal(permission.sessionId, id); assert.equal(permission.toolCallId, call);
  assert.deepEqual(permission.request.requestedCapabilityIds, ['event.create']);
  assert.equal((await f.environment()).sections.agents.self.status, 'waiting');
  if (decision === 'reset') await f.command({ action: 'reset' }); else await f.answer(permission, decision);
  await f.complete(call);
  assert.equal((await f.environment()).sections.agents.self?.status, decision === 'reset' ? undefined : 'completed');
  assert.equal((await f.read()).management.permissions.length, 0);
  const granted = decision.startsWith('allow');
  assert.equal((await f.readEvents()).events.length, granted ? 1 : 0);
  await until(() => f.executions.get(id, 't-1', call));
  assert.equal(f.executions.get(id, 't-1', call).outcome, granted ? 'returned' : decision === 'deny' ? 'failed' : 'cancelled');
  if (decision === 'allow_session') {
    const second = await f.invoke('assistant_event', { ...reminder, text: 'Second reminder' }); assert.ok(second.eventId);
    assert.equal((await f.read()).management.permissions.length, 0);
  }
});

test('full-control management uses ordinary admission semantics without creating a human permission card', async t => {
  const f = await fixture(t); await f.configureEvents();
  f.registry.resolve('assistant_event').authorize = () => ({ kind: 'ask', request: { reason: 'Reminder needs approval', actions: ['event.create'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['event.create'] } });
  const created = await f.invoke('assistant_event', reminder, { permissionMode: 'all_free' });
  assert.ok(created.eventId); assert.equal((await f.read()).management.permissions.length, 0);
});

test('trusted pre-tool policy still blocks assistant management even with full control', async t => {
  const f = await fixture(t), script = join(f.root, 'block.cjs'); await f.configureEvents();
  await writeFile(script, `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Blocked by fixture policy'}}));`);
  f.hooks.push({ id: 'block-event', pluginId: 'fixture', root: f.root, event: 'PreToolUse', matcher: 'assistant_event', dialect: 'claude', type: 'command',
    trusted: true, command: process.execPath, args: [script], timeout: 10 });
  const result = await f.invoke('assistant_event', reminder, { permissionMode: 'all_free' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /Blocked by fixture policy/);
  assert.equal((await f.readEvents()).events.length, 0);
});

test('retrying a reply after registration retains the receipt and never resubmits the event', async t => {
  const f = await fixture(t); await f.configureEvents(); f.faults.reply = true;
  const call = await f.begin('assistant_event', reminder);
  await until(async () => !(await f.read()).busy);
  assert.match((await f.read()).error, /Fixture reply interrupted/);
  const event = (await f.readEvents()).events[0]; assert.ok(event);
  assert.equal(f.executions.get(id, 't-1', call).outcome, 'returned');
  await f.command({ action: 'retry', parent: f.parent(), profile: assistantProfileSchema.parse({}) });
  await f.complete(call);
  assert.deepEqual((await f.readEvents()).events.map(item => item.id), [event.id]);
  assert.ok(f.requests.at(-1).messages.some(item => item.role === 'tool' && item.toolCallId === call && JSON.parse(item.content).eventId === event.id));
});
