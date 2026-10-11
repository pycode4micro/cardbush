import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHookRunner } from '../dist/pluginHookRunner.js';

test('plugin replacement drains foreground and background hooks, suppresses stale starts and resumes explicitly', async () => {
  const calls = [], pending = [];
  const runner = new PluginHookRunner(process.cwd(), { evaluate: async hook => {
    calls.push(hook.id);
    if (hook.pluginId === 'slow') return new Promise(resolve => { pending.push(resolve); });
    return { ok: true };
  } });
  const hook = { id: 'foreground', pluginId: 'slow', root: process.cwd(), dialect: 'claude', event: 'Stop', type: 'prompt', prompt: 'fixture', timeout: 10 };
  const context = { request: { sessionId: 'hooks', turnId: 't', metadata: {} } };
  const foreground = runner.run([hook], 'Stop', context);
  await runner.run([{ ...hook, id: 'background', async: true }], 'Stop', context);
  assert.equal(pending.length, 2);
  let drained = false;
  const removal = runner.removePlugin('slow', true).then(() => { drained = true; });
  await runner.run([hook, { ...hook, id: 'peer', pluginId: 'peer' }], 'Stop', context);
  assert.deepEqual(calls, ['foreground', 'background', 'peer']);
  pending[0]({ ok: true }); await foreground;
  assert.equal(drained, false, 'the other invocation must also complete');
  pending[1]({ ok: true }); await removal;
  await runner.run([hook], 'Stop', context);
  assert.equal(calls.length, 3, 'a stale turn cannot start the suspended plugin again');
  runner.resumePlugins(['slow']);
  const resumed = runner.run([{ ...hook, id: 'replacement' }], 'Stop', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), 'replacement');
  pending[2]({ ok: true }); await resumed; await runner.close();
});
