import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';

const { GlobalInstructionsStore, readAgentInstructionDocuments } = createRequire(import.meta.url)('../dist-electron/globalInstructions.js');
const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
async function fixture(t) {
  const directory = await mkdtemp(join(parent, 'global-instructions-test-'));
  t.after(async () => {
    assert.ok(directory.startsWith(parent + sep + 'global-instructions-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'config', 'AGENTS.md');
  return { path, store: new GlobalInstructionsStore(path) };
}

test('settings and subsequent turns read the same UTF-8 AGENTS.md, including external edits and clearing', async t => {
  const { store, path } = await fixture(t);
  const initial = await store.read();
  assert.equal(initial.path, path);
  assert.equal(initial.content, '');
  const saved = await store.save('# 全局约束\n请用中文回答。\n', initial.revision);
  assert.equal(await readFile(path, 'utf8'), saved.content);
  assert.deepEqual(await new GlobalInstructionsStore(path).read(), saved);
  await writeFile(path, '# Global rules\nVerify delivery.');
  const external = await store.read();
  assert.notEqual(external.revision, saved.revision);
  await assert.rejects(store.save('stale editor content', saved.revision), /AGENTS.md changed/);
  assert.equal((await store.read()).content, external.content);
  assert.equal((await store.save('', external.revision)).content, '');
});

test('concurrent settings saves reject a stale revision without losing the first edit', async t => {
  const { store } = await fixture(t);
  const { revision } = await store.read();
  const results = await Promise.allSettled([store.save('first', revision), store.save('second', revision)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((await store.read()).content, 'first');
});

test('invalid or unreadable AGENTS.md fails explicitly instead of silently dropping constraints', async t => {
  const { store, path } = await fixture(t);
  await mkdir(path, { recursive: true });
  await assert.rejects(store.read());
  await rmdir(path);
  await writeFile(path, Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(store.read(), /encoded data|encoding/i);
});

const turn = overrides => createProductAgentTurnRequest({
  requestId: 'request-global', sessionId: 'session-one', turnId: 'turn-one', messageId: 'message-one',
  createdAt: '2026-09-09T00:00:00Z', localDate: '2026-09-09', userText: '检查当前项目',
  model: 'fixture', tools: [], permissionMode: 'task_free', planEnabled: true,
  instructionDocuments: [{ path: 'C:/CardBush/AGENTS.md', scope: 'global', content: '# 工作偏好\n先核对事实，再执行修改。' }],
  ...overrides,
});

test('global prefixes are identical across projects and projectless sessions and are inherited by children', () => {
  const project = turn({ projectDir: 'D:/project-one', projectInstructions: 'OBSOLETE_PROJECT_PROMPT' });
  for (const request of [
    turn({ projectDir: 'D:/project-two', sessionId: 'session-two', localDate: '2026-09-10' }),
    turn({ workspaceDir: 'D:/task-only', sessionId: 'session-three' }),
  ]) {
    assert.deepEqual(request.prefixMessages.slice(0, 2), project.prefixMessages.slice(0, 2));
    assert.notEqual(request.prefixMessages[2].content, project.prefixMessages[2].content);
    assert.deepEqual(request.metadata.subagentChildPrefixMessages[1], project.prefixMessages[1]);
  }
  assert.equal(project.prefixMessages[1].name, 'global_instructions');
  assert.equal(project.prefixMessages[1].role, 'user');
  assert.match(project.prefixMessages[1].content, /<INSTRUCTIONS>\n# 工作偏好\n先核对事实，再执行修改。\n<\/INSTRUCTIONS>/);
  assert.doesNotMatch(JSON.stringify(project), /OBSOLETE_PROJECT_PROMPT|Project instructions/);
  assert.match(project.prefixMessages[2].content, /D:\/project-one/);
  assert.equal(turn({ instructionDocuments: [] }).prefixMessages.some(message => message.name === 'global_instructions'), false);
  const updated = turn({ instructionDocuments: [{ path: 'C:/CardBush/AGENTS.md', scope: 'global', content: 'Updated global rules.' }] });
  assert.deepEqual(updated.prefixMessages[0], project.prefixMessages[0]);
  assert.notDeepEqual(updated.prefixMessages[1], project.prefixMessages[1]);
});


test('project mode loads applicable ancestor files in order, with full user-role bodies and exact scopes', async t => {
  const { store, path: globalPath } = await fixture(t);
  const parentDirectory = join(globalPath, '..', '..', 'projects');
  const project = resolve(parentDirectory, 'project');
  const workingDirectory = join(project, 'src');
  const deeper = join(workingDirectory, 'nested');
  await mkdir(deeper, { recursive: true });
  const definitions = [
    [resolve(parentDirectory), 'Shared ancestor rules.'],
    [project, '# Project rules\nDo not publish builds.'],
    [workingDirectory, '# Directory rules\nUse the existing UI styles.'],
    [deeper, 'Only applies inside nested; do not promote to the parent.'],
  ];
  for (const [directory, content] of definitions) await writeFile(join(directory, 'AGENTS.md'), content);
  await store.save('Global user preferences.', (await store.read()).revision);
  const documents = await readAgentInstructionDocuments(store, project, workingDirectory);
  assert.equal(documents[0].scope, 'global');
  assert.deepEqual(documents.slice(-3).map(document => [document.directory, document.content]), definitions.slice(0, 3));
  assert.equal(documents.some(document => document.directory === deeper), false);
  const request = turn({ instructionDocuments: documents, projectDir: project, workspaceDir: workingDirectory });
  const messages = request.prefixMessages.filter(message => message.name?.endsWith('_instructions'));
  assert.equal(messages.length, documents.length);
  for (let index = 0; index < documents.length; index++) {
    assert.equal(messages[index].role, 'user');
    assert.ok(messages[index].content.includes(documents[index].content));
    assert.ok(messages[index].content.includes(documents[index].path));
  }
  const ownDirectory = await readAgentInstructionDocuments(store, project, deeper);
  assert.equal(ownDirectory.at(-1).directory, deeper);
  await writeFile(join(project, 'AGENTS.md'), 'Updated project rules.');
  assert.equal((await readAgentInstructionDocuments(store, project)).at(-1).content, 'Updated project rules.');
  const projectless = await readAgentInstructionDocuments(store, undefined, workingDirectory);
  assert.deepEqual(projectless.map(document => document.scope), ['global']);
});
