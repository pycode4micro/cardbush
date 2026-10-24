import { replacedToolPresentation } from './toolPresentation.js';
import type { ToolRegistry } from "./toolRegistry.js";
import { SOLUTION_SELECTION_TOOL, solutionSelectionInputSchema, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { RuntimeSolutionBroker } from './runtimeSolutionBroker.js';
import type { RuntimeAsyncJobs } from './runtimeAsyncJobs.js';

const questionProperties = {
  prompt: { type: 'string', minLength: 1, maxLength: 500, description: 'One self-contained question.' },
  options: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Concrete suggested answers. Free text is always available.' },
};
// A fixed object schema for both entry points; conditional validation stays in the decoder.
const solutionToolInputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    questions: { type: 'array', minItems: 1, maxItems: 3,
      description: 'Prefer one question; group up to three related questions when needed. Answers are submitted together. Do not also provide prompt/options.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'prompt', 'options'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 80, description: 'Unique stable question ID.' }, ...questionProperties } } },
    ...questionProperties,
  },
};

export function registerAsyncInteraction(registry: ToolRegistry, solutions: RuntimeSolutionBroker, jobs: RuntimeAsyncJobs) {
  registry.register<SolutionSelectionInput>({
    definition: { name: 'request_user_input_async', description: 'Ask necessary, self-contained questions and immediately continue independent work. Prefer one; group at most three related questions in questions, each with a unique id, prompt and 1–3 concise options. Legacy prompt/options still accepts one question. The UI permits free text and submits all answers together. Returns a task_id; the actual answers arrive separately. Do not start steps that depend on the answers, infer approval from elapsed time, repeat a dismissed question, or use this for permissions or progress updates.', inputSchema: solutionToolInputSchema },
    manifest: interactionManifest('solution.request_async'), nestedCallable: false, visibleToChild: false,
    decodeInput: value => solutionSelectionInputSchema.parse(value),
    authorize: context => context.turn?.request.requestCapabilities.interactiveRequests === true && context.turn.request.metadata.agentRole !== 'child'
      ? { kind: 'allow' } : { kind: 'deny', code: 'solution_selection_unavailable', message: 'A user-facing parent session is required.' },
    execute: context => {
      if (solutions.list(context.sessionId).length) throw new Error('A question is already pending. Continue independent work and wait for its actual answer.');
      return jobs.start(context, 'question', signal => solutions.start({ requestId: context.requestId, sessionId: context.sessionId, turnId: context.turnId }, context.toolCall.id, context.input, signal).result);
    },
  });
}

export const REQUEST_PERMISSION_TOOL = "request_permission" as const;

export function registerInteractionTools(
  registry: ToolRegistry,
  solutions?: RuntimeSolutionBroker,
): void {
  if (!registry.resolve(REQUEST_PERMISSION_TOOL)) {
    registry.register<{
      reason: string;
      actions: string[];
      resources: string[];
      targets: Array<{
        kind: "filesystem_path" | "opaque";
        value: string;
      }>;
      capabilityIds: string[];
    }>({
      definition: {
        name: REQUEST_PERMISSION_TOOL,
        description: "Legacy compatibility only. This tool cannot grant permission to another invocation. Call the concrete file, terminal or external tool with its exact arguments; Runtime requests approval when needed. Never use this tool to pre-approve or repeat a pending permission request.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            path: { type: "string" },
            access_kind: { enum: ["read", "write", "execute"] },
            reason: { type: "string" },
            operation: { type: "string" },
            actions: { type: "array", items: { type: "string" }, minItems: 1 },
            resources: { type: "array", items: { type: "string" }, minItems: 1 },
            capability_ids: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
      },
      manifest: interactionManifest("permission.request"),
      projectModelDefinition: () => null,
      visibleToChild: true,
      decodeInput: (value) => {
        const item = record(value);
        const path = text(item.path);
        const reason = text(item.reason);
        const accessKind = text(item.access_kind);
        const actions = stringArray(item.actions);
        const resources = stringArray(item.resources);
        const capabilityIds = stringArray(item.capability_ids);
        if (!reason) throw new Error("reason is required.");
        if (path && !["read", "write", "execute"].includes(accessKind)) {
          throw new Error("access_kind must be read, write, or execute when path is used.");
        }
        const normalizedActions = actions.length ? actions : [text(item.operation) || accessKind];
        const normalizedResources = resources.length ? resources : [path];
        const normalizedCapabilities = capabilityIds.length
          ? capabilityIds
          : [`${accessKind}:${path}`];
        if (
          normalizedActions.some((item) => !item) ||
          normalizedResources.some((item) => !item) ||
          normalizedCapabilities.some((item) => !item)
        ) throw new Error("Provide either path/access_kind or non-empty actions/resources/capability_ids.");
        return {
          reason,
          actions: normalizedActions,
          resources: normalizedResources,
          targets: path
            ? [{ kind: "filesystem_path" as const, value: path }]
            : normalizedResources.map((value) => ({ kind: "opaque" as const, value })),
          capabilityIds: normalizedCapabilities,
        };
      },
      // Approval must bind the actual invocation and its canonical scope. An
      // allow_once on this generic tool used to be consumed here, while claiming
      // that a later operation had been authorized. Old frozen catalogs can
      // still call this handler, but it never opens a prompt or grants access.
      execute: (context) => ({
        granted: false,
        actions: context.input.actions,
        resources: context.input.resources,
        capability_ids: [],
        message: "No permission was granted. Invoke the concrete operation with its exact arguments; Runtime will request approval if needed. If that operation is already waiting for approval, wait for its result instead of starting another request. A rejected action must not be retried indirectly.",
      }),
    });
  }

  if (solutions && !registry.resolve(SOLUTION_SELECTION_TOOL)) {
    registry.register<SolutionSelectionInput>({
      projectModelDefinition: replacedToolPresentation('request_user_input_async'),
      definition: {
        name: SOLUTION_SELECTION_TOOL,
        description: 'Solution Selection — a last resort for consequential ambiguity that remains after inspecting context and available tools, where guessing risks a materially wrong outcome. Prefer one question; group at most three related questions with unique IDs in questions, or use legacy prompt/options for a single question. Offer concrete solutions, not teaching, surveys, progress updates, routine preferences, permission requests or reconfirmation of authorized work. Wait for all answers before dependent work. If dismissed, report the unresolved dependency; do not pick a default or repeat the request.',
        inputSchema: solutionToolInputSchema,
      },
      manifest: interactionManifest('solution.select'),
      visibleToChild: true,
      decodeInput: input => solutionSelectionInputSchema.parse(input),
      authorize: context => context.turn?.request.requestCapabilities.interactiveRequests === true && context.turn.request.metadata.agentRole !== 'child'
        ? { kind: 'allow' } : { kind: 'deny', code: 'solution_selection_unavailable',
          message: 'Solution Selection requires a user-facing parent session. Continue independently or report the unresolved dependency to the parent.' },
      execute: context => solutions.request({ requestId: context.requestId, sessionId: context.sessionId, turnId: context.turnId },
        context.toolCall.id, context.input, context.signal),
    });
  }
}

function interactionManifest(operation: string) {
  return {
    effect_kind: "interaction", operation, risk: "user_decision", owner: "runtime_interaction",
    dispatch_scope: "session", mutating: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return String(value ?? "").trim(); }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
