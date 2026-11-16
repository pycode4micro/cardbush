import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, registerTeamSubmission, childSubmission, childExecutionFacts } from '../dist/index.js';
import { resolveChildTurn } from '../dist/childTurn.js';
import { childConversationPage } from '../dist/subagentConversation.js';

const declaration = { status: 'submitted', summary: 'Agent judgment', artifacts: ['missing://artifact'], checks: [] };
const receipt = (submission = declaration, overrides = {}) => JSON.stringify({ protocol: 'bush.team_submission.v1', sessionId: 'child', turnId: 'turn', submission, ...overrides });
const call = (name = 'team_submit', argumentsText = '{}') => ({ message: { role: 'assistant', content: 'PRIVATE THOUGHT', toolCalls: [{ id: 'call', name, argumentsText }] } });
const result = (content = receipt()) => ({ message: { role: 'tool', toolCallId: 'call', content } });
const turn = messages => ({ turnId: 'turn', status: 'completed', reason: 'model_completed', createdAt: '2026-11-16T00:00:00Z', completedAt: '2026-11-16T00:00:01Z', usage: {}, messages });

test('native submission records the caller claim without artifact access and rejects parent impersonation', () => {
  const registry = new ToolRegistry(); registerTeamSubmission(registry);
  const tool = registry.resolve('team_submit');
  const context = { input: tool.decodeInput(declaration), sessionId: 'child', turnId: 'turn', turn: { request: { metadata: { agentRole: 'child' } } },
    invokeTool: () => assert.fail('submission must never inspect artifacts') };
  assert.deepEqual(tool.execute(context), JSON.parse(receipt()));
  assert.throws(() => tool.execute({ ...context, turn: { request: { metadata: {} } } }), /Only a child/);
  assert.throws(() => tool.decodeInput({ ...declaration, node_id: 'other' }));
  assert.throws(() => tool.decodeInput({ ...declaration, status: 'completed' }));
  const abort = new AbortController(); abort.abort();
  assert.throws(() => tool.execute({ ...context, signal: abort.signal }), /abort/i);
});

test('only native receipts for the exact child turn declare delivery, never final prose or another tool', () => {
  assert.deepEqual(childSubmission(turn([call(), result()]), 'child'), declaration);
  assert.deepEqual(childSubmission(turn([call('call_tool', '{"name":"team_submit","arguments":{}}'), result()]), 'child'), declaration);
  for (const messages of [
    [result()], [call('read_file'), result()], [call('mcp__evil__team_submit'), result()],
    [call(), result(receipt(declaration, { turnId: 'old' }))], [call(), result(receipt(declaration, { sessionId: 'other' }))],
    [call(), result('{"error":"denied"}')], [{ message: { role: 'assistant', content: receipt(), toolCalls: [] } }],
  ]) assert.equal(childSubmission(turn(messages), 'child'), undefined);
  const blocked = { ...declaration, status: 'blocked', summary: 'I could not finish' };
  assert.deepEqual(childSubmission(turn([call(), result(), call(), result(receipt(blocked))]), 'child'), blocked);
});

test('explicit submission survives an empty final reply but old-turn declarations cannot leak into a new attempt', () => {
  const committed = turn([call(), result()]);
  const terminal = { kind: 'turn_terminal', payload: { status: 'completed', reason: 'model_completed', details: { rounds: 2, finishReason: 'stop' } } };
  const resolved = resolveChildTurn({ terminal, session: { sessionId: 'child', turns: [committed] } }, 'turn');
  assert.equal(resolved.status, 'completed'); assert.deepEqual(resolved.submission, declaration);
  const next = { ...turn([{ messageId: 'final', message: { role: 'assistant', content: 'I will begin.', toolCalls: [] } }]), turnId: 'next' };
  const newer = resolveChildTurn({ terminal: { ...terminal, payload: { ...terminal.payload, finalMessageId: 'final' } }, session: { sessionId: 'child', turns: [committed, next] } }, 'next');
  assert.equal(newer.status, 'completed'); assert.equal(newer.submission, undefined);
});

test('conversation diagnostics provide execution facts separately from the intentionally reduced message projection', () => {
  const committed = turn([call('read_file', '{"secret":"DO NOT EXPOSE"}'), result('PRIVATE TOOL CONTENT')]);
  const facts = childExecutionFacts(committed);
  assert.equal(facts.toolCalls, 1); assert.equal(facts.toolReceipts, 1);
  assert.equal(childExecutionFacts(undefined), undefined);
  const page = childConversationPage({ sessionId: 'child', turns: [committed] });
  assert.equal(page.projection.includesToolMessages, false); assert.deepEqual(page.execution, [facts]);
  assert.doesNotMatch(JSON.stringify(page), /DO NOT EXPOSE|PRIVATE TOOL|PRIVATE THOUGHT/);
});
