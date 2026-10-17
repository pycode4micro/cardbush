import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { emptyCanvas, serializeCanvas, CANVAS_FILE_NAME } from '@cardbush/bush-protocol';
import ts from 'typescript';
import { CreationCanvasFiles, readCanvas, exportCanvas } from '../dist-electron/creationCanvasFiles.mjs';
import { captureCanvasVersion, rewriteCanvasResources } from '@cardbush/bush-runtime';

async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-canvas-')); t.after(() => rm(root, { recursive: true, force: true })); const service = new CreationCanvasFiles(async () => root); return { root, service, snapshot: await service.command({ action: 'create', root }) }; }
test('canvas persists independently of a project and uses revision-checked atomic saves', async t => {
  const f = await fixture(t); assert.equal(f.snapshot.document.items.length, 0);
  const second = await f.service.command({ action: 'create', root: f.root, document: emptyCanvas('Ignored duplicate creation') }); assert.equal(second.revision, f.snapshot.revision);
  const results = await Promise.allSettled(['A', 'B'].map(title => f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...f.snapshot.document, title } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String(results.find(result => result.status === 'rejected').reason), /REVISION_CONFLICT/);
  assert.equal((await readCanvas(f.snapshot.path)).document.title, results.find(result => result.status === 'fulfilled').value.document.title);
});

test('canvas retries a transient Windows rename without overwriting a concurrent edit', async t => {
  const f = await fixture(t), original = fs.rename;
  let attempts = 0, changeWhileLocked = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.snapshot.path && attempts++ === 0) {
      if (changeWhileLocked) await writeFile(to, serializeCanvas(emptyCanvas('External edit')));
      throw Object.assign(Error('Windows file lock'), { code: 'EPERM' });
    }
    return original(from, to);
  });
  const saved = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: emptyCanvas('Saved after retry') });
  assert.equal(saved.document.title, 'Saved after retry'); assert.equal(attempts, 2);
  attempts = 0; changeWhileLocked = true;
  await assert.rejects(f.service.command({ action: 'save', path: saved.path, expectedRevision: saved.revision, document: emptyCanvas('Must not replace') }), /REVISION_CONFLICT/);
  assert.equal((await readCanvas(saved.path)).document.title, 'External edit');
  assert.ok((await readdir(f.root)).every(name => !name.endsWith('.tmp') && !name.endsWith('.canvas-lock')));
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

test('fixed versions capture dependencies, survive missing originals and reject ordinary overwrites', async t => {
  const f = await fixture(t), sources = join(f.root, 'live'); await mkdir(sources);
  await writeFile(join(sources, 'image.png'), 'first image');
  await writeFile(join(sources, 'theme.css'), 'body{background:url(image.png)}');
  await writeFile(join(sources, 'part.html'), '<link href="theme.css" rel="stylesheet"><img src="image.png"><a href="https://example.org">Source</a>');
  let current = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [
    { id: 'live', title: 'Live', kind: 'file', source: 'live/part.html', frame: { x: 0, y: 0, width: 500, height: 350 } },
    { id: 'compare', title: 'Comparison', kind: 'file', source: 'live/part.html', reference: { source: 'live/original.pdf', mode: 'snapshot', page: '1' }, frame: { x: 600, y: 0, width: 500, height: 350 } },
  ] } });
  current = await f.service.command({ action: 'freeze', path: current.path, expectedRevision: current.revision, itemId: 'compare' });
  const fixed = current.document.items[1], versionRoot = dirname(join(f.root, fixed.source));
  await writeFile(join(sources, 'part.html'), '<p>New content</p>'); await writeFile(join(sources, 'image.png'), 'new image');
  const refreshed = await readCanvas(current.path);
  assert.notEqual(refreshed.resources.live, current.resources.live); assert.equal(refreshed.resources.compare, current.resources.compare);
  assert.equal(refreshed.revision, current.revision); assert.deepEqual(refreshed.document.items[1], fixed);
  const html = await readFile(join(f.root, fixed.source), 'utf8');
  assert.match(html, /href="https:\/\/example.org"/); assert.match(html, /href="\d+-theme.css"/);
  assert.equal(await readFile(join(versionRoot, html.match(/src="([^"]+)"/)[1]), 'utf8'), 'first image');
  await assert.rejects(f.service.command({ action: 'save', path: current.path, expectedRevision: current.revision, document: { ...current.document, items: current.document.items.map(item => item.id === 'compare' ? { ...item, source: 'live/part.html' } : item) } }), /CANVAS_FIXED_VERSION/);
  // A fixed-only export does not depend on the existence of its original.
  await rm(sources, { recursive: true, force: true });
  const folder = await exportCanvas({ ...current, document: { ...current.document, items: [fixed] } }, f.root);
  const reopened = await readCanvas(join(folder, CANVAS_FILE_NAME));
  assert.ok(reopened.document.items[0].fixed); assert.match(await readFile(join(folder, reopened.document.items[0].source), 'utf8'), /theme.css/);
});

