import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationScheduler, InMemoryRuntimeHost, ToolRegistry } from '../dist/index.js';
import { PluginHookRunner } from '../dist/pluginHookRunner.js';

const context = (sessionId = 'session') => ({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId, turnId: 'human-turn', model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Follow the user.' }], inputMessages: [{ messageId: 'human-input', message: { role: 'user', content: 'Hello' } }],
  tools: [], metadata: {}, permissionMode: 'task_free', requestCapabilities: { interactiveRequests: true, vision: false }, sessionMetadata: { title: 'Fixture' } });
const definition = (trigger, sessionId = 'session') => ({ name: 'Review', sessionId, prompt: 'Review the project.', timeZone: 'Asia/Shanghai', trigger });
const until = async check => { const deadline = Date.now() + 3000; while (!await check()) { if (Date.now() > deadline) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-automation-')); let now = Date.parse('2026-09-09T00:00:00Z'), idle = false;
  const calls = [];
  const options = { path: join(root, 'automations.json'), now: () => now, canRun: () => idle,
    run: async (job, run, ctx) => { calls.push({ job, run, ctx }); return { status: 'completed', reason: 'done' }; }, ...overrides };
  const scheduler = new AutomationScheduler(options);
  t.after(async () => { await scheduler.close(); assert.ok(root.startsWith(join(tmpdir(), 'cardbush-automation-'))); await rm(root, { recursive: true, force: true }); });
  await scheduler.remember(context());
  return { root, scheduler, options, calls, setIdle: value => { idle = value; }, advance: ms => { now += ms; } };
}
test('one-time jobs wait for the target session, run once and survive reload without replay', async t => {
  const f = await fixture(t);
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T08:00:00+08:00' }) });
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  assert.equal((await f.scheduler.list()).jobs[0].runs[0].status, 'queued');
  f.setIdle(true); await f.scheduler.tick();
  await until(async () => (await f.scheduler.list()).jobs[0].state === 'completed');
  await Promise.all(Array.from({ length: 8 }, () => f.scheduler.tick())); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].ctx.permissionMode, 'task_free');
  await f.scheduler.close();
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  await reloaded.tick(); assert.equal(f.calls.length, 1);
  assert.equal((await reloaded.list()).jobs[0].id, job.id);
});
test('recurring missed times coalesce; pause, explicit run, revision fences and session ownership share one store', async t => {
  const f = await fixture(t);
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'interval', at: '2026-09-08T00:00:00Z', seconds: 60 }) }, 'session');
  f.setIdle(true); await until(async () => { await f.scheduler.tick(); return f.calls.length === 1; });
  await until(async () => (await f.scheduler.list()).jobs[0].runs[0].status === 'completed');
  assert.equal((await f.scheduler.list()).jobs[0].nextRunAt, '2026-09-09T00:01:00.000Z');
  await assert.rejects(f.scheduler.manage({ action: 'update', id: job.id, expectedRevision: 1, definition: definition(job.trigger) }), /changed/);
  await assert.rejects(f.scheduler.manage({ action: 'pause', id: job.id }, 'other'), /not found/);
  await f.scheduler.manage({ action: 'pause', id: job.id }); f.advance(3600000); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  await f.scheduler.manage({ action: 'run', id: job.id });
  await until(async () => (await f.scheduler.list()).jobs[0].runs.at(-1).status === 'completed');
  assert.equal(f.calls.length, 2); assert.equal((await f.scheduler.list()).jobs[0].state, 'paused');
  await f.scheduler.manage({ action: 'resume', id: job.id }); f.advance(60000); await f.scheduler.tick();
  await until(() => f.calls.length === 3);
  assert.equal((await f.scheduler.list('other')).jobs.length, 0);
});
test('hook event matching, deduplication and cooldown never create overlapping runs', async t => {
  const f = await fixture(t);
  await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'event', event: 'PostToolUse', tool: 'read_file', cooldownSeconds: 60 }) });
  const event = { id: 'event-1', sessionId: 'session', event: 'PostToolUse', tool: 'read_file' };
  await f.scheduler.emit({ ...event, tool: 'write_file' }); assert.equal((await f.scheduler.list()).jobs[0].runs.length, 0);
  await Promise.all([f.scheduler.emit(event), f.scheduler.emit(event)]); assert.equal((await f.scheduler.list()).jobs[0].runs.length, 1);
  f.setIdle(true); await f.scheduler.tick(); await until(async () => (await f.scheduler.list()).jobs[0].runs[0].status === 'completed');
  await f.scheduler.emit({ ...event, id: 'event-2' }); assert.equal((await f.scheduler.list()).jobs[0].runs.length, 1);
  f.advance(61000); await f.scheduler.emit(event); assert.equal((await f.scheduler.list()).jobs[0].runs.length, 1);
  await f.scheduler.emit({ ...event, id: 'event-3' }); await f.scheduler.tick(); await until(() => f.calls.length === 2);
});
test('running jobs can be stopped and an interrupted persisted run is paused after restart', async t => {
  const f = await fixture(t, { run: async (_job, _run, _context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  f.setIdle(true); await until(async () => { await f.scheduler.tick(); return (await f.scheduler.list()).jobs[0].runs[0]?.status === 'running'; });
  await assert.rejects(f.scheduler.manage({ action: 'delete', id: job.id }), /Stop the running/);
  const crash = JSON.parse(await readFile(f.options.path, 'utf8'));
  await f.scheduler.manage({ action: 'stop', id: job.id });
  await until(async () => (await f.scheduler.list()).jobs[0].runs[0].status === 'stopped');
  await f.scheduler.close(); await writeFile(f.options.path, JSON.stringify(crash));
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  const restored = (await reloaded.list()).jobs[0]; assert.equal(restored.state, 'paused'); assert.equal(restored.runs[0].status, 'interrupted');
  await reloaded.tick(); assert.equal((await reloaded.list()).jobs[0].runs.length, 1);
});

test('a foreground admission race requeues the same run without executing or pausing the job', async t => {
  let attempts = 0;
  const f = await fixture(t, { run: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Foreground session won admission.'), { code: 'runtime_session_busy' });
    return { status: 'completed', reason: 'done' };
  } });
  await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  f.setIdle(true); await f.scheduler.tick();
  await until(async () => attempts === 1 && (await f.scheduler.list()).jobs[0].runs[0]?.status === 'queued');
  const queued = (await f.scheduler.list()).jobs[0]; assert.equal(queued.state, 'active'); assert.equal(queued.runs.length, 1);
  await f.scheduler.tick(); await until(async () => (await f.scheduler.list()).jobs[0].state === 'completed');
  assert.equal((await f.scheduler.list()).jobs[0].runs[0].id, queued.runs[0].id);
});

test('trusted plugin activations deduplicate, retain provenance, and failed or approval-blocked runs pause', async t => {
  const f = await fixture(t, { run: async () => ({ status: 'awaiting_user_action', reason: 'permission_required' }) });
  const input = { sessionId: 'session', prompt: 'Review the completed export.', plugin: { id: 'exporter', hookId: 'exporter:Stop', definitionHash: 'reviewed-hash' }, eventId: 'turn:Stop' };
  await Promise.all([f.scheduler.wakePlugin(input), f.scheduler.wakePlugin(input)]);
  assert.equal((await f.scheduler.list()).jobs.length, 1);
  assert.deepEqual((await f.scheduler.list()).jobs[0].plugin, input.plugin);
  f.setIdle(true); await f.scheduler.tick(); await until(async () => (await f.scheduler.list()).jobs[0].state === 'paused');
  assert.equal((await f.scheduler.list()).jobs[0].runs[0].status, 'awaiting_user_action');
  await f.scheduler.wakePlugin(input); assert.equal((await f.scheduler.list()).jobs.length, 1);
  await f.scheduler.wakePlugin({ ...input, eventId: 'different-turn:Stop' });
  assert.equal((await f.scheduler.list()).jobs[0].runs.length, 1, 'pausing a hook activation suppresses subsequent events too');
});
test('invalid stores fail visibly without erasure; unsafe timestamps and unknown sessions are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T08:00:00' }) }), /ISO datetime/);
  await assert.rejects(f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }, 'unknown') }), /Send a message/);
  const path = join(f.root, 'broken.json'); await writeFile(path, 'broken');
  const broken = new AutomationScheduler({ ...f.options, path });
  await assert.rejects(broken.list()); assert.equal(await readFile(path, 'utf8'), 'broken');
});
test('real runtime turns and schedule_task share context, events and permission scope without self-trigger loops', async t => {
  let host; const seen = [];
  const registry = new ToolRegistry();
  const f = await fixture(t, { canRun: () => !host?.hasActiveSession('session'), run: async (job, run, ctx, signal) => {
    const result = await host.runSessionTurn({ ...context(job.sessionId), ...ctx, requestId: run.id, turnId: run.turnId,
      metadata: { ...ctx.metadata, automationRunId: run.id }, inputMessages: [{ messageId: run.id, message: { role: 'user', name: 'automation_prompt', content: job.prompt } }] }, { signal });
    return result.payload;
  } });
  host = new InMemoryRuntimeHost({ automation: f.scheduler, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) { seen.push(request); yield { protocol: 'bush.model_event.v1', kind: 'text_delta', requestId: request.requestId, sequence: 1, createdAt: new Date().toISOString(), delta: 'Done' };
      yield { protocol: 'bush.model_event.v1', kind: 'response_completed', requestId: request.requestId, sequence: 2, createdAt: new Date().toISOString(), finishReason: 'stop' }; } } });
  const schedule = registry.resolve('schedule_task'); assert.equal(schedule.visibleToChild, false);
  await host.runSessionTurn(context());
  const job = await schedule.execute({ sessionId: 'session', turn: { request: { metadata: {} } }, input: { action: 'create', name: 'Follow up', prompt: 'Review the last result', trigger: { kind: 'event', event: 'Stop' } } });
  assert.equal((await f.scheduler.list()).jobs[0].id, job.id);
  await host.runSessionTurn({ ...context(), turnId: 'human-turn-2', requestId: 'request-2', inputMessages: [{ messageId: 'human-input-2', message: { role: 'user', content: 'Next task' } }] });
  await f.scheduler.tick(); await until(async () => (await f.scheduler.list()).jobs[0].runs.at(-1)?.status === 'completed');
  assert.equal(seen.length, 3); assert.equal(seen[2].permissionMode, 'task_free');
  await f.scheduler.tick(); assert.equal((await f.scheduler.list()).jobs[0].runs.length, 1, 'scheduled turns cannot activate their own Stop rule');
  const session = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'session' } });
  assert.equal(session.turns.length, 3);
  assert.ok(session.turns.at(-1).messages.some(row => row.message.content === 'Review the last result'));
});
test('only executed trusted hooks can request a queued agent activation through structured output', async () => {
  const activations = [], calls = [];
  const runner = new PluginHookRunner('.', { callMcp: async hook => { calls.push(hook.id); return { structuredContent: { cardbush: { activateAgent: { prompt: 'Inspect the completed export.' } } } }; },
    activateAgent: async (hook, prompt) => { activations.push({ id: hook.id, prompt }); } });
  const hook = { id: 'fixture-hook', pluginId: 'fixture', root: '.', command: '', type: 'mcp_tool', server: 'fixture', tool: 'read', event: 'PostToolUse', matcher: '*', timeout: 2, trusted: true };
  await runner.run([{ ...hook, trusted: false }], 'PostToolUse', { request: context(), toolName: 'read_file' }); assert.equal(calls.length, 0);
  await runner.run([hook], 'PostToolUse', { request: context(), toolName: 'read_file' });
  assert.deepEqual(activations, [{ id: 'fixture-hook', prompt: 'Inspect the completed export.' }]); await runner.close();
});
