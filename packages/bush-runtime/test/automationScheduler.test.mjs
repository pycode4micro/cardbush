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
test('one-time jobs wait for runtime admission, run once and survive reload without replay', async t => {
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
test('temporary timers keep owned settings across source deletion, collection, restart and editing', async t => {
  const f = await fixture(t);
  await f.scheduler.remember({ ...context(), model: 'saved-model', temperature: 0, topP: 0.8,
    metadata: { workspaceDir: 'fixture-project', allowedSkills: ['review'] },
    tools: [{ name: 'inspect', description: 'Inspect', inputSchema: { type: 'object' } }] });
  const job = await f.scheduler.manage({ action: 'create', definition: { ...definition({ kind: 'interval', at: '2026-09-09T01:00:00Z', seconds: 60 }), executionMode: 'conversation' } });
  assert.equal(job.executionMode, 'isolated', 'clock runs always use temporary sessions');
  await f.scheduler.remember({ ...context(), model: 'later-model', permissionMode: 'all_free' });
  await f.scheduler.sessionDeleted('session');
  const before = await f.scheduler.list(); assert.equal(before.jobs[0].state, 'active'); assert.equal(before.sessions.length, 0);
  const collected = await f.scheduler.collectContexts(new Set());
  assert.equal(collected.roots.jobContexts[job.id].model, 'saved-model', 'source turns never silently change a saved timer');
  assert.equal(collected.roots.jobContexts[job.id].inputMessages, undefined);
  assert.doesNotMatch(JSON.stringify(before), /saved-model|prefixMessages|jobContexts/);
  await f.scheduler.close(); f.setIdle(true);
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  await reloaded.manage({ action: 'update', id: job.id, definition: { ...definition(job.trigger), prompt: 'Updated self-contained task.' } });
  await reloaded.manage({ action: 'run', id: job.id });
  await until(async () => (await reloaded.list()).jobs[0].runs.at(-1)?.status === 'completed');
  const first = f.calls[0]; assert.notEqual(first.run.sessionId, 'session'); assert.equal(first.ctx.model, 'saved-model');
  assert.equal(first.ctx.permissionMode, 'task_free'); assert.equal(first.ctx.temperature, 0); assert.equal(first.ctx.topP, 0.8);
  assert.equal(first.job.prompt, 'Updated self-contained task.');
  const result = await reloaded.manage({ action: 'conversation', id: job.id, runIds: [first.run.id] });
  assert.equal(result.sourceSession, undefined); assert.equal(result.job.sessionId, 'session');
  assert.equal(result.sessionId, first.run.sessionId); assert.deepEqual(result.allowedTools, ['inspect']);
  assert.equal(result.workspaceDir, 'fixture-project');
  await reloaded.remember(context(first.run.sessionId));
  assert.equal((await reloaded.list()).sessions.length, 0, 'inspector follow-ups do not turn execution settings into source choices');
  await reloaded.manage({ action: 'run', id: job.id });
  await until(() => f.calls.length === 2);
  assert.notEqual(f.calls[1].run.sessionId, first.run.sessionId); assert.equal(f.calls[1].ctx.model, 'saved-model');
  await until(async () => (await reloaded.list()).jobs[0].runs.at(-1)?.status === 'completed');
  await assert.rejects(reloaded.manage({ action: 'create', definition: definition(job.trigger) }), /Send a message/);
  await assert.rejects(reloaded.manage({ action: 'update', id: job.id, definition: definition(job.trigger, 'missing') }), /Send a message/);
  await reloaded.remember({ ...context('replacement'), model: 'replacement-model' });
  await reloaded.manage({ action: 'update', id: job.id, definition: definition(job.trigger, 'replacement') });
  const saved = JSON.parse(await readFile(f.options.path, 'utf8')); assert.equal(saved.jobContexts[job.id].model, 'replacement-model');
  await reloaded.manage({ action: 'delete', id: job.id });
  const cleaned = await reloaded.collectContexts(new Set(['replacement']));
  assert.deepEqual(cleaned.roots.jobContexts, {}); assert.deepEqual(Object.keys(cleaned.roots.contexts), ['replacement']);
});

test('busy source does not block timers; source deletion cancels event queues but preserves a timer queue', async t => {
  let release = false;
  const f = await fixture(t, { canRun: sessionId => release && sessionId !== 'session' });
  const timer = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  const event = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'event', event: 'Stop' }) });
  await f.scheduler.emit({ id: 'stop', sessionId: 'session', event: 'Stop' });
  await f.scheduler.tick();
  const queuedId = (await f.scheduler.list()).jobs[0].runs[0].id;
  await f.scheduler.sessionDeleted('session');
  const jobs = (await f.scheduler.list()).jobs;
  assert.equal(jobs[0].runs[0].status, 'queued'); assert.equal(jobs[1].state, 'paused'); assert.equal(jobs[1].runs[0].status, 'stopped');
  await assert.rejects(f.scheduler.manage({ action: 'resume', id: event.id }), /No conversation execution context/);
  release = true; await f.scheduler.tick();
  await until(async () => (await f.scheduler.list()).jobs[0].state === 'completed');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].job.id, timer.id); assert.equal(f.calls[0].run.id, queuedId);
});

