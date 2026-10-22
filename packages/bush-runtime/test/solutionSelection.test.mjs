import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solutionSelectionInputSchema, runtimeSolutionAnswerSchema, DEFAULT_CHILD_AGENT_DISABLED_TOOLS,
  ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND, LIST_RUNTIME_SOLUTION_SELECTIONS_COMMAND, GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  BUSH_SESSION_TURN_REQUEST_PROTOCOL, BUSH_MODEL_EVENT_PROTOCOL } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, InMemoryRuntimeEventLog } from '../dist/index.js';
import { RuntimeSolutionBroker } from '../dist/runtimeSolutionBroker.js';

const input = { prompt: '数据冲突如何处理', options: ['保留现有数据（推荐）', '使用新数据', '分别保留两份'] };
const batch = { questions: [
  { id: 'scope', ...input },
  { id: 'period', prompt: '统计哪个时间段', options: ['最近七天'] },
] };
const identity = { requestId: 'request-a', sessionId: 'session-a', turnId: 'turn-a' };
const answerFor = (request, answer) => ({ selectionId: request.selectionId, sessionId: request.sessionId, turnId: request.turnId, ...answer });

test('accepts only 1–3 distinct brief plain text solutions, without recommendation metadata', () => {
  assert.deepEqual(solutionSelectionInputSchema.parse(input), input);
  for (const candidate of [ { ...input, options: [] }, { ...input, options: ['一', '二', '三', '四'] },
    { ...input, options: [{ label: '保留', recommended: true }] }, { ...input, recommended: 0 },
    { ...input, prompt: '字'.repeat(501) }, { ...input, options: ['字'.repeat(121)] },
    { ...input, options: ['保留', '保留'] }, { ...input, prompt: '一\n二' } ]) {
    assert.equal(solutionSelectionInputSchema.safeParse(candidate).success, false);
  }
  assert.equal(solutionSelectionInputSchema.safeParse({ prompt: '🧩'.repeat(15), options: ['保留'] }).success, true);
  assert.equal(solutionSelectionInputSchema.safeParse({ prompt: '🧩'.repeat(500), options: ['字'.repeat(120)] }).success, true);
  assert.equal(runtimeSolutionAnswerSchema.safeParse({ selectionId: 'id', sessionId: 'a', turnId: 'a', kind: 'text', text: '  ' }).success, false);
  assert.ok(DEFAULT_CHILD_AGENT_DISABLED_TOOLS.includes('solution_selection'));
});

test('binds selection to exact session and turn, does not auto-pick, and accepts free text', async () => {
  const log = new InMemoryRuntimeEventLog(), broker = new RuntimeSolutionBroker(log);
  let settled = false;
  const first = broker.request(identity, 'tool-a', input).then(value => { settled = true; return value; });
  const request = broker.list('session-a')[0];
  assert.equal(broker.list('session-b').length, 0);
  await Promise.resolve(); assert.equal(settled, false);
  assert.throws(() => broker.answer({ ...answerFor(request, { kind: 'option', optionIndex: 0 }), sessionId: 'session-b' }), /different session/);
  assert.throws(() => broker.answer({ ...answerFor(request, { kind: 'option', optionIndex: 0 }), turnId: 'turn-b' }), /different session/);
  assert.throws(() => broker.request(identity, 'second', input), /already pending/);
  broker.answer(answerFor(request, { kind: 'text', text: '先备份，再合并指定字段' }));
  assert.deepEqual(await first, { status: 'selected', source: 'text', text: '先备份，再合并指定字段' });
  assert.throws(() => broker.answer(answerFor(request, { kind: 'option', optionIndex: 0 })), /not pending/);
  assert.equal(broker.list('session-a').length, 0);
  assert.deepEqual(log.replay(identity.sessionId, identity.turnId).map(event => event.kind), ['solution_selection_requested', 'solution_selection_answered']);
});

