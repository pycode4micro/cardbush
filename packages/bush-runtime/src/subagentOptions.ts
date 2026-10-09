import { DEFAULT_CHILD_AGENT_DISABLED_TOOLS } from '@cardbush/bush-protocol';
import type { SubagentPermissionPolicy } from './childTurn.js';
import { childAgentToolDenial } from './childAgentPolicy.js';
import type { SubagentModelCatalog } from './cleanAgentSettings.js';
import type { RegisteredAgentStore } from './registeredAgents.js';
import type { PluginAgent, PluginHook } from './pluginExtensions.js';
import type { RemoteSubagentBridge } from './subagentTool.js';
import type { ToolRegistry } from './toolRegistry.js';
import { briefText, catalogPage, catalogPageProperties, decodeCatalogQuery, type CatalogQuery } from './catalogPage.js';

interface OptionsInput extends CatalogQuery {
  section: 'agents' | 'settings' | 'tools';
  agentId?: string;
  agentType?: string;
}

interface OptionsSources {
  agents?: RegisteredAgentStore;
  models?: SubagentModelCatalog;
  permissionPolicy?: SubagentPermissionPolicy;
  loadPluginAgents?: () => Promise<PluginAgent[]>;
  loadHooks?: () => Promise<PluginHook[]>;
  remoteAgents?: Pick<RemoteSubagentBridge, 'list'>;
}

const fields = new Set(['section', 'agent_id', 'agent_type', 'query', 'offset', 'limit']);
function decodeOptions(value: unknown): OptionsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Subagent options must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.has(key))) throw new Error('Use section, agent_id, agent_type, query, offset or limit.');
  const section = input.section ?? 'agents';
  if (section !== 'agents' && section !== 'settings' && section !== 'tools') throw new Error('section must be agents, settings or tools.');
  for (const key of ['agent_id', 'agent_type']) if (input[key] !== undefined && (section !== 'agents' || typeof input[key] !== 'string' || !input[key].trim())) throw new Error(`${key} requires the agents section and a nonempty exact ID.`);
  const detail = input.agent_id !== undefined || input.agent_type !== undefined;
  if (input.agent_id !== undefined && input.agent_type !== undefined) throw new Error('Inspect one agent_id or agent_type at a time.');
  if (['query', 'offset', 'limit'].some(key => input[key] !== undefined) && (section === 'settings' || detail)) throw new Error('query, offset and limit apply only to agent or tool lists.');
  return { ...decodeCatalogQuery(input), section, agentId: (input.agent_id as string | undefined)?.trim(), agentType: (input.agent_type as string | undefined)?.trim() };
}

