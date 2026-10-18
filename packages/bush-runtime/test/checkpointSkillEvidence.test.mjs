import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { collectCheckpointSkillExcerpts, checkpointSkillExcerpts, checkpointSkillReceiptEvidence } from '../dist/checkpointSkillEvidence.js';
import { projectContextCompactionMaintenanceMessages, registerContextCompactionTool } from '../dist/contextCompaction.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { InMemoryRuntimeHost, SessionStore } from '../dist/index.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';

// These are the two recorded Skill snapshots and ten PRE-FIX replies. No live
// provider, configuration, installed Skill or business tool is used by this suite.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/skill-compaction-recorded.json', import.meta.url)));
const fixed = { role: 'system', content: 'Frozen system prefix.' };
const user = content => ({ role: 'user', content });
const block = value => `<skill_constraints>${JSON.stringify(value)}</skill_constraints>`;
const all = block({ keep: 'all', retire: [] });
const normalize = text => text.replace(/\s+/g, ' ').trim();
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
  for (const rule of item.rubric) assert.ok(excerpts.some(excerpt => normalize(excerpt.text).includes(normalize(rule.quote))), `${item.name} ${rule.id}: original wording/condition lost`);
  for (const excerpt of excerpts) {
    assert.equal(excerpt.path, item.source.path);
    assert.equal(excerpt.revision, item.source.sha256);
    assert.ok(item.source.content.includes(excerpt.text), 'source wording is never generated from a summary');
  }
};

for (const item of recorded.cases) {
  test(`${item.name}: reject all five recorded prose-only checkpoints, then bind every original requirement and source`, () => {
    for (const pass of item.passes) {
      const input = setup([[user(item.request), ...read(item)]]), tx = new ContextCompactionTransaction(input);
      assert.equal(tx.accept(result(`bad-${pass.pass}`, [{ source: 0, summary: pass.summary }])), false);
      assert.match(receipt(tx).rejected[0].reason, /Skill coverage/);
      assert.deepEqual(tx.canonicalMessages.slice(0, input.messages.length), input.messages);
      // A deterministic correction exercises the protocol; it is NOT a new
      // model-generated summary or evidence of post-fix model quality.
      assert.equal(tx.accept(result(`fixed-${pass.pass}`, [{ source: 0, summary: all }])), true);
      conserved(item, entries(tx));
    }
  });

  test(`${item.name}: five consecutive disk-equivalent checkpoints retain atomic wording, scope and source without rereads`, () => {
    let history = [user(item.request), ...read(item)];
    const expected = collectCheckpointSkillExcerpts(history);
    const registry = new ToolRegistry(); registerContextCompactionTool(registry, () => { throw Error('No execution'); });
    const catalog = JSON.stringify(registry.definitions());
    for (const pass of item.passes) {
      if (pass.stage.user) history.push(user(pass.stage.user));
      const input = setup([history]);
      let tx = new ContextCompactionTransaction(input);
      const job = tx.job();
      assert.deepEqual(job.messages[0], fixed);
      assert.deepEqual(tx.job(), job, 'reading a dispatch cannot mutate the canonical notice/cache prefix');
      assert.equal(tx.accept(result(`carry-${pass.pass}`, [{ source: 0, summary: all }])), true);
      const saved = JSON.parse(JSON.stringify(tx.incremental.history));
      tx = new ContextCompactionTransaction({ ...input, continuation: saved });
      conserved(item, entries(tx));
      assert.deepEqual(entries(tx), expected, 'no source/path drift or repeated expansion across compactions/restart');
      history = JSON.parse(JSON.stringify(tx.incremental.history.slice(-2)));
      assert.equal(JSON.stringify(registry.definitions()), catalog);
    }
  });

  test(`${item.name}: omission of any recorded rubric item's source excerpt is rejected`, () => {
    const history = [user(item.request), ...read(item)], units = collectCheckpointSkillExcerpts(history);
    for (const rule of item.rubric) {
      const missing = units.find(unit => normalize(unit.text).includes(normalize(rule.quote)));
      assert.ok(missing, rule.id);
      const tx = new ContextCompactionTransaction(setup([history]));
      const partial = block({ keep: units.filter(unit => unit.id !== missing.id).map(unit => unit.id), retire: [] });
      assert.equal(tx.accept(result(rule.id, [{ source: 0, summary: partial }])), false, rule.id);
      assert.match(receipt(tx).rejected[0].reason, /Unaccounted Skill/);
      assert.ok(receipt(tx).rejected[0].reason.includes(missing.id));
    }
  });
}

