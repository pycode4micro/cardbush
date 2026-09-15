import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import { checkOfficePreviewAdmission, officePreviewLimits } from '../dist-electron/officePreviewAdmission.js';
import { runResourceManagedCommand, ProcessResourceGovernor, defaultProcessResourceLimits } from '../packages/bush-runtime/dist/processes.js';
import { localFileResponse } from '../dist-electron/localFileStream.js';

test('Office preview rejects large and expanded files before decoding; ordinary workbooks render in a bounded worker', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-office-resources-'));
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sales</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const normal = join(directory, 'report.xlsx');
    await writeFile(normal, bytes); await checkOfficePreviewAdmission(normal);
    const giant = join(directory, 'large.xlsx');
    const file = await open(giant, 'w');
    await file.truncate(officePreviewLimits.compressedBytes + 1); await file.close();
    await assert.rejects(checkOfficePreviewAdmission(giant), /文件较大/);
    const expanded = Buffer.from(bytes);
    const central = expanded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expanded.writeUInt32LE(officePreviewLimits.entryBytes + 1, central + 24);
    const bomb = join(directory, 'huge-entry.xlsx');
    await writeFile(bomb, expanded); await assert.rejects(checkOfficePreviewAdmission(bomb), /文件较大/);
    const truncated = join(directory, 'truncated.xlsx');
    await writeFile(truncated, bytes.subarray(0, bytes.length - 8));
    await assert.rejects(checkOfficePreviewAdmission(truncated), /不完整/);
    const defaults = defaultProcessResourceLimits(8 * 1024 ** 3);
    const governor = new ProcessResourceGovernor({ limits: defaults, availableMemory: () => 4 * 1024 ** 3 });
    const result = await runResourceManagedCommand({ executable: process.execPath,
      args: [resolve('dist-electron/officePreviewWorker.js'), normal], cwd: directory, governor,
      memoryCeilingBytes: 512 * 1024 ** 2, maxOutputBytes: 24 * 1024 ** 2, timeoutMs: 15_000 });
    assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /Sales/); assert.match(result.stdout, /42/);
    assert.equal(result.outputTruncated, false);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /cardbush-office-resources-/);
    await rm(directory, { recursive: true, force: true });
  }
});

test('local media streams with byte backpressure, ranges, HEAD and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-media-resources-'));
  try {
    const filePath = join(directory, 'large-media.bin');
    const file = await open(filePath, 'w');
    await file.write(Buffer.from('hello')); await file.truncate(64 * 1024 ** 2); await file.close();
    const request = new Request('http://fixture/');
    const head = await localFileResponse(filePath, 'application/octet-stream', new Request(request, { method: 'HEAD' }));
    assert.equal(head.headers.get('content-length'), String(64 * 1024 ** 2)); assert.equal(head.body, null);
    const ranged = await localFileResponse(filePath, 'application/octet-stream', request, { start: 0, end: 4 });
    assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'hello');
    const before = process.memoryUsage().arrayBuffers;
    const stream = await localFileResponse(filePath, 'application/octet-stream', request);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(process.memoryUsage().arrayBuffers - before < 2 * 1024 ** 2, 'an unread response cannot buffer the entire file');
    await stream.body.cancel();
    assert.equal((await localFileResponse(filePath, 'application/octet-stream', request, undefined, 1024)).status, 413);
    assert.equal((await localFileResponse(filePath, 'application/octet-stream', request, { start: 80 * 1024 ** 2, end: 81 * 1024 ** 2 })).status, 416);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /cardbush-media-resources-/);
    await rm(directory, { recursive: true, force: true });
  }
});
