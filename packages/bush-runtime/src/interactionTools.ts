import type { ToolRegistry } from "./toolRegistry.js";

export const REQUEST_PERMISSION_TOOL = "request_permission" as const;

export function registerInteractionTools(
  registry: ToolRegistry,
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
