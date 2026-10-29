import type { ToolRegistry, ToolHandlerContext } from "./toolRegistry.js";
import { solutionSelectionInputSchema, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { RuntimeSolutionBroker } from './runtimeSolutionBroker.js';
import type { RuntimeAsyncJobs } from './runtimeAsyncJobs.js';

const questionProperties = {
  prompt: { type: 'string', minLength: 1, maxLength: 500, description: 'One self-contained question.' },
  options: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Concrete suggested answers. Free text is always available.' },
};
// One public question shape; the broker owns normalization and answer delivery.
const solutionToolInputSchema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: { type: 'array', minItems: 1, maxItems: 3,
      description: 'Prefer one question; group up to three related questions when needed. Answers are submitted together. Do not also provide prompt/options.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'prompt', 'options'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 80, description: 'Unique stable question ID.' }, ...questionProperties } } },
  },
};

export function registerAsyncInteraction(registry: ToolRegistry, solutions: RuntimeSolutionBroker, jobs: RuntimeAsyncJobs,
  onParentQuestion?: (context: ToolHandlerContext<unknown>, request: import('@cardbush/bush-protocol').RuntimeSolutionSelection) => void) {
  registry.register<SolutionSelectionInput>({
    definition: { name: 'request_user_input_async', description: 'Ask necessary, self-contained questions and immediately continue independent work. Prefer one; group at most three related questions in questions, each with a unique id, prompt and 1–3 concise options. The UI permits free text and submits all answers together. Returns a task_id; the actual answers arrive separately. Do not start steps that depend on the answers, infer approval from elapsed time, repeat a dismissed question, or use this for permissions or progress updates.', inputSchema: solutionToolInputSchema },
    manifest: interactionManifest('solution.request_async'), nestedCallable: false, visibleToChild: false,
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'questions') || !Array.isArray(input.questions)) throw new Error('Use questions with id, prompt and options.');
      return solutionSelectionInputSchema.parse(input);
    },
    authorize: context => context.turn?.request.requestCapabilities.interactiveRequests === true && context.turn.request.metadata.agentRole !== 'child'
      ? { kind: 'allow' } : { kind: 'deny', code: 'solution_selection_unavailable', message: 'A user-facing parent session is required.' },
    execute: context => {
      if (solutions.list(context.sessionId).length) throw new Error('A question is already pending. Continue independent work and wait for its actual answer.');
      return jobs.start(context, 'question', signal => solutions.start({ requestId: context.requestId, sessionId: context.sessionId, turnId: context.turnId }, context.toolCall.id, context.input, signal).result);
    },
  });
  registry.register<{ text: string }>({
    definition: { name: 'ask_parent', description: 'Ask your parent Agent one necessary question in plain words and wait for its answer. Use only when delegated as a child. This does not request or grant permissions, contact siblings, or start another task.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 500 } } } },
    manifest: interactionManifest('parent.question'), visibleToChild: true, nestedCallable: false,
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || Object.keys(input).some(key => key !== 'text') || typeof input.text !== 'string') throw new Error('Provide one question as text.');
      const result = solutionSelectionInputSchema.parse({ prompt: input.text, options: [] });
      return { text: result.prompt! };
    },
    authorize: context => context.turn?.request.metadata.agentRole === 'child' && typeof context.turn.request.metadata.parentSessionId === 'string'
      ? { kind: 'allow' } : { kind: 'deny', code: 'parent_unavailable', message: 'Only an owned child task can ask its parent.' },
    execute: context => {
      const pending = solutions.start({ requestId: context.requestId, sessionId: context.sessionId, turnId: context.turnId },
        context.toolCall.id, { prompt: context.input.text, options: [] }, context.signal, true);
      onParentQuestion?.(context, pending.request);
      return pending.result;
    },
  });
}

function interactionManifest(operation: string) {
  return {
    effect_kind: "interaction", operation, risk: "user_decision", owner: "runtime_interaction",
    dispatch_scope: "session", mutating: false,
  };
}
