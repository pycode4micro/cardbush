import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ExclusiveResources, runtimeExclusiveResources, decodeExclusiveResources } from '../dist/exclusiveResources.js';
import { TerminalSessionManager, WorkspaceObservationStore, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';

test('overlapping paths and host labels are exclusive, atomic and idempotently released', () => {
  const leases = new ExclusiveResources(), root = resolve('lease-fixture');
  const release = leases.acquire('first', root, ['build/app.exe', 'HOST:GPU']);
  assert.throws(() => leases.acquire('second', root, ['unused', 'build']), { code: 'terminal_resource_busy' });
  const other = leases.acquire('third', root, ['unused', 'build-other']); other();
  assert.throws(() => leases.acquire('gpu', resolve('another'), ['host:gpu']), { code: 'terminal_resource_busy' });
  if (process.platform === 'win32') assert.throws(() => leases.acquire('case', root.toUpperCase(), ['BUILD/APP.EXE']), { code: 'terminal_resource_busy' });
  release(); release();
  leases.acquire('next', root, ['build', 'host:gpu'])();
  assert.throws(() => decodeExclusiveResources(['']), /exclusive_resources/);
  assert.throws(() => decodeExclusiveResources(['bad\nlabel']), /exclusive_resources/);
});

test('project leases prevent edits in other observation stores until released', () => {
  const root = resolve('mutation-lease-fixture'), store = new WorkspaceObservationStore();
  const release = runtimeExclusiveResources.acquire('compile', root, ['.']);
  try { assert.throws(() => store.acquireMutation(join(root, 'src', 'capture.cs')), { code: 'workspace_resource_busy' }); }
  finally { release(); }
  store.acquireMutation(join(root, 'src', 'capture.cs'))();
});

const shell = process.platform === 'win32' ? 'powershell' : 'posix';
const command = script => process.platform === 'win32'
  ? `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`
  : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;

test('real background terminals retain leases across yields/managers and release on stop, exit and failed spawn', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-exclusive-'));
  const managers = [new TerminalSessionManager(), new TerminalSessionManager()];
  t.after(async () => {
    for (const manager of managers) await manager.stopWithin(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  });
  const input = { ownerSessionId: 'parent', cwd: root, shell, command: command('setInterval(()=>{},1000)'), yieldTimeMs: 1, exclusiveResources: ['build/app.exe'] };
  const first = await managers[0].start(input);
  assert.equal(first.state, 'running');
  await assert.rejects(managers[1].start({ ...input, ownerSessionId: 'child' }), { code: 'terminal_resource_busy' });
  assert.equal(managers[1].list('child').length, 0, 'conflicting command never spawns');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(managers[0].poll('parent', { sessionId: first.terminalSessionId, yieldTimeMs: 10 }, cancelled.signal));
  await assert.rejects(managers[1].start(input), { code: 'terminal_resource_busy' });
  await managers[0].stop('parent', first.terminalSessionId);
  const done = await managers[1].start({ ...input, command: command('process.exit(0)'), yieldTimeMs: 10000 });
  assert.equal(done.exitCode, 0);
  assert.equal(done.state, 'exited');
  const bad = await managers[0].start({ ...input, cwd: join(root, 'missing'), exclusiveResources: [join(root, 'build/app.exe')], yieldTimeMs: 10000 }).catch(error => ({ state: 'failed', error }));
  assert.equal(bad.state, 'failed');
  const again = await managers[1].start({ ...input, command: command('process.exit(0)'), yieldTimeMs: 10000 });
  assert.equal(again.exitCode, 0);
});

test('workspace tool exposes and validates declarations without granting extra permissions', () => {
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const tool = registry.resolve('terminal_exec');
  assert.equal(tool.definition.inputSchema.properties.exclusive_resources.type, 'array');
  const input = { command: 'echo test', cwd: '.', shell, yield_time_ms: 10, exclusive_resources: ['host:gpu'] };
  assert.deepEqual(tool.decodeInput(input).exclusiveResources, ['host:gpu']);
  assert.throws(() => tool.decodeInput({ ...input, exclusive_resources: 'host:gpu' }), /exclusive_resources/);
});