test('native text rendering, forwarded calls, partial reads and actual referenced documents preserve locators', () => {
  const item = recorded.cases[1];
  const direct = collectCheckpointSkillExcerpts(read(item));
  assert.deepEqual(collectCheckpointSkillExcerpts(read(item, `read-${item.name}`, 'text')), direct);
  assert.deepEqual(collectCheckpointSkillExcerpts(read(item, `read-${item.name}`, 'forwarded')), direct);
  const fragment = checkpointSkillExcerpts({ path: item.source.path, content: item.source.content.split('\n').slice(179, 187).join('\n'),
    read: 'range', revision: item.source.sha256, start: 180 });
  assert.ok(fragment.every(unit => unit.start >= 180 && unit.end <= 187));
  assert.ok(fragment.some(unit => unit.text.includes('tail_padding')));
  const ref = { name: 'reference', source: { path: item.source.path.replace('SKILL.md', 'generated-hooks.md'),
    content: 'Read the actual generated result before attaching it.', sha256: 'reference-revision' } };
  const combined = collectCheckpointSkillExcerpts([...read(item), ...read(ref)]);
  assert.ok(combined.some(unit => unit.path === ref.source.path));
  assert.deepEqual(collectCheckpointSkillExcerpts(read(ref)), [], 'an unrelated document is not promoted to Skill requirements');
});

test('unknown IDs, source substitutions and source-content tampering do not pass as retained requirements', () => {
  const [item, other] = recorded.cases, history = [user(item.request), ...read(item)];
  const tx = new ContextCompactionTransaction(setup([history]));
  assert.equal(tx.accept(result('wrong-source', [{ source: 0, summary: block({ keep: collectCheckpointSkillExcerpts(read(other)).map(x => x.id), retire: [] }) }])), false);
  assert.match(receipt(tx).rejected[0].reason, /Unknown/);
  assert.equal(tx.accept(result('good', [{ source: 0, summary: all }])), true);
  for (const change of ['text', 'path', 'revision', 'section']) {
    const pair = structuredClone(tx.incremental.history.slice(-2));
    const data = JSON.parse(pair[1].content), unit = data.skill_evidence[0].excerpts[0];
    if (change === 'section') unit.section = ['Changed applicability'];
    else if (change === 'path' || change === 'revision') data.skill_evidence[0].origins[0][change] = 'Changed';
    else unit[change] = 'Changed';
    pair[1].content = JSON.stringify(data);
    assert.throws(() => collectCheckpointSkillExcerpts(pair), /Invalid saved checkpoint Skill evidence/);
  }
});

test('retirements require model decisions plus quoted source evidence; future conditions cannot silently disappear', () => {
  const item = recorded.cases[0], initial = [user(item.request), ...read(item)];
  const units = collectCheckpointSkillExcerpts(initial);
  const conditional = units.find(unit => unit.text.includes('具体设计版本'));
  assert.ok(conditional);
  const stop = '取消服装设计任务，只解释之前的设计。';
  const history = [...initial, user(stop)], input = setup([history]);
  const attempt = retirement => {
    const tx = new ContextCompactionTransaction(input);
    const accepted = tx.accept(result('retire', [{ source: 0, summary: block({ keep: 'all', retire: [retirement] }) }]));
    return { accepted, tx };
  };
  for (const bad of [
    { id: conditional.id, kind: 'out_of_scope', reason: 'No longer applies.' },
    { id: conditional.id, kind: 'out_of_scope', reason: '', evidence: { message: 4, quote: stop } },
    { id: conditional.id, kind: 'out_of_scope', reason: 'Cancelled.', evidence: { message: 4, quote: 'Invented confirmation' } },
    { id: conditional.id, kind: 'completed_once', reason: 'Completed.', evidence: { message: 4, quote: stop } },
    { id: conditional.id, kind: 'out_of_scope', reason: 'Cancelled.', evidence: { message: 3, quote: '具体设计版本' } },
  ]) assert.equal(attempt(bad).accepted, false);
  const valid = { id: conditional.id, kind: 'out_of_scope', reason: 'The user ended the design workflow.', evidence: { message: 4, quote: stop } };
  const { accepted, tx } = attempt(valid);
  assert.equal(accepted, true);
  assert.ok(!entries(tx).some(unit => unit.id === conditional.id));
  const next = new ContextCompactionTransaction(setup([tx.incremental.history.slice(-2)]));
  assert.equal(next.accept(result('next', [{ source: 0, summary: all }])), true);
  assert.deepEqual(entries(next), entries(tx), 'an explicitly retired item does not resurrect');
});

