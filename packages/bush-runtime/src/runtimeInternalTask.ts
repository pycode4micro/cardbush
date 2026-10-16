import type { ModelRequest, RuntimeEvent, SessionUsage } from '@cardbush/bush-protocol';
import type { RuntimeExecutionOptions } from './runtimeTurnExecution.js';

export interface RuntimeInternalTaskOptions extends RuntimeExecutionOptions {
  signal?: AbortSignal;
  /** Validate and commit domain data before the Runtime publishes completion. */
  acceptResult: (text: string, signal: AbortSignal) => Promise<void>;
}

export type RuntimeInternalTaskRunner = (request: ModelRequest, options: RuntimeInternalTaskOptions) => Promise<{
  terminal: Extract<RuntimeEvent, { kind: 'turn_terminal' }>;
  usage: SessionUsage;
}>;
