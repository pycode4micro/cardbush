import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext } from '../dist/index.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { contextPressureNotice, projectContextCompactionMaintenanceMessages, registerContextCompactionTool } from '../dist/contextCompaction.js';
import { validateConversation } from '../dist/sessionStore.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';
import { collectCheckpointSkillExcerpts } from '../dist/checkpointSkillEvidence.js';

const now = '2026-10-18T11:00:00Z';
const source = 'C:/skills/local-preview/SKILL.md#execution; sha256=abc123; bush-tool-result://s/read/skill';
const block = text => `<skill_constraints>\n${text}\n</skill_constraints>`;
const continuous = `Throughout this preview task, run at most one heavy task at a time. Source: ${source}`;
const conditional = `If publication is requested later, get the user's confirmation first. Source: ${source}`;
const oneTime = `Before the first preview, check the dependencies. Source: ${source}`;
const active = block(`${continuous}\n${conditional}`);
const retired = block('none: The user ended the preview workflow and requested only an explanation; its execution requirements no longer apply.');
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const completed = (id, input) => ({ status: 'completed', text: '', usage: {}, finishReason: 'tool_calls',
  toolCalls: [{ protocol: 'bush.tool_call.v1', id, name: 'checkpoint_context', argumentsText: JSON.stringify(input) }] });
const lastReceipt = tx => JSON.parse(tx.canonicalMessages.at(-1).content);
const savedCheckpoint = (id, summary, evidence = {}) => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'checkpoint_context', argumentsText: JSON.stringify({ updates: [{ source: 0, summary }] }) }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify({ complete: true, summarized_turns: ['original'],
    summaries: [{ source: 0, turn_id: 'original', current: false, summary }], ...evidence }) },
];

function fixture(history = [[...savedCheckpoint('prior', active), user('Continue the preview.')]], format = 'incremental') {
  const messages = [{ role: 'system', content: 'Fixed system instructions.' }, ...history.flat()];
  let start = 1;
  const sources = history.map((items, index) => {
    const row = { turnId: `old_${index}`, target: format === 'incremental' ? `source ${index}` : `summaries[${index}]`,
      startMessage: start, endMessageExclusive: start + items.length };
    start = row.endMessageExclusive; return row;
  });
  return { messages, sources, prefixMessageCount: 1,
    state: { revision: history.length, totalTurns: history.length, unsummarizedTurnIds: sources.map(row => row.turnId) },
    pressure: { ratio: 0.96 }, outputTokens: 4000, maximumOutputTokens: 4000, inputFormat: format };
}

test('maintenance carries the review contract without changing the Tool catalog or making file registration mandatory', () => {
  const registry = new ToolRegistry();
  registerContextCompactionTool(registry, () => { throw new Error('No execution'); });
  const before = structuredClone(registry.definitions());
  for (const format of ['incremental', 'ordered', 'separate', 'identified']) {
    const notice = contextPressureNotice(fixture().state, { ratio: 0.96 }, format);
    assert.match(notice.content, /<skill_constraints>/);
    assert.match(notice.content, /previous checkpoint block/);
    assert.match(notice.content, /Continuous constraints remain after being followed once/);
    assert.match(notice.content, /exact source locator/);
    assert.match(notice.content, /Do not create a remember file/);
  }
  assert.deepEqual(registry.definitions(), before);
  assert.doesNotMatch(JSON.stringify(before), /<skill_constraints>/, 'maintenance text is not a new Tool argument or dynamic description');
});

for (const format of ['incremental', 'ordered']) test(`${format}: inherited constraints cannot disappear; explicit retirement remains model-authored`, () => {
  const instruction = 'Stop using that workflow; only explain the saved result.';
  const input = fixture([[...savedCheckpoint('prior', active), user(instruction)]], format), tx = new ContextCompactionTransaction(input);
  const args = summary => format === 'incremental' ? { updates: [{ source: 0, summary }] } : { summaries: [summary] };
  if (format === 'incremental') {
    assert.equal(tx.accept(completed('omitted', args('Dependencies checked; continue.'))), false);
    assert.deepEqual(lastReceipt(tx).accepted, []);
    assert.match(lastReceipt(tx).rejected[0].reason, /previous <skill_constraints>/);
  } else assert.throws(() => tx.accept(completed('omitted', args('Dependencies checked; continue.'))), /previous <skill_constraints>/);
  assert.deepEqual(tx.canonicalMessages.slice(0, input.messages.length), input.messages, 'rejection does not replace the source');
  const retire = retired;
  assert.equal(tx.accept(completed('retired', args(retire))), true);
  const receipt = format === 'incremental' ? lastReceipt(tx) : tx.receiptEvidence;
  const next = new ContextCompactionTransaction(fixture([savedCheckpoint('retired-prior', retire, { skill_evidence: receipt.skill_evidence })], format));
  assert.equal(next.accept(completed('no-resurrection', args('Only explain the existing result.'))), true);
});

