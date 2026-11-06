import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('preload exposes active window APIs without retired Cardling IPC or listeners', () => {
  const ipcRenderer = new EventEmitter();
  let api;
  const code = ts.transpileModule(readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports: {}, process: { platform: process.platform }, require(name) {
    assert.equal(name, 'electron');
    return { ipcRenderer, webUtils: {}, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } };
  } });
  assert.deepEqual(Object.keys(api).filter(name => /cardling/i.test(name)), []);
  assert.deepEqual(ipcRenderer.eventNames().filter(name => String(name).startsWith('cardling:')), []);
  assert.equal(typeof api.openShadowWindow, 'function', 'the active Shadow bridge remains available');
});