/** Agent discovery must not serialize the entire inherited tool catalog. */
export function registerSubagentOptions(registry: ToolRegistry, options: OptionsSources) {
  if (registry.resolve('list_subagent_options')) return;
  registry.register<OptionsInput>({
    definition: {
      name: 'list_subagent_options',
      description: 'Discover reusable employees, plugin roles and saved remote hosts by capability. Agent and tool lists support query and next_offset pagination. Use agent_id or agent_type for one full definition only when inspecting configuration; section=settings for configured models, defaults and trusted hooks; section=tools for tool availability. Registered employees use their saved configuration. Fork needs no setup lookup.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        section: { type: 'string', enum: ['agents', 'settings', 'tools'], default: 'agents' },
        agent_id: { type: 'string', minLength: 1, description: 'agents section only: exact registered employee ID for its full definition and revision.' },
        agent_type: { type: 'string', minLength: 1, description: 'agents section only: exact plugin role ID for its instructions and configuration.' },
        ...catalogPageProperties,
      } },
    },
    manifest: { effect_kind: 'observation', operation: 'agent.options', risk: 'low', owner: 'runtime_subagent', dispatch_scope: 'parent_session', mutating: false },
    parallelSafe: true,
    decodeInput: decodeOptions,
    execute: async context => {
      if (!context.turn) throw new Error('Subagent options require the current Turn context.');
      if (context.input.agentId) {
        const agent = await options.agents?.get(context.input.agentId);
        if (!agent) throw new Error('Registered Agent is unavailable.');
        return agent;
      }
      if (context.input.agentType) {
        const role = (await options.loadPluginAgents?.())?.find(agent => agent.id === context.input.agentType);
        if (!role) throw new Error('Plugin Agent role is unavailable.');
        return JSON.parse(JSON.stringify({ id: role.id, description: role.description, prompt: role.prompt, model: 'inherit',
          tools: role.tools, disallowedTools: role.disallowedTools, memory: role.memory, permissionMode: role.permissionMode,
          maxTurns: role.maxTurns, background: role.background, isolation: role.isolation, trusted: role.trusted,
          skills: role.skills?.map(skill => skill.name), mcpServers: role.mcpServers?.flatMap(server => typeof server === 'string' ? [server] : Object.keys(server)),
        }));
      }
      if (context.input.section === 'agents') {
        const [registered, roles, remote] = await Promise.all([
          options.agents?.list() ?? [], options.loadPluginAgents?.() ?? [], options.remoteAgents?.list(context.signal) ?? [],
        ]);
        const needle = context.input.query?.toLowerCase();
        const entries = [
          ...registered.map(({ definition: { id, name, description, enabled } }) => ({ kind: 'registered_agents' as const, id, name, description: briefText(description), enabled, search: `${id} ${name} ${description}` })),
          ...roles.map(({ id, description }) => ({ kind: 'agent_roles' as const, id, description: briefText(description), search: `${id} ${description}` })),
          ...remote.map(({ id, name }) => ({ kind: 'remote_agents' as const, id, name: briefText(name, 160), search: `${id} ${name}` })),
        ].filter(item => !needle || item.search.toLowerCase().includes(needle))
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
          .map(({ search: _search, ...item }) => item);
        const { items, ...page } = catalogPage(entries, { ...context.input, query: undefined });
        return {
          registered_agents: items.filter(item => item.kind === 'registered_agents').map(({ kind: _kind, ...item }) => item),
          agent_roles: items.filter(item => item.kind === 'agent_roles').map(({ kind: _kind, ...item }) => item),
          remote_agents: items.filter(item => item.kind === 'remote_agents').map(({ kind: _kind, ...item }) => item),
          ...page,
          default_mode: 'fork',
          clean_usage: 'Use agent_id for registered clean employees and Team nodes; agent_type selects a plugin role. If the requested employee is missing, register it with subagent action=save before saving a Team. New tasks have separate conversations; task_id continues an existing task.',
        };
      }

      const request = context.turn.request;
      const policy = request.metadata.childAgentPolicy as Record<string, unknown> | undefined;
      const configured = options.permissionPolicy;
      const disabledTools = policy?.disabledTools ?? configured?.disabledTools ?? [...DEFAULT_CHILD_AGENT_DISABLED_TOOLS];
      if (context.input.section === 'tools') {
        const { query } = context.input;
        const needle = query?.toLowerCase();
        const matches = request.tools.filter(tool => !needle || tool.name.toLowerCase().includes(needle))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const childRequest = { ...request, metadata: { ...request.metadata, agentRole: 'child', disabledTools } };
        const summaries = matches.map(tool => {
          const registration = registry.resolve(tool.name);
          const denial = registration ? childAgentToolDenial(childRequest, registration) : { message: 'Tool is no longer registered.' };
          return { name: tool.name, child_available: !denial, ...(denial ? { restriction: briefText(denial.message) } : {}) };
        });
        const { items, ...page } = catalogPage(summaries, { ...context.input, query: undefined });
        return { tools: items, ...page };
      }

      const [models, hooks] = await Promise.all([options.models?.list(context.signal) ?? [], options.loadHooks?.() ?? []]);
      const route = request.metadata.subagentPermissionRouting ?? policy?.permissionRouting ?? configured?.permissionRouting ?? 'user';
      const modelPolicy = policy?.model && typeof policy.model === 'object' ? policy.model as Record<string, unknown> : {};
      // The settings schema already belongs to subagent's input definition.
      // Return only configured choices and omit unavailable optional defaults.
      return JSON.parse(JSON.stringify({
        models: models.map(({ id, model, maxContextTokens, maxOutputTokens, reasoningEffort }) => ({ id, model, maxContextTokens, maxOutputTokens, reasoningEffort })),
        defaults: {
          model: modelPolicy.mode === 'fixed' ? { mode: 'fixed', id: modelPolicy.modelId, model: modelPolicy.model } : { mode: 'inherit' }, parent_model: request.model,
          reasoning_effort: modelPolicy.mode === 'fixed' ? modelPolicy.reasoningEffort : request.reasoningEffort, max_output_tokens: modelPolicy.maxOutputTokens ?? request.maxOutputTokens,
          max_context_tokens: modelPolicy.maxContextTokens ?? request.metadata.contextWindowTokens, temperature: request.temperature, top_p: request.topP,
          permission_routing: route,
          permission_ceiling: request.permissionMode === 'all_free' || route === 'user' ? request.permissionMode : policy?.childPermissionMode ?? configured?.childPermissionMode ?? 'task_free',
          disabled_tools: disabledTools, allowed_skills: request.metadata.allowedSkills, disabled_skills: request.metadata.disabledSkills ?? [],
        },
        hooks: hooks.filter(hook => hook.trusted === true).map(({ id, event, matcher }) => ({ id, event, matcher })),
        skill_discovery: 'Use search_skills for installed Skills, within defaults.allowed_skills when present.',
      }));
    },
  });
}
