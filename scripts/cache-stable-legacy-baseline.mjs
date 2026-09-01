import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';

/** Former product shape, isolated here strictly as a regression baseline. */
export function createLegacyProductAgentTurnRequest(input) {
  const request = createProductAgentTurnRequest({
    ...input,
    sessionEnvironmentLocalDate: input.localDate,
  });
  const workspaceDir = String(input.workspaceDir ?? input.projectDir ?? '').trim();
  const content = [
    workspaceDir ? `Workspace: ${workspaceDir}` : '',
    String(input.projectInstructions ?? '').trim()
      ? `Project instructions:\n${String(input.projectInstructions).trim()}`
      : '',
    input.files?.length ? `Attached files:\n${input.files.join('\n')}` : '',
    input.images?.length ? `Attached images:\n${input.images.join('\n')}` : '',
    input.filesystemLocations?.length
      ? `Filesystem locations:\n${input.filesystemLocations
        .map((location) => `${location.name}: ${location.path}`)
        .join('\n')}`
      : '',
    `Local date: ${input.localDate}`,
  ].filter(Boolean).join('\n');
  const {
    sessionEnvironmentProtocol: _environmentProtocol,
    sessionEnvironmentLocalDate: _environmentLocalDate,
    ...metadata
  } = request.metadata;
  return {
    ...request,
    prefixMessages: [
      request.prefixMessages[0],
      ...(content ? [{
        role: 'developer',
        name: 'runtime_context',
        content: `<runtime_context>\n${content}\n</runtime_context>`,
      }] : []),
    ],
    inputMessages: request.inputMessages.filter((message) =>
      message.message.visibility !== 'internal'),
    tools: input.tools,
    metadata,
  };
}
