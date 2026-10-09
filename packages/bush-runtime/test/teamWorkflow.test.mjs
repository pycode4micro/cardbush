import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { teamWorkflowSchema } from '@cardbush/bush-protocol';
import { RegisteredAgentStore, TeamWorkflowManager, ToolRegistry, registerSubagentTool, SubagentTaskStore } from '../dist/index.js';
import { teamCompletionAlreadyRead, teamCompletionNotice, teamRunResult } from '../dist/teamResults.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const outcome = (request, text, failed = false) => ({ terminal: { kind: 'turn_terminal', payload: { status: failed ? 'failed' : 'completed', reason: failed ? 'fixture failure' : '', finalMessageId: 'answer' } }, session: { turns: [{ turnId: request.turnId, usage: {}, messages: [{ messageId: 'answer', message: { role: 'assistant', content: text } }] }] } });
async function setup(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-team-workflow-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-team-workflow-')); await rm(root, { recursive: true, force: true }); });
  const agents = new RegisteredAgentStore(join(root, 'agents'));
  for (const id of ['stock', 'shipping', 'review']) await agents.put({ id, name: id, system_prompt: `${id} role`, memory: 'none' }, 0);
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), saved = new Map();
  const subagents = registerSubagentTool(registry, tasks, run, { agents, saveChildRequest: async request => { saved.set(request.sessionId, structuredClone(request)); }, loadChildRequest: async id => saved.get(id) });
  const manager = new TeamWorkflowManager(agents, subagents.dispatch, { directory: join(root, 'teams') });
  manager.register(registry);
  const parent = new AbortController(); let serial = 0;
  const call = async (input, overrides = {}, signal = parent.signal) => {
    const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 'turn', model: 'model', tools: registry.definitions(), permissionMode: 'all_free', messages: [{ role: 'system', content: 'PRIVATE PARENT' }], metadata: {}, ...overrides };
    const registration = registry.resolve('team');
    return registration.execute({ input: registration.decodeInput(input), requestId: 'r', sessionId: 'parent', turnId: 'turn', toolCall: { id: `call-${++serial}` },
      signal, turn: { request, contextMessages: request.messages }, capabilityIds: [], invokeTool: async () => { throw Error('unexpected nested tool'); }, recordWorkspaceChange: () => {} });
  };
  t.after(() => manager.close());
  return { root, manager, call, agents, parent, tasks, subagents };
}
const flow = { id: 'fulfil', name: 'Fulfilment', max_parallel: 2, nodes: [
  { id: 'stock', agent_id: 'stock', prompt: 'Check inventory' },
  { id: 'shipping', agent_id: 'shipping', prompt: 'Check shipping' },
  { id: 'review', agent_id: 'review', prompt: 'Review evidence', depends_on: ['stock', 'shipping'] },
] };

test('Team validates dependencies before execution', () => {
  assert.throws(() => teamWorkflowSchema.parse({ ...flow, nodes: [{ id: 'a', agent_id: 'stock', prompt: 'a', depends_on: ['missing'] }] }), /acyclic/);
  assert.throws(() => teamWorkflowSchema.parse({ ...flow, nodes: [{ id: 'a', agent_id: 'stock', prompt: 'a', depends_on: ['b'] }, { id: 'b', agent_id: 'stock', prompt: 'b', depends_on: ['a'] }] }), /acyclic/);
  assert.throws(() => teamWorkflowSchema.parse({ ...flow, nodes: [flow.nodes[0], flow.nodes[0]] }), /Duplicate/);
});

