import type { PluginHookContext, PluginHookEvent, PluginHookResult } from './pluginExtensions.js';
import type { ToolExecutionHooks } from './toolExecutionCoordinator.js';

type RunHook = (event: PluginHookEvent, context: Omit<PluginHookContext, 'request'>) => Promise<PluginHookResult>;
/** Terminal polls observe an existing command, not a fresh command admission. */
export class PluginTerminalHooks {
  private readonly commands = new Map<string, { input: unknown; toolCallId: string }>();
  forTurn(sessionId: string, run: RunHook): ToolExecutionHooks {
    const transport = new Set(['terminal_poll', 'terminal_write', 'terminal_stop']);
    return {
      before: context => transport.has(context.toolCall.name) ? Promise.resolve({ messages: [] })
        : run('PreToolUse', { signal: context.signal, toolName: context.toolCall.name, toolCallId: context.toolCall.id, input: context.input }),
      permission: context => run('PermissionRequest', { signal: context.signal, toolName: context.toolCall.name, toolCallId: context.toolCall.id, input: { ...object(context.input), description: context.reason } }),
      after: async context => {
        let name = context.toolCall.name, input = context.input, toolCallId = context.toolCall.id;
        const output = context.outcome.kind === 'returned' ? object(context.outcome.result) : {};
        if (name === 'terminal_exec' || transport.has(name)) {
          const terminalId = String(output.terminalSessionId || object(input).session_id || '');
          const key = JSON.stringify([sessionId, terminalId]);
          if (name === 'terminal_exec' && output.state === 'running') { this.commands.set(key, { input, toolCallId }); return { messages: [] }; }
          if (transport.has(name)) {
            const command = this.commands.get(key);
            if (!command || output.state === 'running' || context.outcome.kind !== 'returned') return { messages: [] };
            this.commands.delete(key); name = 'terminal_exec'; input = command.input; toolCallId = command.toolCallId;
          }
        }
        return run(context.outcome.kind === 'returned' ? 'PostToolUse' : 'PostToolUseFailure', { signal: context.signal, toolName: name, toolCallId, input,
          ...(context.outcome.kind === 'returned' ? { output: context.outcome.result } : { error: context.outcome.error.message }) });
      },
    };
  }
  closeSession(sessionId: string) { for (const key of this.commands.keys()) if (JSON.parse(key)[0] === sessionId) this.commands.delete(key); }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
