import type { ModelRequest } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

export const PLUGIN_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop'] as const;
export type PluginHookEvent = typeof PLUGIN_HOOK_EVENTS[number];
export interface PluginHook {
  scope?: { kind: 'skill' | 'agent'; id: string };
  id: string;
  pluginId: string;
  root: string;
  dialect?: 'openai' | 'claude';
  event: PluginHookEvent;
  matcher: string;
  type?: 'command' | 'mcp_tool' | 'prompt' | 'agent' | 'http';
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  prompt?: string;
  model?: string;
  continueOnBlock?: boolean;
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
  memory?: 'user' | 'project' | 'local';
  background?: boolean;
  isolation?: 'worktree';
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
  mcpServers?: Array<string | Record<string, Record<string, unknown>>>;
  definitionHash?: string;
  trusted?: boolean;
  id: string;
  pluginId: string;
  root: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  skills?: Array<{ name: string; path: string; prompt: string; dependencyServers?: string[] }>;
}
export interface PluginCommand {
  background?: boolean;
  kind?: 'command' | 'skill';
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
  context?: 'fork';
  agent?: string;
  dependencyServers?: string[];
}
export interface PluginExtensions { hooks: PluginHook[]; agents: PluginAgent[]; commands?: PluginCommand[]; skills?: PluginCommand[] }
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
  Agent: ['subagent', 'await_subagents'], Task: ['subagent', 'await_subagents'], Skill: ['search_skills', 'run_skill', 'read_file'],
  WebFetch: ['web_fetch'], WebSearch: ['web_search'], TodoWrite: ['update_task_plan'],
};
export function pluginAgentTools(agent: PluginAgent, exposed: string[]): string[] {
  const expand = (names: string[]) => new Set(names.flatMap(name => {
    if (name.startsWith('mcp__')) {
      const scope = `mcp__plugin_${agent.pluginId.replace(/\./g, '_')}_`;
      const normalized = name.replace(/__\*$/, '');
      const serverScope = name.endsWith('__*') || !name.slice(5).includes('__');
      return exposed.filter(exposedName => {
        const tool = exposedName.replace(/__scope_[a-f0-9]{16}(?=__)/, '');
        return name === 'mcp__*' ? tool.startsWith('mcp__') : tool === name || tool === name.replace('mcp__', scope) || (serverScope && (tool.startsWith(`${normalized}__`) || tool.startsWith(`${normalized.replace('mcp__', scope)}__`)));
      });
    }
    return CLAUDE_TOOL_NAMES[name] ?? [name];
  }));
  const allowed = agent.tools ? expand(agent.tools) : undefined;
  const denied = expand(agent.disallowedTools ?? []);
  const result = exposed.filter(name => (!allowed || allowed.has(name)) && !denied.has(name));
  if (result.some(name => name.startsWith('mcp__'))) for (const name of ['mcp_search', 'mcp_call']) if (exposed.includes(name) && !denied.has(name) && !result.includes(name)) result.push(name);
  return result;
}

export function validateAgentSkills(agent: PluginAgent | undefined, request: Pick<ModelRequest, 'metadata' | 'tools'>, registry: ToolRegistry): void {
  for (const skill of agent?.skills ?? []) {
    const names = [skill.name, skill.name.split(':').at(-1)];
    const { disabledSkills, allowedSkills } = request.metadata;
    if ((Array.isArray(disabledSkills) && names.some(name => disabledSkills.includes(name))) ||
        (Array.isArray(allowedSkills) && !names.some(name => allowedSkills.includes(name)))) throw new Error(`Agent Skill ${skill.name} is disabled or outside the allowed Skills.`);
    if ((skill.dependencyServers ?? []).some(server => !request.tools.some(tool => registry.resolve(tool.name)?.mcpHook?.server === server))) throw new Error(`Connect and expose the MCP dependencies of Agent Skill ${skill.name} first.`);
  }
}
