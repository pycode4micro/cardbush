import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { collectCheckpointSkillExcerpts, checkpointSkillExcerpts, checkpointSkillReceiptEvidence, checkpointSkillSourceLink, validateCheckpointSkillEvidence } from '../dist/checkpointSkillEvidence.js';
import { projectContextCompactionMaintenanceMessages, registerContextCompactionTool } from '../dist/contextCompaction.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { InMemoryRuntimeHost, SessionStore } from '../dist/index.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';

// These are the two recorded Skill snapshots and ten PRE-FIX replies. No live
// provider, configuration, installed Skill or business tool is used by this suite.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/skill-compaction-recorded.json', import.meta.url)));
const fixed = { role: 'system', content: 'Frozen system prefix.' };
const user = content => ({ role: 'user', content });
const block = text => `<skill_constraints>
${text}
</skill_constraints>`;
const normalize = text => text.replace(/\s+/g, ' ').trim();
const rangeFor = (item, quote) => {
  const match = new RegExp(quote.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).exec(item.source.content);
  assert.ok(match, quote);
  const offset = match.index;
  const start = item.source.content.slice(0, offset).split('\n').length;
  return { path: item.source.path, start, end: start + match[0].split('\n').length - 1 };
};
const all = item => block(item.rubric.map(rule => `- ${rule.check} ${checkpointSkillSourceLink(rangeFor(item, rule.quote), rule.id)}`).join('\n'));
const result = (id, updates, format = 'incremental') => ({ status: 'completed', text: '', reasoning: '', usage: {}, finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'checkpoint_context', argumentsText: JSON.stringify(format === 'incremental' ? { updates } : { summaries: updates.map(item => item.summary) }) }] });
const receipt = tx => JSON.parse(tx.incremental.history.at(-1).content);
const read = (item, id = `read-${item.name}`, presentation = 'json') => {
  const { path, sha256, content } = item.source;
  return [{ role: 'assistant', content: '', toolCalls: [{ id, name: presentation === 'forwarded' ? 'call_tool' : 'read_file',
    argumentsText: JSON.stringify(presentation === 'forwarded' ? { name: 'read_file', arguments: { path } } : { path }) }] },
  { role: 'tool', toolCallId: id, content: presentation === 'json' ? JSON.stringify({ path, sha256, content })
    : JSON.stringify({ path, sha256 }) + '\n\n[content]\n' + content }];
};
const setup = (histories, format = 'incremental') => {
  let offset = 1;
  const sources = histories.map((messages, source) => {
    const range = { turnId: `turn-${source}`, target: `source ${source}`, startMessage: offset, endMessageExclusive: offset + messages.length };
    offset += messages.length; return range;
  });
  return { messages: [fixed, ...histories.flat()], prefixMessageCount: 1, sources,
    state: { revision: 1, totalTurns: histories.length, unsummarizedTurnIds: sources.map(item => item.turnId) },
    pressure: { ratio: 0.96 }, inputFormat: format, outputTokens: 12000, maximumOutputTokens: 12000 };
};
const entries = tx => checkpointSkillReceiptEvidence(tx.incremental.history.at(-1)).flatMap(row => row.excerpts);
const conserved = (item, excerpts) => {
  for (const rule of item.rubric) {
    const range = rangeFor(item, rule.quote);
    assert.ok(excerpts.some(e => e.start <= range.start && e.end >= range.end), `${rule.id}: source range lost`);
  }
  for (const excerpt of excerpts) {
    assert.equal(excerpt.path, item.source.path);
    assert.equal(excerpt.revision, item.source.sha256);
    assert.equal(excerpt.text, '', 'the checkpoint must not repeat source paragraphs');
  }
};

for (const item of recorded.cases) {
  test(`${item.name}: recorded incomplete handoffs require source links; five offline compactions preserve authored conditions and references`, () => {
    let history = [user(item.request), ...read(item)];
    const registry = new ToolRegistry(); registerContextCompactionTool(registry, () => { throw Error('No execution'); });
    const catalog = JSON.stringify(registry.definitions());
    let expected;
    for (const pass of item.passes) {
      if (pass.stage.user) history.push(user(pass.stage.user));
      const input = setup([history]);
      let tx = new ContextCompactionTransaction(input);
      const job = tx.job(); assert.deepEqual(job.messages[0], fixed); assert.deepEqual(tx.job(), job);
      assert.doesNotMatch(job.messages.at(-1).content, /Every ID must|"keep":"all"/);
      assert.equal(tx.accept(result(`bad-${pass.pass}`, [{ source: 0, summary: pass.summary }])), false);
      assert.deepEqual(tx.canonicalMessages.slice(0, input.messages.length), input.messages);
      // This authored fixture tests transport/validation, not model understanding.
      const handoff = `${pass.stage.note}\n${all(item)}`;
      assert.equal(tx.accept(result(`fixed-${pass.pass}`, [{ source: 0, summary: handoff }])), true, JSON.stringify(receipt(tx)));
      const saved = JSON.parse(JSON.stringify(tx.incremental.history));
      tx = new ContextCompactionTransaction({ ...input, continuation: saved });
      conserved(item, entries(tx));
      expected ??= entries(tx); assert.deepEqual(entries(tx), expected);
      for (const rule of item.rubric) assert.ok(receipt(tx).summaries[0].summary.includes(rule.check));
      assert.ok(!JSON.stringify(receipt(tx).skill_evidence).includes(item.source.content));
      history = JSON.parse(JSON.stringify(tx.incremental.history.slice(-2)));
      assert.equal(JSON.stringify(registry.definitions()), catalog);
    }
  });
}

