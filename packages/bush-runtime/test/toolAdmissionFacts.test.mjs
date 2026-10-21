import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolRegistry, ToolExecutionCoordinator, registerWorkspaceTools, TerminalSessionManager,
  ProcessResourceGovernor, defaultProcessResourceLimits, configureProcessResourceClient,
} from '../dist/index.js';

const identity = { requestId: 'admission-r', sessionId: 'admission-s', turnId: 'admission-t', round: 1, ordinal: 0 };
const noExecution = { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'retry' };
const unknownExecution = { dispatch: 'started', effects: 'possible', result: 'unknown', recovery: 'inspect_existing' };

function fixture(terminals) {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, undefined, { terminals });
  const manifest = { owner: 'runtime', operation: 'fixture', effect_kind: 'delegation', risk: 'low', dispatch_scope: 'turn', mutating: true };
  registry.register({ definition: { name: 'delegate_terminal', description: 'Fixture', inputSchema: { type: 'object' } },
    manifest, delegatesToolExecution: true, decodeInput: value => value,
    execute: context => context.invokeTool('terminal_exec', context.input) });
  registry.register({ definition: { name: 'post_dispatch_failure', description: 'Fixture', inputSchema: { type: 'object' } },
    manifest, decodeInput: value => value, execute: () => {
      throw Object.assign(new Error('Failure after dispatch'), { code: 'resource_memory_pressure',
        details: { execution: noExecution, retryable: true } });
    } });
  const schemas = JSON.stringify(registry.definitions());
  const request = { protocol: 'bush.model_request.v1', ...identity, model: 'fixture', tools: registry.definitions(),
    messages: [], permissionMode: 'all_free', metadata: { workspaceDir: process.cwd() } };
  const coordinator = new ToolExecutionCoordinator({ registry });
  return {
    run: (name, input = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: name, name, argumentsText: JSON.stringify(input) },
      identity, undefined, { request, contextMessages: [] }),
    verifySchemas: () => { assert.equal(JSON.stringify(registry.definitions()), schemas); assert.equal(JSON.stringify(request.tools), schemas); },
  };
}

test('terminal resource admission reports no execution through direct and delegated calls without weakening the guard', async () => {
  const limits = defaultProcessResourceLimits(8 * 1024 ** 3);
  const governor = new ProcessResourceGovernor({ limits, availableMemory: () => 1, observe: false });
  const f = fixture(new TerminalSessionManager({ resourceGovernor: governor }));
  const input = { command: 'echo admission-fixture', cwd: process.cwd(), shell: process.platform === 'win32' ? 'powershell' : 'posix', yield_time_ms: 1 };
  // Reusing the same rejected command also proves its starting reservation is released.
  for (const name of ['terminal_exec', 'delegate_terminal', 'terminal_exec']) {
    const outcome = await f.run(name, input);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.error.code, 'resource_memory_pressure');
    assert.match(outcome.error.message, /No process was started/);
    assert.deepEqual(outcome.execution, noExecution);
    assert.deepEqual(outcome.error.details.execution, noExecution);
  }
  assert.deepEqual(governor.limits, limits);
  assert.throws(() => governor.acquire(), { code: 'resource_memory_pressure' });
  assert.deepEqual((await f.run('post_dispatch_failure')).execution, unknownExecution,
    'the same error code or untrusted details cannot prove no execution');
  f.verifySchemas();
});

test('worker resource RPC rejections gain facts at the terminal admission boundary', async t => {
  let acquisitions = 0;
  configureProcessResourceClient({ acquire: async () => {
    acquisitions++;
    // The RPC boundary creates a fresh Error; no in-process marker survives it.
    throw Object.assign(new Error('The concurrent task budget is full.'), { code: 'resource_capacity_busy' });
  } });
  t.after(() => configureProcessResourceClient());
  const f = fixture(new TerminalSessionManager());
  const outcome = await f.run('terminal_exec', { command: 'echo admission-fixture', cwd: process.cwd(),
    shell: process.platform === 'win32' ? 'powershell' : 'posix', yield_time_ms: 1 });
  assert.equal(acquisitions, 1);
  assert.equal(outcome.error.code, 'resource_capacity_busy');
  assert.deepEqual(outcome.execution, noExecution);
  f.verifySchemas();
});

test('missing Windows supervisor reports no command started through native and delegated tools', { skip: process.platform !== 'win32' }, async t => {
  const previous = process.env.CARDBUSH_PROCESS_HOST_PATH;
  process.env.CARDBUSH_PROCESS_HOST_PATH = new URL('./missing-process-host.exe', import.meta.url).pathname;
  t.after(() => { if (previous === undefined) delete process.env.CARDBUSH_PROCESS_HOST_PATH; else process.env.CARDBUSH_PROCESS_HOST_PATH = previous; });
  const governor = new ProcessResourceGovernor({ limits: defaultProcessResourceLimits(8 * 1024 ** 3), availableMemory: () => 8 * 1024 ** 3, observe: false });
  const f = fixture(new TerminalSessionManager({ resourceGovernor: governor }));
  const expected = { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'do_not_retry' };
  for (const name of ['terminal_exec', 'delegate_terminal']) {
    const outcome = await f.run(name, { command: 'echo must-not-run', cwd: process.cwd(), shell: 'cmd', yield_time_ms: 1 });
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.error.code, 'resource_protection_unavailable');
    assert.deepEqual(outcome.execution, expected);
    assert.deepEqual(outcome.error.details.execution, expected);
  }
  const lease = governor.acquire(); lease.release();
  assert.deepEqual((await f.run('post_dispatch_failure')).execution, unknownExecution);
  f.verifySchemas();
});
