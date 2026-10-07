import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('a delayed companion subscriber receives only the latest state and can unsubscribe', () => {
  const ipcRenderer = new EventEmitter();
  let api;
  const code = ts.transpileModule(readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports: {}, process: { platform: process.platform }, require(name) {
    assert.equal(name, 'electron');
    return { ipcRenderer, webUtils: {}, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } };
  } });
  // The host sends its first state before the deferred UI has downloaded.
  ipcRenderer.emit('cardling:state', {}, { status: 'thinking' });
  const latest = { status: 'complete', miniChat: { lastAssistant: 'Ready.' } };
  ipcRenderer.emit('cardling:state', {}, latest);
  const received = [];
  const off = api.onCardlingState(value => received.push(value));
  assert.deepEqual(received, [latest], 'subscription must replay the current state, not all past updates');
  const next = { status: 'idle' };
  ipcRenderer.emit('cardling:state', {}, next);
  assert.deepEqual(received, [latest, next]);
  off();
  ipcRenderer.emit('cardling:state', {}, { status: 'waiting' });
  assert.equal(received.length, 2);
  const baseline = ipcRenderer.listenerCount('cardling:state');
  for (let i = 0; i < 30; i++) {
    const unsubscribe = api.onCardlingState(value => assert.equal(value.status, 'waiting'));
    unsubscribe();
  }
  assert.equal(ipcRenderer.listenerCount('cardling:state'), baseline, 'remounts must not retain old subscribers');
});
