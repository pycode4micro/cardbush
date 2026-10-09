import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, GET_RUNTIME_SESSION_COMMAND } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost } from '../dist/index.js';

test('native Team uses real session execution and employee memory without holding its parent turn open', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-native-team-host-'));
  let release, host;
  const gate = new Promise(done => { release = done; });
  t.after(async () => {
    release(); await host?.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-native-team-host-'));
    await rm(root, { recursive: true, force: true });
  });
  const rounds = new Map(), childRequests = [];
  const provider = { async *stream(request) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
    const tool = (name, args) => ({ ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `${request.turnId}-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(args) });
    if (request.metadata.registeredAgentId) {
      childRequests.push(structuredClone(request)); await gate;
      if (request.metadata.teamMemberId === 'remember' && round === 1) {
        yield tool('agent_memory_read', {});
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
      }
      if (request.metadata.teamMemberId === 'remember' && round === 2) {
        const receipt = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
        yield tool('agent_memory_write', { content: 'Warehouse dispatch requires a verified order number.', expected_revision: receipt.revision });
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
      }
    } else if (round === 1) {
      yield tool('team', { action: 'run', team_id: 'warehouse', input: 'Order 42' });
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
    }
    yield { ...base, sequence: 0, kind: 'text_delta', delta: request.metadata.registeredAgentId ? 'Order checked.' : 'The team is running independently.' };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } };
  host = new InMemoryRuntimeHost({ dataRoot: root, provider });
  await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'save', expected_revision: 0, definition: {
    id: 'clerk', name: 'Warehouse clerk', system_prompt: 'Use verified inventory records.', allowed_tools: [], memory: 'user',
  } } });
  await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'save', expected_revision: 0, definition: {
    id: 'warehouse', name: 'Warehouse', nodes: [
      { id: 'remember', agent_id: 'clerk', prompt: 'Remember the warehouse rule.' },
      { id: 'verify', agent_id: 'clerk', prompt: 'Check the order.', depends_on: ['remember'] },
    ],
  } } });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await Promise.race([
    host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn', model: 'fixture',
      prefixMessages: [{ role: 'system', content: 'PRIVATE PARENT ROLE' }], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Start the warehouse team.' } }],
      tools, permissionMode: 'all_free', metadata: { individuation: { habits: false, predictions: false } } }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Parent was incorrectly joined to the independent Team')), 4000); timer.unref(); }),
  ]);
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(host.hasActiveSession('parent'), true, 'Team keeps the session in use after the turn ends');
  for (let attempt = 0; attempt < 400 && !childRequests.length; attempt++) await new Promise(done => setTimeout(done, 10));
  assert.ok(childRequests.length > 0);
  const active = (await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'list' } })).runs[0];
  assert.equal(active.nodes[0].sessionId, childRequests[0].sessionId, 'persist the child identity before model execution, not only after its result');
  release();
  let run;
  for (let attempt = 0; attempt < 400; attempt++) {
    run = (await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'list' } })).runs[0];
    if (run?.status !== 'running') break;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.equal(run?.status, 'completed', JSON.stringify(run));
  assert.doesNotMatch(JSON.stringify(childRequests.map(request => request.messages)), /PRIVATE PARENT ROLE/);
  const verify = childRequests.find(request => request.metadata.teamMemberId === 'verify');
  assert.match(JSON.stringify(verify.messages), /Warehouse dispatch requires a verified order number/);
  assert.notEqual(run.nodes[0].sessionId, run.nodes[1].sessionId);
  const child = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: run.nodes[1].sessionId } });
  assert.equal(child.turns.length, 1);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  host = new InMemoryRuntimeHost({ dataRoot: root, provider });
  const restored = await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'status', run_id: run.id } });
  assert.equal(restored.status, 'completed');
  assert.deepEqual(restored.nodes, run.nodes);
});

for (const finishBeforeWait of [false, true]) test(`Team reads a real file and delivers its final result once (${finishBeforeWait ? 'settled before wait' : 'wait during execution'})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-native-team-host-'));
  const inventory = join(root, 'inventory.txt');
  await writeFile(inventory, 'SKU_42_AVAILABLE=7');
  let host;
  t.after(async () => {
    await host?.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-native-team-host-'));
    await rm(root, { recursive: true, force: true });
  });
  const rounds = new Map(), parents = [], children = [];
  const provider = { async *stream(request) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
    const call = (name, args) => ({ ...base, sequence: 0, kind: 'tool_call_delta', index: 0,
      toolCallId: `${request.turnId}-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(args) });
    let text;
    if (request.metadata.registeredAgentId) {
      children.push(structuredClone(request));
      if (request.metadata.teamMemberId === 'stock') {
        if (round === 1) {
          yield call('read_file', { path: inventory });
          yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
        }
        assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content, /SKU_42_AVAILABLE=7/);
        text = 'INVENTORY_EVIDENCE: SKU 42 has 7 units.';
      } else {
        assert.match(JSON.stringify(request.messages), /INVENTORY_EVIDENCE: SKU 42 has 7 units/);
        text = 'FINAL_DELIVERABLE: Order 42 can use the 7 available units.';
      }
    } else {
      parents.push(structuredClone(request));
      if (round === 1) {
        yield call('team', { action: 'run', team_id: 'inventory', input: 'Check order 42 against the inventory file.' });
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
      }
      const receipt = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
      if (round === 2) {
        if (finishBeforeWait) {
          for (let attempt = 0; attempt < 400; attempt++) {
            const run = await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'status', run_id: receipt.run_id } });
            if (run.status === 'completed') break;
            await new Promise(done => setTimeout(done, 10));
            assert.ok(attempt < 399, 'Team completion timed out');
          }
        }
        yield call('team', { action: 'wait', run_id: receipt.run_id });
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
      }
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
      assert.equal(receipt.nodes[0].output, undefined);
      assert.match(receipt.nodes[1].output, /FINAL_DELIVERABLE/);
      assert.equal(request.messages.filter(message => message.content.includes('FINAL_DELIVERABLE')).length, 1);
      assert.doesNotMatch(JSON.stringify(request.messages), /INVENTORY_EVIDENCE/);
      assert.equal(request.messages.filter(message => message.name === 'subagent_result').length, 0,
        'a wait receipt consumes the simultaneous completion notification');
      text = 'Order checked from inventory.';
    }
    yield { ...base, sequence: 0, kind: 'text_delta', delta: text };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } };
  host = new InMemoryRuntimeHost({ dataRoot: root, provider });
  for (const [id, allowed_tools] of [['clerk', ['read_file']], ['reviewer', []]]) {
    await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'save', expected_revision: 0,
      definition: { id, name: id, system_prompt: 'Use verified records and the requested output format.', allowed_tools, memory: 'none', guards: ['read_only'] } } });
  }
  await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'save', expected_revision: 0, definition: {
    id: 'inventory', name: 'Inventory', nodes: [
      { id: 'stock', agent_id: 'clerk', prompt: 'Read the inventory file.' },
      { id: 'final', agent_id: 'reviewer', prompt: 'Assess availability from the stock evidence.', depends_on: ['stock'] },
    ],
  } } });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn',
    model: 'fixture', prefixMessages: [{ role: 'system', content: 'PRIVATE PARENT CONTEXT' }],
    inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Check inventory with the team.' } }], tools,
    permissionMode: 'all_free', metadata: { workspaceDir: root, individuation: { habits: false, predictions: false } } });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(parents.length, 3, 'run, wait, final reply; no redundant model round');
  assert.equal(children.length, 3, 'stock calls read_file, then final receives its evidence');
  assert.doesNotMatch(JSON.stringify(children), /PRIVATE PARENT CONTEXT/);
});