test('dismissal is a cancellation result, stopping aborts the wait, and other sessions remain live', async () => {
  const broker = new RuntimeSolutionBroker(new InMemoryRuntimeEventLog());
  const controller = new AbortController();
  const first = broker.request(identity, 'tool-a', input, controller.signal);
  const second = broker.request({ ...identity, requestId: 'b', sessionId: 'b', turnId: 'b' }, 'tool-b', { prompt: '目标环境', options: ['测试环境'] });
  const next = broker.list('b')[0];
  assert.throws(() => broker.answer(answerFor(next, { kind: 'option', optionIndex: 1 })), /does not exist/);
  broker.answer(answerFor(next, { kind: 'cancel' }));
  assert.equal((await second).status, 'cancelled');
  assert.equal(broker.list('session-a').length, 1);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(broker.list('session-a').length, 0);
});

test('batch input rejects ambiguous formats, duplicate IDs, empty and oversized questions', () => {
  assert.deepEqual(solutionSelectionInputSchema.parse(batch), batch);
  for (const value of [ {}, { prompt: input.prompt }, { options: input.options }, { ...input, ...batch },
    { questions: [] }, { questions: Array.from({ length: 4 }, (_, i) => ({ ...batch.questions[0], id: String(i) })) },
    { questions: [batch.questions[0], batch.questions[0]] }, { questions: [{ ...batch.questions[0], id: ' ' }] },
    { questions: [{ ...batch.questions[0], options: [] }] }, { questions: [{ ...batch.questions[0], id: 'x'.repeat(81) }] },
    { questions: [{ ...batch.questions[0], options: ['same', 'same'] }] } ]) {
    assert.equal(solutionSelectionInputSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});

test('all answers are checked atomically, bound to question IDs and returned in question order', async () => {
  const log = new InMemoryRuntimeEventLog(), broker = new RuntimeSolutionBroker(log);
  let settled = false;
  const pending = broker.request(identity, 'batch', batch).then(result => { settled = true; return result; });
  const request = broker.list(identity.sessionId)[0];
  const first = { questionId: 'scope', kind: 'option', optionIndex: 0 };
  const second = { questionId: 'period', kind: 'text', text: '近 30 天' };
  for (const invalid of [ { kind: 'option', optionIndex: 0 }, { kind: 'answers', answers: [first] },
    { kind: 'answers', answers: [first, first] }, { kind: 'answers', answers: [first, { ...second, questionId: 'unknown' }] },
    { kind: 'answers', answers: [first, { questionId: 'period', kind: 'option', optionIndex: 1 }] },
    { kind: 'answers', answers: [first, { ...second, text: ' ' }] },
    { kind: 'answers', answers: [first, { ...second, text: 'x'.repeat(8001) }] } ]) {
    assert.throws(() => broker.answer(answerFor(request, invalid)));
    assert.equal(broker.list(identity.sessionId).length, 1);
    assert.equal(log.replay(identity.sessionId, identity.turnId).length, 1, 'invalid batches publish no partial answer');
  }
  const valid = answerFor(request, { kind: 'answers', answers: [second, first] });
  assert.throws(() => broker.answer({ ...valid, sessionId: 'other' }), /different session/);
  assert.throws(() => broker.answer({ ...valid, turnId: 'other' }), /different session/);
  await Promise.resolve(); assert.equal(settled, false);
  broker.answer(valid);
  assert.deepEqual(await pending, { status: 'selected', answers: [
    { questionId: 'scope', prompt: input.prompt, source: 'option', text: input.options[0] },
    { questionId: 'period', prompt: batch.questions[1].prompt, source: 'text', text: '近 30 天' },
  ] });
  assert.equal(log.replay(identity.sessionId, identity.turnId).filter(event => event.kind === 'solution_selection_answered').length, 1);
  assert.throws(() => broker.answer(valid), /not pending/);
});

test('batch dismissal and turn stop resolve no partial answers; one-question batches remain valid', async () => {
  const broker = new RuntimeSolutionBroker(new InMemoryRuntimeEventLog());
  const pending = broker.request(identity, 'batch-cancel', batch);
  broker.answer(answerFor(broker.list(identity.sessionId)[0], { kind: 'cancel' }));
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.answers, undefined);
  const controller = new AbortController();
  const stopped = broker.request(identity, 'batch-stop', batch, controller.signal);
  controller.abort(); await assert.rejects(stopped, { name: 'AbortError' });
  assert.equal(broker.list(identity.sessionId).length, 0);
  const single = broker.request(identity, 'single-batch', { questions: [batch.questions[0]] });
  broker.answer(answerFor(broker.list(identity.sessionId)[0], { kind: 'answers', answers: [{ questionId: 'scope', kind: 'option', optionIndex: 1 }] }));
  assert.equal((await single).answers[0].text, input.options[1]);
});

for (const mode of ['parent', 'batch', 'child', 'noninteractive', 'stop']) test(`offline provider/tool loop: ${mode} selection lifecycle and declarations`, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'cardbush-solutions-'));
  const log = new InMemoryRuntimeEventLog();
  const controller = new AbortController();
  let round = 0, modelReply;
  const event = (requestId, sequence, kind, rest = {}) => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId, sequence, kind, createdAt: new Date().toISOString(), ...rest });
  const host = new InMemoryRuntimeHost({ dataRoot, eventLog: log, provider: { async *stream(request) {
    assert.ok(request.tools.some(tool => tool.name === 'solution_selection'), 'child tool declaration remains unchanged');
    if (++round === 1) {
      yield event(request.requestId, 0, 'tool_call_delta', { index: 0, toolCallId: 'choose', nameDelta: 'solution_selection', argumentsDelta: JSON.stringify(mode === 'batch' ? batch : input) });
      yield event(request.requestId, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      modelReply = request.messages.filter(message => message.role === 'tool').at(-1);
      yield event(request.requestId, 0, 'text_delta', { delta: '已按方案继续。' });
      yield event(request.requestId, 1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  try {
    const catalog = await host.sendCommand({ kind: GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND, payload: {} });
    const tool = catalog.find(entry => entry.definition.name === 'solution_selection');
    assert.ok(tool); assert.equal(tool.manifest.operation, 'solution.select');
    assert.equal(tool.definition.inputSchema.type, 'object');
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) assert.equal(tool.definition.inputSchema[keyword], undefined);
    assert.equal(tool.definition.inputSchema.properties.questions.maxItems, 3);
    const request = { protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL, ...identity, model: 'fixture',
      prefixMessages: [{ role: 'system', content: 'Use the available tools.' }],
      inputMessages: [{ messageId: 'user', message: { role: 'user', content: '解决数据冲突' } }],
      tools: [tool.definition], permissionMode: 'all_free',
      requestCapabilities: { interactiveRequests: mode !== 'noninteractive' }, metadata: mode === 'child' ? { agentRole: 'child' } : {} };
    const running = host.runSessionTurn(request, { signal: controller.signal });
    if (mode === 'parent' || mode === 'batch' || mode === 'stop') {
      const deadline = Date.now() + 3000;
      let pending = [];
      while (!pending.length) {
        pending = await host.sendCommand({ kind: LIST_RUNTIME_SOLUTION_SELECTIONS_COMMAND, payload: { sessionId: identity.sessionId } });
        assert.ok(Date.now() < deadline, 'selection request arrived');
        if (!pending.length) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(round, 1, 'model waits for explicit reply even with full permissions');
      if (mode === 'stop') controller.abort();
      else await host.sendCommand({ kind: ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND, payload: answerFor(pending[0], mode === 'batch'
        ? { kind: 'answers', answers: [{ questionId: 'scope', kind: 'option', optionIndex: 1 }, { questionId: 'period', kind: 'text', text: '上个月' }] }
        : { kind: 'option', optionIndex: 1 }) });
    }
    const terminal = await running;
    if (mode === 'stop') {
      assert.equal(terminal.payload.status, 'stopped');
      assert.deepEqual(await host.sendCommand({ kind: LIST_RUNTIME_SOLUTION_SELECTIONS_COMMAND, payload: { sessionId: identity.sessionId } }), []);
      return;
    }
    assert.equal(terminal.payload.status, 'completed');
    assert.ok(modelReply);
    const result = JSON.parse(modelReply.content);
    if (mode === 'parent') assert.deepEqual(result, { status: 'selected', source: 'option', text: '使用新数据' });
    else if (mode === 'batch') assert.deepEqual(result.answers.map(answer => [answer.questionId, answer.text]), [['scope', '使用新数据'], ['period', '上个月']]);
    else {
      assert.ok(result.runtimeError);
      assert.equal(log.replay(identity.sessionId, identity.turnId).some(event => event.kind === 'solution_selection_requested'), false);
    }
  } finally { controller.abort(); await rm(dataRoot, { recursive: true, force: true }); }
});
