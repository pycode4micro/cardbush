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

export const executionFactSchema = z.object({
  protocol: z.literal(BUSH_EXECUTION_FACT_PROTOCOL),
  receipt_id: z.string().min(1),
  action_manifest_id: z.string().min(1),
  status: z.string().min(1),
  operation: z.string().min(1),
  effect_kind: z.string().min(1),
  owner: z.string().min(1),
  dispatch_scope: z.string().min(1),
  categories: z.array(z.string()),
  paths: z.array(z.string()),
  execution_success: z.boolean(),
  semantic_success: z.boolean(),
  verification_state: z.enum(["verified", "attempted", "unverified", "failed"]),
  error_code: z.string(),
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
      code: z.string().min(1),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
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
