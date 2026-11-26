import { parseSshWorkspace, sshShellOptions, type ToolDefinition } from '@cardbush/bush-protocol';

export const sshTerminalTools: ReadonlySet<string> = new Set([
  'terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_list',
]);

export function executionWorkspace(metadata: Record<string, unknown>): string | undefined {
  const root = metadata.workspaceDir || metadata.projectDir || metadata.sessionWorkspaceDir;
  return typeof root === 'string' ? root : undefined;
}

export function isSshExecution(metadata: Record<string, unknown>): boolean {
  return Boolean(parseSshWorkspace(executionWorkspace(metadata)));
}

// Context maintenance is authorized separately and is never an ordinary SSH tool.
export function sshExecutionTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(tool => sshTerminalTools.has(tool.name) || tool.name === 'checkpoint_context').map(tool => {
    if (tool.name !== 'terminal_exec') return tool;
    const properties = tool.inputSchema.properties as Record<string, object> | undefined;
    if (!properties?.shell) return tool;
    const { write_paths: _localWritePaths, ...remoteProperties } = properties;
    const shell = { ...properties.shell, enum: sshShellOptions };
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...remoteProperties, shell } } };
  });
}
