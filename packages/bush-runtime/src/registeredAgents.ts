import { registeredAgentSchema, type RegisteredAgent, type DefinitionReceipt } from '@cardbush/bush-protocol';
import { DefinitionStore } from './definitionStore.js';
import { CLEAN_AGENT_SETTINGS_SCHEMA, decodeCleanAgentSettings } from './cleanAgentSettings.js';
import type { PluginAgent, PluginHook } from './pluginExtensions.js';

export const REGISTERED_AGENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['id', 'name', 'system_prompt'], properties: {
    id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$' }, name: { type: 'string' }, description: { type: 'string' },
    system_prompt: { type: 'string', description: 'Persistent role, principles, task boundaries and output requirements.' },
    remote: { type: 'object', additionalProperties: false, required: ['connection_id', 'agent_id'], properties: {
      connection_id: { type: 'string', description: 'Saved worker connection ID from list_subagent_options.remote_agents. Credentials are managed by the host, never included here.' },
      agent_id: { type: 'string', description: 'Verified service instance ID from that connection. A different instance requires a new registration.' },
    }, description: 'Register a remote worker as a reusable subagent. Its own model, workspace and tools execute the role. Omit local allowed_tools, settings, hooks and guards.' },
    allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Exact available tools. Omit to inherit the host catalog, [] to run without tools.' },
    settings: CLEAN_AGENT_SETTINGS_SCHEMA,
    hooks: { type: 'array', items: { type: 'string' }, description: 'Exact trusted hook IDs from list_subagent_options section=settings. Host hooks always remain enforced.' },
    guards: { type: 'array', items: { type: 'string', enum: ['read_only'] }, description: 'Runtime-enforced guards. read_only denies resource mutations.' },
    enabled: { type: 'boolean', default: true },
  },
};

export class RegisteredAgentStore extends DefinitionStore<RegisteredAgent> {
  constructor(directory?: string) {
    super(value => {
      const agent = registeredAgentSchema.parse(value);
      if (agent.settings) agent.settings = { ...decodeCleanAgentSettings(agent.settings) };
      return agent;
    }, directory);
  }
}

/** Adapt registered roles to the existing scoped tool environment; no second execution engine. */
export function registeredAgentProfile(receipt: DefinitionReceipt<RegisteredAgent>): PluginAgent {
  const agent = registeredAgentSchema.parse(receipt.definition);
  return { id: `registered:${agent.id}`, pluginId: 'builtin', root: '', name: agent.id, description: agent.description,
    prompt: agent.system_prompt,
    permissionMode: agent.guards.includes('read_only') ? 'plan' : 'default',
    definitionHash: String(receipt.revision), trusted: true };
}

export function validateRegisteredHooks(agent: RegisteredAgent, hooks: PluginHook[]) {
  for (const id of agent.hooks) if (!hooks.some(hook => hook.id === id && hook.trusted === true)) throw new Error(`Registered Agent hook ${id} is unavailable or untrusted.`);
}
