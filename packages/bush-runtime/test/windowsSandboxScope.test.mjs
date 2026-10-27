import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';
import { WindowsSandboxScopePool, sandboxPowerShellArgs } from '../dist/windowsSandboxScope.js';
import { spawnResourceManagedProcess, resolveProcessResourceHost } from '../dist/processResourceGuard.js';
import { runResourceManagedCommand } from '../dist/processes.js';
import { TerminalSessionManager } from '../dist/terminalSessionManager.js';
import { commandInvocation } from '@cardbush/platform';

const windows = process.platform === 'win32';
const quote = value => `'${value.replaceAll("'", "''")}'`;
async function fixture(t) {
  const temporary = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporary, 'cardbush-scope-test-')));
  const work = join(root, 'work'), tools = join(root, 'tools'), outside = join(root, 'outside'), reference = join(root, 'reference');
  await Promise.all([work, tools, outside, reference].map(path => mkdir(path)));
  const pool = new WindowsSandboxScopePool();
  const pools = [pool], tasks = [], leases = [];
  t.after(async () => {
    for (const task of tasks) { task.stop(); await task.complete(); }
    for (const lease of leases) lease.release();
    for (const p of pools) await p.close();
    assert.equal(dirname(root).toLowerCase(), temporary.toLowerCase()); await rm(root, { recursive: true, force: true });
  });
  const executable = join(tools, 'worker.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const built = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`, fileURLToPath(new URL('./fixtures/SandboxWorker.cs', import.meta.url))], { windowsHide: true, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const acl = path => {
    const result = spawnSync(executable, ['acl', path], { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  return { root, work, tools, outside, reference, pool, pools, tasks, leases, executable, acl };
}

test('native authorization rejects a directory replaced after JavaScript preparation without changing its ACL', { skip: !windows }, async t => {
  const f = await fixture(t), info = statSync(f.work, { bigint: true });
  const before = f.acl(f.work), old = join(f.root, 'old-work');
  const original = childProcess.spawn; let swapped = false;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    if (args.includes('--sandbox')) { renameSync(f.work, old); mkdirSync(f.work); swapped = true; }
    return original(executable, args, options);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(runResourceManagedCommand({ executable: f.executable, args: ['wait-write', join(f.work, 'unexpected')], cwd: f.work,
      sandbox: { readableRoots: [f.tools], writableRoots: [f.work], network: 'disabled', requireCanonicalRoots: true,
        expectedIdentities: { [f.work]: `${info.dev}:${info.ino}` } }, timeoutMs: 5000 }),
      error => error.code === 'resource_protection_failed' && /object changed before startup/.test(error.message));
    assert.equal(swapped, true);
    assert.equal(f.acl(f.work), before); assert.equal(f.acl(old), before);
    await assert.rejects(readFile(join(f.work, 'unexpected')), { code: 'ENOENT' });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('PowerShell 7 uses the admitted cwd for relative IO and native child commands without parent grants', { skip: !windows, timeout: 30_000 }, async t => {
  const { work, root } = await fixture(t);
  const executable = commandInvocation('powershell', '').executable;
  const source = `"cwd="+(Get-Location).ProviderPath; Set-Content -LiteralPath './relative.txt' -Value 'inside' -ErrorAction Stop; Get-Content './relative.txt'; & "$env:SystemRoot\\System32\\cmd.exe" /d /c echo CHILD_OK; try { [IO.File]::GetAttributes(${quote(root)}); throw 'parent unexpectedly accessible' } catch [UnauthorizedAccessException] { 'PARENT_DENIED' }`;
  const result = await runResourceManagedCommand({ executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], cwd: work,
    sandbox: { writableRoots: [work], network: 'disabled' }, timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stderr, ''); assert.ok(result.stdout.includes(work));
  assert.match(result.stdout, /CHILD_OK/); assert.match(result.stdout, /PARENT_DENIED/);
  assert.equal((await readFile(join(work, 'relative.txt'), 'utf8')).trim(), 'inside');
});

test('PowerShell bootstrap works before filesystem drives and Core modules are available', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), executable = commandInvocation('powershell', '').executable;
  const command = `Set-Content './bootstrapped.txt' 'ok' -ErrorAction Stop; @{cwd=(Get-Location).ProviderPath} | ConvertTo-Json -Compress`;
  const bootstrap = sandboxPowerShellArgs(executable, ['-Command', command]).at(-1);
  const reset = String.raw`
$null = $ExecutionContext.SessionState.Path.SetLocation('Env:\')
foreach ($drive in $ExecutionContext.SessionState.Drive.GetAll()) {
  if ($drive.Provider.Name -eq 'FileSystem') { $ExecutionContext.SessionState.Drive.Remove($drive.Name, $true, 'Global') }
}
Remove-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue
$env:PSModulePath = ''
`;
  const result = await runResourceManagedCommand({ executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(reset + bootstrap, 'utf16le').toString('base64')], cwd: f.work,
    sandbox: { writableRoots: [f.work], network: 'disabled' }, timeoutMs: 20000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stderr, '');
  assert.equal((await readFile(join(f.work, 'bootstrapped.txt'), 'utf8')).trim(), 'ok');
});

test('pooled directory capabilities preserve exact rights, network isolation, descendants and ACL restoration', { skip: !windows, timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.outside, 'secret.txt'), 'outside'); await writeFile(join(f.reference, 'reference.txt'), 'read only');
  await symlink(f.outside, join(f.work, 'escape'), 'junction');
  const original = new Map([f.work, f.reference, f.tools, f.outside].map(p => [p, f.acl(p)]));
  const server = createServer(s => s.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const control = createConnection({ host: '127.0.0.1', port: server.address().port }); await once(control, 'close');
  let connections = 0; server.on('connection', () => connections++);
  const policy = { writableRoots: [f.work], readableRoots: [f.tools, f.reference], network: 'disabled' };
  const run = sandbox => runResourceManagedCommand({ executable: f.executable,
    args: ['probe', f.work, f.outside, f.reference, String(server.address().port)], cwd: f.work, sandbox, sandboxScopePool: f.pool, timeoutMs: 15_000 });
  const check = result => {
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const facts = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => line.split('=')));
    assert.equal(facts.insideWrite, 'allowed'); assert.equal(facts.readOnlyRead, 'allowed');
    for (const key of ['outsideWrite', 'outsideRead', 'readOnlyWrite', 'linkedWrite', 'childOutsideWrite']) assert.equal(facts[key], 'UnauthorizedAccessException', JSON.stringify(facts));
    assert.notEqual(facts.network, 'allowed'); assert.equal(facts.hostSecret, 'absent');
  };
  check(await run(policy)); check(await run(policy));
  const expanded = await run({ ...policy, writableRoots: [f.work, f.outside, f.reference], readableRoots: [f.tools] });
  assert.match(expanded.stdout, /outsideWrite=allowed/); assert.match(expanded.stdout, /readOnlyWrite=allowed/);
  check(await run(policy)); // A cached expanded capability must not attach to a later baseline command.
  const stateProbe=await runResourceManagedCommand({executable:f.executable,args:['host-scope-state'],cwd:f.work,sandbox:policy,sandboxScopePool:f.pool});
  assert.match(stateProbe.stdout,/hostScopeStateWrite=(UnauthorizedAccessException|SecurityException)/);
  assert.equal(connections, 0);
  await f.pool.close();
  for (const [path, acl] of original) assert.equal(f.acl(path), acl, path);
});

