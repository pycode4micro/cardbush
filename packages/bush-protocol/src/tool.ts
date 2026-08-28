import { z } from "zod";

export const BUSH_TOOL_CALL_PROTOCOL = "bush.tool_call.v1" as const;
export const BUSH_TOOL_RESULT_PROTOCOL = "bush.tool_result.v1" as const;
export const BUSH_EXECUTION_FACT_PROTOCOL = "bush.tool.execution_fact.v1" as const;

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

export const toolResultSchema = z.object({
  protocol: z.literal(BUSH_TOOL_RESULT_PROTOCOL),
  tool_call_id: z.string().min(1),
  success: z.boolean(),
  output: z.unknown(),
  facts: z.array(executionFactSchema).default([]),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;