test('file versions, line coverage and source membership are checked without claiming semantic validation', () => {
  const item = recorded.cases[0], other = structuredClone(item);
  other.source.sha256 = 'new-revision';
  const excerpts = collectCheckpointSkillExcerpts([...read(item), ...read(other, 'changed')]);
  const contract = { excerpts, messages: [], evidenceMessages: new Set() };
  const check = link => validateCheckpointSkillEvidence(block(`- Before editing, reread the applicable constraints. ${link}`), contract);
  assert.match(check(checkpointSkillSourceLink(rangeFor(item, item.rubric[0].quote))).issue, /Ambiguous/);
  const ref = { ...rangeFor(item, item.rubric[0].quote), revision: item.source.sha256 };
  assert.equal(check(checkpointSkillSourceLink(ref)).issue, undefined);
  assert.match(check(checkpointSkillSourceLink({ ...ref, revision: 'invented' })).issue, /Unknown/);
  assert.match(check(checkpointSkillSourceLink({ ...ref, start: 99999, end: 99999 })).issue, /not delivered/);
  assert.match(check(checkpointSkillSourceLink({ ...ref, path: 'C:/other/SKILL.md' })).issue, /Unknown/);
  assert.match(validateCheckpointSkillEvidence(block('- Missing source.'), contract).issue, /source line link/);
  assert.match(validateCheckpointSkillEvidence(block('{"keep":"all","retire":[]}'), contract).issue, /Markdown/);
  assert.deepEqual(validateCheckpointSkillEvidence(block('none: User ended the workflow; no future execution remains.'), contract), { excerpts: [] });
});

test('native/forwarded reads, partial text archives and reference reads in reverse order track only delivered lines', () => {
  const item = recorded.cases[1];
  assert.deepEqual(collectCheckpointSkillExcerpts(read(item, 'read', 'text')), collectCheckpointSkillExcerpts(read(item, 'read')));
  assert.deepEqual(collectCheckpointSkillExcerpts(read(item, 'read', 'forwarded')), collectCheckpointSkillExcerpts(read(item, 'read')));
  const pair = read(item, 'archive', 'text');
  const prefix = pair[1].content.slice(0, pair[1].content.indexOf('\n\n[content]\n') + 12) + 'first complete line\npartial condition';
  pair[1].content = JSON.stringify({ archived: true, format: 'text', locator: 'tool-result://s/t/archive', originalChars: 20000 }) + '\n\n' + prefix;
  const actual = collectCheckpointSkillExcerpts(pair);
  assert.equal(actual[0].text, 'first complete line\n'); assert.equal(actual[0].end, 1);
  assert.equal(actual[1].start, 2); assert.equal(actual[1].unresolved, 'tool-result://s/t/archive');
  const reference = { name: 'reference', source: { path: item.source.path.replace('SKILL.md', 'resources.md'), content: 'Use the shared queue.', sha256: 'ref-version' } };
  assert.equal(collectCheckpointSkillExcerpts(read(reference)).length, 0);
  assert.ok(collectCheckpointSkillExcerpts([...read(reference), ...read(item)]).some(e => e.path === reference.source.path));
  const tx = new ContextCompactionTransaction(setup([[...read(item), ...read(reference)]]));
  const summary = block(`- Before a heavy task, reread the resource policy. ${checkpointSkillSourceLink({ path: reference.source.path, start: 1, end: 1 })}`);
  assert.equal(tx.accept(result('reference-only', [{ source: 0, summary }])), true);
  const revised = structuredClone(reference); revised.source.sha256 = 'ref-version-2';
  const retained = collectCheckpointSkillExcerpts([...tx.incremental.history.slice(-2), ...read(revised, 'reread-reference')]);
  assert.deepEqual(new Set(retained.map(e => e.revision)), new Set(['ref-version', 'ref-version-2']), 'a known support file remains tracked after its parent text is compacted');
  const ranged = read(item); ranged[1].content = JSON.stringify({ path: item.source.path, sha256: item.source.sha256, start_line: 180, content: 'one\ntwo\n' });
  assert.deepEqual(collectCheckpointSkillExcerpts(ranged).map(e => [e.start, e.end]), [[180, 181]]);
});