test('commands sharing a directory capability retain separate private identities and survive peer cancellation', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const policy = { writableRoots: [f.work], readableRoots: [f.tools], network: 'disabled' };
  const start = args => spawnResourceManagedProcess({ executable: f.executable, args, cwd: f.work, sandbox: policy, sandboxScopePool: f.pool });
  const first = await start(['private-wait']); f.tasks.push(first);
  t.after(async () => { first.stop(); await first.complete(); });
  const [privateLine] = await once(first.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  const result = await runResourceManagedCommand({ executable: f.executable, args: ['read-private', String(privateLine).trim()], cwd: f.work, sandbox: policy, sandboxScopePool: f.pool });
  assert.match(result.stdout, /peerPrivateRead=UnauthorizedAccessException/);
  const second = await start(['wait-write', join(f.work, 'continued.txt')]); f.tasks.push(second);
  t.after(async () => { second.stop(); await second.complete(); });
  const [ready] = await once(second.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) }); assert.match(String(ready), /ready/);
  first.stop(); await first.complete();
  second.child.stdin.end('\n'); assert.equal((await second.complete()).code, '');
  assert.equal(await readFile(join(f.work, 'continued.txt'), 'utf8'), 'after peer exit');
});

test('temporary expansion cannot carry a reusable baseline capability on files moved outside the workspace', { skip: !windows, timeout: 20_000 }, async t => {
  const f=await fixture(t),otherPool=new WindowsSandboxScopePool(); f.pools.push(otherPool);
  const baseline={writableRoots:[f.work],readableRoots:[f.tools],network:'disabled'};
  const run=(args,sandbox=baseline,pool=f.pool)=>runResourceManagedCommand({executable:f.executable,args,cwd:f.work,sandbox,sandboxScopePool:pool??undefined});
  for(const [index,pool] of [f.pool,otherPool,null].entries()) {
    const source=join(f.work,`moving-${index}.txt`),target=join(f.outside,`moved-${index}.txt`);
    await writeFile(source,'data');
    assert.match((await run(['read-private',source])).stdout,/peerPrivateRead=allowed/);
    await run(['move',source,target],{...baseline,writableRoots:[f.work,f.outside]},pool);
    assert.match((await run(['read-private',target])).stdout,/peerPrivateRead=UnauthorizedAccessException/);
  }
});

