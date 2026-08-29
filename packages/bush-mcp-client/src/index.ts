import { createHash, randomUUID } from "node:crypto";

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool as McpTool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  actionManifestTemplateSchema,
  mcpSnapshotSchema,
  toolResultSchema,
  type McpServerSnapshot,
  type McpSnapshot,
  type McpSnapshotResult,
  type McpToolPolicy,
  type ActionManifestTemplate,
  type ToolResult,
} from "@cardbush/bush-protocol";
import {
  type ToolHandlerContext,
  type ToolRegistration,
  ToolRegistry,
} from "@cardbush/bush-runtime";

interface ConnectedServer {
  config: McpServerSnapshot;
  client: Client;
  tools: Array<{
    remote: McpTool;
    runtimeName: string;
    policy: McpToolPolicy;
    manifest: ActionManifestTemplate;
  }>;
}

export interface McpClientManagerOptions {
  registry: ToolRegistry;
  canApply?: () => boolean;
  createReceiptId?: () => string;
  createClient?: (server: McpServerSnapshot) => Client;
  createTransport?: (server: McpServerSnapshot) => Transport;
}

/**
 * Applies product-owned MCP configuration snapshots to the Runtime Tool catalog.
 * It performs no task routing and never infers permission or concurrency policy
 * from a Tool name or description.
 */
export class McpClientManager {
  readonly #registry: ToolRegistry;
  readonly #canApply: () => boolean;
  readonly #createReceiptId: () => string;
  readonly #createClient: (server: McpServerSnapshot) => Client;
  readonly #createTransport: (server: McpServerSnapshot) => Transport;
  #connections: ConnectedServer[] = [];
  #snapshot?: McpSnapshot;
  #result?: McpSnapshotResult;

  constructor(options: McpClientManagerOptions) {
    this.#registry = options.registry;
    this.#canApply = options.canApply ?? (() => true);
    this.#createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);
    this.#createClient = options.createClient ?? createClient;
    this.#createTransport = options.createTransport ?? createTransport;
  }

  snapshot(): McpSnapshotResult | undefined {
    return this.#result ? structuredClone(this.#result) : undefined;
  }

