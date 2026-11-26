import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutionCoordinator, ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';
import { fileOperationPermission } from '../dist/fileOperationPermissions.js';
import { PERSONAL_ASSISTANT_SESSION, mcpFileOperationsSchema } from '@cardbush/bush-protocol';

test('file operations bind paths and host code for every document format, regardless of plugin name', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'cardbush-document-admission-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const root = await realpath(stage);
  const workspace = join(root, 'work');
  const source = join(root, 'source.pdf');
  await mkdir(workspace);
  await writeFile(source, 'fixture');
  const resource = 'mcp://fixture/tools/create_artifact';
  const authority = { sessionId: PERSONAL_ASSISTANT_SESSION, permissionMode: 'all_free', metadata: {} };
  const context = { turn: { request: { permissionMode: 'task_free', metadata: {
    workspaceDir: workspace, agentRole: 'child', permissionRouting: 'parent', parentSessionId: PERSONAL_ASSISTANT_SESSION,
  } } }, input: { code: 'return 1', inputs: [{ path: source }], outputs: [join(root, 'export.pdf')] } };
  const manifest = async (kind) => (JSON.parse(await readFile(
    new URL(`../../../assets/plugins/${kind}/.mcp.json`, import.meta.url), 'utf8'))).mcpServers.documents;
  for (const kind of ['pdf', 'docx', 'pptx', 'xlsx']) {
    const { author_document: operation, inspect_document: read } =
      mcpFileOperationsSchema.parse((await manifest(kind)).cardbush_file_operations);
    const inherited = await fileOperationPermission({ ...context, parentWorkspaceAuthority: authority }, resource, operation);
    assert.equal(inherited.parentApproval, true);
    assert.equal(inherited.request.requiresHuman, false);
    assert.equal(inherited.request.outsideParentScope, undefined);
    assert.equal((await fileOperationPermission({ ...context, parentWorkspaceAuthority: { ...authority, permissionMode: 'task_free' } },
      resource, operation)).request.requiresHuman, true);
    assert.equal((await fileOperationPermission({ ...context, input: { path: source } }, resource, read)).request.requiresHuman, false);
  }
  const operation = mcpFileOperationsSchema.parse((await manifest('pdf')).cardbush_file_operations).author_document;
  const planned = await fileOperationPermission(context, resource, operation);
  assert.deepEqual(planned.request.targets.map(target => target.value), [resource, source, join(root, 'export.pdf')]);
  assert.deepEqual(planned.request.actions, ['external_tool_call', 'read', 'write']);
  assert.equal(planned.request.requiresHuman, true);
  for (const input of [{ code: 'return 2' }, { outputs: [join(root, 'other.pdf')] }]) {
    assert.notEqual((await fileOperationPermission({ ...context, input: { ...context.input, ...input } }, resource, operation)).capabilityId,
      planned.capabilityId);
  }
});

test('host-declared attachment readers support new tool names, with approval bound to this turn and this file version', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'cardbush-attachment-reader-'));
  const root = await realpath(stage);
  const source = join(root, 'data.ods'), other = join(root, 'other.ods');
  await writeFile(source, 'original');
  await writeFile(other, 'other');
  const registry = new ToolRegistry();
  const tools = ['read_cells', 'undeclared_read', 'write_cells'].map(name => ({ name,
    annotations: { readOnlyHint: name !== 'write_cells' },
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, row: { type: 'integer' } }, required: ['file', 'row'] },
  }));
  const manager = new McpClientManager({ registry,
    createTransport: () => ({ async send() {} }),
    createClient: () => ({
      async connect() {}, async close() {}, getNegotiatedProtocolVersion: () => '2025-11-25',
      async listTools() { return { tools }; },
      async callTool({ arguments: input }) { return { content: [{ type: 'text', text: JSON.stringify(input) }] }; },
    }),
  });
  t.after(async () => {
    await manager.close();
    await rm(stage, { recursive: true, force: true });
  });
  const reader = { pathArgument: 'file', readArguments: ['row'] };
  await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'attachment-reader', revision: 1, servers: [{
    id: 'plugin_records_documents', pluginId: 'records', implementationFingerprint: '1'.repeat(64),
    transport: { kind: 'stdio', command: 'fixture' }, attachmentReaders: { read_cells: reader, write_cells: reader },
  }] });
  const requests = [];
  const coordinator = new ToolExecutionCoordinator({ registry, isTurnAttachment: path => path === source,
    permissions: { async request(request) {
      requests.push(request);
      return { decision: 'allow_once', grantedCapabilityIds: request.capabilityIds };
    } },
  });
  let ordinal = 0;
  const call = async (name, file, row, turnId = 'task-1') => {
    const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${ordinal}`,
      name: `mcp__plugin_records_documents__${name}`, argumentsText: JSON.stringify({ file, row }) },
    { requestId: 'request', sessionId: 'child', turnId, round: 1, ordinal: ordinal++ });
    assert.equal(result.kind, 'returned', JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.result.content[0].text), { file, row });
  };
  await call('read_cells', source, 0);
  await call('read_cells', source, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].reason, /current task/);
  await call('read_cells', other, 0);
  await call('read_cells', other, 1);
  assert.equal(requests.length, 3, 'another file uses the regular approval for each call');
  await call('write_cells', source, 0);
  await call('write_cells', source, 1);
  await call('undeclared_read', source, 0);
  await call('undeclared_read', source, 1);
  assert.equal(requests.length, 7, 'write and self-declared read-only tools cannot use the scoped read grant');
  await writeFile(source, 'replaced attachment');
  await call('read_cells', source, 2);
  assert.equal(requests.length, 8, 'a changed version requests permission again');
  await call('read_cells', source, 3, 'task-2');
  assert.equal(requests.length, 9, 'a new task requests permission again');
});
