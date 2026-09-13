import { reasoningEffortSchema, type ReasoningEffort, type RuntimePermissionMode, type RuntimeProviderBindingRef } from '@cardbush/bush-protocol';

export interface SubagentModelOption {
  id: string;
  model: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface SubagentModelSelection extends SubagentModelOption {
  providerBinding: RuntimeProviderBindingRef;
}

export interface SubagentModelCatalog {
  list: (signal?: AbortSignal) => Promise<SubagentModelOption[]>;
  resolve: (id: string, signal?: AbortSignal) => Promise<SubagentModelSelection>;
}

export interface CleanAgentSettings {
  model_id?: string;
  reasoning_effort?: ReasoningEffort;
  max_context_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  max_turns?: number;
  permission_mode?: RuntimePermissionMode;
  permission_routing?: 'user' | 'parent';
  disabled_tools?: string[];
  allowed_skills?: string[];
  disabled_skills?: string[];
}

const names = { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } };
export const CLEAN_AGENT_SETTINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Clean mode only. Choose the child settings yourself from list_subagent_options. Omitted values keep the displayed host defaults. These choices cannot widen host permissions, tool or Skill restrictions.',
  properties: {
    model_id: { type: 'string', minLength: 1, description: 'Exact configured model id from list_subagent_options. Credentials are resolved by the host.' },
    reasoning_effort: { type: 'string', enum: reasoningEffortSchema.options },
    max_context_tokens: { type: 'integer', minimum: 1 },
    max_output_tokens: { type: 'integer', minimum: 1 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    top_p: { type: 'number', minimum: 0, maximum: 1 },
    max_turns: { type: 'integer', minimum: 1, description: 'Maximum model rounds for this child; an explicit plugin Agent limit still applies.' },
    permission_mode: { type: 'string', enum: ['task_free', 'user_free', 'all_free'], description: 'Must not exceed the displayed child permission ceiling.' },
    permission_routing: { type: 'string', enum: ['user', 'parent'], description: 'user shares the parent permission scope; parent uses a separate child scope. This does not raise the permission ceiling.' },
    disabled_tools: { ...names, description: 'Additional runtime-denied tools; declarations need not be removed.' },
    allowed_skills: { ...names, description: 'Optional exact Skill names/ids from search_skills within the displayed host scope; [] allows none. When the host provides an allowlist, select from those exact values.' },
    disabled_skills: { ...names, description: 'Additional disabled Skill names/ids.' },
  },
};

export function decodeCleanAgentSettings(value: unknown): CleanAgentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object.');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(CLEAN_AGENT_SETTINGS_SCHEMA.properties, key));
  if (unknown.length) throw new Error(`Unsupported clean settings: ${unknown.join(', ')}.`);
  for (const key of ['max_context_tokens', 'max_output_tokens', 'max_turns']) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) <= 0)) throw new Error(`${key} must be a positive integer.`);
  }
  for (const [key, max] of [['temperature', 2], ['top_p', 1]] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > max)) throw new Error(`${key} must be between 0 and ${max}.`);
  }
  if (input.model_id !== undefined && (typeof input.model_id !== 'string' || !input.model_id.trim())) throw new Error('model_id must be a non-empty configured model id.');
  if (input.reasoning_effort !== undefined) reasoningEffortSchema.parse(input.reasoning_effort);
  if (input.permission_mode !== undefined && !['task_free', 'user_free', 'all_free'].includes(String(input.permission_mode))) throw new Error('Invalid clean permission_mode.');
  if (input.permission_routing !== undefined && !['user', 'parent'].includes(String(input.permission_routing))) throw new Error('Invalid clean permission_routing.');
  const result = { ...input };
  if (typeof input.model_id === 'string') result.model_id = input.model_id.trim();
  for (const key of ['disabled_tools', 'allowed_skills', 'disabled_skills']) {
    if (input[key] !== undefined) result[key] = decodeToolOrSkillNames(input[key], key);
  }
  return result as CleanAgentSettings;
}

export function decodeToolOrSkillNames(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.some(name => typeof name !== 'string' || !name.trim())) throw new Error(`${label} must be an array of non-empty names.`);
  const names = input.map(name => name.trim());
  if (new Set(names).size !== names.length) throw new Error(`${label} must contain unique names.`);
  return names;
}
