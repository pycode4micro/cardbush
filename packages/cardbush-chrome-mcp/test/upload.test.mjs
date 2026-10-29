import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uploadFiles } from '../dist/pageUpload.js';
import { createCardbushBrowserServer } from '../dist/index.js';

test('validates upload files before page input and never repeats an uncertain selection', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardbush-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '头像 example.txt');
  await writeFile(file, 'fixture');
  const calls = [];
  let failSelection = false, resetInput = false;
  const command = async (name, params) => {
    calls.push({ name, params });
    if (name === 'DOM.resolveNode') return { object: { objectId: 'input' } };
    if (name === 'Runtime.callFunctionOn') return { result: { value: params.functionDeclaration.includes('fileInput:')
      ? { fileInput: true, connected: true, disabled: false, multiple: false }
      : resetInput ? [] : [{ name: path.basename(file), size: 7 }] } };
    if (name === 'DOM.setFileInputFiles' && failSelection) throw Error('connection lost');
    return {};
  };
  for (const filePath of ['relative.txt', path.join(dir, 'missing'), dir]) {
    await assert.rejects(uploadFiles(command, { uid: 'cb_1', filePaths: [filePath] }), error => /invalid_upload_path|upload_file_unavailable/.test(error.code));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(uploadFiles(command, { uid: 'cb_1', filePaths: [file, file] }), error => error.code === 'upload_multiple_not_allowed');
  assert.equal(calls.filter(c => c.name === 'DOM.setFileInputFiles').length, 0);
  assert.equal(calls.at(-1).name, 'Runtime.releaseObject');
  const receipt = await uploadFiles(command, { uid: 'cb_1', filePaths: [file] });
  assert.equal(receipt.fileSelectionVerified, true);
  assert.equal(receipt.outcomeVerified, false);
  assert.deepEqual(calls.find(c => c.name === 'DOM.setFileInputFiles').params.files, [file]);
  resetInput = true;
  assert.equal((await uploadFiles(command, { uid: 'cb_1', filePaths: [file] })).fileSelectionVerified, false);
  failSelection = true;
  await assert.rejects(uploadFiles(command, { uid: 'cb_1', filePaths: [file] }), error =>
    error.code === 'upload_selection_unconfirmed' && error.details.execution === 'unknown');
  assert.equal(calls.filter(c => c.name === 'DOM.setFileInputFiles').length, 3, 'one dispatch per requested selection, never a retry');
  assert.equal(calls.at(-1).name, 'Runtime.releaseObject');
});

test('upload tool is a mutation, requires one observed target and scoped browser access', async () => {
  const server = createCardbushBrowserServer({ connector: async () => { throw Error('unbound request'); } });
  const tool = server._registeredTools.upload_file;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, false);
  for (const input of [ { filePaths: ['x'] }, { uid: 'cb_1', selector: 'input', filePaths: ['x'] },
    { uid: 'cb_1', filePaths: [] } ]) assert.equal(tool.inputSchema.safeParse(input).success, false);
  const result = await tool.handler({ uid: 'cb_1', filePaths: ['x'] }, { mcpReq: { signal: new AbortController().signal } });
  assert.equal(result.structuredContent.error.code, 'browser_scope_missing');
});
