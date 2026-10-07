import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { authorDocument, renderPdf, withOutputs, convertDocument, findOffice } from '../dist/jobs.mjs';
import { inspectDocument, workbookStructure } from '../dist/inspect.mjs';
import { fingerprint, officePackage, safeForOfficeConversion, xml } from '../dist/files.mjs';
import { createDocumentServer, runDocumentJob } from '../dist/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-document-test-'));
  t.after(async () => {
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return root;
}
const spreadsheet = `const book = new tools.ExcelJS.Workbook();
const sheet = book.addWorksheet('销售'); sheet.addRow(['订单', '金额']);
sheet.addRow(['0001234567890123456789', 12]); sheet.addRow(['订单二', 18]);
sheet.getCell('B4').value = { formula: 'SUM(B2:B3)' };
sheet.getCell('AO2').value = 'far column';
await book.xlsx.writeFile(outputs[0]);`;

test('XLSX roundtrip preserves identifiers and formulas, supports row/column paging, and edits a copy', async t => {
  const root = await fixture(t), original = join(root, '销售.xlsx'), output = join(root, 'updated.xlsx');
  const created = await authorDocument('xlsx', { outputs: [original], code: spreadsheet });
  assert.equal(created.validations[0].formulas, 1);
  assert.equal(created.validations[0].missingCaches, 1);
  assert.equal(created.validations[0].calculation, 'not_verified');
  const first = await inspectDocument('xlsx', { path: original, limit: 2 });
  assert.equal(first.nextOffset, 2);
  assert.equal(first.rows[1].cells[0].value, '0001234567890123456789');
  assert.equal(first.rows[1].nextColumn, 41);
  const wide = await inspectDocument('xlsx', { path: original, offset: 1, limit: 1, start_column: 41, expected_sha256: first.sha256 });
  assert.equal(wide.rows[0].cells[0].value, 'far column');
  const end = await inspectDocument('xlsx', { path: original, offset: first.nextOffset });
  assert.equal(end.nextOffset, null);
  assert.equal(end.rows[1].cells[0].formula, 'SUM(B2:B3)');
  await authorDocument('xlsx', { inputs: [{ path: original, sha256: first.sha256 }], outputs: [output],
    code: `const book = new tools.ExcelJS.Workbook(); await book.xlsx.readFile(inputs[0]); book.worksheets[0].getCell('B2').value = 99; await book.xlsx.writeFile(outputs[0]);` });
  assert.equal(await fingerprint(original), first.sha256);
  assert.equal((await inspectDocument('xlsx', { path: output, offset: 1, limit: 1 })).rows[0].cells[1].value, '99');
  assert.deepEqual(await inspectDocument('xlsx', { path: original, limit: 2 }), first, 'explicit reads are repeatable');
});

test('PPTX creation and targeted package editing retain unrelated parts and ordered slides', async t => {
  const root = await fixture(t), original = join(root, 'deck.pptx'), output = join(root, 'edited.pptx');
  await authorDocument('pptx', { outputs: [original], code: `const ppt = new tools.PptxGenJS(); ppt.layout = 'LAYOUT_WIDE';
    for (const title of ['第一页', 'Second slide']) { const slide = ppt.addSlide(); slide.addText(title, {x:1,y:1,w:8,h:1,fontSize:28}); }
    await ppt.writeFile({fileName: outputs[0]});` });
  const first = await inspectDocument('pptx', { path: original, limit: 1 });
  assert.equal(first.pageCount, 2); assert.equal(first.nextOffset, 1);
  assert.equal(first.pages[0].paragraphs[0].text, '第一页');
  await authorDocument('pptx', { inputs: [{ path: original, sha256: first.sha256 }], outputs: [output], code:
    `const zip = await tools.JSZip.loadAsync(await tools.fs.readFile(inputs[0]));
    zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml').async('string')).replace('第一页', '修改标题'));
    await tools.fs.writeFile(outputs[0], await zip.generateAsync({type:'nodebuffer'}));` });
  const a = await officePackage(await readFile(original)), b = await officePackage(await readFile(output));
  assert.equal(await a.file('ppt/slides/slide2.xml').async('string'), await b.file('ppt/slides/slide2.xml').async('string'));
  assert.equal((await inspectDocument('pptx', { path: output, limit: 1 })).pages[0].paragraphs[0].text, '修改标题');
  assert.equal(await fingerprint(original), first.sha256);
});

test('wide spreadsheet output stays bounded and every cell remains reachable by its cursor', async t => {
  const file = join(await fixture(t), 'wide.xlsx');
  await authorDocument('xlsx', { outputs: [file], code: `const book = new tools.ExcelJS.Workbook();
    book.addWorksheet('Wide').addRow(Array.from({length:90}, (_, i) => ({formula:'REPT("A",500)'+' '.repeat(240),result:'A'.repeat(500)})));
    await book.xlsx.writeFile(outputs[0]);` });
  const addresses = [];
  let start_column = 1;
  do {
    const page = await inspectDocument('xlsx', { path: file, limit: 1, start_column });
    assert.ok(JSON.stringify(page).length < 12500);
    assert.ok(page.rows[0].cells.every(cell => cell.valueTruncated && cell.formulaTruncated));
    addresses.push(...page.rows[0].cells.map(cell => cell.address));
    const next = page.rows[0].nextColumn;
    assert.ok(next === null || next > start_column);
    start_column = next;
  } while (start_column !== null);
  assert.equal(addresses.length, 90); assert.equal(new Set(addresses).size, 90);
});

test('DOCX writes real paragraphs and tables and reads them progressively', async t => {
  const file = join(await fixture(t), '中文.docx');
  await authorDocument('docx', { outputs: [file], code: `const { Document, Packer, Paragraph, Table, TableRow, TableCell } = tools.docx;
    const doc = new Document({sections:[{children:[new Paragraph('文档标题'), new Paragraph('正文内容'),
      new Table({rows:[new TableRow({children:[new TableCell({children:[new Paragraph('表格内容')]})]})]})]}]});
    await tools.fs.writeFile(outputs[0], await Packer.toBuffer(doc));` });
  const first = await inspectDocument('docx', { path: file, limit: 2 });
  assert.equal(first.tableCount, 1); assert.equal(first.paragraphs[0].text, '文档标题');
  assert.equal(first.nextOffset, 2);
  assert.equal((await inspectDocument('docx', { path: file, offset: 2 })).paragraphs[0].text, '表格内容');
});

test('PDF can be authored, inspected, and rendered to a nonempty PNG', async t => {
  const root = await fixture(t), file = join(root, 'report.pdf'), image = join(root, 'page.png');
  await authorDocument('pdf', { outputs: [file], code: `const doc = await tools.PDFLib.PDFDocument.create();
    doc.addPage([400,300]).drawText('Document plugin test', {x:30,y:220,size:20});
    doc.addPage([400,300]).drawText('Second page'); await tools.fs.writeFile(outputs[0], await doc.save());` });
  const result = await inspectDocument('pdf', { path: file, limit: 1 });
  assert.equal(result.pageCount, 2); assert.equal(result.nextOffset, 1);
  assert.match(result.pages[0].text, /Document plugin test/);
  const render = await renderPdf({ path: file, output: image, page: 1, scale: 1 });
  const bytes = await readFile(image);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG'); assert.ok(bytes.length > 1000);
  assert.equal(render.width, 400); assert.equal(render.height, 300);
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(400, 300), context = canvas.getContext('2d');
  context.drawImage(await loadImage(bytes), 0, 0);
  const pixels = context.getImageData(20, 50, 350, 50).data;
  assert.ok(pixels.some((value, index) => index % 4 !== 3 && value < 100), 'render contains visible ink');
  assert.equal(await fingerprint(file), result.sha256);
});

test('failed jobs never publish partial outputs or overwrite preexisting files', async t => {
  const root = await fixture(t), source = join(root, 'source.xlsx'), target = join(root, 'target.xlsx');
  await authorDocument('xlsx', { outputs: [source], code: spreadsheet });
  const hash = await fingerprint(source);
  await assert.rejects(authorDocument('xlsx', { inputs: [{ path: source, sha256: '0'.repeat(64) }], outputs: [target], code: 'throw Error("must not run")' }), /changed since/);
  await assert.rejects(access(target));
  await assert.rejects(authorDocument('xlsx', { outputs: [source], code: 'throw Error("must not run")' }), /already exists/);
  await assert.rejects(authorDocument('xlsx', { outputs: [target], code: 'await tools.fs.writeFile(outputs[0], "not a workbook")' }));
  await assert.rejects(access(target));
  const last = join(root, 'last.xlsx');
  await assert.rejects(withOutputs([target, last], async outputs => {
    await writeFile(outputs[0], 'created'); await writeFile(outputs[1], 'created');
    await writeFile(last, 'concurrent user output'); // Destination appears between checking and publication.
  }));
  await assert.rejects(access(target));
  assert.equal(await readFile(last, 'utf8'), 'concurrent user output');
  assert.equal(await fingerprint(source), hash);
});

test('conversion preflight rejects external data and reports missing engines without emitting a file', async t => {
  const root = await fixture(t), source = join(root, 'source.xlsx'), output = join(root, 'converted.pdf');
  await authorDocument('xlsx', { outputs: [source], code: spreadsheet });
  const zip = await officePackage(await readFile(source));
  zip.file('xl/connections.xml', '<connections/>');
  await assert.rejects(safeForOfficeConversion(zip), /external data/);
  zip.remove('xl/connections.xml');
  zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml').async('string')).replace('SUM(B2:B3)', 'WEBSERVICE(&quot;https://example.invalid&quot;)'));
  await assert.rejects(workbookStructure(zip, true), /external services/);
  assert.throws(() => xml('<!DOCTYPE a [<!ENTITY b "x">]><a/>'), /DTD/);
  if (!await findOffice()) {
    await assert.rejects(convertDocument('xlsx', { path: source, output }), error => error.code === 'document_engine_unavailable');
    await assert.rejects(access(output));
  }
});

test('worker preserves cancellation and propagates script failure without outputs', { timeout: 45000 }, async t => {
  const root = await fixture(t), output = join(root, 'cancelled.docx');
  const controller = new AbortController();
  const job = runDocumentJob('docx', 'author', { outputs: [output], code: 'await new Promise(resolve => setTimeout(resolve, 60000));' }, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('cancel document test')), 1500);
  try { await assert.rejects(job, /cancel document test/); } finally { clearTimeout(timer); }
  await assert.rejects(access(output));
  await assert.rejects(runDocumentJob('docx', 'author', { outputs: [output], code: 'throw new Error("author failure")' }), /author failure/);
  await assert.rejects(access(output));
});

test('MCP schemas expose format-specific tools and return one copy of bounded content', async t => {
  const path = join(await fixture(t), 'inspection.xlsx');
  await authorDocument('xlsx', { outputs: [path], code: spreadsheet });
  const server = createDocumentServer('xlsx');
  assert.deepEqual(Object.keys(server._registeredTools), ['document_environment', 'inspect_document', 'author_document', 'convert_document']);
  assert.ok(createDocumentServer('pdf')._registeredTools.render_pdf_page);
  const result = await server._registeredTools.inspect_document.handler({ path, limit: 1 }, { mcpReq: { signal: new AbortController().signal } });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(result.structuredContent, undefined); assert.equal(result.content.length, 1);
  assert.equal(JSON.parse(result.content[0].text).nextOffset, 1);
  assert.equal(server._registeredTools.author_document.annotations.destructiveHint, true);
});