test('fixed Markdown keeps local images but retains ordinary outbound links', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'picture.png'), 'image');
  let current = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [
    { id: 'note', kind: 'markdown', title: 'Notes', markdown: '[Docs](https://example.org)\n\n![Image](picture.png)', frame: { x: 0, y: 0, width: 500, height: 350 } },
  ] } });
  current = await f.service.command({ action: 'freeze', path: current.path, expectedRevision: current.revision, itemId: 'note' });
  assert.match(current.document.items[0].markdown, /canvas-versions\//); assert.match(current.document.items[0].markdown, /https:\/\/example.org/);
  const resumed = await f.service.command({ action: 'unfreeze', path: current.path, expectedRevision: current.revision, itemId: 'note' });
  assert.equal(resumed.document.items[0].fixed, undefined); assert.match(resumed.document.items[0].markdown, /file:\/\//);
});

test('Markdown resource discovery ignores examples and rewrites only real destinations', async () => {
  const examples = [
    '图片：`![替代文字](图片路径.png)`',
    '``![example](nested.png) `code` ``',
    '```md\n![Image](fenced.png)\n<img src="fenced-html.png">\n```',
    '    ![Image](indented.png)',
    '\\![Image](https://example.org)',
    '\\[not a link](escaped.md)',
    '<!-- <img src="comment.png"> -->',
    '[unused]: unused.png',
    '结论有据可查[^1]。\n\n[^1]: 这里写脚注的具体说明。',
    '| 语法 | 示例 |\n| --- | --- |\n| 图片 | `![表格](table.png)` |',
  ].join('\n\n');
  const markdown = examples + '\n\n[![Preview](<image (1).png> "Picture")](guide.md "Read more")\n\n![Ref][picture]\n[Docs][docs]\n\n[picture]: <image (1).png> "Caption"\n[docs]: https://example.org\n\n<img src="image.png">';
  const calls = [];
  const result = await rewriteCanvasResources(markdown, async (value, usage) => { calls.push([value, usage]); return /^https:/.test(value) ? value : 'captured/' + value; }, 'markdown');
  assert.ok(result.startsWith(examples), 'code, comments, escaped markup and unused definitions stay byte-for-byte unchanged');
  assert.deepEqual(calls.filter(([value]) => !/^https:/.test(value)), [
    ['image (1).png', 'asset'], ['guide.md', 'link'], ['image (1).png', 'asset'], ['image.png', 'asset'],
  ]);
  assert.match(result, /<captured\/image%20%281%29.png> "Picture"/);
  assert.match(result, /captured\/guide.md "Read more"/);
  assert.match(result, /\[picture\]: <captured\/image%20%281%29.png> "Caption"/);
  assert.ok(calls.some(([value, usage]) => value === 'https://example.org' && usage === 'link'));
});

