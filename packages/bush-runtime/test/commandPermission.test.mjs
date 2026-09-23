import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  InMemoryRuntimeCapabilityStore, ToolExecutionCoordinator, ToolRegistry,
  registerInteractionTools, registerWorkspaceTools,
} from '../dist/index.js';

const root = realpathSync(process.cwd());
const shell = process.platform === 'win32' ? 'powershell' : 'posix';
const exec = (command = 'echo first', overrides = {}) => ({ command, cwd: root, shell, yield_time_ms: 1, ...overrides });

function fixture({ required = false, sandboxMode, decision = 'allow_session', remote, onApproval } = {}) {
  const prompts = [], starts = [], writes = [], sessions = new Map();
  const registry = new ToolRegistry();
  registerInteractionTools(registry);
  registerWorkspaceTools(registry, undefined, {
    ...(required || sandboxMode ? { commandSandbox: { mode: sandboxMode ?? 'required', network: 'disabled', readableRoots: [], writableRoots: [] } } : {}),
    remote,
    terminals: {
      list: owner => [...sessions.values()].filter(item => item.owner === owner),
      describe: (owner, id) => {
        const session = sessions.get(id);
        if (!session || session.owner !== owner) throw Error('Wrong terminal owner');
        return { ...session, sessionId: id };
      },
      start: async input => {
        starts.push(input);
        const id = `terminal-${starts.length}`;
        sessions.set(id, { terminalSessionId: id, owner: input.ownerSessionId, command: input.command,
          sandbox: input.sandbox ? { backend: 'fixture', network: input.sandbox.network } : null });
        return { terminalSessionId: id, state: 'running' };
      },
      poll: async () => ({ state: 'running', stdout: '' }),
      write: async (owner, input) => { writes.push({ owner, ...input }); return { state: 'running' }; },
    },
  });
  const coordinator = new ToolExecutionCoordinator({ registry, capabilities: new InMemoryRuntimeCapabilityStore(),
    permissions: { request: async request => {
      prompts.push(request);
      await onApproval?.(request);
      return { protocol: 'bush.runtime_permission_answer.v1', permissionId: `p-${prompts.length}`, answerId: 'a',
        decision, grantedCapabilityIds: decision === 'deny' ? [] : request.capabilityIds };
    } },
  });
  let serial = 0;
  const run = (name, input, { mode = 'task_free', owner = 'owner', workspace = root } = {}) => {
    const identity = { requestId: 'r', sessionId: owner, turnId: 't', round: 1, ordinal: ++serial };
    return coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${serial}`, name, argumentsText: JSON.stringify(input) },
      identity, undefined, { contextMessages: [], request: { protocol: 'bush.model_request.v1', ...identity,
        model: 'fixture', messages: [], tools: registry.definitions(), permissionMode: mode, metadata: { workspaceDir: workspace } } });
  };
  return { prompts, starts, writes, registry, run };
}

test('unsandboxed execution asks inside the workspace and grants only the exact invocation', async () => {
  const f = fixture();
  for (const input of [exec(), exec(), exec('echo second'), exec('echo first', { cwd: join(root, 'other') })]) {
    assert.equal((await f.run('terminal_exec', input)).kind, 'returned');
  }
  assert.equal(f.prompts.length, 3, 'changing the command or cwd needs another approval');
  assert.equal(f.prompts[0].targets[0].value, root);
  assert.match(f.prompts[0].targets[1].label, /echo first/);
  assert.equal(f.starts.length, 4);
  await f.run('terminal_exec', exec(), { owner: 'another-owner' });
  assert.equal(f.prompts.length, 4, 'session grants cannot authorize a different task');
  if (process.platform === 'win32') {
    await f.run('terminal_exec', exec('echo first', { shell: 'cmd' }));
    assert.equal(f.prompts.length, 5, 'changing the interpreter also changes the operation');
  }
});

async function directories(t) {
  const folder = await mkdtemp(join(tmpdir(), 'cardbush-permission-test-'));
  const paths = Object.fromEntries(['work', 'read', 'write'].map(name => [name, join(folder, name)]));
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  t.after(async () => { assert.equal(dirname(folder).toLowerCase(), resolve(tmpdir()).toLowerCase()); await rm(folder, { recursive: true, force: true }); });
  return { folder, ...paths };
}

test('auto mode isolates routine commands; approved extensions bind command, scope and network without leaking to the next command', async t => {
  const paths = await directories(t), f = fixture({ sandboxMode: 'auto' });
  const run = (command, more = {}) => f.run('terminal_exec', exec(command, { cwd: paths.work, ...more }), { workspace: paths.work });
  assert.equal((await run('echo normal')).kind, 'returned');
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.starts[0].sandbox.writableRoots, [paths.work]);
  const extra = { additional_permissions: { read_roots: [paths.read], write_roots: [paths.write], network: true }, justification: 'Build using reference assets' };
  assert.equal((await run('echo expanded', extra)).kind, 'returned');
  assert.equal(f.prompts.length, 1);
  assert.ok(f.starts[1].sandbox.readableRoots.includes(paths.read));
  assert.ok(f.starts[1].sandbox.writableRoots.includes(paths.write));
  assert.equal(f.starts[1].sandbox.network, 'enabled');
  assert.ok(f.prompts[0].targets.some(target => target.label === `Write: ${paths.write}`));
  assert.equal((await run('echo expanded', extra)).kind, 'returned');
  assert.equal(f.prompts.length, 1, 'matching session approval can be reused');
  await run('echo different', extra);
  assert.equal(f.prompts.length, 2, 'different commands need their own approval');
  await run('echo expanded', { additional_permissions: { write_roots: [paths.read], network: true } });
  assert.equal(f.prompts.length, 3, 'a read grant cannot become a write grant');
  await run('echo after');
  assert.equal(f.starts.at(-1).sandbox.network, 'disabled');
  assert.deepEqual(f.starts.at(-1).sandbox.writableRoots, [paths.work]);
  assert.ok(!f.starts.at(-1).sandbox.readableRoots.includes(paths.read));
  await f.run('terminal_exec', exec('echo full', { cwd: paths.work }), { workspace: paths.work, mode: 'all_free' });
  assert.equal(f.starts.at(-1).sandbox, undefined, 'auto full access preserves unsandboxed execution');
  assert.equal(f.prompts.length, 3);
});

test('additional access rejection or a changed canonical directory cannot start a command', async t => {
  const paths = await directories(t);
  const denied = fixture({ sandboxMode: 'auto', decision: 'deny' });
  const call = exec('echo scoped', { cwd: paths.work, additional_permissions: { read_roots: [paths.read] } });
  assert.equal((await denied.run('terminal_exec', call, { workspace: paths.work })).error.code, 'permission_rejected');
  assert.equal(denied.starts.length, 0);
  const link = join(paths.folder, 'alias'); await symlink(paths.read, link, 'junction');
  const changed = fixture({ sandboxMode: 'auto', onApproval: async () => {
    await unlink(link); await symlink(paths.write, link, 'junction');
  } });
  const result = await changed.run('terminal_exec', { ...call, additional_permissions: { read_roots: [link] } }, { workspace: paths.work });
  assert.equal(result.error.code, 'sandbox_approval_changed');
  assert.equal(changed.starts.length, 0);
});

test('an outside cwd is granted as an exact writable scope; required host limits cannot be expanded', async t => {
  const paths = await directories(t), f = fixture({ sandboxMode: 'auto' });
  const input = exec('echo outside', { cwd: paths.write });
  assert.equal((await f.run('terminal_exec', input, { workspace: paths.work })).kind, 'returned');
  assert.ok(f.prompts[0].targets.some(target => target.label === `Write: ${paths.write}`));
  assert.ok(f.starts[0].sandbox.writableRoots.includes(paths.write));
  const required = fixture({ required: true });
  for (const mode of ['task_free', 'all_free']) {
    for (const command of [input, exec('echo network', { cwd: paths.work, additional_permissions: { network: true } })]) {
      assert.equal((await required.run('terminal_exec', command, { workspace: paths.work, mode })).error.code, 'sandbox_host_limit');
    }
  }
  assert.equal(required.prompts.length, 0); assert.equal(required.starts.length, 0);
});

test('allow once does not authorize a later invocation and a denial has no side effect', async () => {
  const once = fixture({ decision: 'allow_once' });
  await once.run('terminal_exec', exec()); await once.run('terminal_exec', exec());
  assert.equal(once.prompts.length, 2);
  const denied = fixture({ decision: 'deny' });
  const result = await denied.run('terminal_exec', exec());
  assert.equal(result.error.code, 'permission_rejected');
  assert.match(result.error.message, /Do not retry it through another tool/);
  assert.equal(denied.starts.length, 0);
});

test('full access skips ordinary command approvals while hard deletion restrictions remain', async () => {
  const f = fixture({ decision: 'deny' });
  assert.equal((await f.run('terminal_exec', exec(), { mode: 'all_free' })).kind, 'returned');
  const command = process.platform === 'win32' ? 'Remove-Item -Recurse -Force .' : 'rm -rf .';
  const denied = await f.run('terminal_exec', exec(command), { mode: 'all_free' });
  assert.equal(denied.error.code, 'protected_path_delete_denied');
  assert.equal(f.prompts.length, 0); assert.equal(f.starts.length, 1);
});

test('an enforced sandbox allows workspace commands without weakening the host policy', async () => {
  const f = fixture({ required: true, decision: 'deny' });
  assert.equal((await f.run('terminal_exec', exec())).kind, 'returned');
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.starts[0].sandbox, { network: 'disabled', readableRoots: [], writableRoots: [root] });
  assert.equal((await f.run('terminal_exec', exec(), { mode: 'all_free' })).kind, 'returned');
  assert.deepEqual(f.starts[1].sandbox, f.starts[0].sandbox);
});

test('stdin approvals bind the exact input and process; polling and sandboxed input remain automatic', async () => {
  const f = fixture();
  const first = (await f.run('terminal_exec', exec(), { mode: 'all_free' })).result.terminalSessionId;
  const second = (await f.run('terminal_exec', exec(), { mode: 'all_free' })).result.terminalSessionId;
  for (const [id, chars] of [[first, 'print(1)\n'], [first, 'print(1)\n'], [first, 'print(2)\n'], [second, 'print(1)\n']]) {
    assert.equal((await f.run('terminal_write', { session_id: id, chars, yield_time_ms: 1 })).kind, 'returned');
  }
  assert.equal(f.prompts.length, 3);
  await f.run('terminal_write', { session_id: first, chars: '', yield_time_ms: 1 });
  await f.run('terminal_poll', { session_id: first, yield_time_ms: 1 });
  await f.run('terminal_write', { session_id: first, chars: 'other', yield_time_ms: 1 }, { mode: 'all_free' });
  assert.equal(f.prompts.length, 3);
  const isolated = fixture({ required: true, decision: 'deny' });
  const id = (await isolated.run('terminal_exec', exec())).result.terminalSessionId;
  assert.equal((await isolated.run('terminal_write', { session_id: id, chars: 'input', yield_time_ms: 1 })).kind, 'returned');
  assert.equal(isolated.prompts.length, 0);
});

test('SSH approvals bind commands and their original connection instead of just the remote cwd', async () => {
  const sent = [];
  const f = fixture({ remote: { request: async (action, payload) => {
    if (action === 'authorize') return { path: payload.path, root: payload.uri, inside: true, home: '/home/user' };
    if (action === 'terminals') return { sessions: [] };
    sent.push(payload); return { state: 'completed' };
  } } });
  for (const [workspace, command] of [
    ['ssh://server-one/work', 'echo first'], ['ssh://server-one/work', 'echo first'],
    ['ssh://server-one/work', 'echo second'], ['ssh://server-two/work', 'echo first'],
  ]) assert.equal((await f.run('terminal_exec', exec(command, { cwd: '.', shell: 'posix' }), { workspace })).kind, 'returned');
  assert.equal(f.prompts.length, 3); assert.equal(sent.length, 4);
  assert.equal(f.prompts[0].targets[0].value, 'ssh://server-one/work');
  await f.run('terminal_exec', exec('echo third', { cwd: '.', shell: 'posix' }), { workspace: 'ssh://server-one/work', mode: 'all_free' });
  assert.equal(f.prompts.length, 3); assert.equal(sent.length, 5);
});
