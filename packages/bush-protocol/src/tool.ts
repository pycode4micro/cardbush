import { z } from "zod";

export const BUSH_TOOL_CALL_PROTOCOL = "bush.tool_call.v1" as const;
export const BUSH_ACTION_MANIFEST_PROTOCOL =
  "bush.tool.action_manifest.v1" as const;
export const BUSH_TOOL_EXECUTION_RECORD_PROTOCOL =
  "bush.tool.execution_record.v2" as const;
export const BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL =
  "bush.tool_execution_summary.v1" as const;
export const GET_RUNTIME_TOOL_EXECUTION_COMMAND =
  "runtime.get_tool_execution" as const;
export const LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND =
  "runtime.list_turn_tool_executions" as const;
export const GET_RUNTIME_TOOL_CATALOG_COMMAND = "runtime.get_tool_catalog" as const;
export const GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND =
  "runtime.get_tool_catalog_details" as const;
export const REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND =
  "runtime.revert_workspace_changes" as const;
export const RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY =
  "revertedWorkspaceChangeIds" as const;
export const RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND =
  "runtime.record_logic_feedback" as const;

export const runtimeLogicFeedbackRequestSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  rating: z.enum(["up", "down"]).nullable(),
});

export const runtimeLogicFeedbackResultSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  rating: z.enum(["up", "down"]).nullable(),
  associatedLogicIds: z.array(z.string()),
  updatedLogicIds: z.array(z.string()),
  missingLogicIds: z.array(z.string()),
});

export type RuntimeLogicFeedbackRequest = z.infer<typeof runtimeLogicFeedbackRequestSchema>;
export type RuntimeLogicFeedbackResult = z.infer<typeof runtimeLogicFeedbackResultSchema>;

export const revertRuntimeWorkspaceChangesSchema = z.object({
  sessionId: z.string().min(1),
  turnIds: z.array(z.string().min(1)).min(1),
});

export const revertRuntimeWorkspaceChangesResultSchema = z.object({
  sessionId: z.string().min(1),
  turnIds: z.array(z.string().min(1)).min(1),
  revertedFiles: z.number().int().nonnegative(),
  revertedChangeIds: z.array(z.string().min(1)),
  revertedAt: z.string().min(1),
});

export type RevertRuntimeWorkspaceChangesResult = z.infer<
  typeof revertRuntimeWorkspaceChangesResultSchema
>;

export const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  inputSchema: z.record(z.string(), z.unknown()),
});

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolCallSchema = z.object({
  protocol: z.literal(BUSH_TOOL_CALL_PROTOCOL),
  id: z.string().min(1),
  name: z.string().min(1),
  argumentsText: z.string(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export const actionManifestSchema = z.object({
  protocol: z.literal(BUSH_ACTION_MANIFEST_PROTOCOL),
  manifest_id: z.string().min(1),
  effect_kind: z.string().min(1),
  operation: z.string().min(1),
  risk: z.string(),
  owner: z.string().min(1),
  dispatch_scope: z.string().min(1),
  mutating: z.boolean(),
});

export type ActionManifest = z.infer<typeof actionManifestSchema>;

export const actionManifestTemplateSchema = actionManifestSchema.omit({
  protocol: true,
  manifest_id: true,
});

export type ActionManifestTemplate = z.infer<
  typeof actionManifestTemplateSchema
>;

export const toolCatalogEntrySchema = z.object({
  definition: toolDefinitionSchema,
  manifest: actionManifestTemplateSchema,
  parallelSafe: z.boolean(),
  executionChannel: z.string().min(1).optional(),
  visibleToChild: z.boolean(),
  registrationOwner: z.string().min(1).optional(),
});

export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>;

export const toolErrorKindSchema = z.enum([
  "tool",
  "protocol",
  "transport",
  "permission",
  "cancelled",
  "runtime",
]);

export type ToolErrorKind = z.infer<typeof toolErrorKindSchema>;

export const workspaceChangeSchema = z.object({
  change_id: z.string().min(1),
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  previous_path: z.string().min(1).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  before_hash: z.string().min(1).optional(),
  after_hash: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;

/**
 * Lossless identity and counters needed by transcript change summaries. Large
 * evidence such as a unified diff remains on the canonical Workspace Change
 * and is read through the full execution/review path when requested.
 */
export const workspaceChangeSummarySchema = workspaceChangeSchema
  .omit({ metadata: true })
  .extend({ detailAvailable: z.boolean() });

export type WorkspaceChangeSummary = z.infer<
  typeof workspaceChangeSummarySchema
>;

export const toolExecutionIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
});

export const turnToolExecutionsIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export const turnToolExecutionsRequestSchema = turnToolExecutionsIdentitySchema.extend({
  detail: z.enum(["full", "summary"]).default("full"),
});

export const runtimeToolErrorSchema = z.object({
  kind: toolErrorKindSchema.default("tool"),
  code: z.string().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type RuntimeToolError = z.infer<typeof runtimeToolErrorSchema>;

export const toolExecutionRecordSchema = z.object({
  protocol: z.literal(BUSH_TOOL_EXECUTION_RECORD_PROTOCOL),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  round: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  recordedAt: z.string().min(1),
  toolCall: toolCallSchema,
  outcome: z.enum(["returned", "failed", "cancelled"]),
  actionManifest: actionManifestSchema.optional(),
  result: z.unknown().optional(),
  workspaceChanges: z.array(workspaceChangeSchema).default([]),
  error: runtimeToolErrorSchema.optional(),
}).superRefine((record, context) => {
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  if (record.outcome === "returned" && (!hasResult || record.result === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "A returned Tool execution requires a native result.",
    });
  }
  if (record.outcome !== "returned" && hasResult) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "A failed or cancelled Tool execution cannot contain a native result.",
    });
  }
  if (record.outcome === "returned" && record.error) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "A returned Tool execution cannot contain a Runtime error.",
    });
  }
  if (record.outcome !== "returned" && !record.error) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "A failed or cancelled Tool execution requires a Runtime error.",
    });
  }
});

/**
 * Read projection used by transcript summaries. The append-only execution
 * record remains native and lossless; large arguments/results are fetched by
 * identity only when the user opens execution details.
 */
export const toolExecutionSummarySchema = z.object({
  protocol: z.literal(BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  round: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  recordedAt: z.string().min(1),
  toolCall: toolCallSchema.pick({ protocol: true, id: true, name: true }),
  outcome: z.enum(["returned", "failed", "cancelled"]),
  actionManifest: actionManifestSchema.optional(),
  resultAvailable: z.boolean(),
  workspaceChanges: z.array(workspaceChangeSummarySchema).default([]),
  error: runtimeToolErrorSchema.optional(),
});

export type ToolExecutionSummary = z.infer<typeof toolExecutionSummarySchema>;

export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
