import type { RuntimeInteractionStore } from "./runtimeInteractionStore.js";
import type { ToolRegistry } from "./toolRegistry.js";

export const REQUEST_PERMISSION_TOOL = "request_permission" as const;
export const REQUEST_USER_CHOICE_TOOL = "request_user_choice" as const;

export function registerInteractionTools(
  registry: ToolRegistry,
  interactions: RuntimeInteractionStore,
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

  if (!registry.resolve(REQUEST_USER_CHOICE_TOOL)) {
    registry.register<Record<string, unknown>>({
      definition: {
        name: REQUEST_USER_CHOICE_TOOL,
        description: "Ask at most three structured questions only when the user explicitly enabled generic interactive choices. Never use for resource permissions.",
        inputSchema: userChoiceInputSchema(),
      },
      manifest: interactionManifest("interaction.user_choice"),
      visibleToChild: true,
      decodeInput: (value) => record(value),
      authorize: (context) => {
        if (context.turn?.request.requestCapabilities.userChoice === true) return { kind: "allow" };
        return {
          kind: "deny",
          code: "user_choice_disabled",
          message: "Generic user choice requests are disabled for this Turn.",
        };
      },
      execute: async (context) => {
        const input = context.input;
        const answer = await interactions.request({
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCall.id,
          title: text(input.title),
          description: text(input.description),
          reason: text(input.reason),
          questions: normalizeQuestions(input.questions),
          submitLabel: text(input.submit_label) || "Submit",
          cancelLabel: text(input.cancel_label) || "Cancel",
          timeoutMinutes: integer(input.timeout_minutes) || 10,
        }, context.signal);
        return answer;
      },
    });
  }
}

function userChoiceInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "questions"],
    properties: {
      title: { type: "string" }, description: { type: "string" }, reason: { type: "string" },
      submit_label: { type: "string" }, cancel_label: { type: "string" },
      timeout_minutes: { type: "integer", minimum: 1, maximum: 1440 },
      questions: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object", additionalProperties: false,
          required: ["id", "label", "question"],
          properties: {
            id: { type: "string" }, label: { type: "string" }, question: { type: "string" },
            selection_mode: { enum: ["single", "multiple", "input"] },
            need_input: { type: "boolean" }, required: { type: "boolean" },
            options: { type: "array", maxItems: 7, items: { type: "object" } },
          },
        },
      },
    },
  };
}

function normalizeQuestions(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new Error("questions must contain 1 to 3 items.");
  }
  return value.map((candidate) => {
    const item = record(candidate);
    const mode = text(item.selection_mode) || "single";
    return {
      id: text(item.id), label: text(item.label), question: text(item.question),
      selectionMode: mode as "single" | "multiple" | "input",
      needInput: item.need_input === true || mode === "input",
      required: item.required !== false,
      options: Array.isArray(item.options) ? item.options.map((option) => {
        const data = record(option);
        return { id: text(data.id), label: text(data.label), ...(text(data.description) ? { description: text(data.description) } : {}) };
      }) : [],
    };
  });
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
function integer(value: unknown): number { const n = Number(value); return Number.isInteger(n) ? n : 0; }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
