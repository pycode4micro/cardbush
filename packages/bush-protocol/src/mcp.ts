import { z } from "zod";
import { actionManifestTemplateSchema } from "./tool.js";
import { OPENAI_HOSTED_PROTOCOL } from './openai.js';
import { networkProxySchema } from './proxy.js';

export const BUSH_MCP_SNAPSHOT_PROTOCOL = "bush.mcp_snapshot.v2" as const;
export const BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL =
  "bush.mcp_snapshot_result.v1" as const;
export const APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND =
  "runtime.apply_mcp_snapshot" as const;
export const GET_RUNTIME_MCP_SNAPSHOT_COMMAND =
  "runtime.get_mcp_snapshot" as const;

const stringMapSchema = z.record(z.string(), z.string());
export const mcpOAuthConfigSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecretEnv: z.string().min(1).optional(),
  clientSecretRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  callbackUrl: z.string().url().optional(),
  callbackPort: z.number().int().min(0).max(65535).optional(),
  resourceUrl: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  clientMetadataUrl: z.string().url().optional(),
});
/** Product settings accept OpenAI spelling; runtime snapshots use one normalized representation. */
export function mcpOAuthFromConfig(...layers: unknown[]) {
  const result: Record<string, unknown> = {};
  for (const input of layers) {
    const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const field = (camel: string, snake: string) => item[camel] !== undefined ? item[camel] : item[snake];
    const values = { clientId: field('clientId', 'client_id'), clientSecretEnv: field('clientSecretEnv', 'client_secret_env'),
      clientSecretRef: field('clientSecretRef', 'client_secret_ref'),
      callbackUrl: field('callbackUrl', 'callback_url'), callbackPort: field('callbackPort', 'callback_port'),
      resourceUrl: field('resourceUrl', 'oauth_resource'), clientMetadataUrl: field('clientMetadataUrl', 'client_metadata_url'), scopes: item.scopes };
    // Normalize each layer before merging: either spelling in a user override wins.
    if (values.callbackUrl != null) delete result.callbackPort;
    else if (values.callbackPort != null) delete result.callbackUrl;
    if (values.clientSecretRef != null) { delete result.clientSecretEnv; values.clientSecretEnv = undefined; }
    else if (values.clientSecretEnv != null) delete result.clientSecretRef;
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete result[key];
      else if (value !== undefined && !(key === 'callbackPort' && values.callbackUrl != null)) result[key] = value;
    }
  }
  return mcpOAuthConfigSchema.parse(result);
}

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
  oauth: mcpOAuthConfigSchema.optional(),
  auth: z.enum(['oauth', 'none', 'openai']).optional(),
  openaiAppId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  headersHelper: z.object({ command: z.string().min(1), cwd: z.string().optional(), env: stringMapSchema.default({}) }).optional(),
});

export const mcpTransportConfigSchema = z.discriminatedUnion("kind", [
  mcpStdioTransportSchema,
  mcpHttpTransportSchema,
]).superRefine((transport, context) => {
  if (transport.kind === 'stdio') return;
  if (transport.auth === 'openai') {
    if (transport.kind !== 'streamable_http' || transport.url !== OPENAI_HOSTED_PROTOCOL.mcpEndpoint || !transport.openaiAppId ||
        transport.headersHelper || transport.oauth || Object.keys(transport.headers).length) {
      context.addIssue({ code: 'custom', message: 'OpenAI hosted connections require the fixed endpoint, an application ID and host-owned authentication.' });
    }
  } else if (transport.openaiAppId) context.addIssue({ code: 'custom', message: 'OpenAI application identity requires OpenAI authentication.' });
});

export const mcpToolPolicySchema = z.object({
  permission: z.enum(["allow", "ask"]).default("ask"),
  enabled: z.boolean().optional(),
  parallelSafe: z.boolean().default(false),
  visibleToChild: z.boolean().default(true),
  actionManifest: actionManifestTemplateSchema.optional(),
});

export const mcpServerSnapshotSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  pluginId: z.string().min(1).optional(),
  networkProxy: networkProxySchema.optional(),
  transport: mcpTransportConfigSchema,
  versionMode: z.enum(["auto", "legacy", "modern"]).default("auto"),
  restartBackoffMs: z.number().int().min(0).max(60_000).default(250),
  exposeTools: z.array(z.string().min(1)).optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
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
  // Optional product configuration revision; runtime revisions also track plugin changes.
  configurationRevision: z.number().int().positive().optional(),
  applicationState: z.enum(["applied", "pending", "failed"]).optional(),
  applicationPhase: z.enum(["waiting_for_idle", "connecting"]).optional(),
  pendingRevision: z.number().int().positive().optional(),
  // Services affected by an uncommitted update; absent on older runtimes.
  pendingServerIds: z.array(z.string().min(1)).optional(),
  applicationError: z.string().optional(),
  servers: z.array(z.object({
    id: z.string().min(1),
    negotiatedProtocolVersion: z.string().min(1).optional(),
    health: z.enum(["ready", "restarting", "unavailable", "auth_required", "configuration_required"]).default("ready"),
    restartAttempts: z.number().int().nonnegative().default(0),
    lastError: z.string().optional(),
    // Background connection progress; tools still describe the currently published catalog.
    updateState: z.enum(['queued', 'connecting', 'waiting_for_catalog', 'failed']).optional(),
    tools: z.array(z.object({
      remoteName: z.string().min(1),
      runtimeName: z.string().min(1),
    })),
  })),
});

export type McpSnapshotResult = z.infer<typeof mcpSnapshotResultSchema>;