test('idle authorization pins directory identities and revokes after expiry', { skip: !windows, timeout: 20_000 }, async t => {
  const f = await fixture(t), pool = new WindowsSandboxScopePool(250);
  f.pools.push(pool);
  t.after(() => pool.close());
  const original = f.acl(f.work);
  const lease = await pool.acquire(resolveProcessResourceHost(), [], [f.work]);
  f.leases.push(lease);
  // Readiness is awaited by command supervisors, not by acquire. A tiny command
  // makes this assertion independent of grant scheduling.
  const result = await runResourceManagedCommand({ executable: process.env.ComSpec, args: ['/d', '/c', 'echo ready'], cwd: f.work,
    sandbox: { writableRoots: [f.work], network: 'disabled' }, sandboxScopePool: pool });
  assert.match(result.stdout, /ready/);
  await assert.rejects(rename(f.work, join(f.root, 'moved')));
  lease.release();
  for (let i = 0; i < 100 && f.acl(f.work) !== original; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(f.acl(f.work), original);
  await rename(f.work, join(f.root, 'moved'));
});

test('a broader live writer cannot smuggle a cached capability onto a moved file', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), source = join(f.work, 'moving.txt'), target = join(f.outside, 'moved.txt');
  await writeFile(source, 'private');
  const baseline = { readableRoots: [f.tools], writableRoots: [f.work], network: 'disabled' };
  const writer = await spawnResourceManagedProcess({ executable: f.executable, args: ['wait-move', source, target], cwd: f.work,
    sandbox: { ...baseline, writableRoots: [f.work, f.outside] } });
  f.tasks.push(writer);
  await once(writer.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  const read = path => runResourceManagedCommand({ executable: f.executable, args: ['read-private', path], cwd: f.work,
    sandbox: baseline, sandboxScopePool: f.pool });
  // Create the narrower cache while the broader writer is already alive.
  assert.match((await read(source)).stdout, /peerPrivateRead=allowed/);
  const moved = once(writer.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  writer.child.stdin.write('\n'); await moved;
  assert.match((await read(target)).stdout, /peerPrivateRead=UnauthorizedAccessException/);
  writer.child.stdin.end('\n'); await writer.complete();
  assert.match((await read(target)).stdout, /peerPrivateRead=UnauthorizedAccessException/);
});

test('exact file reads do not invalidate a reusable directory scope', { skip: !windows, timeout: 20_000 }, async t => {
  const f = await fixture(t), file = join(f.outside, 'readable.txt'); await writeFile(file, 'data');
  const baseline = { readableRoots: [f.tools], writableRoots: [f.work], network: 'disabled' };
  await runResourceManagedCommand({ executable: f.executable, args: ['read-private', file], cwd: f.work, sandbox: baseline, sandboxScopePool: f.pool });
  await runResourceManagedCommand({ executable: f.executable, args: ['read-private', file], cwd: f.tools,
    sandbox: { readableRoots: [f.tools], readableFiles: [file], writableRoots: [], network: 'disabled' } });
  const task = await spawnResourceManagedProcess({ executable: f.executable, args: ['read-private', file], cwd: f.work, sandbox: baseline, sandboxScopePool: f.pool });
  f.tasks.push(task); task.child.stdout.resume(); task.child.stderr.resume();
  assert.equal((await task.complete()).sandboxScopeStale, false);
});

test('a crashed broader writer invalidates scopes created during its lifetime and permits fresh reuse', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), source = join(f.work, 'moving.txt'), target = join(f.outside, 'moved.txt');
  await writeFile(source, 'data');
  const baseline = { readableRoots: [f.tools], writableRoots: [f.work], network: 'disabled' };
  const writer = await spawnResourceManagedProcess({ executable: f.executable, args: ['wait-move', source, target], cwd: f.work,
    sandbox: { ...baseline, writableRoots: [f.work, f.outside] } });
  f.tasks.push(writer); await once(writer.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  // Keep an idle capability alive without issuing it to a command yet.
  const lease = await f.pool.acquire(resolveProcessResourceHost(), [f.tools], [f.work]); f.leases.push(lease);
  let ready = false;
  for (let i = 0; i < 250; i++) {
    try { await readFile(lease.reference.policyPath + '.ready'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(ready, true);
  const moved = once(writer.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) }); writer.child.stdin.write('\n'); await moved;
  process.kill(writer.child.pid); await writer.complete(); // Skip the native writer's finally block.
  const probe = async () => {
    const task = await spawnResourceManagedProcess({ executable: f.executable, args: ['read-private', target], cwd: f.work, sandbox: baseline, sandboxScopePool: f.pool });
    f.tasks.push(task); let output = ''; task.child.stdout.on('data', chunk => { output += chunk; }); task.child.stderr.resume();
    const report = await task.complete(); assert.match(output, /peerPrivateRead=UnauthorizedAccessException/); return report;
  };
  assert.equal((await probe()).sandboxScopeStale, true);
  lease.release();
  assert.equal((await probe()).sandboxScopeStale, false, 'dead writer records must not permanently disable caching');
});

test('losing a directory supervisor stops its command and repairs interrupted ACL cleanup', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), original = f.acl(f.work);
  const lease = await f.pool.acquire(resolveProcessResourceHost(), [f.tools], [f.work]);
  f.leases.push(lease);
  const command = await spawnResourceManagedProcess({ executable: f.executable, args: ['wait-write', join(f.work, 'unexpected.txt')], cwd: f.work,
    sandbox: { writableRoots: [f.work], readableRoots: [f.tools], network: 'disabled' }, sandboxScopePool: f.pool });
  f.tasks.push(command);
  t.after(async () => { command.stop(); await command.complete(); lease.release(); });
  await once(command.child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  process.kill(lease.reference.processId);
  assert.equal((await command.complete()).code, 'sandbox_authorization_lost');
  lease.release(); await f.pool.close();
  assert.equal(f.acl(f.work), original);
  await assert.rejects(readFile(join(f.work, 'unexpected.txt')), { code: 'ENOENT' });
});

