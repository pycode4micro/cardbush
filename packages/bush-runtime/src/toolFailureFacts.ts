import type { ToolExecutionFacts } from '@cardbush/bush-protocol';

type FailureFacts = Pick<ToolExecutionFacts, 'effects' | 'result'> & {
  dispatch?: 'not_started';
  recovery?: ToolExecutionFacts['recovery'];
};
const failures = new WeakMap<Error, Readonly<FailureFacts>>();

/** Executor-owned facts, never inferred from error text or deserialized tool data. */
export function withToolFailureFacts<T extends Error>(error: T, facts: FailureFacts): T {
  failures.set(error, Object.freeze({ ...facts }));
  return error;
}

export function toolFailureFacts(error: unknown): Readonly<FailureFacts> | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}