  async apply(input: unknown): Promise<McpSnapshotResult> {
    const snapshot = mcpSnapshotSchema.parse(input);
    if (!this.#canApply()) {
      throw new Error("MCP configuration cannot change while a Runtime Turn is active.");
    }
    if (this.#snapshot?.snapshotId === snapshot.snapshotId) {
      if (snapshot.revision < this.#snapshot.revision) {
        throw new Error("MCP snapshot revision cannot move backwards.");
      }
      if (snapshot.revision === this.#snapshot.revision) {
        if (fingerprint(snapshot) !== fingerprint(this.#snapshot)) {
          throw new Error("MCP snapshot identity was reused with different content.");
        }
        return structuredClone(this.#result!);
      }
    }

    const next: ConnectedServer[] = [];
    try {
      for (const server of snapshot.servers) {
        next.push(await this.#connect(server));
      }
      const registrations = next.flatMap((connection) =>
        connection.tools.map((tool) => this.#registration(connection, tool)),
      );
      this.#registry.replaceOwned("runtime_mcp", registrations);
    } catch (error) {
      await closeConnections(next);
      throw error;
    }

    const previous = this.#connections;
    this.#connections = next;
    this.#snapshot = snapshot;
    this.#result = {
      protocol: BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      servers: next.map((connection) => ({
        id: connection.config.id,
        negotiatedProtocolVersion:
          connection.client.getNegotiatedProtocolVersion() ?? undefined,
        tools: connection.tools.map((tool) => ({
          remoteName: tool.remote.name,
          runtimeName: tool.runtimeName,
        })),
      })),
    };
    await closeConnections(previous);
    return structuredClone(this.#result);
  }

  async close(): Promise<void> {
    const current = this.#connections;
    this.#connections = [];
    this.#snapshot = undefined;
    this.#result = undefined;
    this.#registry.removeOwned("runtime_mcp");
    await closeConnections(current);
  }

  async #connect(config: McpServerSnapshot): Promise<ConnectedServer> {
    const client = this.#createClient(config);
    try {
      await client.connect(this.#createTransport(config));
      const listed = await client.listTools();
      const exposed = config.exposeTools ? new Set(config.exposeTools) : undefined;
      const tools = listed.tools
        .filter((tool) => !exposed || exposed.has(tool.name))
        .map((remote) => {
          const policy = config.toolPolicies[remote.name] ?? config.defaultToolPolicy;
          return {
            remote,
            runtimeName: runtimeToolName(config.id, remote.name),
            policy,
            manifest: explicitActionManifest(config.id, remote, policy),
          };
        });
      assertUnique(tools.map((tool) => tool.runtimeName), `MCP server ${config.id}`);
      return { config, client, tools };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  #registration(
    connection: ConnectedServer,
    tool: ConnectedServer["tools"][number],
  ): ToolRegistration<Record<string, unknown>> {
    const resource = `mcp://${connection.config.id}/tools/${encodeURIComponent(tool.remote.name)}`;
    return {
      registrationOwner: "runtime_mcp",
      definition: {
        name: tool.runtimeName,
        description: tool.remote.description ?? "",
        inputSchema: jsonObject(tool.remote.inputSchema),
      },
      manifest: tool.manifest,
      parallelSafe: tool.policy.parallelSafe,
      visibleToChild: tool.policy.visibleToChild,
      decodeInput: jsonObject,
      authorize: tool.policy.permission === "allow"
        ? () => ({ kind: "allow" as const })
        : () => {
            const capabilityId = `capability:mcp:${createHash("sha256")
              .update(resource)
              .digest("hex")}`;
            return {
              kind: "ask" as const,
              request: {
                reason: "The selected external MCP tool requires explicit permission.",
                actions: ["external_tool_call"],
                resources: [resource],
                capabilityIds: [capabilityId],
              },
            };
          },
      execute: async (context) => {
        const receiptId = this.#createReceiptId();
        const candidate = await connection.client.callTool(
          {
            name: tool.remote.name,
            arguments: context.input,
            _meta: mcpRequestMetadata(context, receiptId),
          },
          { signal: context.signal, toolDefinition: tool.remote },
        );
        return strictMcpToolResult(
          context,
          toJson(candidate),
          resource,
          receiptId,
        );
      },
    };
  }
}

function mcpRequestMetadata(
  context: ToolHandlerContext<unknown>,
  receiptId: string,
): Record<string, unknown> {
  const rawContext = context.turn?.request.metadata.mcpContext;
  const declared = rawContext != null && typeof rawContext === "object" && !Array.isArray(rawContext)
    ? rawContext as Record<string, unknown>
    : {};
  const filesystemRoots = Array.isArray(declared.filesystemRoots)
    ? declared.filesystemRoots
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const transportChannel = typeof declared.transportChannel === "string"
    ? declared.transportChannel.trim()
    : "";
  return {
    session_id: context.sessionId,
    turn_id: context.turnId,
    tool_call_id: context.toolCall.id,
    permission_grants: [...context.capabilityIds],
    filesystem_roots: filesystemRoots,
    runtime_tool_result_protocol: BUSH_TOOL_RESULT_PROTOCOL,
    receipt_id: receiptId,
    action_manifest: { ...context.actionManifest },
    ...(transportChannel ? { transport_channel: transportChannel } : {}),
  };
}

function explicitActionManifest(
  serverId: string,
  remote: McpTool,
  policy: McpToolPolicy,
): ActionManifestTemplate {
  const metadata = remote._meta && typeof remote._meta === "object"
    ? remote._meta as Record<string, unknown>
    : {};
  const candidate = policy.actionManifest ?? metadata["cardbush/action_manifest"];
  const parsed = actionManifestTemplateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `MCP Tool ${serverId}/${remote.name} must provide a complete cardbush/action_manifest or product policy manifest.`,
    );
  }
  return parsed.data;
}

function createClient(server: McpServerSnapshot): Client {
  return new Client(
    { name: "cardbush-runtime", version: "0.1.0" },
    {
      versionNegotiation: {
        mode: server.versionMode === "modern"
          ? { pin: "2026-07-28" }
          : server.versionMode,
      },
    },
  );
}

function createTransport(server: McpServerSnapshot): Transport {
  const transport = server.transport;
  if (transport.kind === "stdio") {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      cwd: transport.cwd,
      env: Object.keys(transport.env).length > 0 ? transport.env : undefined,
      stderr: "pipe",
    });
  }
  const requestInit = Object.keys(transport.headers).length > 0
    ? { headers: transport.headers }
    : undefined;
  if (transport.kind === "sse") {
    return new SSEClientTransport(new URL(transport.url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), { requestInit });
}

function strictMcpToolResult(
  context: ToolHandlerContext<unknown>,
  output: Record<string, unknown>,
  resource: string,
  receiptId: string,
): ToolResult {
  if (output.isError === true) {
    return mcpProtocolFailure(
      context,
      output,
      resource,
      receiptId,
      "mcp_tool_error",
      `MCP tool ${resource} reported an error.`,
    );
  }
  const parsed = toolResultSchema.safeParse(output.structuredContent);
  if (!parsed.success) {
    return mcpProtocolFailure(
      context,
      output,
      resource,
      receiptId,
      "mcp_tool_result_protocol_invalid",
      `MCP tool ${resource} did not return a complete ${BUSH_TOOL_RESULT_PROTOCOL} structured result.`,
      { issues: parsed.error.issues },
    );
  }
  if (!parsed.data.facts.some((fact) => fact.receipt_id === receiptId)) {
    return mcpProtocolFailure(
      context,
      output,
      resource,
      receiptId,
      "mcp_tool_result_receipt_missing",
      `MCP tool ${resource} did not return the Runtime-issued receipt identity.`,
    );
  }
  return parsed.data;
}

function mcpProtocolFailure(
  context: ToolHandlerContext<unknown>,
  output: Record<string, unknown>,
  resource: string,
  receiptId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: false,
    output,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "failed",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["mcp_protocol_failure"],
      paths: [],
      execution_success: true,
      semantic_success: false,
      verification_state: "failed",
      error_code: code,
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
    error: { code, message, details },
  };
}

function runtimeToolName(serverId: string, remoteName: string): string {
  const normalize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${normalize(serverId)}__${normalize(remoteName)}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP Tool input and schemas must be JSON objects.");
  }
  return toJson(value) as Record<string, unknown>;
}

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertUnique(values: string[], scope: string): void {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`${scope} exposes colliding normalized Tool names.`);
  }
}

function fingerprint(snapshot: McpSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function closeConnections(connections: ConnectedServer[]): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.client.close()));
}