test('Runtime exit revokes pooled authorization even without JavaScript disposal', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), original = f.acl(f.work);
  const source = `import {WindowsSandboxScopePool} from ${JSON.stringify(new URL('../dist/windowsSandboxScope.js',import.meta.url).href)};
    import {spawnResourceManagedProcess,resolveProcessResourceHost} from ${JSON.stringify(new URL('../dist/processResourceGuard.js',import.meta.url).href)};
    const pool=new WindowsSandboxScopePool();
    const lease=await pool.acquire(resolveProcessResourceHost(),[${JSON.stringify(f.tools)}],[${JSON.stringify(f.work)}]);
    const task=await spawnResourceManagedProcess({executable:${JSON.stringify(f.executable)},args:['wait-orphan',${JSON.stringify(join(f.work,'orphan.txt'))}],cwd:${JSON.stringify(f.work)},sandbox:{writableRoots:[${JSON.stringify(f.work)}],readableRoots:[${JSON.stringify(f.tools)}],network:'disabled'},sandboxScopePool:pool});
    task.child.stdout.once('data',()=>{console.log(JSON.stringify({owner:process.pid,reference:lease.reference}));process.stdin.resume()});`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe', windowsHide: true });
  owner.stderr.resume();
  t.after(() => { owner.kill(); });
  const [ready] = await once(owner.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  const metadata=JSON.parse(String(ready)); assert.equal(metadata.owner,owner.pid);
  t.after(async()=>{
    spawnSync(resolveProcessResourceHost(),['--sandbox-scope-cleanup',metadata.reference.policyPath],{windowsHide:true});
    const directory=dirname(metadata.reference.policyPath);
    assert.equal(dirname(directory).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
    assert.ok(directory.includes('cardbush-scope-')); await rm(directory,{recursive:true,force:true});
  });
  const exited = once(owner, 'exit'); owner.kill(); await exited;
  for (let i=0;i<150 && f.acl(f.work)!==original;i++) await new Promise(resolve=>setTimeout(resolve,50));
  let finished; try {finished=await readFile(metadata.reference.policyPath+'.finished','utf8')}catch{}
  assert.equal(f.acl(f.work),original,JSON.stringify({metadata,exit:owner.exitCode,finished}));
  await new Promise(resolve=>setTimeout(resolve,2100));
  await assert.rejects(readFile(join(f.work,'orphan.txt')), {code:'ENOENT'});
});

