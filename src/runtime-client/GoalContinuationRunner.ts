import {
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  type GoalState,
  type RuntimeEvent,
  type RuntimeSessionTurnRequest,
} from '@cardbush/bush-protocol';

import type { ProtocolRuntimeClient } from './ProtocolRuntimeClient';

type RuntimeTerminalEvent = Extract<RuntimeEvent, { kind: 'turn_terminal' }>;

export interface GoalContinuationRunInput {
  goalId: string;
  objective: string;
  initialTurn: RuntimeSessionTurnRequest;
  continuationPrompt: string;
  tokenBudget?: number;
}

export interface GoalContinuationTurnResult {
  request: RuntimeSessionTurnRequest;
  terminal: RuntimeTerminalEvent;
  goal: GoalState;
}

export interface GoalContinuationResult {
  goal: GoalState;
  turns: GoalContinuationTurnResult[];
}

export interface GoalContinuationRunnerOptions {
  client: Pick<ProtocolRuntimeClient, 'createGoal' | 'getGoal'>;
  runTurn: (
    request: RuntimeSessionTurnRequest,
    signal?: AbortSignal,
  ) => Promise<RuntimeTerminalEvent>;
  createId?: (kind: 'request' | 'turn' | 'message') => string;
}

/**
 * Runs one ordinary Session Turn at a time. Goal meaning is declared by the
 * model through update_goal; this runner only observes the typed Goal status.
 */
export class GoalContinuationRunner {
  readonly #client: GoalContinuationRunnerOptions['client'];
  readonly #runTurn: GoalContinuationRunnerOptions['runTurn'];
  readonly #createId: NonNullable<GoalContinuationRunnerOptions['createId']>;

  constructor(options: GoalContinuationRunnerOptions) {
    this.#client = options.client;
    this.#runTurn = options.runTurn;
    this.#createId = options.createId ?? ((kind) => `${kind}_${crypto.randomUUID()}`);
  }

  async run(
    input: GoalContinuationRunInput,
    options: {
      signal?: AbortSignal;
      onTurnCompleted?: (result: GoalContinuationTurnResult) => void | Promise<void>;
    } = {},
  ): Promise<GoalContinuationResult> {
    const continuationPrompt = input.continuationPrompt.trim();
    if (!continuationPrompt) throw new Error('Goal continuationPrompt is required.');
    let goal = await this.#client.createGoal({
      goalId: input.goalId,
      sessionId: input.initialTurn.sessionId,
      objective: input.objective,
      ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
    }, options.signal);
    const turns: GoalContinuationTurnResult[] = [];
    let request = input.initialTurn;

    while (true) {
      if (options.signal?.aborted) throw abortError();
      const terminal = await this.#runTurn(request, options.signal);
      const current = await this.#client.getGoal(request.sessionId, options.signal);
      if (!current || current.goalId !== goal.goalId) {
        throw new Error(`Goal ${goal.goalId} is no longer the current Session Goal.`);
      }
      goal = current;
      const result = { request, terminal, goal } satisfies GoalContinuationTurnResult;
      turns.push(result);
      await options.onTurnCompleted?.(result);

      if (goal.status !== 'active' || terminal.payload.status !== 'completed') {
        return { goal, turns };
      }
      request = continuationRequest(request, continuationPrompt, this.#createId);
    }
  }
}

function continuationRequest(
  previous: RuntimeSessionTurnRequest,
  prompt: string,
  createId: NonNullable<GoalContinuationRunnerOptions['createId']>,
): RuntimeSessionTurnRequest {
  return {
    ...previous,
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId: createId('request'),
    turnId: createId('turn'),
    inputMessages: [{
      messageId: createId('message'),
      message: { role: 'user', content: prompt },
    }],
  };
}

function abortError(): Error {
  const error = new Error('Goal continuation was cancelled.');
  error.name = 'AbortError';
  return error;
}
