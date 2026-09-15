import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { HostProcessResourceOwner } from '../dist-electron/hostProcesses.js';
import { McpHostBridge, handleMcpHostRequest } from '../dist-electron/mcpHostBridge.js';
import { getProcessResourceGovernor } from '../packages/bush-runtime/dist/processes.js';

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
