import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
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
  await terminal.execute(call);
  assert.deepEqual(start.sandbox, { network: 'disabled', readableRoots: [], writableRoots: [process.cwd()] });
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