test('legacy queued timers migrate once, preserve paused jobs and recorded run identities', async t => {
  const f = await fixture(t);
  const timer = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  await f.scheduler.tick(); await f.scheduler.close();
  const legacy = JSON.parse(await readFile(f.options.path, 'utf8')); delete legacy.jobContexts;
  delete legacy.jobs[0].executionMode; legacy.jobs[0].runs[0].sessionId = 'session';
  const completed = { ...legacy.jobs[0].runs[0], id: 'completed', turnId: 'completed', status: 'completed', finishedAt: '2026-09-08T00:00:00Z' };
  legacy.jobs[0].runs.unshift(completed);
  legacy.jobs.push({ ...legacy.jobs[0], id: 'paused-timer', state: 'paused', runs: [] });
  await writeFile(f.options.path, JSON.stringify(legacy));
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  const migrated = (await reloaded.list()).jobs;
  assert.equal(migrated[0].runs[0].sessionId, 'session'); assert.notEqual(migrated[0].runs[1].sessionId, 'session');
  assert.equal(migrated[1].state, 'paused');
  await reloaded.sessionDeleted('session'); await reloaded.close();
  f.setIdle(true);
  const restarted = new AutomationScheduler(f.options); t.after(() => restarted.close());
  assert.equal((await restarted.list()).jobs[0].runs[1].sessionId, migrated[0].runs[1].sessionId);
  await restarted.tick(); await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].job.id, timer.id); assert.equal(f.calls[0].ctx.model, 'fixture');
});

