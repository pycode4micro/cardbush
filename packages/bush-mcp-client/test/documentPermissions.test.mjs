import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentFilePermission, isDocumentFileTool } from '../dist/documentPermissions.js';

test('document approval binds the code and exact files and escalates when a child needs human authority', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'cardbush-document-admission-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const root = await realpath(stage);
  const workspace = join(root, 'work');
  const source = join(root, 'source.pdf');
  await mkdir(workspace);
  await writeFile(source, 'fixture');
  const server = { id: 'plugin_pdf_documents', pluginId: 'pdf', transport: { kind: 'stdio' } };
  assert.equal(isDocumentFileTool(server, 'author_document'), true);
  assert.equal(isDocumentFileTool({ ...server, id: 'other' }, 'author_document'), false);
  const resource = 'mcp://plugin_pdf_documents/tools/author_document';
  const context = { turn: { request: { permissionMode: 'task_free', metadata: {
    workspaceDir: workspace, agentRole: 'child', permissionRouting: 'parent',
  } } }, input: { code: 'return 1', inputs: [{ path: source }], outputs: [join(root, 'export.pdf')] } };
  const planned = await documentFilePermission(context, resource, 'author_document');
  assert.deepEqual(planned.request.targets.map(target => target.value), [resource, source, join(root, 'export.pdf')]);
  assert.deepEqual(planned.request.actions, ['external_tool_call', 'read', 'write']);
  assert.equal(planned.request.requiresHuman, true);
  for (const input of [{ code: 'return 2' }, { outputs: [join(root, 'other.pdf')] }]) {
    assert.notEqual((await documentFilePermission({ ...context, input: { ...context.input, ...input } }, resource, 'author_document')).capabilityId,
      planned.capabilityId);
  }
  const observation = await documentFilePermission({ ...context, input: { path: source } }, resource, 'inspect_document');
  assert.equal(observation.request.requiresHuman, false);
});
