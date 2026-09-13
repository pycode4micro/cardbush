import type { ToolRegistry } from "./toolRegistry.js";
import { SOLUTION_SELECTION_TOOL, solutionSelectionInputSchema, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { RuntimeSolutionBroker } from './runtimeSolutionBroker.js';

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
      definition: {
        name: SOLUTION_SELECTION_TOOL,
        description: 'Solution Selection — offer solutions for a blocking, consequential ambiguity. Use only when the user intent or an essential fact remains insufficient after inspecting available context and trying available ways to resolve it yourself, and choosing without the user could cause a materially wrong direction or an uncontrolled error. This is a last-resort solution offering tool, not a general interaction or question tool. Exercise judgment and proceed autonomously for routine implementation, reversible choices and optional preferences. Never use it for teaching, surveys, progress updates, permission requests, reconfirming existing authorization, or asking whether to start/continue. Identify one actual unresolved direction and offer 1–3 concrete solutions, not open-ended exploration. Keep the prompt and each option to at most 15 characters (aim for 10–15); use plain text strings. You may append 推荐 or Recommended as ordinary option text within that limit; there is no recommendation flag. Do not add an Other option: a free-text reply is always provided by the UI. Wait for the actual reply before dependent work. Dismissal is not consent: do not choose a default or repeat the same request; state the unresolved dependency and continue only independent work.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['prompt', 'options'], properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 15, description: 'One short, concrete unresolved decision, in the user’s language.' },
          options: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 15 }, description: 'Concrete solution text only. No IDs, descriptions, objects or recommendation metadata.' },
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
