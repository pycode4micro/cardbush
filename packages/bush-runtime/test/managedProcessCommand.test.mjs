import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoundedProcessOutput, ManagedProcessScope, ProcessResourceGovernor, defaultProcessResourceLimits,
  runResourceManagedCommand, spawnResourceManagedProcess,
} from '../dist/processes.js';
import { executePluginProcess } from '../dist/pluginHookProcess.js';

const command = (code, options = {}) => ({ executable: process.execPath, args: ['-e', code], cwd: process.cwd(), ...options });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function gone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(20);
  }
  assert.fail(`Owned process ${pid} survived cleanup.`);
}
const tree = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore',windowsHide:true});
console.log(JSON.stringify({parent:process.pid,child:child.pid}));setTimeout(()=>{},15000);`;
async function startTree(t, scope) {
  const managed = await scope.spawn(command(tree));
  const ids = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Worker did not start.')), 5000);
    managed.child.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.trim())); }
    });
    managed.child.once('error', error => { clearTimeout(timer); reject(error); });
    managed.child.stderr.resume();
  });
  t.after(async () => { managed.stop(); await managed.complete(); });
  return { managed, ids };
}

test('output budget is shared across streams and stays bounded while receiving', () => {
  const output = new BoundedProcessOutput(1024);
  const chunk = Buffer.alloc(65536, 'x');
  for (let index = 0; index < 100; index++) {
    output.append(index % 2 ? 'stdout' : 'stderr', chunk);
    assert.ok(output.sizeBytes <= 1024);
  }
  output.append('stderr', Buffer.from('last error'));
  assert.equal(output.text('stdout').length + output.text('stderr').length, 1024);
  assert.equal(output.text('stderr'), 'last error');
  chunk.fill('z');
  assert.match(output.text('stdout'), /^x+$/);
  assert.equal(output.truncated, true);
});

test('managed commands preserve env, Unicode, stdin, stderr and nonzero exit', { timeout: 15000 }, async () => {
  const result = await runResourceManagedCommand(command(`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{console.log(process.env.CARDBUSH_TEST_TEXT+'|'+input);console.error('diagnostic');process.exitCode=7;});`, {
    env: { ...process.env, CARDBUSH_TEST_TEXT: '中文😀' }, input: '输入内容',
  }));
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout.trim(), '中文😀|输入内容');
  assert.equal(result.stderr.trim(), 'diagnostic');
  assert.equal(result.outputTruncated, false);
});

test('command output overflow terminates the task, while truncation keeps the final tail', { timeout: 15000 }, async () => {
  const noisy = `for(let i=0;i<64;i++)process.stdout.write('x'.repeat(65536));process.stdout.write('TAIL');`;
  await assert.rejects(runResourceManagedCommand(command(noisy, { maxOutputBytes: 1024 })), { code: 'process_output_limit' });
  const result = await runResourceManagedCommand(command(noisy, { maxOutputBytes: 1024, outputLimit: 'truncate' }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 1024);
  assert.ok(result.stdout.endsWith('TAIL'));
  assert.equal(result.outputTruncated, true);
});

test('scope closure kills only its own process trees and forbids later launches', { timeout: 15000 }, async t => {
  const firstScope = new ManagedProcessScope(), secondScope = new ManagedProcessScope();
  t.after(() => Promise.all([firstScope.close(), secondScope.close()]));
  const first = await startTree(t, firstScope), second = await startTree(t, secondScope);
  await firstScope.close();
  await Promise.all(Object.values(first.ids).map(gone));
  for (const pid of Object.values(second.ids)) assert.doesNotThrow(() => process.kill(pid, 0));
  await assert.rejects(firstScope.spawn(command('process.exit(0)')), { name: 'AbortError' });
  await secondScope.close();
  await Promise.all(Object.values(second.ids).map(gone));
});

test('cancellation during async launch releases the admission slot without starting a command', { timeout: 15000 }, async () => {
  const governor = new ProcessResourceGovernor({ limits: { ...defaultProcessResourceLimits(), maxConcurrentTasks: 1 } });
  const controller = new AbortController();
  const pending = spawnResourceManagedProcess(command('setTimeout(()=>{},15000)', { governor, signal: controller.signal }));
  controller.abort();
  if (process.platform === 'win32') await assert.rejects(pending, { name: 'AbortError' });
  else { const managed = await pending; await managed.complete(); }
  const result = await runResourceManagedCommand(command('console.log("next")', { governor }));
  assert.equal(result.stdout.trim(), 'next');
});

test('timeouts and missing native hosts reject explicitly, without unprotected fallback', { timeout: 15000 }, async () => {
  await assert.rejects(runResourceManagedCommand(command('setTimeout(()=>{},15000)', { timeoutMs: 100 })), { code: 'process_timeout' });
  if (process.platform === 'win32') {
    await assert.rejects(runResourceManagedCommand(command('process.exit(0)', { hostPath: 'C:\\cardbush-nonexistent-test-host.exe' })), { code: 'ENOENT' });
  }
});

test('plugin hooks keep exec/env/input semantics and honor cancellation and output bounds', { timeout: 15000 }, async () => {
  const hook = { command: process.execPath, args: ['-e', `process.stdin.pipe(process.stdout);process.stderr.write(process.env.PLUGIN_ROOT);`], timeout: 5 };
  const result = await executePluginProcess(hook, '{"event":"test"}', process.cwd(), { ...process.env, PLUGIN_ROOT: '中文路径' });
  assert.equal(result.stdout, '{"event":"test"}');
  assert.equal(result.stderr, '中文路径');
  assert.equal(result.exitCode, 0);
  await assert.rejects(executePluginProcess({ ...hook, args: ['-e', 'process.stdout.write("x".repeat(8192))'] }, '', process.cwd(), process.env, undefined, 1024), { code: 'process_output_limit' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executePluginProcess(hook, '', process.cwd(), process.env, controller.signal), { name: 'AbortError' });
});