test('saved compact references reject tampered ranges, versions and text', () => {
  const item = recorded.cases[0], tx = new ContextCompactionTransaction(setup([[user(item.request), ...read(item)]]));
  assert.equal(tx.accept(result('good', [{ source: 0, summary: all(item) }])), true);
  for (const field of ['start', 'revision', 'text']) {
    const pair = structuredClone(tx.incremental.history.slice(-2)); const data = JSON.parse(pair[1].content);
    if (field === 'revision') data.skill_evidence[0].origins[0].revision = 'forged';
    else data.skill_evidence[0].excerpts[0][field] = field === 'text' ? 'forged source' : 99999;
    pair[1].content = JSON.stringify(data);
    assert.throws(() => collectCheckpointSkillExcerpts(pair), /Invalid saved checkpoint Skill evidence/);
  }
});

test('emergency projection retains complete Skill excerpts and still archives ordinary large results', () => {
  const item = recorded.cases[1], skill = read(item);
  const log = [{ role: 'assistant', content: '', toolCalls: [{ id: 'logs', name: 'read_file', argumentsText: '{"path":"C:/logs/build.log"}' }] },
    { role: 'tool', toolCallId: 'logs', content: 'Routine log. '.repeat(10000) }];
  const projected = projectContextCompactionMaintenanceMessages({ messages: [...skill, ...log], sessionId: 's', turnId: 't',
    pressure: { estimatedPromptTokens: 40000, usableInputTokens: 4000, ratio: 10, measurement: 'provider', reservedOutputTokens: 1000,
      fallbackPromptTokens: 40000, fallbackScale: 1 } });
  assert.equal(projected.compactedToolResults, 1);
  assert.deepEqual(projected.messages.slice(0, 2), skill);
  assert.ok(projected.removedChars > 0);
});

test('committed ordered receipts retain exact Skill sources across five compactions', () => {
  const item = recorded.cases[1];
  let history = [user(item.request), ...read(item)];
  let original;
  for (let round = 0; round < 5; round++) {
    const tx = new ContextCompactionTransaction(setup([history], 'ordered'));
    const candidate = result(`ordered-${round}`, [{ source: 0, summary: all(item) }], 'ordered');
    assert.equal(tx.accept(candidate), true);
    history = [{ role: 'assistant', content: '', toolCalls: candidate.toolCalls },
      { role: 'tool', toolCallId: candidate.toolCalls[0].id,
        content: JSON.stringify({ ...tx.receiptEvidence, summarized_turns: ['turn-0'] }) }];
    original ??= collectCheckpointSkillExcerpts(history);
    assert.deepEqual(collectCheckpointSkillExcerpts(history), original);
    conserved(item, original);
  }
});

for (const ordered of [false, true]) test(`retained Skill evidence is included in the final input budget (ordered=${ordered})`, async t => {
  const item = recorded.cases[1], store = new SessionStore(), now = '2026-10-18T07:40:00Z';
  store.commitTurn('s', { turnId: 'original', turnSequence: 1, createdAt: now, completedAt: now,
    status: 'completed', reason: 'model_response_completed', usage: {},
    messages: [user(item.request), ...read(item)].map((message, index) => ({ messageId: `m-${index}`, turnId: 'original',
      turnSequence: 1, messageIndex: index, createdAt: now, message })) });
  const before = structuredClone(store.snapshot('s').turns);
  let attempts = 0, candidateCounts = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    async countInputTokens(request) {
      const maintenance = request.messages.some(m => m.name === 'context_pressure');
      const evidence = request.messages.filter(m => m.role === 'tool').flatMap(checkpointSkillReceiptEvidence);
      if (!maintenance && evidence.length) { candidateCounts++; conserved(item, evidence.flatMap(row => row.excerpts)); }
      return { source: 'provider', inputTokens: maintenance ? 1000 : evidence.length ? 3500 : 2950 };
    },
    async *stream(request) {
      assert.ok(request.messages.some(m => m.name === 'context_pressure'), 'oversized final context is never dispatched');
      const call = result(`budget-${++attempts}`, [{ source: 0, summary: all(item) }], ordered ? 'ordered' : 'incremental').toolCalls[0];
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 0, kind: 'tool_call_delta', createdAt: now,
        index: 0, toolCallId: call.id, nameDelta: call.name, argumentsDelta: call.argumentsText };
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 1, kind: 'response_completed', createdAt: now, finishReason: 'tool_calls' };
    },
  } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'current', sessionId: 's', turnId: 'current',
    model: 'offline-fixture', prefixMessages: [fixed], inputMessages: [{ messageId: 'next', message: user('Continue.') }],
    ...(ordered ? { tools: [orderedCheckpointTool] } : {}), maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 } });
  assert.equal(terminal.payload.reason, 'context_compaction_result_limit_exceeded', JSON.stringify(terminal.payload));
  assert.equal(attempts, 3);
  assert.equal(candidateCounts, 3);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 1), before);
  assert.equal(store.snapshot('s').turns.at(-1).contextCheckpoint, undefined);
});
