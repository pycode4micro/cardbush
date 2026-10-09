import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';

/** A realtime conversational parent can delegate without starting a text-model turn. */
export const REALTIME_AGENT_TOOL_COMMAND = 'runtime.realtime_agent_tool' as const;
export const realtimeAgentToolRequestSchema = z.object({
  sessionId: z.string().min(1),
  callId: z.string().min(1).max(200),
  action: z.enum(['subagent', 'read_subagent_conversation', 'list_subagent_options', 'team']),
  parent: runtimeSessionTurnRequestSchema.optional(),
  prompt: z.string().trim().min(1).max(8000).optional(),
  taskId: z.string().min(1).optional(),
  cursor: z.string().regex(/^\d+:\d+$/).optional(),
  targetAgent: z.string().min(1).max(200).optional(),
  /** Text assistant uses the Runtime's native schemas; voice keeps its small interface. */
  nativeArguments: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type RealtimeAgentToolRequest = z.infer<typeof realtimeAgentToolRequestSchema>;
