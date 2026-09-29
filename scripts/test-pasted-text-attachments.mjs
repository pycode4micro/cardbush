import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import ts from 'typescript';
import { PastedTextAttachments, pastedTextDraftLifetime } from '../dist-electron/pastedTextAttachments.mjs';

async function load(file) {
  const source = await readFile(file, 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
}
const { pastedTextSummary } = await load('src/features/composer/pastedText.ts');
const { uploadAgentFile } = await load('src/features/agents/uploadAgentFile.ts');
async function directory(t) {
  const parent = resolve('tmp/pasted-text-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  t.after(async () => { assert.ok(root.startsWith(parent)); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('thresholds and short previews cover plain, CRLF, CR and Unicode text', () => {
  assert.equal(pastedTextSummary('a'.repeat(8000)).attach, false);
  assert.equal(pastedTextSummary('界'.repeat(8001)).attach, true);
  assert.equal(pastedTextSummary('a\n'.repeat(199)).attach, false);
  assert.equal(pastedTextSummary('a\n'.repeat(200)).attach, true);
  assert.equal(pastedTextSummary('one\r\ntwo\rthree\nfour').lines, 4);
  const summary = pastedTextSummary('界'.repeat(1_000_000));
  assert.equal(summary.preview.length, 160);
  assert.ok(JSON.stringify(summary).length < 250);
});

test('UTF-8 file is exact; retaining preserves its path after restart, expiry and delayed removal', async t => {
  const root = await directory(t); let now = Date.now();
  const store = new PastedTextAttachments(root, () => now);
  const text = '\uFEFF中文🙂\r\n  exact whitespace\t\n'.repeat(1000);
  const attachment = await store.create(text);
  assert.equal(await readFile(attachment.path, 'utf8'), text);
  assert.equal(attachment.size, Buffer.byteLength(text));
  assert.equal(attachment.name.endsWith('.txt'), true);
  await store.retain([attachment.id]);
  now += pastedTextDraftLifetime * 2;
  const restarted = new PastedTextAttachments(root, () => now);
  await restarted.sweep(); await restarted.discard(attachment.id);
  assert.equal(await readFile(attachment.path, 'utf8'), text);
});

test('removed unsent files are deleted; inactive drafts expire while active drafts stay intact', async t => {
  const root = await directory(t); let now = Date.now();
  const store = new PastedTextAttachments(root, () => now);
  const removed = await store.create('remove');
  await store.discard(removed.id); await store.discard(removed.id);
  await assert.rejects(stat(removed.path), { code: 'ENOENT' });
  const draft = await store.create('draft');
  now += pastedTextDraftLifetime + 1;
  await store.sweep(); assert.equal(await readFile(draft.path, 'utf8'), 'draft');
  await new PastedTextAttachments(root, () => now).sweep();
  await assert.rejects(stat(draft.path), { code: 'ENOENT' });
});

test('Agent chunk transfer preserves split UTF-8, supports retries and never returns text in its receipt', async t => {
  const store = new PastedTextAttachments(await directory(t));
  const text = '🙂中文\r\n'.repeat(130_000);
  const id = randomUUID(), chunks = [];
  const result = await uploadAgentFile(new Blob([text]), async chunk => {
    const input = { id, ...chunk }; chunks.push(input);
    const receipt = await store.upload(input);
    assert.deepEqual(await store.upload(input), receipt);
    return receipt;
  });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.content.length < 710_000));
  assert.equal(await readFile(result.path, 'utf8'), text);
  assert.ok(JSON.stringify(result).length < 600);
  await store.retain([id]);
  assert.deepEqual(await store.upload(chunks.at(-1)), result);
  await assert.rejects(store.upload({ ...chunks[0], content: Buffer.from('changed').toString('base64') }), /conflict/);
});

test('incomplete uploads cannot be sent and can be removed without leaving files', async t => {
  let now = Date.now();
  const store = new PastedTextAttachments(await directory(t), () => now), id = randomUUID();
  const receipt = await store.upload({ id, offset: 0, content: Buffer.from('partial').toString('base64'), complete: false });
  await assert.rejects(store.retain([id]), /incomplete/);
  await assert.rejects(store.upload({ id, offset: 100, content: 'YQ==', complete: true }), /conflict/);
  await store.discard(id); await assert.rejects(stat(receipt.path), { code: 'ENOENT' });
  const abandoned = await store.upload({ id: randomUUID(), offset: 0, content: 'YQ==', complete: false });
  now += pastedTextDraftLifetime + 1;
  await store.sweep();
  await assert.rejects(stat(abandoned.path), { code: 'ENOENT' });
});

test('failed upload acknowledgements and oversized attachments fail before continuing', async () => {
  let calls = 0;
  await assert.rejects(uploadAgentFile(new Blob(['abc']), async () => { calls++; return { nextOffset: 0 }; }), /acknowledgement/);
  assert.equal(calls, 1);
  await assert.rejects(uploadAgentFile({ size: 64 * 1024 * 1024 + 1 }, async () => { calls++; }), /64 MiB/);
  assert.equal(calls, 1);
});

test('cleanup accepts only generated IDs and never follows directory junctions', async t => {
  const root = await directory(t), managed = join(root, 'managed');
  const store = new PastedTextAttachments(managed);
  await store.create('initialize');
  await assert.rejects(store.discard('../outside'), /Invalid/);
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  const id = randomUUID();
  await symlink(outside, join(managed, id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.discard(id), /Invalid/);
  await store.sweep();
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('concurrent retain wins over a later discard, with no metadata temporary files', async t => {
  const store = new PastedTextAttachments(await directory(t));
  const attachment = await store.create('queued message');
  await Promise.all([store.retain([attachment.id]), store.discard(attachment.id)]);
  assert.equal(await readFile(attachment.path, 'utf8'), 'queued message');
  assert.equal(JSON.parse(await readFile(join(dirname(attachment.path), 'metadata.json'), 'utf8')).state, 'retained');
  assert.deepEqual((await readdir(dirname(attachment.path))).sort(), ['metadata.json', attachment.name].sort());
});
