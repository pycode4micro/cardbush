import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { GET_RUNTIME_TOOL_EXECUTION_COMMAND, LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND } from '@cardbush/bush-protocol';
import { FileToolExecutionPersistence, InMemoryRuntimeHost, ToolExecutionStore, ToolRegistry } from '../dist/index.js';

test('removed presentation tools retain their original attachments through durable history reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-artifact-history-'));
  const journal = join(root, 'executions');
  const writer = new FileToolExecutionPersistence({ root: journal });
  const reader = new FileToolExecutionPersistence({ root: journal });
  t.after(async () => {
    writer.close(); reader.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-artifact-history-'));
    await rm(root, { recursive: true, force: true });
  });
  // The file no longer exists; reading history must retain the original observation.
  const path = join(root, 'old-image.png');
  const native = { protocol: 'bush.artifact.v1', presentation: 'submitted',
    file: { path, size: 42, mtimeMs: 1234, mediaTypeSource: 'extension' },
    artifacts: [{ id: 'old-artifact', path, name: 'old-image.png', type: 'image', mimeType: 'image/png', size: 42, display: 'inline', readOnly: true }],
  };
  const record = new ToolExecutionStore({ persistence: writer }).record(
    { protocol: 'bush.tool_call.v1', id: 'old-call', name: 'present_artifact', argumentsText: JSON.stringify({ path }) },
    { sessionId: 's', turnId: 't', requestId: 'old-request', round: 1, ordinal: 0 },
    { kind: 'returned', workspaceChanges: [], result: native, actionManifest: {
      protocol: 'bush.tool.action_manifest.v1', manifest_id: 'historical-presentation',
      effect_kind: 'observation', operation: 'artifact.present', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false,
    } }, JSON.stringify(native),
  );
  writer.close();
  const [filename] = await readdir(journal);
  const originalBytes = await readFile(join(journal, filename));
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolRegistry: registry,
    toolExecutionStore: new ToolExecutionStore({ persistence: reader }),
    provider: { async *stream() { throw Error('History must not invoke a model or replay a tool'); } },
  });
  assert.equal(registry.resolve('present_artifact'), undefined);
  assert.ok(registry.resolve('remember_file'));
  assert.ok(registry.resolve('mcp_app_status'));
  assert.deepEqual(await host.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND,
    payload: { sessionId: 's', turnId: 't', toolCallId: 'old-call' } }), record);
  assert.deepEqual(await host.sendCommand({ kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
    payload: { sessionId: 's', turnId: 't', detail: 'full' } }), [record]);
  assert.deepEqual(await readFile(join(journal, filename)), originalBytes, 'history reads do not rewrite the original journal');
});
