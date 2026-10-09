import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AutomationScheduler, SubagentTaskStore, ToolRegistry } from '../dist/index.js';
import { registerPluginCommandTools } from '../dist/pluginCommandTools.js';
import { PluginBackgroundTasks } from '../dist/pluginBackgroundTasks.js';
import { registerExtendedBuiltins } from '../dist/extendedBuiltins.js';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-progressive-tools-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-progressive-tools-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
const call = async (registry, name, args, sessionId = 'session') => {
  const tool = registry.resolve(name);
  return tool.execute({ input: tool.decodeInput(args), sessionId, turnId: 'turn', signal: new AbortController().signal, turn: { request: { metadata: {} } } });
};

test('plugin Command discovery is bounded, searchable and has an explicit full metadata read', async () => {
  const registry = new ToolRegistry();
  const commands = Array.from({ length: 55 }, (_, i) => ({ id: `fixture:command-${String(i).padStart(2, '0')}`,
    description: 'Useful capability '.repeat(100) + `needle-${i}`, argumentHint: '[arguments] '.repeat(100),
    userInvocable: i !== 2, disableModelInvocation: i === 3, prompt: 'PRIVATE COMMAND INSTRUCTIONS' }));
  registerPluginCommandTools(registry, async () => commands);
  const ids = [];
  let offset = 0;
  do {
    const page = await call(registry, 'list_plugin_commands', { offset, limit: 50 });
    assert.equal(page.total, 55);
    assert.ok(JSON.stringify(page).length < 6500);
    assert.ok(page.commands.every(command => command.truncated));
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
    ids.push(...page.commands.map(command => command.id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 55);
  assert.equal(ids.length, 55);
  const found = await call(registry, 'list_plugin_commands', { query: 'NEEDLE-54' });
  assert.equal(found.total, 1, 'search must consider text beyond the description preview');
  const detail = await call(registry, 'list_plugin_commands', { command: found.commands[0].id });
  assert.equal(detail.description, commands[54].description);
  assert.equal(detail.argumentHint, commands[54].argumentHint);
  const restricted = await call(registry, 'list_plugin_commands', { command: commands[3].id });
  assert.equal(restricted.modelInvocable, false);
  assert.equal(restricted.userInvocable, true);
  await assert.rejects(call(registry, 'list_plugin_commands', { command: commands[0].id, offset: 1 }));
});

test('background task discovery omits large answers; selected read and wait preserve results and ownership', async t => {
  const root = await temporary(t), registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  new PluginBackgroundTasks(root, tasks, registry);
  const answer = 'COMPLETE TASK ANSWER '.repeat(2000);
  for (let i = 0; i < 35; i++) {
    const session = i === 34 ? 'other' : 'session', taskId = `task-${i}`;
    tasks.start({ taskId, parentSessionId: session, parentTurnId: 'turn', childSessionId: `child-${i}`, childTurnId: `turn-${i}`,
      prompt: 'PRIVATE TASK PROMPT', inheritContext: false, inheritedMessageCount: 0, background: true });
    tasks.finish({ parentSessionId: session, taskId, status: 'completed', finalResponse: answer, errorMessage: '', usage: {} });
  }
  const page = await call(registry, 'manage_plugin_agents', { action: 'list' });
  assert.equal(page.total, 34);
  assert.equal(page.tasks.length, 20);
  assert.equal(page.next_offset, 20);
  assert.ok(JSON.stringify(page).length < 6500);
  assert.doesNotMatch(JSON.stringify(page), /COMPLETE TASK ANSWER|PRIVATE TASK PROMPT/);
  assert.ok(page.tasks.every(task => task.has_result));
  const second = await call(registry, 'manage_plugin_agents', { action: 'list', offset: page.next_offset });
  assert.equal(second.tasks.length, 14);
  assert.equal(second.next_offset, null);
  for (const action of ['read', 'wait']) {
    const read = await call(registry, 'manage_plugin_agents', { action, task_ids: ['task-3'] });
    assert.equal(read.length, 1);
    assert.equal(read[0].finalResponse, answer);
    await assert.rejects(call(registry, 'manage_plugin_agents', { action, task_ids: ['task-34'] }), /another conversation/);
  }
  await assert.rejects(call(registry, 'manage_plugin_agents', { action: 'read' }), /requires task_ids/);
  await assert.rejects(call(registry, 'manage_plugin_agents', { action: 'wait', offset: 1 }), /only to list/);
  assert.equal(tasks.get('session', 'task-3').finalResponse, answer, 'discovery never rewrites the saved answer');
});

test('schedule discovery returns receipts while explicit configuration and result reads remain complete', async t => {
  const root = await temporary(t), registry = new ToolRegistry();
  const prompt = 'PRIVATE AUTOMATION CONFIG '.repeat(200).trim(), output = 'COMPLETE SCHEDULED OUTPUT '.repeat(300).trim();
  const scheduler = new AutomationScheduler({ path: join(root, 'automations.json'), canRun: () => true,
    run: async () => ({ status: 'completed', reason: 'done', result: output }) });
  t.after(() => scheduler.close());
  await scheduler.remember({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Schedule requested work' } }],
    tools: [], permissionMode: 'all_free', requestCapabilities: { interactiveRequests: true, vision: false }, metadata: {} });
  registerExtendedBuiltins(registry, { dataRoot: root, automation: scheduler });
  const created = [];
  for (const name of ['First', 'Second']) created.push(await call(registry, 'schedule_task', { action: 'create', name, prompt,
    trigger: { kind: 'once', at: '2099-10-09T00:00:00Z' } }));
  assert.equal(created[0].revision, 1);
  assert.doesNotMatch(JSON.stringify(created), /PRIVATE AUTOMATION|"runs"/);
  const first = await call(registry, 'schedule_task', { action: 'list', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  assert.equal(first.jobs.length, 1);
  const second = await call(registry, 'schedule_task', { action: 'list', offset: first.next_offset });
  assert.equal(second.jobs[0].name, 'Second');
  const found = await call(registry, 'schedule_task', { action: 'list', query: 'private automation' });
  assert.equal(found.total, 2);
  const detail = await call(registry, 'schedule_task', { action: 'get', job_id: created[0].id });
  assert.equal(detail.prompt, prompt);
  assert.equal(detail.trigger.at, '2099-10-09T00:00:00Z');
  await assert.rejects(call(registry, 'schedule_task', { action: 'get', job_id: created[0].id }, 'other'), /not found/);
  for (let i = 0; i < 25; i++) {
    await call(registry, 'schedule_task', { action: 'run', job_id: created[0].id });
    await scheduler.tick();
    const deadline = Date.now() + 3000;
    while ((await scheduler.list()).jobs[0].runs.at(-1)?.status !== 'completed') {
      assert.ok(Date.now() < deadline, 'Fixture schedule must finish');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const native = await scheduler.list('session');
  assert.equal(native.jobs[0].prompt, prompt, 'the UI still receives editable configuration');
  assert.equal(native.jobs[0].runs.length, 25, 'the UI still receives history');
  const list = await call(registry, 'schedule_task', { action: 'list' });
  assert.doesNotMatch(JSON.stringify(list), /PRIVATE AUTOMATION|COMPLETE SCHEDULED|"runs"/);
  assert.equal(list.jobs[0].last_run.status, 'completed');
  const ids = [];
  let offset = 0;
  do {
    const page = await call(registry, 'scheduled_results', { offset });
    assert.equal(page.total, 25);
    assert.ok(JSON.stringify(page).length < 6500);
    assert.ok(page.results.every(result => !('result' in result) && result.summary.length <= 320));
    ids.push(...page.results.map(result => result.id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  const read = await call(registry, 'scheduled_results', { run_ids: [ids[0]] });
  assert.equal(read.results.length, 1);
  assert.equal(read.results[0].result, output);
  assert.equal((await scheduler.reminder()).total, 25, 'neither browsing nor reading acknowledges results');
});
