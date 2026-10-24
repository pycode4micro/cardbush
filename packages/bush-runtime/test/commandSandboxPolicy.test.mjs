import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandSandboxPlan } from '../dist/commandSandboxAdmission.js';
import { commandSandboxConfiguration, commandSandboxPolicy, registerWorkspaceTools, ToolRegistry } from '../dist/index.js';

const configuration = () => commandSandboxConfiguration({ CARDBUSH_EXECUTION_SANDBOX: 'required' });
const context = (workspace = resolve('project')) => ({ sessionId: 'owner', input: {}, turn: { request: {
  permissionMode: 'all_free', metadata: { workspaceDir: workspace, taskRoots: [resolve('unexpected')],
    commandSandbox: { mode: 'off' }, sandbox: false },
} } });

test('host sandbox policy cannot be disabled or broadened by full control or turn metadata', () => {
  assert.deepEqual(commandSandboxPolicy(configuration(), context()), {
    network: 'disabled', readableRoots: [], writableRoots: [resolve('project')],
  });
  assert.equal(commandSandboxPolicy(commandSandboxConfiguration({}), context()), undefined);
  for (const env of [ { CARDBUSH_EXECUTION_SANDBOX: 'typo' }, { CARDBUSH_SANDBOX_NETWORK: 'maybe' },
    { CARDBUSH_SANDBOX_READ_ROOTS: '["relative"]' }, { CARDBUSH_SANDBOX_WRITE_ROOTS: '{}' }, { CARDBUSH_BWRAP_PATH: 'relative' } ]) {
    assert.throws(() => commandSandboxConfiguration(env), { code: 'sandbox_policy_invalid' });
  }
});

test('auto follows the user mode while the backend path remains host-owned', () => {
  const executable = resolve('admin-tools', 'bwrap');
  const config = commandSandboxConfiguration({ CARDBUSH_EXECUTION_SANDBOX: 'auto', CARDBUSH_BWRAP_PATH: executable });
  const call = context();
  assert.equal(commandSandboxPolicy(config, call), undefined);
  call.turn.request.permissionMode = 'task_free';
  call.turn.request.metadata.linuxExecutable = resolve('untrusted-bwrap');
  assert.equal(commandSandboxPolicy(config, call).linuxExecutable, executable);
});

test('registered terminals snapshot host policy and do not derive grants from the requested cwd', async () => {
  const mutable = { ...configuration(), readableRoots: [], writableRoots: [] };
  let start;
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, undefined, { commandSandbox: mutable,
    terminals: { list: () => [], start: async value => { start = value; return {}; } },
  });
  mutable.mode = 'off'; mutable.writableRoots.push(resolve('unexpected'));
  const terminal = registry.resolve('terminal_exec');
  const call = context(process.cwd()); call.input = terminal.decodeInput({ command: 'irrelevant', cwd: process.cwd(), yield_time_ms: 1, shell: process.platform === 'win32' ? 'cmd' : 'posix', sandbox: false });
  assert.equal((await terminal.authorize(call)).kind, 'allow');
  await terminal.execute(call);
  assert.equal(start.sandbox.network, 'disabled');
  assert.deepEqual(start.sandbox.readableRoots, []);
  assert.deepEqual(start.sandbox.writableRoots, [process.cwd()]);
  assert.equal(start.sandbox.requireCanonicalRoots, true);
});

test('required command isolation rejects unverified SSH execution before contacting the remote bridge', async () => {
  let contacted = false;
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, undefined, { commandSandbox: configuration(),
    remote: { request: async () => { contacted = true; throw Error('must not send commands'); } },
  });
  const terminal = registry.resolve('terminal_exec');
  const call = context('ssh://saved-connection/project');
  call.input = terminal.decodeInput({ command: 'irrelevant', cwd: '/project', yield_time_ms: 1, shell: 'posix' });
  for (const entry of ['authorize', 'execute']) await assert.rejects(terminal[entry](call), { code: 'sandbox_remote_unavailable' });
  assert.equal(contacted, false);
});

test('a narrower cwd recovers an implicit workspace that contains supervisor state', async t => {
  const temporary = await realpath(tmpdir());
  const work = await realpath(await mkdtemp(join(temporary, 'cardbush-admission-')));
  t.after(async () => { assert.equal(dirname(work), temporary); await rm(work, { recursive: true, force: true }); });
  const config = commandSandboxConfiguration({ CARDBUSH_EXECUTION_SANDBOX: 'auto' });
  const call = context(temporary); call.turn.request.permissionMode = 'task_free';
  call.input = { command: 'echo fixture', shell: process.platform === 'win32' ? 'cmd' : 'posix' };
  await assert.rejects(commandSandboxPlan(config, call, temporary), { code: 'sandbox_policy_invalid' });
  const plan = await commandSandboxPlan(config, call, work);
  assert.equal(plan.admission.kind, 'allow');
  assert.deepEqual(plan.policy.writableRoots, [work]);
  assert.equal(plan.policy.requireCanonicalRoots, true);
  assert.equal(plan.policy.network, 'disabled');
  assert.equal(call.turn.request.metadata.workspaceDir, temporary, 'no session relocation');
  for (const roots of [{ writableRoots: [temporary] }, { readableRoots: [temporary] }]) {
    await assert.rejects(commandSandboxPlan({ ...config, ...roots }, call, work), { code: 'sandbox_policy_invalid' },
      'explicit host grants cannot be silently discarded');
  }
  await assert.rejects(commandSandboxPlan(config, { ...call, input: { ...call.input,
    additionalPermissions: { readRoots: [temporary], writeRoots: [], network: false } } }, work), { code: 'sandbox_policy_invalid' });
});
