import { z } from "zod";
import { actionManifestTemplateSchema } from "./tool.js";

export const BUSH_MCP_SNAPSHOT_PROTOCOL = "bush.mcp_snapshot.v2" as const;
export const BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL =
  "bush.mcp_snapshot_result.v1" as const;
export const APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND =
  "runtime.apply_mcp_snapshot" as const;
export const GET_RUNTIME_MCP_SNAPSHOT_COMMAND =
  "runtime.get_mcp_snapshot" as const;

const stringMapSchema = z.record(z.string(), z.string());

const mcpStdioTransportSchema = z.object({
  kind: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: stringMapSchema.default({}),
});

const mcpHttpTransportSchema = z.object({
  kind: z.enum(["streamable_http", "sse"]),
  url: z.string().url(),
  headers: stringMapSchema.default({}),
});

export const mcpTransportConfigSchema = z.discriminatedUnion("kind", [
  mcpStdioTransportSchema,
  mcpHttpTransportSchema,
]);

export const mcpToolPolicySchema = z.object({
  permission: z.enum(["allow", "ask"]).default("ask"),
  parallelSafe: z.boolean().default(false),
  visibleToChild: z.boolean().default(true),
  actionManifest: actionManifestTemplateSchema.optional(),
});

export const mcpServerSnapshotSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  transport: mcpTransportConfigSchema,
  versionMode: z.enum(["auto", "legacy", "modern"]).default("auto"),
  restartBackoffMs: z.number().int().min(0).max(60_000).default(250),
  exposeTools: z.array(z.string().min(1)).optional(),
  defaultToolPolicy: mcpToolPolicySchema.default({
    permission: "ask",
    parallelSafe: false,
    visibleToChild: true,
  }),
  toolPolicies: z.record(z.string(), mcpToolPolicySchema).default({}),
});

export const mcpSnapshotSchema = z.object({
  protocol: z.literal(BUSH_MCP_SNAPSHOT_PROTOCOL),
  snapshotId: z.string().min(1),
  revision: z.number().int().positive(),
  servers: z.array(mcpServerSnapshotSchema),
});

export type McpSnapshot = z.infer<typeof mcpSnapshotSchema>;
export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

export const mcpSnapshotIdentitySchema = z.object({
  snapshotId: z.string().min(1),
});

export const mcpSnapshotResultSchema = z.object({
  protocol: z.literal(BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL),
  snapshotId: z.string().min(1),
  revision: z.number().int().positive(),
  servers: z.array(z.object({
    id: z.string().min(1),
    negotiatedProtocolVersion: z.string().min(1).optional(),
    health: z.enum(["ready", "restarting", "unavailable"]).default("ready"),
    restartAttempts: z.number().int().nonnegative().default(0),
    lastError: z.string().optional(),
    tools: z.array(z.object({
      remoteName: z.string().min(1),
      runtimeName: z.string().min(1),
    })),
  })),
});

export type McpSnapshotResult = z.infer<typeof mcpSnapshotResultSchema>;
