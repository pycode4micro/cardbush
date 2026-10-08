import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, cp, mkdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import PptxGenJS from 'pptxgenjs';
import { Client } from '@modelcontextprotocol/client';
import { ManagedStdioClientTransport } from '../packages/bush-mcp-client/dist/managedStdio.js';
import { loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';

// Run after the frontend and Electron builds. These tests exercise real Chromium
// pixels and the shipped MCP tool, with no visible window or network dependency.
const require = createRequire(import.meta.url), electron = require('electron');
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

async function decode(file) {
  const image = await loadImage(await readFile(file)), canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data };
}
function pixel(image, x, y) {
  const at = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [...image.pixels.slice(at, at + 3)];
}
function near(actual, expected) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 3), `${actual} != ${expected}`);
}

test('native preset geometry, lazy slides, PNG scaling, ASAR and the presentation MCP tool agree', { timeout: 180000 }, async t => {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'pptx-render-test-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), parent); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const source = join(root, 'geometry.pptx'), deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE';
  const first = deck.addSlide(); first.background = { color: '202020' };
  first.addShape(deck.ShapeType.roundRect, { x: 1, y: 1, w: 4, h: .6, rectRadius: .29, fill: { color: 'FFFF00' }, line: { color: 'FFFF00', transparency: 100 } });
  first.addShape(deck.ShapeType.roundRect, { x: 1, y: 2, w: .6, h: 2.8, rectRadius: .27, fill: { color: 'FF0000' }, line: { transparency: 100 } });
  first.addShape(deck.ShapeType.donut, { x: 4, y: 2, w: 2, h: 2, fill: { color: '0070C0' }, line: { transparency: 100 } });
  first.addShape(deck.ShapeType.snipRoundRect, { x: 7, y: 1, w: 4, h: .6, fill: { color: '00CC88' }, line: { transparency: 100 } });
  first.addShape(deck.ShapeType.rightArrow, { x: 7, y: 2, w: 3, h: 1, rotate: 15, fill: { color: 'FF8800' }, line: { transparency: 100 } });
  first.addShape(deck.ShapeType.arc, { x: 7, y: 4, w: 3, h: 1, line: { color: 'FFFFFF', width: 2 } });
  first.addText('Native geometry / 圆角与空心形状', { x: 1, y: 6, w: 10, h: .6, fontSize: 18, color: 'FFFFFF' });
  for (const [index, color] of ['FFFFFF', '00CC88', 'FF8800', '0070C0'].entries()) {
    const slide = deck.addSlide(); slide.background = { color };
    slide.addText(`Lazy slide ${index + 2}`, { x: 1, y: 3, w: 10, h: 1, fontSize: 30 });
  }
  await deck.writeFile({ fileName: source });
  const original = sha(await readFile(source));
  let serial = 0;
  async function render(request, entry = resolve('dist-electron/bootstrap.js'), appEntry = false) {
    const id = serial++, output = join(root, `${id}.png`), job = join(root, `${id}.json`), receipt = join(root, `${id}-result.json`);
    await writeFile(job, JSON.stringify({ path: source, output, expected_sha256: original, ...request }));
    let failure;
    try { await execute(electron, [entry, '--cardbush-presentation-export', job, receipt], { env, windowsHide: true, timeout: 70000, maxBuffer: 65536 }); }
    catch (error) { failure = error; }
    const result = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(Boolean(failure), !result.ok, `process and receipt disagree${appEntry ? ' inside ASAR' : ''}`);
    return { output, ...result };
  }
  const full = await render({ width: 1440 }); assert.equal(full.ok, true, full.error);
  const fullHash = sha(await readFile(full.output));
  const small = await render({ width: 720 }); assert.equal(small.ok, true, small.error);
  const a = await decode(full.output), b = await decode(small.output);
  assert.deepEqual([a.width, a.height, b.width, b.height], [1440, 810, 720, 405]);
  // The pill has a long, flat top. A horizontally stretched quarter ellipse
  // misses this point. The donut's center stays empty and its ring stays blue.
  for (const image of [a, b]) {
    const scale = image.width / (40 / 3);
    const at = (x, y) => pixel(image, x * scale, y * scale);
    near(at(1.6, 1.05), [255, 255, 0]); near(at(1.03, 1.02), [32, 32, 32]);
    near(at(1.3, 1.3), [255, 255, 0]); near(at(1.03, 2.03), [32, 32, 32]);
    near(at(1.3, 3), [255, 0, 0]); near(at(5, 3), [32, 32, 32]); near(at(4.15, 3), [0, 112, 192]);
  }
  const sheet = await render({ pages: [5, 2, 1, 4], width: 640, columns: 2 }); assert.equal(sheet.ok, true, sheet.error);
  assert.equal(sheet.result.slideCount, 5); // Page 5 was outside the initial live-slide window.
  const contact = await decode(sheet.output); assert.deepEqual([contact.width, contact.height], [1292, 732]);
  near(pixel(contact, 10, 10), [0, 112, 192]); near(pixel(contact, 662, 10), [255, 255, 255]);
  near(pixel(contact, 10, 382), [32, 32, 32]); near(pixel(contact, 662, 382), [255, 136, 0]);
  for (const request of [{ pages: [6] }, { pages: [1, 1] }, { expected_sha256: '0'.repeat(64) }, { output: full.output }]) {
    const result = await render(request); assert.equal(result.ok, false);
    if (!request.output) await assert.rejects(access(result.output));
  }
  assert.equal(sha(await readFile(source)), original, 'renders never modify the source');
  assert.equal(sha(await readFile(full.output)), fullHash, 'existing PNG remains intact');

  // Stage only the reachable preview bundles, not years of retained build files.
  const stage = join(root, 'stage'), seen = new Set();
  async function copyAsset(file) {
    if (seen.has(file)) return; seen.add(file);
    const bytes = await readFile(resolve('dist', file));
    await mkdir(dirname(join(stage, 'dist', file)), { recursive: true }); await writeFile(join(stage, 'dist', file), bytes);
    if (!/\.(?:js|css|html)$/.test(file)) return;
    for (const match of bytes.toString().matchAll(/[\w.~$-]+\.(?:js|css|wasm|otf|woff2?)\b/g)) {
      const asset = join('assets', basename(match[0]));
      if (await access(resolve('dist', asset)).then(() => true, () => false)) await copyAsset(asset);
    }
  }
  await copyAsset('office-preview.html');
  for (const file of ['bootstrap.js', 'presentationExport.js', 'officePreviewAdmission.js']) {
    await mkdir(join(stage, 'dist-electron'), { recursive: true }); await cp(resolve('dist-electron', file), join(stage, 'dist-electron', file));
  }
  await writeFile(join(stage, 'dist-electron/main.js'), "throw Error('Export must not initialize desktop services');");
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'presentation-export-test', version: '1.0.0', main: 'dist-electron/bootstrap.js' }));
  const archive = join(root, 'app.asar'); await (await import('@electron/asar')).createPackage(stage, archive);
  const packaged = await render({ width: 720 }, archive, true); assert.equal(packaged.ok, true, packaged.error);
  assert.equal(sha(await readFile(packaged.output)), sha(await readFile(small.output)), 'ASAR uses the identical rendering path');

  const server = (await loadEnabledProductPluginMcpServers([{ path: resolve('assets/plugins'), source: 'bundled' }], join(root, 'apps.json'), [], join(root, 'data')))
    .find(server => server.id === 'plugin_pptx_documents');
  const client = new Client({ name: 'presentation-png-test', version: '1' }); t.after(() => client.close());
  await client.connect(new ManagedStdioClientTransport({ ...server.transport, env: { ...server.transport.env,
    CARDBUSH_PRESENTATION_EXPORT_EXECUTABLE: electron, CARDBUSH_PRESENTATION_EXPORT_ENTRY: resolve('dist-electron/bootstrap.js') } }));
  const capabilities = await client.callTool({ name: 'document_environment', arguments: {} });
  assert.equal(JSON.parse(capabilities.content[0].text).pngPreview, true);
  const throughMcp = join(root, 'mcp.png');
  const response = await client.callTool({ name: 'render_presentation', arguments: { path: source, output: throughMcp, expected_sha256: original, width: 720 } }, undefined, { timeout: 90000 });
  assert.equal(response.isError, undefined, JSON.stringify(response.content.filter(item => item.type === 'text')));
  assert.ok(response.content.some(item => item.type === 'image' && item.mimeType === 'image/png'));
  assert.equal(sha(await readFile(throughMcp)), sha(await readFile(small.output)));
  await client.close();
});
