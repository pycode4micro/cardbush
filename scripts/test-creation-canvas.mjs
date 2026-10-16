import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { emptyCanvas, serializeCanvas, CANVAS_FILE_NAME } from '@cardbush/bush-protocol';
import ts from 'typescript';
import { CreationCanvasFiles, readCanvas, exportCanvas } from '../dist-electron/creationCanvasFiles.mjs';

async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-canvas-')); t.after(() => rm(root, { recursive: true, force: true })); const service = new CreationCanvasFiles(async () => root); return { root, service, snapshot: await service.command({ action: 'create', root }) }; }
test('canvas persists independently of a project and uses revision-checked atomic saves', async t => {
  const f = await fixture(t); assert.equal(f.snapshot.document.items.length, 0);
  const second = await f.service.command({ action: 'create', root: f.root, document: emptyCanvas('Ignored duplicate creation') }); assert.equal(second.revision, f.snapshot.revision);
  const results = await Promise.allSettled(['A', 'B'].map(title => f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...f.snapshot.document, title } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String(results.find(result => result.status === 'rejected').reason), /REVISION_CONFLICT/);
  assert.equal((await readCanvas(f.snapshot.path)).document.title, results.find(result => result.status === 'fulfilled').value.document.title);
});
test('exports copy referenced assets, resource dependencies and source provenance into a reusable folder', async t => {
  const f = await fixture(t); const sources = join(f.root, 'sources'); await mkdir(sources);
  await writeFile(join(sources, 'image.png'), Buffer.from('image content'));
  await writeFile(join(sources, 'theme.css'), 'body{background:url("image.png")}');
  await writeFile(join(sources, 'part.html'), '<link rel="stylesheet" href="theme.css"><img src="image.png">');
  await writeFile(join(sources, 'original.pdf'), Buffer.from('pdf content'));
  const document = { ...emptyCanvas('Space'), items: [{ id: 'file', kind: 'file', title: 'HTML', source: join(sources, 'part.html'), frame: { x: 20, y: 20, width: 600, height: 400 }, reference: { source: join(sources, 'original.pdf'), page: '2', mode: 'snapshot' } }] };
  const saved = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document });
  const folder = await exportCanvas(saved, f.root), reopened = await readCanvas(join(folder, CANVAS_FILE_NAME));
  assert.ok(reopened.document.items[0].source.startsWith('assets/'));
  assert.equal((await readdir(join(folder, 'assets'))).length, 4);
  const html = await readFile(join(folder, reopened.document.items[0].source), 'utf8');
  assert.match(html, /href="\d+-theme.css"/); assert.match(html, /src="\d+-image.png"/);
  const css = await readFile(join(folder, 'assets', html.match(/href="([^"]+)"/)[1]), 'utf8'); assert.match(css, /url\("\d+-image.png"\)/);
  await rm(sources, { recursive: true, force: true });
  assert.equal(await readFile(join(folder, reopened.document.items[0].reference.source), 'utf8'), 'pdf content');
  assert.match(await readFile(join(folder, 'index.html'), 'utf8'), /<iframe/);
  const second = await exportCanvas(reopened, f.root); assert.notEqual(folder, second);
});
test('failed exports roll back only their new folder and invalid writes preserve the original', async t => {
  const f = await fixture(t), before = await readFile(f.snapshot.path, 'utf8');
  await assert.rejects(f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), width: 0 } }));
  assert.equal(await readFile(f.snapshot.path, 'utf8'), before);
  const files = await readdir(f.root);
  await assert.rejects(exportCanvas({ ...f.snapshot, document: { ...emptyCanvas('broken'), items: [{ id: 'x', title: 'Missing', kind: 'file', source: 'absent.pdf', frame: { x: 0, y: 0, width: 100, height: 100 } }] } }, f.root));
  assert.deepEqual(await readdir(f.root), files);
  await assert.rejects(f.service.command({ action: 'image', path: f.snapshot.path, data: 'data:image/png;base64,AAAA' }));
  assert.equal(dirname(f.snapshot.path), f.root);
});
test('canvas resource revisions change without rewriting layout and missing files remain recoverable', async t => {
  const f = await fixture(t), source = join(f.root, 'note.md'); await writeFile(source, 'First version');
  const saved = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [{ id: 'note', title: 'Note', kind: 'file', source: 'note.md', frame: { x: 0, y: 0, width: 400, height: 300 } }] } });
  await writeFile(source, 'A revised version from an agent'); const updated = await readCanvas(saved.path);
  assert.equal(updated.revision, saved.revision); assert.notEqual(updated.resources.note, saved.resources.note);
  await rm(source); assert.equal((await readCanvas(saved.path)).resources.note, 'missing');
  await writeFile(source, 'Restored'); assert.notEqual((await readCanvas(saved.path)).resources.note, 'missing');
});
test('inline Markdown resources and JavaScript/CSS dependencies survive export', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'image.png'), 'png'); await writeFile(join(f.root, 'helper.mjs'), 'export const text="Hello";');
  await writeFile(join(f.root, 'main.mjs'), 'import {text} from "./helper.mjs"; document.body.textContent=text;');
  await writeFile(join(f.root, 'part.html'), '<script type="module" src="main.mjs"></script><img srcset="image.png 1x, image.png 2x">');
  const document = { ...emptyCanvas(), items: [
    { id: 'md', kind: 'markdown', title: 'MD', markdown: '![Image](image.png)', frame: { x: 0, y: 0, width: 400, height: 300 } },
    { id: 'html', kind: 'file', title: 'HTML', source: 'part.html', frame: { x: 450, y: 0, width: 500, height: 300 } },
  ] };
  const folder = await exportCanvas({ ...f.snapshot, document }, f.root), exported = await readCanvas(join(folder, CANVAS_FILE_NAME));
  assert.match(exported.document.items[0].markdown, /assets\/\d+-image.png/);
  const html = await readFile(join(folder, exported.document.items[1].source), 'utf8'); assert.match(html, /srcset="\d+-image.png 1x, \d+-image.png 2x"/);
  const js = await readFile(join(folder, 'assets', html.match(/src="([^"]+)"/)[1]), 'utf8'); assert.match(js, /from "\.\/\d+-helper.mjs"/);
});
test('oversized canvas content fails before serialization can create an unreadable document', () => {
  const item = { kind: 'html', title: 'Large', html: '中'.repeat(200000), frame: { x: 0, y: 0, width: 400, height: 300 } };
  assert.throws(() => serializeCanvas({ ...emptyCanvas(), items: Array.from({ length: 30 }, (_, index) => ({ ...item, id: String(index) })) }), /8 MiB/);
});
test('canvas conversations receive design instructions while legacy document sessions retain their editor contract', async () => {
  const source = await readFile(new URL('../src/backend/creationWorkspaceContext.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { creationWorkspaceInstructions } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
  const current = creationWorkspaceInstructions({ creation_canvas: 'C:/space/space.canvas.json' }, 'C:/space');
  assert.match(current, /design\(action=inspect\)/); assert.match(current, /expected_revision/); assert.match(current, /selected|selection/); assert.doesNotMatch(current, /Create Markdown editor/);
  assert.match(creationWorkspaceInstructions({}, 'C:/legacy'), /Create Markdown editor/);
});
