/** Host implementation facts, separate from server-authored tool declarations. */
export const MCP_HOST_CAPABILITIES = {
  interfaces: { mcpApps: true, openAiBridge: true, presentation: 'conversation', statusTool: 'mcp_app_status' },
  files: {
    presentationTool: 'present_artifact',
  },
} as const;
