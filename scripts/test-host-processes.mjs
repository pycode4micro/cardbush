import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { closeHostProcesses, processOwnerSignal, runHostCommand, spawnHostProcess } from '../dist-electron/hostProcesses.js';

class Renderer extends EventEmitter {
  isDestroyed() { return this.destroyed === true; }
}
const command = (code, signal) => ({ executable: process.execPath, args: ['-e', code], cwd: process.cwd(), signal });

test('renderer lifetime releases only that window; navigations renew ownership without adding listeners', async () => {
  const first = new Renderer(), second = new Renderer();
  const firstSignal = processOwnerSignal(first), secondSignal = processOwnerSignal(second);
  first.emit('did-start-navigation', {}, '/hash', true, true);
  assert.equal(firstSignal.aborted, false);
  first.emit('did-start-navigation', {}, '/frame', false, false);
  assert.equal(firstSignal.aborted, false);
  first.emit('did-start-navigation', {}, '/reload', false, true);
  assert.equal(firstSignal.aborted, true);
  assert.equal(secondSignal.aborted, false);
  for (let index = 0; index < 20; index++) {
    const signal = processOwnerSignal(first);
    assert.equal(signal.aborted, false);
    first.emit('render-process-gone');
    assert.equal(signal.aborted, true);
  }
  assert.equal(first.listenerCount('render-process-gone'), 1);
  first.destroyed = true; first.emit('destroyed');
  assert.equal(processOwnerSignal(first).aborted, true);
});

test('window closure ends its terminal; host closure handles pending launches and prevents new ones', { timeout: 15000 }, async () => {
  const window = new Renderer();
  const task = await spawnHostProcess(command('setTimeout(()=>{},15000)', processOwnerSignal(window)));
  task.child.stdout.resume(); task.child.stderr.resume();
  window.emit('destroyed');
  await task.complete();
  assert.notEqual(task.child.signalCode ?? task.child.exitCode, null);
  const result = await runHostCommand(command('console.log("other-window-still-works")'));
  assert.match(result.stdout, /other-window-still-works/);
  const pending = runHostCommand(command('setTimeout(()=>{},15000)'));
  const rejected = assert.rejects(pending);
  await closeHostProcesses();
  await rejected;
  await assert.rejects(runHostCommand(command('process.exit(0)')), { name: 'AbortError' });
});
