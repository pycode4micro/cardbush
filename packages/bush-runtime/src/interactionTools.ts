import { replacedToolPresentation } from './toolPresentation.js';
import type { ToolRegistry } from "./toolRegistry.js";
import { SOLUTION_SELECTION_TOOL, solutionSelectionInputSchema, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { RuntimeSolutionBroker } from './runtimeSolutionBroker.js';
import type { RuntimeAsyncJobs } from './runtimeAsyncJobs.js';

export function registerAsyncInteraction(registry: ToolRegistry, solutions: RuntimeSolutionBroker, jobs: RuntimeAsyncJobs) {
  registry.register<SolutionSelectionInput>({
    definition: { name: 'request_user_input_async', description: 'Ask one necessary, self-contained question and immediately continue independent work. Provide 1–3 concise suggested answers; the UI also permits free text. Returns a task_id; the actual answer arrives separately. Do not start steps that depend on the answer, infer approval from elapsed time, repeat a dismissed question, or use this for permissions or progress updates.', inputSchema: {
      type: 'object', additionalProperties: false, required: ['prompt', 'options'], properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 500 }, options: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    } },
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
        description: "Ask the user to grant exact action/resource capabilities. A grant does not execute the blocked operation; retry it afterward.",
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
      authorize: (context) => ({
        kind: "ask",
        request: {
          reason: context.input.reason,
          actions: context.input.actions,
          targets: context.input.targets,
          capabilityIds: context.input.capabilityIds,
        },
      }),
      execute: (context) => ({
        granted: true,
        actions: context.input.actions,
        resources: context.input.resources,
        capability_ids: context.capabilityIds,
        message: "Permission granted. Retry the blocked operation.",
      }),
    });
  }

  if (solutions && !registry.resolve(SOLUTION_SELECTION_TOOL)) {
    registry.register<SolutionSelectionInput>({
      projectModelDefinition: replacedToolPresentation('request_user_input_async'),
      definition: {
        name: SOLUTION_SELECTION_TOOL,
        description: 'Solution Selection — a last resort for one consequential ambiguity that remains after inspecting context and available tools, where guessing risks a materially wrong outcome. Offer concrete solutions, not teaching, surveys, progress updates, routine preferences, permission requests or reconfirmation of authorized work. Wait for the actual reply before dependent work. If dismissed, report the unresolved dependency; do not pick a default or repeat the request.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['prompt', 'options'], properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 500, description: 'One concrete unresolved decision, with enough context to answer.' },
          options: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 120 }, description: '1–3 concrete solution strings. Omit Other; the UI already allows free-text replies.' },
        } },
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
