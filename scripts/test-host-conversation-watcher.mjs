import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/backend/hostConversationWatcher.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { watchHostConversation } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('background conversation status reuses the existing stream attachment contract, with recovery and cleanup', async () => {
  const seen = [], errors = []; let calls = 0, disposed = 0, currentSignal;
  const stop = watchHostConversation(async signal => {
    currentSignal = signal; calls++;
    if (calls === 1) throw Error('temporary disconnect');
    return calls < 4 ? { activeTurnId: 'peer-turn', revision: 'peer-turn:running' } : { revision: 'peer-turn:idle' };
  }, state => seen.push(state), error => errors.push(error), () => disposed++, 5);
  while (!seen.some(state => state.revision === 'peer-turn:idle')) await tick();
  stop(); const count = calls; await tick();
  assert.equal(errors.length, 1); assert.equal(disposed, 1); assert.equal(currentSignal.aborted, true); assert.equal(calls, count);
  assert.ok(seen.some(state => state.activeTurnId === 'peer-turn')); assert.ok(seen.every(state => state.queued.length === 0));
});

test('unmount cancels an in-flight read and never publishes a stale conversation update', async () => {
  const gate = Promise.withResolvers(); let calls = 0, updates = 0, errors = 0, disposed = 0, signal;
  const stop = watchHostConversation(async input => { signal = input; calls++; return gate.promise; },
    () => updates++, () => errors++, () => disposed++, 5);
  stop(); gate.resolve({ activeTurnId: 'old', revision: 'old' }); await tick();
  assert.equal(signal.aborted, true); assert.equal(updates, 0); assert.equal(errors, 0); assert.equal(calls, 1); assert.equal(disposed, 1);
});
