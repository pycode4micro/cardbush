import test from 'node:test';
import assert from 'node:assert/strict';
import { webArtifactManifest, receiptOutputs, generatedArtifactPath } from '../dist-electron/webArtifactManifest.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { WebError, csrfToken } from '../dist-electron/webCommon.mjs';

const root = '/data/workspaces/generated/';
const prefix = 'mcp__plugin_volcengine_images_images__';
const png = i => `${root}original-${i}.png`;
const jpg = i => `${root}stitched-${i}/拼图.jpg`;
const task = (path, sources = []) => ({ kind: sources.length ? 'image_stitch' : 'seedream', status: 'succeeded', result: { data: [{ local_path: path }], sources: sources.map(source_path => ({ source_path })) } });
const stitch = i => ({ toolCall: { name: prefix + 'image_stitch' }, outcome: 'returned', result: { structuredContent: { task: task(jpg(i), Array.from({ length: 4 }, (_, j) => png(i * 4 + j))) } } });
const generated = indices => ({ toolCall: { name: prefix + 'generation_wait_tasks' }, outcome: 'returned', result: { structuredContent: { items: indices.map(i => ({ observation: { task: task(png(i)) } })) } } });
function fixture() {
  const index = new Map([
    ['first', [generated([64, 65, 66])]], // Older rejected samples do not belong to this delivery.
    ['second', [generated(Array.from({ length: 8 }, (_, i) => i)), stitch(0), stitch(1)]],
    ['third', [generated(Array.from({ length: 16 }, (_, i) => i + 8))]],
    ['last', [generated(Array.from({ length: 40 }, (_, i) => i + 24)), ...Array.from({ length: 14 }, (_, i) => stitch(i + 2))]],
  ]);
  const snapshot = { turns: [...index.keys()].map(turnId => ({ turnId, messages: turnId === 'last' ? [{ message: { role: 'assistant', content:
    Array.from({ length: 16 }, (_, i) => `![色${i}](${i === 15 ? jpg('typo') : jpg(i)})`).join('\n') } }] : [] })) };
  const files = new Set([...Array.from({ length: 67 }, (_, i) => png(i)), ...Array.from({ length: 16 }, (_, i) => jpg(i))]);
  const calls = [];
  const agent = { async call(operation, input) {
    calls.push({ operation, input });
    if (operation === 'runtime.command') return index.get(input.payload.turnId) ?? [];
    if (operation === 'sessions.get') return snapshot;
    if (operation === 'chat.jobs') return [];
    assert.equal(operation, 'web.files'); assert.equal(input.action, 'describe');
    if (!files.has(input.path)) throw new Error('ENOENT: missing file');
    return { path: input.path, size: 6 * 1024 * 1024, mime: input.path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }, close() {} };
  return { snapshot, files, calls, agent, index };
}

test('continuation delivers all 64 originals and 16 collages, excluding hallucinated links and rejected samples', async () => {
  const f = fixture(); const items = await webArtifactManifest(f.agent, 'session', 'last', f.snapshot);
  assert.equal(items.length, 80);
  assert.equal(items.filter(item => item.path.endsWith('.png')).length, 64);
  assert.equal(items.filter(item => item.path.endsWith('.jpg')).length, 16);
  assert.equal(new Set(items.map(item => item.path)).size, 80);
  assert.ok(!items.some(item => /typo|original-6[456]/.test(item.path)));
  assert.ok(items.some(item => item.path === jpg(15)), 'The real receipt wins over the mistyped final Markdown.');
  assert.ok(f.calls.every(call => !['chat.send', 'files.list'].includes(call.operation)));
});

test('manifest is turn scoped and never incorporates future turns or unrelated conversation output', async () => {
  const f = fixture(); const items = await webArtifactManifest(f.agent, 'session', 'third', f.snapshot);
  assert.equal(items.length, 16); assert.ok(items.every(item => /original-/.test(item.path)));
  assert.deepEqual(f.calls.filter(call => call.operation === 'runtime.command').map(call => call.input.payload.turnId), ['third']);
});

test('only successful trusted receipts can add generated originals; inputs and arbitrary tools stay excluded', () => {
  const record = stitch(0); record.result.structuredContent.task.result.sources.push({ source_path: '/data/workspaces/uploads/private.png' });
  assert.equal(receiptOutputs([record])[0].sources.length, 4);
  assert.deepEqual(receiptOutputs([{ ...record, outcome: 'failed' }, { ...record, toolCall: { name: 'read_file' } }, { ...record, result: { ...record.result, isError: true } }]), []);
  for (const path of [root + '../private.png', root + '%2e%2e/private.png', 'https://example.test/pic.png', '/data/workspaces/other/a.png', 'file://remote/data/workspaces/generated/a.png']) assert.equal(generatedArtifactPath(path), null);
});

test('file disappearance is excluded but transport failure remains retryable', async () => {
  const f = fixture(); f.files.delete(png(0));
  assert.equal((await webArtifactManifest(f.agent, 'session', 'last', f.snapshot)).length, 79);
  const call = f.agent.call.bind(f.agent); f.agent.call = (operation, input) => { if (operation === 'web.files') throw new Error('transport closed'); return call(operation, input); };
  await assert.rejects(webArtifactManifest(f.agent, 'session', 'last', f.snapshot), /transport closed/);
});

test('HTTP manifest enforces account and turn ownership and coalesces repeat reads', async t => {
  const f = fixture(), sessionId = 'web-' + 'a'.repeat(40), tokens = { alice: { id: 'alice', role: 'member', is_active: true }, bob: { id: 'bob', role: 'member', is_active: true } };
  let starts = 0;
  const store = { async authenticate(token) { return tokens[token.replace(/_+$/, '')] ?? null; }, async conversation(user, id) { if (user !== 'alice' || id !== sessionId) throw new WebError(404, '会话不存在。'); return { id }; } };
  const server = await serveWeb({ origin: 'http://fixture.test', port: 0, host: '127.0.0.1', staticRoot: 'dist-web', modelSecret: 'm'.repeat(64), defaultModelId: 'test', models: [{ id: 'test' }] }, store,
    { async get() { starts++; return f.agent; }, close() {} });
  t.after(() => server.close());
  const request = (user, turn = 'last') => fetch(`http://127.0.0.1:${server.port}/api/web/v1/sessions/${sessionId}/artifacts?turnId=${turn}`, { headers: { Cookie: 'cardbush_web=' + user.padEnd(54, '_'), 'X-CSRF-Token': csrfToken(user.padEnd(54, '_')) } });
  assert.equal((await request('bob')).status, 404); assert.equal(starts, 0);
  assert.equal((await request('missing')).status, 401); assert.equal(starts, 0);
  assert.equal((await request('alice', 'not-this-turn')).status, 404);
  const response = await request('alice'); assert.equal(response.status, 200); assert.equal((await response.json()).length, 80);
  const reads = f.calls.length; assert.equal((await request('alice')).status, 200); assert.equal(f.calls.length, reads);
});