test('source links use session existence, not retained settings; missing legacy settings fail once', async t => {
  const live = new Set(['session']);
  const f = await fixture(t, { sessionExists: id => live.has(id) });
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  await f.scheduler.tick();
  const run = (await f.scheduler.list()).jobs[0].runs[0];
  assert.equal((await f.scheduler.manage({ action: 'conversation', id: job.id, runIds: [run.id] })).sourceSession.id, 'session');
  live.clear();
  const detail = await f.scheduler.manage({ action: 'conversation', id: job.id, runIds: [run.id] });
  assert.equal(detail.sourceSession, undefined); assert.equal(detail.executionSessionAvailable, false); assert.equal((await f.scheduler.list()).sessions.length, 0);
  await f.scheduler.close();
  const broken = JSON.parse(await readFile(f.options.path, 'utf8')); delete broken.jobContexts; broken.contexts = {};
  await writeFile(f.options.path, JSON.stringify(broken));
  f.setIdle(true);
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  await reloaded.tick(); await until(async () => (await reloaded.list()).jobs[0].state === 'paused');
  assert.match((await reloaded.list()).jobs[0].runs[0].error, /No conversation execution context/);
  await reloaded.tick(); assert.equal(f.calls.length, 0); assert.equal((await reloaded.list()).jobs[0].runs.length, 1);
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

test('read state belongs to a result, persists independently and cannot acknowledge pending work', async t => {
  const f = await fixture(t, { run: async () => ({ status: 'completed', reason: 'done', result: 'Daily report: one pending item.' }) });
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'interval', at: '2026-09-09T00:00:00Z', seconds: 60 }) });
  await f.scheduler.tick();
  let current = (await f.scheduler.list()).jobs[0];
  await assert.rejects(f.scheduler.manage({ action: 'mark_read', runIds: [current.runs[0].id] }), /Wait for execution/);
  f.setIdle(true); await f.scheduler.tick();
  await until(async () => (await f.scheduler.reminder()).total === 1);
  current = (await f.scheduler.list()).jobs[0]; const run = current.runs[0];
  assert.equal(current.executionMode, 'isolated'); assert.notEqual(run.sessionId, job.sessionId);
  const detail = await f.scheduler.manage({ action: 'conversation', id: job.id, runIds: [run.id] });
  assert.equal(detail.sessionId, run.sessionId); assert.equal(detail.run.result, 'Daily report: one pending item.');
  assert.equal((await f.scheduler.reminder()).total, 1, 'opening a conversation is a read-only operation');
  await f.scheduler.manage({ action: 'mark_read', expectedRevision: 1, runIds: [run.id] });
  current = (await f.scheduler.list()).jobs[0];
  assert.equal(current.revision, detail.job.revision, 'acknowledgment does not invalidate an open plan editor');
  assert.equal(current.state, 'active'); assert.equal(current.runs[0].status, 'completed');
  assert.equal((await f.scheduler.reminder()).total, 0);
  f.advance(60000); await f.scheduler.tick(); await until(async () => (await f.scheduler.reminder()).total === 1);
  const second = (await f.scheduler.list()).jobs[0].runs[1]; assert.notEqual(second.sessionId, run.sessionId); assert.equal(second.readAt, undefined);
  await f.scheduler.close(); const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  assert.equal((await reloaded.reminder()).total, 1);
  await reloaded.manage({ action: 'mark_unread', runIds: [run.id] }); assert.equal((await reloaded.reminder()).total, 2);
  await assert.rejects(reloaded.manage({ action: 'mark_read', runIds: [run.id, 'missing'] }), /not found/);
  assert.equal((await reloaded.reminder()).total, 2, 'batch acknowledgments are atomic');
});

test('unread results keep recorded conversations while older timers migrate future runs', async t => {
  const f = await fixture(t);
  await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  await f.scheduler.tick(); await f.scheduler.close();
  const stored = JSON.parse(await readFile(f.options.path, 'utf8'));
  const job = stored.jobs[0]; delete job.executionMode; job.state = 'paused'; delete job.nextRunAt;
  job.runs = Array.from({ length: 65 }, (_, i) => ({ id: `old-${i}`, turnId: `old-turn-${i}`, queuedAt: '2026-09-08T00:00:00Z', finishedAt: '2026-09-08T00:00:01Z', status: 'completed', reason: 'schedule' }));
  await writeFile(f.options.path, JSON.stringify(stored));
  const reloaded = new AutomationScheduler(f.options); t.after(() => reloaded.close());
  assert.equal((await reloaded.list()).jobs[0].executionMode, 'isolated');
  assert.ok((await reloaded.list()).jobs[0].runs.every(run => run.sessionId === 'session'), 'recorded sessions are never rewritten');
  const reminder = await reloaded.reminder(); assert.equal(reminder.total, 65); assert.equal(reminder.items.length, 8);
  await reloaded.manage({ action: 'run', id: job.id });
  const queued = (await reloaded.list()).jobs[0]; assert.equal(queued.runs.length, 66); assert.notEqual(queued.runs.at(-1).sessionId, 'session');
  const results = await reloaded.manage({ action: 'results', offset: 20 }); assert.equal(results.results.length, 20); assert.equal(results.total, 66);
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

test('live user guidance appends changed reminders without rewriting sent history or authored text', async t => {
  const f = await fixture(t);
  const job = await f.scheduler.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  f.setIdle(true); await f.scheduler.tick(); await until(async () => (await f.scheduler.reminder()).total === 1);
  const run = (await f.scheduler.list()).jobs[0].runs[0];
  const registry = new ToolRegistry(), requests = []; let host;
  host = new InMemoryRuntimeHost({ automation: f.scheduler, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      requests.push(structuredClone(request));
      const event = (kind, rest = {}) => ({ protocol: 'bush.model_event.v1', kind, requestId: request.requestId, sequence: kind === 'response_completed' ? 2 : 1, createdAt: new Date().toISOString(), ...rest });
      if (requests.length === 1) {
        await f.scheduler.manage({ action: 'mark_read', id: job.id, runIds: [run.id] });
        await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: { protocol: 'bush.runtime_guidance.v1', sessionId: 'session', turnId: 'human-turn', messageId: 'live-guidance', content: '按新的范围继续。', createdAt: new Date().toISOString() } });
        yield event('tool_call_delta', { index: 0, toolCallId: 'read-inbox', nameDelta: 'scheduled_results', argumentsDelta: '{}' });
        yield event('response_completed', { finishReason: 'tool_calls' }); return;
      }
      yield event('text_delta', { delta: 'Done' }); yield event('response_completed', { finishReason: 'stop' });
    } } });
  const request = context(); request.tools = registry.definitions().filter(tool => tool.name === 'scheduled_results');
  await host.runSessionTurn(request);
  assert.equal(requests[0].messages.at(-1).name, 'automation_unread_reminder');
  assert.ok(requests[1].messages.some(message => message.content === '按新的范围继续。'));
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  const reminders = requests[1].messages.filter(message => message.name === 'automation_unread_reminder');
  assert.equal(reminders.length, 2, 'the read change appends a new observation');
  assert.equal(JSON.parse(reminders.at(-1).content.split('\n').at(-1)).total, 0);
  const history = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'session' } });
  const guidance = history.turns[0].messages.find(message => message.messageId === 'live-guidance');
  assert.equal(guidance.message.content, '按新的范围继续。'); assert.equal(guidance.metadata.automationReminder.total, 0);
  assert.deepEqual(history.turns[0].messages.filter(message => message.message.name === 'automation_unread_reminder').map(item => item.message), reminders);
  await f.scheduler.manage({ action: 'mark_unread', runIds: [run.id] });
  for (const [name, metadata] of [['goal_continuation', {}], ['automation_prompt', { automationRunId: run.id }]]) {
    await host.runSessionTurn({ ...context(), requestId: name, turnId: name, metadata, inputMessages: [{ messageId: name, message: { role: 'user', name, content: 'Continue' } }] });
    assert.deepEqual(requests.at(-1).messages.filter(message => message.name === 'automation_unread_reminder'), reminders, 'automatic inputs retain history without adding inbox reminders');
  }
});