test('tutorial Markdown can be frozen and exported without reading example image paths', async t => {
  const f = await fixture(t);
  const markdown = '# 你好\n\n- 图片：`![替代文字](图片路径.png)`\n\n```html\n<img src="示例图片.png">\n```\n\n结论有据可查[^1]。\n\n[^1]: 这里写脚注的具体说明。\n\n![真实图片][image]\n[文档][docs]\n\n[image]: picture.png\n[docs]: https://example.org';
  await writeFile(join(f.root, 'tutorial.md'), markdown); await writeFile(join(f.root, 'picture.png'), 'real image');
  let current = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [
    { id: 'file', kind: 'file', title: 'Tutorial', source: 'tutorial.md', frame: { x: 0, y: 0, width: 500, height: 350 } },
    { id: 'inline', kind: 'markdown', title: 'Inline tutorial', markdown, frame: { x: 520, y: 0, width: 500, height: 350 } },
  ] } });
  const liveExport = await exportCanvas(current, f.root);
  assert.match((await readCanvas(join(liveExport, CANVAS_FILE_NAME))).document.items[1].markdown, /`!\[替代文字\]\(图片路径.png\)`/);
  for (const itemId of ['file', 'inline']) current = await f.service.command({ action: 'freeze', path: current.path, expectedRevision: current.revision, itemId });
  for (const item of current.document.items) {
    const text = item.kind === 'file' ? await readFile(join(f.root, item.source), 'utf8') : item.markdown;
    assert.match(text, /`!\[替代文字\]\(图片路径.png\)`/); assert.match(text, /src="示例图片.png"/);
    assert.match(text, /\[image\]: (?:canvas-versions\/[^/]+\/)?\d+-picture.png/);
    assert.match(text, /\[docs\]: https:\/\/example.org/);
  }
  await rm(join(f.root, 'picture.png')); await rm(join(f.root, 'tutorial.md'));
  const folder = await exportCanvas(current, f.root), exported = await readCanvas(join(folder, CANVAS_FILE_NAME));
  assert.equal(exported.document.items.length, 2); assert.match(exported.document.items[1].markdown, /\[image\]: assets\//);
  const resumed = await f.service.command({ action: 'unfreeze', path: current.path, expectedRevision: current.revision, itemId: 'inline' });
  assert.match(resumed.document.items[1].markdown, /\[image\]: file:\/\//);
  assert.match(resumed.document.items[1].markdown, /`!\[替代文字\]\(图片路径.png\)`/);
});

test('a genuinely missing embedded resource still blocks an incomplete fixed version', async t => {
  const f = await fixture(t), current = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [
    { id: 'broken', kind: 'markdown', title: 'Broken', markdown: '![Real missing image](missing.png)', frame: { x: 0, y: 0, width: 500, height: 350 } },
  ] } });
  await assert.rejects(f.service.command({ action: 'freeze', path: current.path, expectedRevision: current.revision, itemId: 'broken' }), /ENOENT/);
  assert.equal((await readCanvas(current.path)).revision, current.revision);
  await assert.rejects(exportCanvas(current, f.root), /ENOENT/);
});

test('canvas file errors show a useful filename without the IPC envelope or system path', async () => {
  const source = await readFile(new URL('../src/features/creationCanvas/canvasErrors.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { canvasErrorMessage } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
  const error = "Error invoking remote method 'creation:canvas': Error: ENOENT: no such file or directory, stat 'C:\\workspace\\图片路径.png'";
  const text = canvasErrorMessage(error, 'zh');
  assert.match(text, /找不到文件「图片路径.png」/); assert.doesNotMatch(text, /Error|ENOENT|workspace|creation:canvas/);
  assert.match(canvasErrorMessage(error, 'en'), /Cannot find.*图片路径.png/);
});

test('remote file versions fail honestly without changing the manifest', async t => {
  const f = await fixture(t), current = await f.service.command({ action: 'save', path: f.snapshot.path, expectedRevision: f.snapshot.revision, document: { ...emptyCanvas(), items: [
    { id: 'remote', kind: 'file', title: 'Web', source: 'https://example.org', frame: { x: 0, y: 0, width: 500, height: 350 } },
  ] } });
  await assert.rejects(f.service.command({ action: 'freeze', path: current.path, expectedRevision: current.revision, itemId: 'remote' }), /locally/);
  assert.equal((await readCanvas(current.path)).revision, current.revision);
});

test('a changing source cannot be presented as a consistent fixed version', async t => {
  const f = await fixture(t), file = join(f.root, 'live.md'); await writeFile(file, 'Before');
  let reads = 0;
  await assert.rejects(captureCanvasVersion({ id: 'note', title: 'Note', kind: 'file', source: file, frame: { x: 0, y: 0, width: 400, height: 300 } }, f.snapshot.path, {
    read: async path => { const bytes = await readFile(path); if (++reads === 1) await writeFile(file, 'Changed during capture'); return bytes; },
    write: async () => {},
  }), /CANVAS_SOURCE_CHANGED/);
  assert.equal((await readCanvas(f.snapshot.path)).revision, f.snapshot.revision);
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
