import { z } from "zod";

export const OBSERVE_RUNTIME_AGENT_COMMAND = 'runtime.observe_agent' as const;
/** Trusted host lifecycle input. Not a model tool or authorization grant. */
export const runtimeAgentObservationSchema = z.object({
  sessionId: z.string().min(1).max(200), executionId: z.string().min(1).max(200),
  channel: z.literal('realtime_voice'), status: z.enum(['running', 'waiting', 'stopped', 'failed']),
}).strict();
export const GET_RUNTIME_ENVIRONMENT_COMMAND = 'runtime.get_environment' as const;
export const runtimeEnvironmentReadSchema = z.object({ sessionId: z.string().min(1) });
export const runtimeAgentFactSchema = z.object({
  agentId: z.string().min(1), executionId: z.string().min(1),
  parentAgentId: z.string().optional(), projectDir: z.string().optional(), workspaceDir: z.string().optional(),
  hostId: z.string().optional(), transport: z.enum(['local', 'remote']).optional(),
  observationStatus: z.enum(['current', 'last_known', 'unavailable']).optional(),
  role: z.enum(['root', 'child']),
  status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unavailable']),
  readOnly: z.boolean().nullable(), canDelegate: z.boolean(), canWake: z.boolean(),
  permissionMode: z.string().optional(), interactiveRequests: z.boolean().optional(),
  startedAt: z.string(), updatedAt: z.string(),
});
export type RuntimeAgentFact = z.infer<typeof runtimeAgentFactSchema>;
export const runtimeEnvironmentSectionsSchema = z.object({
  host: z.object({ platform: z.string(), architecture: z.string() }).optional(),
  workspace: z.object({ projectDir: z.string().nullable(), workspaceDir: z.string().nullable() }).optional(),
  agents: z.object({ self: runtimeAgentFactSchema.optional(), items: z.array(runtimeAgentFactSchema),
    total: z.number().int().nonnegative(), coordination: z.array(z.string()).optional(), coordinationTruncated: z.boolean().optional() }).optional(),
  capabilities: z.object({ permissionMode: z.string().nullable(), interactiveRequests: z.boolean().nullable(), readOnly: z.boolean().nullable() }).optional(),
}).catchall(z.unknown());
export const runtimeEnvironmentSnapshotSchema = z.object({
  protocol: z.literal('bush.runtime_environment.v1'), sessionId: z.string().min(1),
  kind: z.enum(['snapshot', 'update']), effectiveAt: z.string(),
  sections: runtimeEnvironmentSectionsSchema,
});
export type RuntimeEnvironmentSnapshot = z.infer<typeof runtimeEnvironmentSnapshotSchema>;

export const BUSH_SESSION_ENVIRONMENT_PROTOCOL =
  "bush.session_environment.v1" as const;

export const sessionEnvironmentFactSchema = z.object({
  protocol: z.literal(BUSH_SESSION_ENVIRONMENT_PROTOCOL),
  kind: z.enum(["snapshot", "update"]),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveAt: z.string().min(1),
});

export type SessionEnvironmentFact = z.infer<
  typeof sessionEnvironmentFactSchema
>;

export function encodeSessionEnvironmentFact(
  input: SessionEnvironmentFact,
): string {
  return JSON.stringify(sessionEnvironmentFactSchema.parse(input));
}

export function decodeSessionEnvironmentFact(
  input: string,
): SessionEnvironmentFact {
  return sessionEnvironmentFactSchema.parse(JSON.parse(input));
}