test('malformed sections are corrected in the existing receipt while other sources remain accepted', () => {
  const tx = new ContextCompactionTransaction(fixture([[user('Apply the preview Skill.')], [user('An unrelated question.')]]));
  assert.equal(tx.accept(completed('malformed', { updates: [
    { source: 0, summary: '<skill_constraints>Do not run concurrently.' }, { source: 1, summary: 'Independent facts.' },
  ] })), false);
  assert.deepEqual(lastReceipt(tx).accepted, [1]);
  assert.match(lastReceipt(tx).rejected[0].reason, /complete/);
  for (const [index, summary] of [block(''), block('none:'), active + active].entries()) {
    assert.equal(tx.accept(completed(`bad-${index}`, { updates: [{ source: 0, summary }] })), false);
    assert.deepEqual(lastReceipt(tx).accepted_sources, [1]);
  }
  assert.equal(tx.accept(completed('corrected', { updates: [{ source: 0, summary: active }] })), true);
  assert.deepEqual(tx.incremental.value.summaries, [active, 'Independent facts.']);
});

test('quoted blocks, arbitrary Tool results and rejected checkpoint drafts do not create inherited requirements', () => {
  const draft = savedCheckpoint('bad-draft', active);
  draft[1].content = JSON.stringify({ complete: false, accepted: [], rejected: [{ source: 0, reason: 'Rejected.' }] });
  const read = [{ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: active }];
  const tx = new ContextCompactionTransaction(fixture([[user(`Example only: ${active}`), ...read, ...draft]]));
  assert.equal(tx.accept(completed('clean', { updates: [{ source: 0, summary: 'The quoted requirements are not applicable to this task.' }] })), true);
});

for (const format of ['incremental', 'ordered']) test(`${format}: consolidation retains new fragment constraints without leaking them into other sources`, () => {
  const input = fixture([[user('Use the preview Skill.')], [user('Explain a separate topic.')]], format);
  let tx = new ContextCompactionTransaction(input);
  assert.equal(tx.partition(), true);
  const args = (source, summary) => format === 'incremental' ? { updates: [{ source, summary }] } : { summaries: [summary] };
  assert.equal(tx.accept(completed('fragment-a', args(0, active))), false);
  const pending = tx.job();
  if (format === 'incremental') {
    tx = new ContextCompactionTransaction({ ...input, continuation: structuredClone(tx.incremental.history) });
    assert.deepEqual(tx.job(), pending, 'recovery preserves the staged checkpoint and pending dispatch');
  }
  assert.equal(tx.accept(completed('fragment-b', args(1, 'Separate topic; no Skill needed.'))), false);
  assert.equal(tx.job().id, 'root');
  if (format === 'incremental') {
    assert.equal(tx.accept(completed('merge', { updates: [{ source: 0, summary: 'Preview next.' }, { source: 1, summary: 'Separate topic.' }] })), false);
    assert.deepEqual(lastReceipt(tx).accepted, [1]);
    assert.deepEqual(lastReceipt(tx).rejected.map(item => item.source), [0]);
    assert.equal(tx.accept(completed('merge-corrected', args(0, active))), true);
    assert.deepEqual(tx.incremental.value.summaries, [active, 'Separate topic.']);
  } else {
    assert.throws(() => tx.accept(completed('merge', { summaries: ['Preview next.', 'Separate topic.'] })), /source 0.summary/);
    assert.equal(tx.accept(completed('merge-corrected', { summaries: [active, 'Separate topic.'] })), true);
  }
});

