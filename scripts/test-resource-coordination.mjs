import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { HostProcessResourceOwner } from '../dist-electron/hostProcesses.js';
import { McpHostBridge, handleMcpHostRequest } from '../dist-electron/mcpHostBridge.js';
import { getProcessResourceGovernor } from '../packages/bush-runtime/dist/processes.js';

test('memory admission diagnostics survive the private host RPC', async () => {
  const details = { limitingBudget: 'system_memory', availableMemoryBytes: 100, startupMemoryBytes: 200 };
  const bridge = new McpHostBridge(message => {
    if (message.type === 'request') void handleMcpHostRequest(message, new AbortController().signal, async () => {
      throw Object.assign(new Error('Memory admission blocked'), { code: 'resource_memory_pressure', details });
    }).then(response => bridge.receive(JSON.parse(JSON.stringify(response))));
  });
  await assert.rejects(bridge.request('resources.acquire', {}), error => {
    assert.equal(error.code, 'resource_memory_pressure');
    assert.deepEqual(error.details, details);
    return true;
  });
});

test('main and independent Runtime owners share admission through private RPC, preserving error codes', async t => {
  const governor = getProcessResourceGovernor();
  const previous = { ...governor.limits };
  Object.assign(governor.limits, { maxConcurrentTasks: 1, startupMemoryBytes: 1024 ** 2 });
  t.after(() => Object.assign(governor.limits, previous));
  const owners = [new HostProcessResourceOwner(), new HostProcessResourceOwner()];
  const bridges = owners.map(owner => {
    const bridge = new McpHostBridge(message => {
      if (message.type === 'request') void handleMcpHostRequest(message, new AbortController().signal,
        (operation, payload, signal) => owner.handle(operation, payload, signal)).then(response => bridge.receive(response));
    });
    return bridge;
  });
  const first = governor.acquire();
  await assert.rejects(bridges[0].request('resources.acquire', { id: randomUUID(), lifetime: 'task' }), { code: 'resource_capacity_busy' });
  first.release();
  const id = randomUUID();
  const grant = await bridges[0].request('resources.acquire', { id, lifetime: 'task' });
  assert.equal(grant.groupName, governor.groupName);
  assert.throws(() => governor.acquire(), { code: 'resource_capacity_busy' });
  await assert.rejects(bridges[1].request('resources.acquire', { id: randomUUID(), lifetime: 'task' }), { code: 'resource_capacity_busy' });
  await bridges[1].request('resources.release', { id });
  assert.throws(() => governor.acquire(), { code: 'resource_capacity_busy' }, 'another owner cannot release this admission');
  await bridges[0].request('resources.release', { id });
  await bridges[0].request('resources.release', { id });
  const final = governor.acquire(); final.release();
  owners.forEach(owner => owner.close());
});

test('cancellation or owner shutdown during the async module load cannot leave a grant behind', async () => {
  const owner = new HostProcessResourceOwner();
  const id = randomUUID();
  const pending = owner.handle('resources.acquire', { id, lifetime: 'task' }, new AbortController().signal);
  await owner.handle('resources.release', { id }, new AbortController().signal);
  await assert.rejects(pending, { name: 'AbortError' });
  owner.close();
  await assert.rejects(owner.handle('resources.acquire', { id: randomUUID(), lifetime: 'task' }, new AbortController().signal), /closed/);
});

test('queued I/O cancellation, reused identities and owner shutdown cannot orphan or steal a lease', async t => {
  const governor = getProcessResourceGovernor(), previous = { ...governor.limits };
  Object.assign(governor.limits, { maxConcurrentIo: 1, ioStartupMemoryBytes: 1024 ** 2 });
  t.after(() => Object.assign(governor.limits, previous));
  const first = await governor.acquireQueued('io'), owner = new HostProcessResourceOwner(), signal = new AbortController().signal;
  t.after(() => { first.release(); owner.close(); });
  const id = randomUUID();
  const pending = owner.handle('resources.acquire', { id, lifetime: 'io' }, signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  const released = owner.handle('resources.release', { id }, signal);
  const replacement = owner.handle('resources.acquire', { id, lifetime: 'io' }, signal);
  await released;
  await rejected; first.release();
  await replacement;
  assert.throws(() => governor.acquire('io'), { code: 'resource_io_capacity_busy' });
  await owner.handle('resources.release', { id }, signal);
  const blocker = await governor.acquireQueued('io');
  const closing = owner.handle('resources.acquire', { id: randomUUID(), lifetime: 'io' }, signal);
  const closed = assert.rejects(closing, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); owner.close(); await closed;
  blocker.release(); (await governor.acquireQueued('io')).release();
});