test('saved contexts round-trip shared generation parameters without transient request state', async t => {
  const f = await fixture(t);
  const request = { ...context(), temperature: 0, topP: 0.73, reasoningEffort: 'high', maxOutputTokens: 8192,
    metadata: { nested: { value: 'saved' } }, tools: [{ name: 'inspect', description: 'Inspect', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }],
    providerState: { strategy: 'response_chain', previousResponseId: 'do-not-save', inputMessageOffset: 1 } };
  await f.scheduler.remember(request);
  request.metadata.nested.value = 'changed after remember'; request.tools[0].inputSchema.properties.value.type = 'number';
  await f.scheduler.remember(context('another-session')); await f.scheduler.close();
  const stored = JSON.parse(await readFile(f.options.path, 'utf8')).contexts.session;
  assert.equal(stored.metadata.nested.value, 'saved'); assert.equal(stored.tools[0].inputSchema.properties.value.type, 'string');
  for (const name of ['temperature', 'topP', 'reasoningEffort', 'maxOutputTokens']) assert.equal(stored[name], request[name]);
  for (const name of ['providerState', 'requestId', 'turnId', 'inputMessages']) assert.equal(stored[name], undefined);
  const runs = [];
  const reloaded = new AutomationScheduler({ ...f.options, canRun: () => true, run: async (_job, _run, ctx) => { runs.push(ctx); return { status: 'completed', reason: 'fixture' }; } });
  t.after(() => reloaded.close());
  await reloaded.manage({ action: 'create', definition: definition({ kind: 'once', at: '2026-09-09T00:00:00Z' }) });
  await reloaded.tick(); await until(() => runs.length === 1);
  for (const name of ['temperature', 'topP', 'reasoningEffort', 'maxOutputTokens']) assert.equal(runs[0][name], request[name]);
  await reloaded.remember(context());
  const cleared = JSON.parse(await readFile(f.options.path, 'utf8')).contexts.session;
  assert.equal(cleared.temperature, undefined); assert.equal(cleared.topP, undefined);
});