test('emergency projection does not archive away constraints present only in the aggregate receipt', () => {
  const checkpoint = savedCheckpoint('aggregate', 'The last accepted source has no Skill.');
  checkpoint[1].content = JSON.stringify({ complete: true, summarized_turns: ['old_0', 'old_1'], summaries: [
    { source: 0, turn_id: 'old_0', summary: active }, { source: 1, turn_id: 'old_1', summary: 'Other facts. '.repeat(400) },
  ] });
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'logs', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'logs', content: 'Routine log line. '.repeat(8000) }, ...checkpoint];
  const projected = projectContextCompactionMaintenanceMessages({ messages, sessionId: 's', turnId: 'current',
    pressure: { estimatedPromptTokens: 10000, usableInputTokens: 3000, ratio: 3.33, measurement: 'provider', reservedOutputTokens: 1000,
      fallbackPromptTokens: 10000, fallbackScale: 1 } });
  assert.equal(projected.compactedToolResults, 1);
  assert.ok(projected.removedChars > 0);
  assert.deepEqual(projected.messages.slice(-2), checkpoint);
  const required = new ContextCompactionTransaction(fixture([checkpoint]));
  assert.equal(required.accept(completed('missing-earlier-source', { updates: [{ source: 0, summary: 'Forgot the first source.' }] })), false);
  assert.match(lastReceipt(required).rejected[0].reason, /previous <skill_constraints>/);
});

