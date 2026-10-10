import { z } from 'zod';

/** Human UI control of an existing owned process, outside the model tool loop. */
export const RUNTIME_TERMINAL_CONTROL_COMMAND = 'runtime.terminal_control' as const;
export const runtimeTerminalControlSchema = z.object({
  sessionId: z.string().min(1), terminalSessionId: z.string().min(1), action: z.enum(['status', 'stop']),
}).strict();
export const runtimeTerminalStatusSchema = z.object({
  terminalSessionId: z.string().min(1), state: z.string().min(1),
  pid: z.number().nullable().optional(), exitCode: z.number().nullable().optional(),
  startedAt: z.string().optional(), durationMs: z.number().nonnegative().optional(),
  lastOutputAt: z.string().nullable().optional(), outputIdleMs: z.number().nonnegative().optional(),
});
export type RuntimeTerminalStatus = z.infer<typeof runtimeTerminalStatusSchema>;