test('terminal shutdown drains pending startup and exposes execution phases before completion', { skip: !windows, timeout: 30_000 }, async t => {
  const f = await fixture(t), terminals=new TerminalSessionManager();
  t.after(()=>terminals.close());
  const original=f.acl(f.work);
  const running=await terminals.start({ownerSessionId:'test',cwd:f.work,shell:'cmd',command:'set /p value=',yieldTimeMs:1,sandbox:{writableRoots:[f.work],network:'disabled'}});
  assert.equal(running.state,'running'); assert.ok(['preparing_sandbox','executing'].includes(running.phase));
  for(let i=0;i<100 && terminals.status('test',running.terminalSessionId).phase!=='executing';i++) await new Promise(r=>setTimeout(r,20));
  assert.equal(terminals.status('test',running.terminalSessionId).phase,'executing');
  const pending=terminals.start({ownerSessionId:'test',cwd:f.work,shell:'cmd',command:'echo pending-start',yieldTimeMs:30000,sandbox:{writableRoots:[f.work],network:'disabled'}});
  await terminals.close(); await pending;
  assert.equal(f.acl(f.work),original);
  await assert.rejects(terminals.start({ownerSessionId:'test',cwd:f.work,shell:'cmd',command:'echo after-close',yieldTimeMs:1}),{code:'terminal_manager_closed'});
});

test('the selected host PowerShell resolves relative IO through the terminal manager', { skip: !windows, timeout: 30_000 }, async t => {
  const f=await fixture(t),terminals=new TerminalSessionManager(); t.after(()=>terminals.close());
  const shell=commandInvocation('powershell','').executable;
  const command=`Set-Content './managed.txt' 'managed' -ErrorAction Stop; Get-Content './managed.txt'; & "$env:SystemRoot\\System32\\cmd.exe" /d /c cd`;
  const result=await terminals.start({ownerSessionId:'test',cwd:f.work,shell:'powershell',command,yieldTimeMs:20000,sandbox:{writableRoots:[f.work],readableRoots:[dirname(shell)],network:'disabled'}});
  assert.equal(result.state,'exited',JSON.stringify(result)); assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(result.stderr,''); assert.match(result.stdout,/managed/); assert.ok(result.stdout.includes(f.work));
  await terminals.close();
});