test('three active-Turn compactions and a restarted follow-up retain constraints and sources without rereads or new memory files', async t => {
  const journal = [], persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
  let store = new SessionStore({ persistence }), host;
  const observed = [], checkpointSummaries = [
    `Skill read. Next check dependencies.\n${block(`${continuous}\n${conditional}\n${oneTime}`)}`,
    `Dependencies verified successfully. Next produce the local preview.\n${active}`,
    `Local preview verified; no publication performed.\n${active}`,
    `Later user instruction ends the preview workflow.\n${retired}`,
    'Continue explaining the saved result; no new execution.',
  ];
  let normalRounds = 0, compactions = 0, attempts = 0, omittedOnce = false, forceCompaction = false, reads = 0;
  const createRegistry = () => {
    const registry = new ToolRegistry();
    for (const name of ['read_file', 'preview_step']) registry.register({
      definition: { name, description: `Fixture ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'runtime', dispatch_scope: 'turn', mutating: false },
      decodeInput: input => input,
      execute: () => name === 'read_file' ? (++reads, { path: 'C:/skills/local-preview/SKILL.md', sha256: 'abc123',
        content: `${continuous}\n\n${conditional}\n\n${oneTime}` }) : { verified: true },
    });
    return registry;
  };
  let registry = createRegistry();
  const emit = (request, sequence, kind, payload) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, kind, createdAt: now, ...payload });
  const provider = {
    async countInputTokens(request) {
      if (request.messages.some(m => m.name === 'context_pressure')) return { source: 'provider', inputTokens: 2900 };
      const last = request.messages.findLast(m => m.role === 'tool');
      // A retained work receipt remains visible after compaction. Only newly
      // produced work increases this fixture's input count, not that receipt's position.
      return { source: 'provider', inputTokens: forceCompaction ||
        (normalRounds > compactions && last?.toolCallId.startsWith('work-')) ? 2860 : 100 };
    },
    async *stream(request) {
      observed.push(structuredClone(request)); validateConversation(request.messages);
      const notice = request.messages.find(m => m.name === 'context_pressure');
      if (notice) {
        attempts++;
        assert.match(notice.content, /previous checkpoint block/);
        const inherited = request.messages.filter(m => m.role === 'tool').flatMap(m => {
          try { return JSON.parse(m.content).summaries ?? []; } catch { return []; }
        });
        if (compactions > 0) assert.ok(inherited.some(item => item.summary === checkpointSummaries[compactions - 1]),
          'prior authored handoff is available to review: ' + request.messages.findLast(message => message.role === 'tool')?.content);
        const omit = compactions === 1 && !omittedOnce;
        omittedOnce ||= omit;
        if (!omit && compactions === 1) {
          const rejected = JSON.parse(request.messages.findLast(m => m.role === 'tool').content);
          assert.match(rejected.rejected[0].reason, /previous <skill_constraints>/);
          assert.equal(rejected.complete, false);
        }
        let summary = 'Dependencies checked. Continue.';
        if (!omit) {
          summary = checkpointSummaries[compactions];
          if (compactions < 3) {
            const withLink = (text, line) => `${text} [source](<C:/skills/local-preview/SKILL.md?revision=abc123#L${line}-L${line}>)`;
            summary = summary.replace(continuous, withLink(continuous, 1)).replace(conditional, withLink(conditional, 3)).replace(oneTime, withLink(oneTime, 5));
          }
          checkpointSummaries[compactions++] = summary;
        }
        forceCompaction = false;
        const sources = notice.content.split('\n').filter(line => line.startsWith('{')).map(JSON.parse)
          .filter(source => Number.isInteger(source.source));
        yield emit(request, 0, 'tool_call_delta', { index: 0, toolCallId: `cp-${attempts}`, nameDelta: 'checkpoint_context',
          argumentsDelta: JSON.stringify({ updates: sources.map(({ source }) => ({ source, summary })) }) });
        yield emit(request, 1, 'response_completed', { finishReason: 'tool_calls' });
        return;
      }
      if (compactions) {
        const receipt = JSON.parse(request.messages.findLast(m => m.role === 'tool' && m.content.includes('summarized_turns')).content);
        assert.equal(receipt.summaries[0].summary, checkpointSummaries[compactions - 1]);
        if (compactions <= 3) {
          assert.ok(JSON.stringify(receipt.skill_evidence).includes('C:/skills/local-preview/SKILL.md'));
          assert.ok(receipt.summaries[0].summary.includes(continuous));
          assert.ok(!JSON.stringify(receipt.skill_evidence).includes(continuous), 'raw constraints are not reinjected');
          if (compactions > 1) assert.ok(!receipt.summaries[0].summary.includes(oneTime), 'completed prerequisite is no longer pending');
        }
      }
      normalRounds++;
      if (normalRounds <= 3) {
        yield emit(request, 0, 'tool_call_delta', { index: 0, toolCallId: `work-${normalRounds}`,
          nameDelta: normalRounds === 1 ? 'read_file' : 'preview_step', argumentsDelta: '{}' });
        yield emit(request, 1, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield emit(request, 0, 'text_delta', { delta: 'Local result ready.' });
        yield emit(request, 1, 'response_completed', { finishReason: 'stop' });
      }
    },
  };
  const makeHost = () => new InMemoryRuntimeHost({ provider, toolRegistry: registry, sessionStore: store, registerDefaultWorkspaceTools: false });
  host = makeHost();
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const prefix = [{ role: 'system', content: 'Fixed system instructions; user directions govern Skill applicability.' }];
  const tools = registry.definitions().filter(item => ['checkpoint_context', 'read_file', 'preview_step'].includes(item.name));
  const run = (turnId, content) => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 's', turnId,
    model: 'fixture', prefixMessages: prefix, tools, inputMessages: [{ messageId: `${turnId}-user`, message: user(content) }],
    maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 } });
  const first = await run('preview', 'Use the preview Skill, check prerequisites and make a local preview.');
  assert.equal(first.payload.status, 'completed', JSON.stringify(first.payload));
  assert.equal(compactions, 3);
  assert.equal(attempts, 4, 'one missing handoff is corrected through the existing incremental receipt');
  assert.equal(host.events('s', 'preview').filter(e => e.kind === 'context_compaction_completed').length, 3);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  store = new SessionStore({ persistence }); registry = createRegistry(); host = makeHost();
  assert.ok(JSON.stringify(assembleContext({ session: store.snapshot('s'), prefix }).messages).includes(continuous));
  forceCompaction = true;
  const explained = await run('explain', 'Stop using that workflow; only explain the existing result.');
  assert.equal(explained.payload.status, 'completed', JSON.stringify(explained.payload));
  forceCompaction = true;
  const explainedAgain = await run('explain-again', 'Continue the explanation.');
  assert.equal(explainedAgain.payload.status, 'completed', JSON.stringify(explainedAgain.payload));
  assert.equal(compactions, 5);
  assert.equal(reads, 1, 'no blanket Skill reread after compaction');
  for (const request of observed) {
    assert.deepEqual(request.messages.filter(m => m.role === 'system'), prefix);
    assert.deepEqual(request.tools, observed[0].tools, 'all normal, maintenance, correction and resumed requests share the same catalog');
  }
  const finalContext = assembleContext({ session: store.snapshot('s'), prefix }).messages;
  assert.ok(!JSON.stringify(finalContext).includes(continuous), 'retired requirements do not resurrect from covered history');
  const calls = store.snapshot('s').turns.flatMap(turn => turn.messages.flatMap(item => item.message.role === 'assistant' ? item.message.toolCalls : []));
  assert.ok(calls.every(call => ['checkpoint_context', 'read_file', 'preview_step'].includes(call.name)), 'no memo or file-writing pipeline');
});
