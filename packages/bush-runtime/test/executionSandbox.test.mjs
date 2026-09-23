import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ProcessResourceGovernor, runResourceManagedCommand, sandboxEnvironment, spawnResourceManagedProcess } from '../dist/processes.js';
import { TerminalSessionManager } from '../dist/index.js';
import { commandInvocation } from '@cardbush/platform';

test('command sandbox removes host secrets and execution injection variables from the environment', () => {
  const environment = sandboxEnvironment({ Path: 'tools', SystemRoot: 'system', LANG: 'en_US.UTF-8',
    CARDBUSH_MCP_DESKTOP_BRIDGE: '1', CARDBUSH_TEST_SECRET: 'secret', OPENAI_API_KEY: 'secret',
    NODE_OPTIONS: '--require malicious.js', LD_PRELOAD: 'malicious.so', PYTHONPATH: 'injection', HTTP_PROXY: 'credential',
  }, resolve('private'));
  assert.equal(environment.Path, 'tools'); assert.equal(environment.SystemRoot, 'system');
  for (const key of ['CARDBUSH_MCP_DESKTOP_BRIDGE', 'CARDBUSH_TEST_SECRET', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD', 'PYTHONPATH', 'HTTP_PROXY']) assert.equal(environment[key], undefined, key);
  assert.equal(environment.HOME, resolve('private')); assert.equal(environment.TEMP, resolve('private/tmp'));
});

test('Windows AppContainer enforces file, child process, network and environment boundaries', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-sandbox-test-'));
  t.after(async () => { assert.equal(dirname(root).toLowerCase(), resolve(tmpdir()).toLowerCase()); await rm(root, { recursive: true, force: true }); });
  const work = join(root, 'work'), outside = join(root, 'outside'), reference = join(root, 'reference'), tools = join(root, 'tools');
  await Promise.all([work, outside, reference, tools].map(path => mkdir(path)));
  await writeFile(join(outside, 'secret.txt'), 'outside secret'); await writeFile(join(reference, 'reference.txt'), 'reference');
  await symlink(outside, join(work, 'escape'), 'junction');
  const executable = join(tools, 'sandbox worker.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
    fileURLToPath(new URL('./fixtures/SandboxWorker.cs', import.meta.url))], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const acl = path => {
    const result = spawnSync(executable, ['acl', path], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const before = new Map([work, reference, tools].map(path => [path, acl(path)]));
  const server = createServer(socket => socket.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let sandboxConnections = 0;
  const reachable = createConnection({ host: '127.0.0.1', port: server.address().port });
  await once(reachable, 'close');
  server.on('connection', () => { sandboxConnections++; });
  const result = await runResourceManagedCommand({ executable, args: ['probe', work, outside, reference, String(server.address().port)], cwd: work,
    env: { ...process.env, CARDBUSH_TEST_SECRET: 'secret', NODE_OPTIONS: '--require forbidden.js' },
    sandbox: { readableRoots: [tools, reference], writableRoots: [work], network: 'disabled' }, timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const facts = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => line.split('=')));
  assert.equal(facts.insideWrite, 'allowed'); assert.equal(facts.readOnlyRead, 'allowed');
  for (const key of ['outsideWrite', 'outsideRead', 'readOnlyWrite', 'linkedWrite', 'childOutsideWrite']) assert.equal(facts[key], 'UnauthorizedAccessException', JSON.stringify(facts));
  assert.ok(['SocketException', 'TimeoutException'].includes(facts.network), JSON.stringify(facts));
  assert.equal(sandboxConnections, 0, 'a reachable host service receives no sandbox connection');
  assert.equal(facts.hostSecret, 'absent'); assert.equal(facts.nodeOptions, 'absent');
  assert.equal(await readFile(join(work, 'inside.txt'), 'utf8'), 'allowed');
  for (const [path, original] of before) assert.equal(acl(path), original, `ACL restored: ${path}`);

  await t.test('concurrent containers retain peer access and stop cleans only its own grant', async () => {
    const nested = join(work, 'nested'); await mkdir(nested);
    const originals = new Map([work, nested, tools].map(path => [path, acl(path)]));
    const start = async (directory, file) => {
      const task = await spawnResourceManagedProcess({ executable, args: ['wait-write', join(directory, file)], cwd: directory,
        sandbox: { readableRoots: [tools], writableRoots: [directory], network: 'disabled' } });
      t.after(async () => { task.stop(); await task.complete(); });
      const [ready] = await once(task.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
      assert.match(String(ready), /ready/); return task;
    };
    const [first, second] = await Promise.all([start(work, 'cancelled.txt'), start(nested, 'continued.txt')]);
    first.stop(); await first.complete();
    second.child.stdin.end('\n');
    const report = await second.complete();
    assert.equal(report.code, '', JSON.stringify(report));
    assert.equal(await readFile(join(nested, 'continued.txt'), 'utf8'), 'after peer exit');
    for (const [path, original] of originals) assert.equal(acl(path), original, `concurrent ACL restored: ${path}`);
  });

  await t.test('the shared terminal manager runs cmd and PowerShell with isolation receipts', async () => {
    const terminals = new TerminalSessionManager();
    t.after(() => terminals.stopWithin(work));
    for (const [shell, command] of [['cmd', 'echo sandbox-cmd'], ['powershell', "Write-Output 'sandbox-powershell'"]]) {
      const result = await terminals.start({ ownerSessionId: 'test', cwd: work, command, shell, yieldTimeMs: 20_000,
        sandbox: { writableRoots: [work], readableRoots: shell === 'powershell' ? [dirname(commandInvocation(shell, command).executable)] : [], network: 'disabled' } });
      assert.equal(result.state, 'exited', JSON.stringify(result));
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.stdout, new RegExp(`sandbox-${shell}`));
      assert.equal(result.sandbox.backend, 'windows-appcontainer');
      assert.equal(result.sandbox.network, 'disabled');
    }
  });
});

test('an unavailable required backend never runs a command and releases admission', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-sandbox-test-'));
  t.after(async () => { assert.equal(dirname(root).toLowerCase(), resolve(tmpdir()).toLowerCase()); await rm(root, { recursive: true, force: true }); });
  const governor = new ProcessResourceGovernor({ availableMemory: () => 32 * 1024 ** 3, observe: false });
  for (let i = 0; i < 10; i++) {
    await assert.rejects(runResourceManagedCommand({ executable: 'cmd.exe', args: ['/d', '/c', 'echo unexpected>escaped.txt'], cwd: root,
      governor, hostPath: join(root, 'missing.exe'), sandbox: { writableRoots: [root], network: 'disabled' },
    }), { code: 'sandbox_unavailable' });
  }
  await assert.rejects(readFile(join(root, 'escaped.txt')), { code: 'ENOENT' });
});

test('Linux bubblewrap enforces filesystem, descendant and network boundaries', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-sandbox-test-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const work = join(root, 'work'), outside = join(root, 'outside'), reference = join(root, 'reference'), tools = join(root, 'tools');
  await Promise.all([work, outside, reference, tools].map(path => mkdir(path)));
  await writeFile(join(outside, 'secret.txt'), 'outside'); await writeFile(join(reference, 'reference.txt'), 'reference');
  await symlink(outside, join(work, 'escape'));
  const script = join(tools, 'worker.mjs'); await copyFile(new URL('./fixtures/SandboxWorker.mjs', import.meta.url), script);
  const server = createServer(socket => socket.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const reachable = createConnection({ host: '127.0.0.1', port: server.address().port }); await once(reachable, 'close');
  let connections = 0; server.on('connection', () => connections++);
  const result = await runResourceManagedCommand({ executable: process.execPath, args: [script, work, outside, reference, String(server.address().port)], cwd: work,
    env: { ...process.env, CARDBUSH_TEST_SECRET: 'secret', NODE_OPTIONS: '--require forbidden.js' }, timeoutMs: 20_000,
    sandbox: { writableRoots: [work], readableRoots: [tools, reference, dirname(process.execPath)], network: 'disabled' },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const facts = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => line.split('=')));
  assert.equal(facts.insideWrite, 'allowed'); assert.equal(facts.readOnlyRead, 'allowed');
  for (const key of ['outsideWrite', 'outsideRead', 'readOnlyWrite', 'linkedWrite', 'childOutsideWrite', 'network']) {
    assert.ok(facts[key] && facts[key] !== 'allowed', JSON.stringify(facts));
  }
  assert.equal(connections, 0); assert.equal(facts.hostSecret, 'absent'); assert.equal(facts.nodeOptions, 'absent');
  assert.equal(await readFile(join(work, 'inside.txt'), 'utf8'), 'allowed');
});
