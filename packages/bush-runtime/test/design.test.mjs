import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCanvas, creationCanvasSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionCoordinator, WorkspaceObservationStore, registerWorkspaceTools } from '../dist/index.js';
import { registerDesignTool } from '../dist/designTool.js';

async function fixture(t, deny = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-design-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'space.canvas.json'); await writeFile(path, JSON.stringify(emptyCanvas('My space')));
  if (deny) await mkdir(join(directory, 'other'));
  const registry = new ToolRegistry(); registerWorkspaceTools(registry, new WorkspaceObservationStore()); registerDesignTool(registry);
  let sequence = 0, requests = 0;
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async input => { requests++; return { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'p', answerId: 'a', decision: deny ? 'deny' : 'allow_once', grantedCapabilityIds: deny ? [] : input.capabilityIds }; } } });
  const call = input => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++sequence}`, name: 'design', argumentsText: JSON.stringify({ path, ...input }) },
    { requestId: 'request', sessionId: 'session', turnId: 'turn', round: 1, ordinal: sequence }, undefined,
    { request: { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'model', messages: [], tools: registry.definitions(), permissionMode: 'task_free', metadata: { workspaceDir: deny ? join(directory, 'other') : directory } }, contextMessages: [] });
  return { path, directory, call, requests: () => requests };
}
const card = { id: 'intro', kind: 'html', title: 'Introduction', html: '<h1>Hello</h1>', frame: { x: 40, y: 40, width: 500, height: 240 } };
test('design inspects, composes, preserves unrelated content and records real filesystem changes', async t => {
  const f = await fixture(t);
  const first = await f.call({ action: 'inspect' }); assert.equal(first.kind, 'returned', JSON.stringify(first));
  assert.equal(first.result.layout.width, 1440);
  const changed = await f.call({ action: 'update', expected_revision: first.result.revision, upsert: [card, { id: 'notes', kind: 'markdown', title: 'Notes', markdown: 'Keep this', frame: { x: 700, y: 40, width: 400, height: 300 } }] });
  assert.equal(changed.kind, 'returned', JSON.stringify(changed));
  assert.ok(changed.workspaceChanges.some(change => change.path === f.path), 'layout edits retain ordinary review/revert evidence');
  const updated = await f.call({ action: 'update', expected_revision: changed.result.revision, upsert: [{ ...card, frame: { ...card.frame, x: 80 } }] });
  assert.equal(updated.kind, 'returned', JSON.stringify(updated));
  const final = JSON.parse(await readFile(f.path, 'utf8')); assert.equal(final.items[1].markdown, 'Keep this'); assert.equal(final.items[0].frame.x, 80);
  assert.notEqual(first.result.revision, updated.result.revision);
});
test('stale revisions and invalid batches leave the canvas unchanged', async t => {
  const f = await fixture(t); const first = await f.call({ action: 'inspect' });
  await f.call({ action: 'update', expected_revision: first.result.revision, upsert: [card] });
  const before = await readFile(f.path, 'utf8');
  const stale = await f.call({ action: 'update', expected_revision: first.result.revision, remove: ['intro'] }); assert.notEqual(stale.kind, 'returned');
  assert.equal(stale.execution.effects, 'none'); assert.equal(stale.execution.result, 'known');
  const current = await f.call({ action: 'inspect' });
  for (const change of [{ upsert: [card, card] }, { remove: ['missing'] }, { canvas: { width: 320 } }, { upsert: [{ ...card, frame: { ...card.frame, x: -10 } }] }]) {
    const result = await f.call({ action: 'update', expected_revision: current.result.revision, ...change }); assert.notEqual(result.kind, 'returned', JSON.stringify(result));
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
});
test('concurrent updates cannot both overwrite the same observed revision', async t => {
  const f = await fixture(t), first = await f.call({ action: 'inspect' });
  const results = await Promise.all(['A', 'B'].map(title => f.call({ action: 'update', expected_revision: first.result.revision, canvas: { title } })));
  assert.equal(results.filter(result => result.kind === 'returned').length, 1, JSON.stringify(results));
});
test('design delegates read permission and rejects non-canvas files', async t => {
  const denied = await fixture(t, true), original = await readFile(denied.path, 'utf8');
  const rejected = await denied.call({ action: 'update', expected_revision: '0'.repeat(64), upsert: [card] });
  assert.notEqual(rejected.kind, 'returned'); assert.match(JSON.stringify(rejected), /permission|admission|denied|outside|read/i); assert.equal(await readFile(denied.path, 'utf8'), original);
  const f = await fixture(t); await writeFile(f.path, '{"important":"not a canvas"}');
  assert.notEqual((await f.call({ action: 'update', expected_revision: '0'.repeat(64), upsert: [card] })).kind, 'returned');
  assert.equal(await readFile(f.path, 'utf8'), '{"important":"not a canvas"}');
  assert.throws(() => creationCanvasSchema.parse({ ...emptyCanvas(), items: [card, card] }));
});