test('Team completion notices deliver final outputs and deduplicate only complete wait receipts from the same result version', () => {
  const run = { id: 'run', teamId: 'flow', status: 'completed', error: '', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:01Z',
    workflow: { nodes: [{ id: 'final', depends_on: [] }] }, nodes: [{ id: 'final', taskId: 'attempt-1', status: 'completed', error: '', output: 'PRIVATE NODE OUTPUT' }] };
  const content = JSON.stringify(teamCompletionNotice(run));
  assert.equal(JSON.parse(content).nodes[0].output, 'PRIVATE NODE OUTPUT');
  const call = { role: 'assistant', content: '', toolCalls: [{ id: 'wait', name: 'team', argumentsText: JSON.stringify({ action: 'wait', run_id: run.id }) }] };
  const receipt = { role: 'tool', toolCallId: 'wait', content: JSON.stringify(teamRunResult(run, ['final'])) };
  assert.equal(teamCompletionAlreadyRead(content, [call, receipt]), true);
  const restored = { ...run, nodes: [{ output: run.nodes[0].output, error: '', status: 'completed', id: 'final', taskId: 'attempt-1' }] };
  assert.equal(teamCompletionAlreadyRead(JSON.stringify(teamCompletionNotice(restored)), [call, receipt]), true, 'storage schema property order must not change the result version');
  assert.equal(teamCompletionAlreadyRead(content, [receipt]), false, 'arbitrary tool text does not acknowledge a Team result');
  const status = { ...call, toolCalls: [{ ...call.toolCalls[0], argumentsText: JSON.stringify({ action: 'status', run_id: run.id }) }] };
  assert.equal(teamCompletionAlreadyRead(content, [status, receipt]), false, 'progress checks do not consume outputs');
  assert.equal(teamCompletionAlreadyRead(content, [call, { ...receipt, content: '{}' }]), false);
  assert.equal(teamCompletionAlreadyRead(content, [call, { ...receipt, content: JSON.stringify({ ...teamRunResult(run, ['final']), output_node_ids: ['upstream'] }) }]), false,
    'reading only intermediate evidence must not consume the final delivery');
  assert.equal(teamCompletionAlreadyRead('not JSON', [call, receipt]), false);
  const resumed = { ...run, nodes: [{ ...run.nodes[0], taskId: 'attempt-2' }] };
  assert.equal(teamCompletionAlreadyRead(JSON.stringify(teamCompletionNotice(resumed)), [call, receipt]), false);
});

test('Team stops active nodes, leaves downstream work pending and respects disabled delegation', async t => {
  const started = gate(), executed = [];
  const f = await setup(t, async (request, signal) => {
    executed.push(request.metadata.teamMemberId);
    if (executed.length === 2) started.resolve();
    await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); });
    return { terminal: { kind: 'turn_terminal', payload: { status: 'stopped' } }, session: { turns: [] } };
  });
  await f.call({ action: 'save', definition: flow, expected_revision: 0 });
  const input = { action: 'run', team_id: 'fulfil', input: 'Order 42' };
  await assert.rejects(f.call(input, { tools: [] }), /subagent execution/);
  await assert.rejects(f.call(input, { metadata: { toolExecutionPolicy: 'none' } }), /subagent execution/);
  await assert.rejects(f.call(input, { metadata: { disabledTools: ['subagent'] } }), /subagent execution/);
  assert.equal(executed.length, 0);
  const run = await f.call(input); await started.promise;
  assert.equal(f.manager.hasActiveRuns('parent'), true);
  const stopped = await f.call({ action: 'stop', run_id: run.run_id });
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.manager.hasActiveRuns(), false);
  assert.equal(stopped.nodes[2].status, 'pending');
  assert.deepEqual(executed.sort(), ['shipping', 'stock']);
});

test('Team runs ready nodes concurrently, propagates only dependencies and survives parent cancellation', async t => {
  const started = gate(), release = gate(), seen = [];
  const f = await setup(t, async (request, signal) => {
    seen.push(request);
    assert.equal(signal.aborted, false);
    if (seen.length === 2) started.resolve();
    if (request.metadata.teamMemberId !== 'review') await release.promise;
    assert.equal(signal.aborted, false);
    return outcome(request, `Evidence ${request.metadata.teamMemberId}`);
  });
  await f.call({ action: 'save', definition: flow, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: 'fulfil', input: 'Order 42' });
  await started.promise;
  assert.equal(seen.length, 2);
  f.parent.abort(); release.resolve();
  // Waiting from another live request does not revive the old parent signal.
  const finished = await new Promise((resolve, reject) => {
    const check = async () => { try { const state = await f.manager.configure({ action: 'status', run_id: run.run_id }); if (state.status === 'running') setTimeout(check, 5); else resolve(state); } catch (error) { reject(error); } }; void check();
  });
  assert.equal(finished.status, 'completed', JSON.stringify(finished)); assert.equal(seen.length, 3);
  assert.doesNotMatch(JSON.stringify(seen), /PRIVATE PARENT/);
  const finalInput = seen[2].inputMessages.at(-1).message.content;
  assert.match(finalInput, /Evidence stock/); assert.match(finalInput, /Evidence shipping/);
  assert.ok(f.tasks.list('parent').every(task => task.origin === 'team'));
});