for (const format of ['incremental', 'ordered']) test(`${format}: staged evidence survives merge and restart without cross-source inheritance`, () => {
  const input = setup(recorded.cases.map(item => [user(item.request), ...read(item)]), format);
  let tx = new ContextCompactionTransaction(input);
  assert.equal(tx.partition(), true);
  assert.equal(tx.accept(result('child-a', [{ source: 0, summary: all }], format)), false);
  if (format === 'incremental') tx = new ContextCompactionTransaction({ ...input, continuation: structuredClone(tx.incremental.history) });
  assert.equal(tx.accept(result('child-b', [{ source: 1, summary: all }], format)), false);
  assert.equal(tx.job().id, 'root');
  assert.equal(tx.accept(result('parent', [{ source: 0, summary: all }, { source: 1, summary: all }], format)), true);
  const evidence = checkpointSkillReceiptEvidence({ role: 'tool', toolCallId: 'final', content: JSON.stringify({ complete: true,
    ...(format === 'incremental' ? receipt(tx) : tx.receiptEvidence) }) });
  for (const [index, item] of recorded.cases.entries()) {
    const own = evidence.find(row => row.source === index).excerpts;
    conserved(item, own);
    assert.ok(own.every(unit => unit.path === item.source.path));
  }
});

test('partial acceptance preserves unrelated work and cannot use another source as retirement evidence', () => {
  const item = recorded.cases[0], stop = 'Stop the other task.';
  const input = setup([[user(item.request), ...read(item)], [user(stop)]]);
  const tx = new ContextCompactionTransaction(input);
  assert.equal(tx.accept(result('part', [{ source: 0, summary: item.passes[4].summary }, { source: 1, summary: 'Other task stopped.' }])), false);
  assert.deepEqual(receipt(tx).accepted, [1]);
  const id = collectCheckpointSkillExcerpts(read(item))[0].id;
  assert.equal(tx.accept(result('cross', [{ source: 0, summary: block({ keep: 'all', retire: [{ id, kind: 'out_of_scope', reason: 'Stopped.', evidence: { message: 4, quote: stop } }] }) }])), false);
  assert.equal(tx.accept(result('own', [{ source: 0, summary: all }])), true);
  assert.equal(tx.incremental.value.summaries[1], 'Other task stopped.');
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
  const original = collectCheckpointSkillExcerpts(history);
  for (let round = 0; round < 5; round++) {
    const tx = new ContextCompactionTransaction(setup([history], 'ordered'));
    const candidate = result(`ordered-${round}`, [{ source: 0, summary: all }], 'ordered');
    assert.equal(tx.accept(candidate), true);
    history = [{ role: 'assistant', content: '', toolCalls: candidate.toolCalls },
      { role: 'tool', toolCallId: candidate.toolCalls[0].id,
        content: JSON.stringify({ ...tx.receiptEvidence, summarized_turns: ['turn-0'] }) }];
    assert.deepEqual(collectCheckpointSkillExcerpts(history), original);
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
      const call = result(`budget-${++attempts}`, [{ source: 0, summary: all }], ordered ? 'ordered' : 'incremental').toolCalls[0];
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
