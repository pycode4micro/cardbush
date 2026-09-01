import { z } from "zod";

export const BUSH_TOOL_CALL_PROTOCOL = "bush.tool_call.v1" as const;
export const BUSH_TOOL_RESULT_PROTOCOL = "bush.tool_result.v1" as const;
export const BUSH_ACTION_MANIFEST_PROTOCOL =
  "bush.tool.action_manifest.v1" as const;
export const BUSH_EXECUTION_FACT_PROTOCOL = "bush.tool.execution_fact.v1" as const;
export const BUSH_TOOL_EXECUTION_RECORD_PROTOCOL =
  "bush.tool.execution_record.v1" as const;
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
  dispatch_phase: z.string().min(1),
  dispatch_scope: z.string().min(1),
  dispatch_side_effect: z.string().min(1),
  dispatch_mutating: z.boolean(),
  dispatch_source: z.string(),
  stage_modes: z.array(z.string()),
  output_kinds: z.array(z.string()),
  handoff_exports: z.array(z.string()),
  evidence_hints: z.array(z.string()),
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

const executionFactStatusSchema = z.enum([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "stopped",
  "not_run",
  "submitted",
  "running",
]);

export const toolErrorKindSchema = z.enum([
  "tool",
  "protocol",
  "transport",
  "permission",
  "cancelled",
  "runtime",
]);

export type ToolErrorKind = z.infer<typeof toolErrorKindSchema>;

export const executionFactSchema = z.object({
  protocol: z.literal(BUSH_EXECUTION_FACT_PROTOCOL),
  receipt_id: z.string().min(1),
  action_manifest_id: z.string().min(1),
  status: executionFactStatusSchema,
  operation: z.string().min(1),
  effect_kind: z.string().min(1),
  owner: z.string().min(1),
  dispatch_scope: z.string().min(1),
  categories: z.array(z.string()),
  paths: z.array(z.string()),
  execution_success: z.boolean(),
  semantic_success: z.boolean().nullable(),
  verification_state: z.enum(["verified", "attempted", "unverified", "failed"]),
  error_code: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).superRefine((fact, context) => {
  if (fact.semantic_success === true && !fact.execution_success) {
    context.addIssue({
      code: "custom",
      path: ["semantic_success"],
      message: "A semantic success requires a successful execution.",
    });
  }
  if (fact.verification_state === "verified" && fact.semantic_success !== true) {
    context.addIssue({
      code: "custom",
      path: ["verification_state"],
      message: "A verified fact must explicitly report semantic success.",
    });
  }
  if (fact.verification_state === "failed" && fact.semantic_success === true) {
    context.addIssue({
      code: "custom",
      path: ["verification_state"],
      message: "A failed verification cannot report semantic success.",
    });
  }
  if (fact.error_code && fact.semantic_success === true) {
    context.addIssue({
      code: "custom",
      path: ["error_code"],
      message: "A semantically successful fact cannot carry an error code.",
    });
  }
  if (fact.status === "failed" && fact.semantic_success !== false) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "A failed fact must explicitly report semantic failure.",
    });
  }
  if (
    (fact.status === "completed" || fact.status === "succeeded") &&
    !fact.execution_success
  ) {
    context.addIssue({
      code: "custom",
      path: ["execution_success"],
      message: `${fact.status} requires a successful execution.`,
    });
  }
  if (
    (fact.status === "cancelled" || fact.status === "stopped" || fact.status === "not_run") &&
    fact.semantic_success === true
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: `${fact.status} cannot report semantic success.`,
    });
  }
});

export type ExecutionFact = z.infer<typeof executionFactSchema>;

export const artifactSchema = z
  .object({
    artifact_id: z.string().min(1),
    type: z.string().min(1),
    uri: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
    display: z.enum(["inline", "attachment", "hidden"]).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((artifact) => artifact.uri !== undefined || artifact.path !== undefined, {
    message: "artifact requires uri or path",
  });

export type Artifact = z.infer<typeof artifactSchema>;

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

export const toolResultSchema = z.object({
  protocol: z.literal(BUSH_TOOL_RESULT_PROTOCOL),
  tool_call_id: z.string().min(1),
  success: z.boolean(),
  output: z.unknown(),
  facts: z.array(executionFactSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  workspace_changes: z.array(workspaceChangeSchema).default([]),
  guidance: z
    .array(
      z.object({
        role: z.literal("user"),
        content: z.string(),
        name: z.string().min(1).optional(),
      }),
    )
    .default([]),
  error: z
    .object({
      kind: toolErrorKindSchema.default("tool"),
      code: z.string().min(1),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
}).superRefine((result, context) => {
  if (result.success && result.error) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "A successful Tool result cannot contain an error.",
    });
  }
  if (!result.success && !result.error) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "A failed Tool result must contain a structured error.",
    });
  }
  if (
    result.success &&
    result.facts.some((fact) =>
      !fact.execution_success || fact.semantic_success === false
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["facts"],
      message: "A successful Tool result cannot contain a failed execution or semantic failure fact.",
    });
  }
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export const toolExecutionIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
});

export const turnToolExecutionsIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export const toolExecutionRecordSchema = z.object({
  protocol: z.literal(BUSH_TOOL_EXECUTION_RECORD_PROTOCOL),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  round: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  recordedAt: z.string().min(1),
  toolCall: toolCallSchema,
  outcome: z.enum(["completed", "failed", "cancelled"]),
  actionManifest: actionManifestSchema.optional(),
  result: toolResultSchema,
});

export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
