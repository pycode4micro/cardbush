import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionStore, AutomationScheduler,
  CoordinationStore, FileCoordinationPersistence, registerSkillTools } from '../dist/index.js';
import { PERSONAL_ASSISTANT_SESSION as id, ASSISTANT_MANAGEMENT_TOOLS, assistantProfileSchema } from '@cardbush/bush-protocol';

const until = async check => { for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
const manifest = { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false };
async function fixture(t) {
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
  const scheduler = new AutomationScheduler({ path: join(root, 'automations.json'), canRun: () => true, sessionExists: key => key === id,
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
  const begin = async (name, args, patch = {}) => {
    sequence++; const callId = `call-${sequence}`; batch = [{ id: callId, name, args }];
    await command({ action: 'turn', entry: { id: `input-${sequence}`, content: 'Manage the requested work.', role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
      parent: { ...parent(), ...patch }, profile: assistantProfileSchema.parse({}) }); return callId;
  };
  const complete = async callId => { await until(async () => !(await read()).busy); assert.equal((await read()).error, ''); return results.get(callId); };
  t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await scheduler.close(); persistence.close?.();
    assert.ok(root.startsWith(join(tmpdir(), 'assistant-management-'))); await rm(root, { recursive: true, force: true }); });
  return { root, registry, scheduler, runs, requests, results, hooks, faults, executions, coordination, persistence, read, command, begin, complete, parent,
    executed: () => executed, invoke: async (name, args, patch) => complete(await begin(name, args, patch)),
    answer: (permission, decision) => host.sendCommand({ kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1', permissionId: permission.permissionId,
      answerId: randomUUID(), decision, ...(['allow_once', 'allow_session'].includes(decision) ? { grantedCapabilityIds: permission.request.requestedCapabilityIds } : {}) } }) };
}
const schedule = { action: 'create', name: 'Report', prompt: 'Read the fixture project and save report.html; return its path.', time_zone: 'Asia/Shanghai', trigger: { kind: 'once', at: '2099-10-30T10:00:00+08:00' } };

test('assistant saves and manages schedules using full execution settings, reads results and preserves them across context reset', async t => {
  const f = await fixture(t);
  const created = await f.invoke('schedule_task', schedule);
  assert.equal(created.state, 'active', JSON.stringify(created));
  const schemas = f.requests[0].tools.map(tool => tool.name);
  for (const name of ASSISTANT_MANAGEMENT_TOOLS) assert.ok(schemas.includes(name), name);
  for (const name of ['call_tool', 'get_tool_schema', 'mcp__fixture__report', 'terminal_exec', 'update_goal']) assert.ok(!schemas.includes(name), name);
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

test('capability discovery respects enabled tools and visibility without executing or delegating catalog entries', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke('search_skills', { query: 'spreadsheet' })).matches[0].name, 'sheets');
  assert.equal((await f.invoke('list_plugin_commands', {})).commands[0].id, 'fixture:report');
  const found = await f.invoke('mcp_search', { query: '*' });
  assert.deepEqual(found.matches.map(item => item.name), ['mcp__fixture__report']); assert.equal(found._searchPage, undefined);
  assert.equal((await f.invoke('call_tool', { name: 'mcp__fixture__report', arguments: {} })).code, 'tool_unavailable');
  assert.equal(f.executed(), 0);
  const metadata = { ...f.parent().metadata, disabledSkills: ['sheets'], builtinPluginCommandsAvailable: false };
  assert.deepEqual((await f.invoke('search_skills', { query: '*' }, { metadata })).matches, []);
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

for (const decision of ['deny', 'cancel', 'allow_once', 'allow_session', 'reset']) test(`management permission ${decision} follows the host broker and records the actual outcome`, async t => {
  const f = await fixture(t);
  f.registry.resolve('schedule_task').authorize = () => ({ kind: 'ask', request: { reason: 'Schedule needs approval', actions: ['schedule.create'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['schedule.create'] } });
  const call = await f.begin('schedule_task', schedule);
  await until(async () => { const state = await f.read(); if (!state.busy) assert.fail(JSON.stringify(f.results.get(call))); return state.management.permissions.length === 1; });
  assert.equal((await f.scheduler.list()).jobs.length, 0);
  const permission = (await f.read()).management.permissions[0];
  assert.equal(permission.sessionId, id); assert.equal(permission.toolCallId, call);
  assert.deepEqual(permission.request.requestedCapabilityIds, ['schedule.create']);
  if (decision === 'reset') await f.command({ action: 'reset' }); else await f.answer(permission, decision);
  await f.complete(call);
  assert.equal((await f.read()).management.permissions.length, 0);
  const granted = decision.startsWith('allow');
  assert.equal((await f.scheduler.list()).jobs.length, granted ? 1 : 0);
  await until(() => f.executions.get(id, 't-1', call));
  assert.equal(f.executions.get(id, 't-1', call).outcome, granted ? 'returned' : decision === 'deny' ? 'failed' : 'cancelled');
  if (decision === 'allow_session') {
    const second = await f.invoke('schedule_task', { ...schedule, name: 'Second report' }); assert.ok(second.id);
    assert.equal((await f.read()).management.permissions.length, 0);
  }
});

test('full-control management uses ordinary admission semantics without creating a human permission card', async t => {
  const f = await fixture(t);
  f.registry.resolve('schedule_task').authorize = () => ({ kind: 'ask', request: { reason: 'Schedule needs approval', actions: ['schedule.create'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['schedule.create'] } });
  const created = await f.invoke('schedule_task', schedule, { permissionMode: 'all_free' });
  assert.ok(created.id); assert.equal((await f.read()).management.permissions.length, 0);
});

test('trusted pre-tool policy still blocks assistant management even with full control', async t => {
  const f = await fixture(t), script = join(f.root, 'block.cjs');
  await writeFile(script, `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Blocked by fixture policy'}}));`);
  const command = `"${process.execPath}" "${script}"`;
  f.hooks.push({ id: 'block-schedule', pluginId: 'fixture', root: f.root, event: 'PreToolUse', matcher: 'schedule_task', dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  const result = await f.invoke('schedule_task', schedule, { permissionMode: 'all_free' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /Blocked by fixture policy/);
  assert.equal((await f.scheduler.list()).jobs.length, 0);
});

test('retrying a reply after scheduling retains the receipt and never resubmits the job', async t => {
  const f = await fixture(t); f.faults.reply = true;
  const call = await f.begin('schedule_task', schedule);
  await until(async () => !(await f.read()).busy);
  assert.match((await f.read()).error, /Fixture reply interrupted/);
  const job = (await f.scheduler.list()).jobs[0]; assert.ok(job);
  assert.equal(f.executions.get(id, 't-1', call).outcome, 'returned');
  await f.command({ action: 'retry', parent: f.parent(), profile: assistantProfileSchema.parse({}) });
  await f.complete(call);
  assert.deepEqual((await f.scheduler.list()).jobs.map(item => item.id), [job.id]);
  assert.ok(f.requests.at(-1).messages.some(item => item.role === 'tool' && item.toolCallId === call && JSON.parse(item.content).id === job.id));
});