test('explicit resume retains completed nodes and resumes the failed employee conversation', async t => {
  const calls = new Map();
  const f = await setup(t, async request => {
    const id = request.metadata.teamMemberId, count = (calls.get(id) ?? 0) + 1;
    calls.set(id, count);
    return outcome(request, `${id} result`, id === 'review' && count === 1);
  });
  await f.call({ action: 'save', definition: flow, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: 'fulfil', input: 'Order 42' });
  const failed = await f.call({ action: 'wait', run_id: run.run_id });
  assert.equal(failed.agents, undefined, 'status receipts do not duplicate employee system prompts');
  assert.equal(failed.status, 'failed'); const session = failed.nodes[2].sessionId;
  await f.call({ action: 'resume', run_id: run.run_id });
  const finished = await f.call({ action: 'wait', run_id: run.run_id });
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.nodes[2].sessionId, session);
  assert.notEqual(finished.result_version, failed.result_version, 'resumed results must not be deduplicated against the failed attempt');
  assert.deepEqual([...calls], [['stock', 1], ['shipping', 1], ['review', 2]]);
});

test('Team wait returns final outputs by default, selected evidence on demand, and full data to the UI', async t => {
  const f = await setup(t, async request => outcome(request, `Evidence ${request.metadata.teamMemberId}`));
  await f.call({ action: 'save', definition: flow, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: flow.id, input: 'Order 42' });
  const final = await f.call({ action: 'wait', run_id: run.run_id });
  assert.deepEqual(final.result_node_ids, ['review']);
  assert.deepEqual(final.output_node_ids, ['review']);
  assert.deepEqual(final.nodes.map(node => node.output), [undefined, undefined, 'Evidence review']);
  assert.ok(final.nodes.every(node => node.has_output));
  assert.match(final.guidance, /not independent validation/);
  const evidence = await f.call({ action: 'wait', run_id: run.run_id, node_ids: ['stock', 'shipping'] });
  assert.deepEqual(evidence.nodes.map(node => node.output), ['Evidence stock', 'Evidence shipping', undefined]);
  assert.equal(evidence.result_version, final.result_version);
  const native = await f.manager.configure({ action: 'status', run_id: run.run_id });
  assert.deepEqual(native.nodes.map(node => node.output), ['Evidence stock', 'Evidence shipping', 'Evidence review']);
  assert.deepEqual(teamCompletionNotice(native).nodes.map(node => node.output), [undefined, undefined, 'Evidence review']);
  for (const node_ids of [[], ['stock', 'stock'], 'stock', [null], ['unknown']]) {
    await assert.rejects(f.call({ action: 'wait', run_id: run.run_id, node_ids }), /node/i);
  }
  await assert.rejects(f.call({ action: 'status', run_id: run.run_id, node_ids: ['stock'] }), /Invalid/);
});

test('Team wait includes every final branch without truncating their outputs', async t => {
  const answer = 'COMPLETE EVIDENCE '.repeat(1500);
  const f = await setup(t, async request => outcome(request, answer + request.metadata.teamMemberId));
  await f.call({ action: 'save', definition: { ...flow, nodes: flow.nodes.slice(0, 2) }, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: flow.id, input: 'Order 42' });
  const final = await f.call({ action: 'wait', run_id: run.run_id });
  assert.deepEqual(final.result_node_ids, ['stock', 'shipping']);
  assert.deepEqual(final.nodes.map(node => node.output), [answer + 'stock', answer + 'shipping']);
});

test('cancelling a wait leaves Team running and its results readable by a later waiter', async t => {
  const started = gate(), release = gate();
  t.after(() => release.resolve());
  const f = await setup(t, async request => { started.resolve(); await release.promise; return outcome(request, 'Finished after cancelled wait'); });
  await f.call({ action: 'save', definition: { ...flow, nodes: [flow.nodes[0]] }, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: flow.id, input: 'Order 42' });
  await started.promise;
  const waiting = f.call({ action: 'wait', run_id: run.run_id });
  f.parent.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(f.manager.hasActiveRuns(), true);
  release.resolve();
  const final = await f.call({ action: 'wait', run_id: run.run_id }, {}, new AbortController().signal);
  assert.equal(final.status, 'completed');
  assert.equal(final.nodes[0].output, 'Finished after cancelled wait');
});

