import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '@cardbush/bush-runtime';
import { modelRequestSchema } from '@cardbush/bush-protocol';

export async function verifyPackagedWorkspaceTools(directory: string) {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: {
    async request() { throw new Error('Package smoke requested access outside the test workspace.'); },
  } });
  const request = modelRequestSchema.parse({
    protocol: 'bush.model_request.v1', requestId: 'packaged-workspace-smoke', sessionId: 'packaged-smoke', turnId: 'fixture',
    model: 'fixture', permissionMode: 'ask_for_approval', tools: registry.definitions(), messages: [], metadata: { workspaceDir: directory },
  });
  let ordinal = 0;
  async function execute(name: string, input: Record<string, unknown>) {
    const outcome = await coordinator.execute({
      protocol: 'bush.tool_call.v1', id: `smoke-${ordinal}`, name, argumentsText: JSON.stringify(input),
    }, { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: ordinal++ },
    undefined, { request, contextMessages: [] });
    if (outcome.kind !== 'returned') throw new Error(`${name}: ${outcome.error.code} ${outcome.error.message}`);
    return outcome.result as { sandbox?: { backend?: string; network?: string }; content?: string; matched?: boolean };
  }
  const target = join(directory, 'fixture.txt');
  const created = await execute('write_file', { path: target, content: 'package-workspace-first\n' });
  const read = await execute('read_file', { path: target, start_line: 1 });
  if (read.content?.trim() !== 'package-workspace-first') throw new Error('Packaged exact-file read returned unexpected content.');
  await execute('apply_patch', { patch: '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-package-workspace-first\n+package-workspace-final\n*** End Patch' });
  const search = await execute('search_file_content', { path: target, query: 'package-workspace-final' });
  if (!search.matched || (await readFile(target, 'utf8')).trim() !== 'package-workspace-final')
    throw new Error('Packaged exact-file patch or search did not complete.');
  if ([created, read, search].some(result => result.sandbox?.backend !== 'windows-appcontainer' || result.sandbox.network !== 'disabled'))
    throw new Error('Packaged workspace tools did not run in the expected AppContainer.');
}
