import { z } from 'zod';

export const AGENT_REGISTRY_COMMAND = 'runtime.agent_registry' as const;
export const TEAM_WORKFLOW_COMMAND = 'runtime.team_workflow' as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
const names = z.array(z.string().trim().min(1)).max(512).refine(items => new Set(items).size === items.length, 'Duplicate names.');

export const registeredAgentSchema = z.object({
  id, name: z.string().trim().min(1).max(160), description: z.string().max(4000).default(''),
  system_prompt: z.string().trim().min(1).max(40000),
  allowed_tools: names.optional(), settings: z.record(z.string(), z.unknown()).optional(),
  hooks: names.default([]), guards: z.array(z.enum(['read_only'])).max(1).default([]),
  memory: z.enum(['user', 'project', 'local', 'none']).default('user'),
  enabled: z.boolean().default(true),
}).strict();
export type RegisteredAgent = z.infer<typeof registeredAgentSchema>;

export const teamWorkflowSchema = z.object({
  id, name: z.string().trim().min(1).max(160), description: z.string().max(4000).default(''),
  // bush-it retains the surrounding document independently of execution fields.
  presentation: z.object({ markdown: z.string().max(2 * 1024 * 1024) }).strict().optional(),
  max_parallel: z.number().int().min(1).max(8).default(3),
  nodes: z.array(z.object({
    id, agent_id: id, prompt: z.string().trim().min(1).max(40000),
    depends_on: z.array(id).max(64).default([]),
    name: z.string().trim().min(1).max(160).optional(),
    position: z.object({ x: z.number().min(-100000).max(100000), y: z.number().min(-100000).max(100000) }).strict().optional(),
  }).strict()).min(1).max(64),
}).strict().superRefine((team, context) => {
  const nodes = new Map(team.nodes.map(node => [node.id, node]));
  if (nodes.size !== team.nodes.length) context.addIssue({ code: 'custom', message: 'Duplicate workflow node IDs.' });
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    const node = nodes.get(key);
    if (!node || new Set(node.depends_on).size !== node.depends_on.length) return false;
    visiting.add(key);
    for (const dependency of node.depends_on) if (!visit(dependency)) return false;
    visiting.delete(key); visited.add(key); return true;
  };
  if (team.nodes.some(node => !visit(node.id))) context.addIssue({ code: 'custom', message: 'Workflow dependencies must exist, be unique and form an acyclic graph.' });
});
export type TeamWorkflow = z.infer<typeof teamWorkflowSchema>;
export interface DefinitionReceipt<T> { revision: number; updatedAt: string; definition: T }

export const workflowNodeStateSchema = z.object({
  id, status: z.enum(['pending', 'running', 'completed', 'failed', 'stopped']),
  taskId: z.string().optional(), sessionId: z.string().optional(),
  output: z.string().default(''), error: z.string().default(''),
});
export const teamRunSchema = z.object({
  id: z.string().min(1), teamId: id, teamRevision: z.number().int().positive(),
  parentSessionId: z.string().min(1), parentTurnId: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'interrupted']),
  input: z.string(), createdAt: z.string(), updatedAt: z.string(),
  workflow: teamWorkflowSchema,
  agents: z.array(z.object({ revision: z.number().int().positive(), updatedAt: z.string(), definition: registeredAgentSchema })),
  nodes: z.array(workflowNodeStateSchema), error: z.string().default(''),
});
export type TeamRun = z.infer<typeof teamRunSchema>;
