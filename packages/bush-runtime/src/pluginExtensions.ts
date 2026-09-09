import type { ModelRequest } from '@cardbush/bush-protocol';

export const PLUGIN_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop'] as const;
export type PluginHookEvent = typeof PLUGIN_HOOK_EVENTS[number];
export interface PluginHook {
  id: string;
  pluginId: string;
  root: string;
  dialect?: 'openai' | 'claude';
  event: PluginHookEvent;
  matcher: string;
  type?: 'command' | 'mcp_tool' | 'prompt' | 'agent';
  command: string;
  commandWindows?: string;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  async?: boolean;
  statusMessage?: string;
  additionalContextLimit?: number;
  /** Desktop loaders always set this after checking the current definition hash. */
  trusted?: boolean;
  definitionHash?: string;
  definition?: Record<string, unknown>;
  args?: string[];
  shell?: 'bash' | 'powershell' | 'cmd';
  timeout: number;
  once?: boolean;
}
export interface PluginAgent {
  id: string;
  pluginId: string;
  root: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
}
export interface PluginCommand {
  id: string;
  pluginId: string;
  root: string;
  path: string;
  name: string;
  description: string;
  prompt: string;
  argumentHint: string;
  arguments: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  shell: 'bash' | 'powershell';
}
export interface PluginExtensions { hooks: PluginHook[]; agents: PluginAgent[]; commands?: PluginCommand[] }
export type PluginExtensionLoader = () => Promise<PluginExtensions>;
export interface PluginHookContext {
  request: ModelRequest;
  signal?: AbortSignal;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  trigger?: 'manual' | 'auto';
  reason?: string;
}
export interface PluginHookResult {
  messages: string[];
  blocked?: string;
  updatedInput?: unknown;
  ask?: string;
  stopTurn?: string;
  continueTurn?: string;
  permissionDecision?: 'allow' | 'deny';
  /** A presentation replacement; the persisted native tool outcome remains authoritative. */
  toolFeedback?: string;
  rejectToolResult?: boolean;
}

// Claude aliases are only a naming adapter. Runtime retains tool exposure and permission checks.
export const CLAUDE_TOOL_NAMES: Record<string, string[]> = {
  Read: ['read_file'], Write: ['write_file'], Edit: ['edit_file'], Glob: ['search_file_content'], Grep: ['search_file_content'],
  Bash: ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_list'],
  PowerShell: ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_list'],
  Agent: ['subagent', 'await_subagents'], Task: ['subagent', 'await_subagents'], Skill: ['search_skills', 'read_file'],
  WebFetch: ['web_fetch'], WebSearch: ['web_search'], TodoWrite: ['update_task_plan'],
};
export function pluginAgentTools(agent: PluginAgent, exposed: string[]): string[] {
  const expand = (names: string[]) => new Set(names.flatMap(name => CLAUDE_TOOL_NAMES[name] ?? [name]));
  const allowed = agent.tools ? expand(agent.tools) : undefined;
  const denied = expand(agent.disallowedTools ?? []);
  return exposed.filter(name => (!allowed || allowed.has(name)) && !denied.has(name));
}
