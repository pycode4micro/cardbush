import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ToolRegistry, RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore } from '../dist/index.js';
import { registerPluginCommandTools } from '../dist/pluginCommandTools.js';
import { readPluginSkill } from '../dist/pluginSkills.js';
import { collectCheckpointSkillExcerpts } from '../dist/checkpointSkillEvidence.js';
import { renderTextFields } from '../dist/toolResultText.js';
import { literalSourceSpans, projectFileSourceResult } from '../dist/fileSourceReceipt.js';

async function fixture(t, body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-source-delivery-')), path = join(root, 'SKILL.md');
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-source-delivery-'));
    await rm(root, { recursive: true, force: true });
  });
  const raw = `---\r\nname: fixture\r\ndescription: Offline fixture\r\n---\r\n${body}`;
  await writeFile(path, raw);
  const { command } = await readPluginSkill(path, 'fixture', root);
  const registry = new ToolRegistry(), store = new ToolExecutionStore();
  registerPluginCommandTools(registry, async () => [command], { skill: true, ...options });
  registry.register({ definition: { name: 'read_file', description: 'Read test snapshot', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', owner: 'runtime', dispatch_scope: 'session', mutating: false, risk: 'low' },
    decodeInput: x => x, execute: () => ({ path, sha256: command.sourceSnapshot.sha256, start_line: 5, content: body }),
    renderModelResult: value => renderTextFields(value, ['content']), projectModelResult: projectFileSourceResult });
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' }, ...(options.hooks ? { hooks: options.hooks } : {}) });
  const request = { requestId: 'r', sessionId: 's', turnId: 't', permissionMode: 'all_free', metadata: {}, tools: registry.definitions() };
  let round = 0;
  const run = async (name, args = {}, budget) => {
    const call = { protocol: 'bush.tool_call.v1', id: `read-${++round}`, name, argumentsText: JSON.stringify(args) };
    const result = await loop.execute([call], { round, assistantMessageId: `a${round}`, request, contextMessages: [],
      ...(budget === undefined ? {} : { modelContextIngressBudgetTokens: budget }) });
    const messages = [{ role: 'assistant', content: '', toolCalls: [call] }, ...result.messages];
    return { messages, evidence: collectCheckpointSkillExcerpts(messages), record: store.get('s', 't', call.id) };
  };
  return { path, raw, command, run, request };
}

test('run_skill and read_file register the same actual lines and snapshot revision; later disk changes do not relabel them', async t => {
  const f = await fixture(t, '# Task\r\nWhen publishing, require approval.\r\nKeep the selected version.\r\n');
  await writeFile(f.path, 'Changed after loading.');
  const a = await f.run('run_skill', { command: 'fixture:fixture' }), b = await f.run('read_file', { path: f.path });
  assert.equal(a.evidence.length, 1, JSON.stringify(a.messages));
  const facts = rows => rows.map(({ path, revision, start, end, text }) => ({ path, revision, start, end, text }));
  assert.deepEqual(facts(a.evidence), facts(b.evidence));
  assert.equal(a.evidence[0].start, 5);
  assert.equal(a.evidence[0].revision, createHash('sha256').update(f.raw).digest('hex'));
  assert.match(a.evidence[0].locator, /^tool-result:\/\/s\/t\//);
});

for (const name of ['run_skill', 'read_file']) test(`${name}: final shared ingress projection registers only complete visible lines`, async t => {
  const body = Array.from({ length: 1000 }, (_, index) => `Requirement ${index}: keep condition ${index} with its exception.\n`).join('');
  const f = await fixture(t, body);
  const { evidence, messages, record } = await f.run(name, name === 'run_skill' ? { command: 'fixture:fixture' } : { path: f.path }, 1800);
  assert.ok(evidence.length >= 1, JSON.stringify(messages));
  const delivered = evidence.filter(e => !e.unresolved);
  assert.ok(delivered.length > 0);
  assert.ok(delivered.at(-1).end < 1004);
  assert.equal(delivered[0].text, body.split('\n').slice(0, delivered[0].end - 4).join('\n') + '\n');
  assert.ok(evidence.some(e => e.unresolved), 'the unread tail stays explicitly unresolved');
  assert.ok(record.modelText.length > messages[1].content.length, 'the original result stays in the existing archive');
});

for (const name of ['run_skill', 'read_file']) test(`${name}: zero text budget preserves a truthful unread source instead of losing registration`, async t => {
  const f = await fixture(t, 'Future condition: must keep it.\n'.repeat(1000));
  const result = await f.run(name, name === 'run_skill' ? { command: 'fixture:fixture' } : { path: f.path }, 0);
  assert.equal(result.evidence.length, 1, JSON.stringify(result.messages));
  assert.equal(result.evidence[0].text, '');
  assert.equal(result.evidence[0].start, 5);
  assert.equal(result.evidence[0].revision, f.command.sourceSnapshot.sha256);
  assert.match(result.evidence[0].unresolved, /^tool-result:/);
});

test('expanded parameters, activation text and fork results are not original Skill file lines', async t => {
  const f = await fixture(t, 'Before the task, check the version.\n$ARGUMENTS\nAfter editing, inspect the output.\n',
    { onInvoke: async () => 'Runtime activation only.' });
  const result = await f.run('run_skill', { command: 'fixture:fixture', arguments: 'line one\nline two' });
  assert.deepEqual(result.evidence.map(e => [e.start, e.end]), [[5, 5], [7, 7]]);
  assert.ok(result.evidence.every(e => !/line one|activation/.test(e.text)));
  const fork = await fixture(t, 'Never claim an unchecked output passed.\n', { fork: async () => 'Child completed.' });
  fork.command.context = 'fork';
  assert.equal((await fork.run('run_skill', { command: 'fixture:fixture' })).evidence.length, 0);
  const source = 'Before\n!`command`\nAfter\n';
  assert.deepEqual(literalSourceSpans('After\n', source.indexOf('After'), 5, 10, s => s, source),
    [{ offset: 10, length: 6, start_line: 7 }]);
});

test('Hook replacement cannot be registered as the original file even when it uses a file-shaped envelope', async t => {
  const fake = renderTextFields({ path: 'C:/fake/SKILL.md', sha256: 'invented', content: 'Synthetic instructions.' }, ['content']);
  const f = await fixture(t, 'Original rule.\n', { hooks: {
    before: async () => ({ messages: [] }),
    after: async () => ({ messages: [], toolFeedback: fake }),
  } });
  for (const name of ['run_skill', 'read_file']) {
    const result = await f.run(name, name === 'run_skill' ? { command: 'fixture:fixture' } : { path: f.path });
    assert.equal(result.evidence.length, 0);
    assert.ok(result.messages[1].content.includes('Synthetic instructions.'));
    assert.ok(JSON.stringify(result.record.result).includes('Original rule.'));
  }
});
