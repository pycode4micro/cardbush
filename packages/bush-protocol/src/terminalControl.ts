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

/** Process facts are separate from whether its tool invocation returned. */
export const terminalCommandOutcomeSchema = z.enum(['running', 'succeeded', 'failed', 'stopped']);
export type TerminalCommandOutcome = z.infer<typeof terminalCommandOutcomeSchema>;
export function terminalCommandOutcome(value: unknown): TerminalCommandOutcome | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (result.state === 'stopped') return 'stopped';
  if (result.state === 'running') return 'running';
  if (result.state === 'failed' || result.state === 'disconnected' ||
      (typeof result.exitCode === 'number' && result.exitCode !== 0) ||
      (typeof result.signal === 'string' && result.signal.length > 0)) return 'failed';
  if ((result.state === 'exited' || result.state === 'completed') && result.exitCode === 0) return 'succeeded';
  return undefined;
}

export function terminalToolOutcome(name: string, result: unknown): TerminalCommandOutcome | undefined {
  return ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_completion'].includes(name)
    ? terminalCommandOutcome(result) : undefined;
}