test('persisted orphaned Team executions become interrupted, without replaying completed nodes', async t => {
  const f = await setup(t, async request => outcome(request, 'Done'));
  await f.call({ action: 'save', definition: flow, expected_revision: 0 });
  const run = await f.call({ action: 'run', team_id: 'fulfil', input: 'Order 42' });
  await f.call({ action: 'wait', run_id: run.run_id }); await f.manager.close();
  const directory = join(f.root, 'teams', 'runs'), file = (await readdir(directory)).find(name => name.endsWith('.json'));
  const record = JSON.parse(await readFile(join(directory, file), 'utf8'));
  record.definition.status = 'running'; record.definition.nodes[2].status = 'running';
  await writeFile(join(directory, file), JSON.stringify(record));
  let executed = false;
  const restarted = new TeamWorkflowManager(f.agents, async () => { executed = true; throw Error('must not auto replay'); }, { directory: join(f.root, 'teams') });
  const state = await restarted.configure({ action: 'status', run_id: run.run_id });
  assert.equal(state.status, 'interrupted'); assert.equal(state.nodes[0].status, 'completed'); assert.equal(state.nodes[2].status, 'stopped');
  assert.equal(executed, false); await restarted.close();
});

test('Team discovery and progress omit instructions and outputs; explicit reads and the UI keep them', async t => {
  const answer = 'VERIFIED FULL NODE RESULT '.repeat(500).trim();
  const f = await setup(t, async request => outcome(request, answer));
  const definition = { ...flow, description: 'Fulfil warehouse orders', nodes: [{ ...flow.nodes[0], prompt: 'PRIVATE NODE INSTRUCTIONS '.repeat(500).trim() }] };
  const saved = await f.call({ action: 'save', definition, expected_revision: 0 });
  assert.equal(saved.revision, 1);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE NODE INSTRUCTIONS/);
  const list = await f.call({ action: 'list' });
  assert.equal(list.total, 1);
  assert.equal(list.teams[0].node_count, 1);
  assert.equal(list.runs, undefined);
  assert.doesNotMatch(JSON.stringify(list), /PRIVATE NODE INSTRUCTIONS|system_prompt/);
  const get = await f.call({ action: 'get', team_id: definition.id });
  assert.equal(get.definition.nodes[0].prompt, definition.nodes[0].prompt);
  const run = await f.call({ action: 'run', team_id: definition.id, input: 'PRIVATE TASK INPUT' });
  const full = await f.call({ action: 'wait', run_id: run.run_id });
  assert.equal(full.nodes[0].output, answer);
  assert.doesNotMatch(JSON.stringify(full), /PRIVATE NODE INSTRUCTIONS|PRIVATE TASK INPUT|system_prompt/);
  const status = await f.call({ action: 'status', run_id: run.run_id });
  assert.equal(status.nodes[0].has_output, true);
  assert.equal(status.status, 'completed');
  assert.doesNotMatch(JSON.stringify(status), /VERIFIED FULL NODE RESULT|PRIVATE NODE INSTRUCTIONS|PRIVATE TASK INPUT|system_prompt/);
  const history = await f.call({ action: 'list', section: 'runs' });
  assert.equal(history.runs[0].run_id, run.run_id);
  assert.doesNotMatch(JSON.stringify(history), /VERIFIED FULL NODE RESULT|PRIVATE NODE INSTRUCTIONS/);
  const native = await f.manager.configure({ action: 'status', run_id: run.run_id });
  assert.equal(native.workflow.nodes[0].prompt, definition.nodes[0].prompt);
  assert.equal(native.nodes[0].output, answer);
  assert.ok(native.agents[0].definition.system_prompt, 'native UI still has the pinned configuration');
});

test('Team catalog pagination and search operate on capabilities, independently of run history', async t => {
  const f = await setup(t, async request => outcome(request, 'Done'));
  for (let i = 0; i < 31; i++) await f.call({ action: 'save', expected_revision: 0,
    definition: { ...flow, id: `flow-${i}`, description: 'Capability '.repeat(200) + `unique-needle-${i}` } });
  const ids = [];
  let offset = 0;
  do {
    const page = await f.call({ action: 'list', offset, limit: 50 });
    assert.equal(page.total, 31);
    assert.ok(JSON.stringify(page).length < 6500);
    ids.push(...page.teams.map(team => team.id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(ids.length, 31);
  assert.equal(new Set(ids).size, 31);
  const found = await f.call({ action: 'list', query: 'UNIQUE-NEEDLE-30' });
  assert.equal(found.total, 1);
  assert.equal(found.teams[0].id, 'flow-30');
});
