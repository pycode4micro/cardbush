import { createHash, randomUUID } from "node:crypto";

import {
  Client,
  SdkErrorCode,
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
  transport: Transport;
  health: "ready" | "restarting" | "unavailable";
  restartAttempts: number;
  lastError?: string;
  restartPromise?: Promise<void>;
  pendingClient?: Client;
  pendingTransport?: Transport;
  retired: boolean;
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
  wait?: (milliseconds: number) => Promise<void>;
  closeTimeoutMs?: number;
  onServiceStateChange?: (state: {
    serverId: string;
    health: "ready" | "restarting" | "unavailable";
    restartAttempts: number;
    transportKind: McpServerSnapshot["transport"]["kind"];
    recoveryOwner: "cardbush_supervisor";
    error?: string;
  }) => void;
  onServerStderr?: (entry: { serverId: string; message: string }) => void;
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
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #closeTimeoutMs: number;
  readonly #onServiceStateChange?: McpClientManagerOptions["onServiceStateChange"];
  readonly #onServerStderr?: McpClientManagerOptions["onServerStderr"];
  #connections: ConnectedServer[] = [];
  #snapshot?: McpSnapshot;
  #result?: McpSnapshotResult;

  constructor(options: McpClientManagerOptions) {
    this.#registry = options.registry;
    this.#canApply = options.canApply ?? (() => true);
    this.#createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);
    this.#createClient = options.createClient ?? createClient;
    this.#createTransport = options.createTransport ?? createTransport;
    this.#wait = options.wait ?? delay;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    this.#onServiceStateChange = options.onServiceStateChange;
    this.#onServerStderr = options.onServerStderr;
  }

  snapshot(): McpSnapshotResult | undefined {
    if (!this.#result) return undefined;
    return structuredClone({
      ...this.#result,
      servers: this.#result.servers.map((server) => {
        const connection = this.#connections.find((item) => item.config.id === server.id);
        return connection
          ? {
              ...server,
              health: connection.health,
              restartAttempts: connection.restartAttempts,
              ...(connection.lastError ? { lastError: connection.lastError } : {}),
            }
          : server;
      }),
    });
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
        return this.snapshot()!;
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
      await this.#retireConnections(next);
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
        health: connection.health,
        restartAttempts: connection.restartAttempts,
        tools: connection.tools.map((tool) => ({
          remoteName: tool.remote.name,
          runtimeName: tool.runtimeName,
        })),
      })),
    };
    await this.#retireConnections(previous);
    return this.snapshot()!;
  }

  async close(): Promise<void> {
    const current = this.#connections;
    this.#connections = [];
    this.#snapshot = undefined;
    this.#result = undefined;
    this.#registry.removeOwned("runtime_mcp");
    await this.#retireConnections(current);
  }

  async #connect(config: McpServerSnapshot): Promise<ConnectedServer> {
    const client = this.#createClient(config);
    const transport = this.#createTransport(config);
    drainTransportStderr(transport, config.id, this.#onServerStderr);
    try {
      await client.connect(transport);
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
            manifest: explicitActionManifest(
              config.id,
              remote,
              policy,
              config.acceptCardbushExtensions,
            ),
          };
        });
      assertUnique(tools.map((tool) => tool.runtimeName), `MCP server ${config.id}`);
      const connection: ConnectedServer = {
        config,
        client,
        transport,
        tools,
        health: "ready",
        restartAttempts: 0,
        retired: false,
      };
      this.#watchClientLifecycle(connection, client);
      return connection;
    } catch (error) {
      await closeConnection(client, transport, this.#closeTimeoutMs);
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
      executionChannel: `mcp:${connection.config.id}`,
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
        if (connection.health !== "ready") {
          return mcpFailure(
            context,
            {},
            resource,
            receiptId,
            "transport",
            connection.health === "restarting"
              ? "mcp_service_restarting"
              : "mcp_service_unavailable",
            `MCP service ${connection.config.id} is recovering; use another available capability instead of retrying this connection.`,
            {
              serverId: connection.config.id,
              health: connection.health,
              restartAttempts: connection.restartAttempts,
              retryable: true,
            },
            false,
          );
        }
        const activeClient = connection.client;
        let candidate;
        try {
          candidate = await activeClient.callTool(
            {
              name: tool.remote.name,
              arguments: context.input,
              _meta: mcpRequestMetadata(
                context,
                receiptId,
                connection.config.acceptCardbushExtensions,
              ),
            },
            {
              signal: context.signal,
              toolDefinition: tool.remote,
            },
          );
        } catch (error) {
          if (context.signal?.aborted || isAbortError(error)) {
            throw abortErrorFromSignal(context.signal, error);
          }
          if (!isMcpConnectionFailure(error)) {
            return mcpFailure(
              context,
              {},
              resource,
              receiptId,
              "protocol",
              "mcp_protocol_error",
              errorMessage(error),
              {
                resource,
                sdkCode: mcpErrorCode(error),
              },
            );
          }
          this.#invalidateConnection(connection, activeClient, error);
          return mcpFailure(
            context,
            {},
            resource,
            receiptId,
            "transport",
            "mcp_service_connection_lost",
            `MCP service ${connection.config.id} lost its connection and is being restarted.`,
            {
              serverId: connection.config.id,
              health: "restarting",
              transportKind: connection.config.transport.kind,
              recoveryOwner: "cardbush_supervisor",
              retryable: true,
            },
            false,
          );
        }
        return strictMcpToolResult(
          context,
          toJson(candidate),
          resource,
          receiptId,
          connection.config.acceptCardbushExtensions,
        );
      },
    };
  }

  #watchClientLifecycle(connection: ConnectedServer, client: Client): void {
    client.onclose = () => {
      this.#invalidateConnection(
        connection,
        client,
        Object.assign(new Error(`MCP service ${connection.config.id} connection closed.`), {
          code: SdkErrorCode.ConnectionClosed,
        }),
      );
    };
  }

  #invalidateConnection(
    connection: ConnectedServer,
    failedClient: Client,
    error: unknown,
  ): void {
    if (
      connection.retired ||
      connection.client !== failedClient ||
      connection.health !== "ready"
    ) return;
    connection.health = "restarting";
    connection.lastError = errorMessage(error);
    this.#publishServiceState(connection, "cardbush_supervisor");
    connection.restartPromise = this.#restartConnection(connection, failedClient)
      .catch((restartError) => {
        if (connection.retired) return;
        connection.health = "unavailable";
        connection.lastError = errorMessage(restartError);
        connection.restartPromise = undefined;
        this.#publishServiceState(connection, "cardbush_supervisor");
      });
  }

  async #restartConnection(
    connection: ConnectedServer,
    failedClient: Client,
  ): Promise<void> {
    const failedTransport = connection.transport;
    await closeConnection(failedClient, failedTransport, this.#closeTimeoutMs);
    while (!connection.retired) {
      const attempt = connection.restartAttempts + 1;
      const backoff = Math.min(
        10_000,
        connection.config.restartBackoffMs * 2 ** Math.min(attempt - 1, 5),
      );
      if (backoff > 0) await this.#wait(backoff);
      if (connection.retired) return;
      connection.health = "restarting";
      connection.restartAttempts = attempt;
      this.#publishServiceState(connection, "cardbush_supervisor");
      const client = this.#createClient(connection.config);
      const transport = this.#createTransport(connection.config);
      drainTransportStderr(
        transport,
        connection.config.id,
        this.#onServerStderr,
      );
      connection.pendingClient = client;
      connection.pendingTransport = transport;
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        const byName = new Map(listed.tools.map((remote) => [remote.name, remote]));
        const missing = connection.tools.filter((tool) => !byName.has(tool.remote.name));
        if (missing.length > 0) {
          throw new Error(
            `Restarted MCP service omitted configured tools: ${missing.map((tool) => tool.remote.name).join(", ")}`,
          );
        }
        if (connection.retired) {
          connection.pendingClient = undefined;
          connection.pendingTransport = undefined;
          await closeConnection(client, transport, this.#closeTimeoutMs);
          return;
        }
        connection.client = client;
        connection.transport = transport;
        this.#watchClientLifecycle(connection, client);
        connection.pendingClient = undefined;
        connection.pendingTransport = undefined;
        connection.tools.forEach((tool) => {
          tool.remote = byName.get(tool.remote.name)!;
        });
        connection.health = "ready";
        connection.lastError = undefined;
        connection.restartPromise = undefined;
        this.#publishServiceState(connection, "cardbush_supervisor");
        return;
      } catch (error) {
        connection.pendingClient = undefined;
        connection.pendingTransport = undefined;
        connection.health = "unavailable";
        connection.lastError = errorMessage(error);
        this.#publishServiceState(connection, "cardbush_supervisor");
        await closeConnection(client, transport, this.#closeTimeoutMs);
      }
    }
  }

  async #retireConnections(connections: ConnectedServer[]): Promise<void> {
    connections.forEach((connection) => {
      connection.retired = true;
    });
    await Promise.allSettled(
      connections.flatMap((connection) => [
        closeConnection(connection.client, connection.transport, this.#closeTimeoutMs),
        ...(connection.pendingClient && connection.pendingTransport
          ? [closeConnection(
              connection.pendingClient,
              connection.pendingTransport,
              this.#closeTimeoutMs,
            )]
          : []),
      ]),
    );
  }

  #publishServiceState(
    connection: ConnectedServer,
    recoveryOwner: "cardbush_supervisor",
  ): void {
    this.#onServiceStateChange?.({
      serverId: connection.config.id,
      health: connection.health,
      restartAttempts: connection.restartAttempts,
      transportKind: connection.config.transport.kind,
      recoveryOwner,
      ...(connection.lastError ? { error: connection.lastError } : {}),
    });
  }
}

function mcpRequestMetadata(
  context: ToolHandlerContext<unknown>,
  receiptId: string,
  acceptCardbushExtensions: boolean,
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
    filesystem_roots: filesystemRoots,
    ...(transportChannel ? { transport_channel: transportChannel } : {}),
    ...(acceptCardbushExtensions
      ? {
          session_id: context.sessionId,
          turn_id: context.turnId,
          tool_call_id: context.toolCall.id,
          permission_grants: [...context.capabilityIds],
          runtime_tool_result_protocol: BUSH_TOOL_RESULT_PROTOCOL,
          receipt_id: receiptId,
          action_manifest: { ...context.actionManifest },
        }
      : {}),
  };
}

function explicitActionManifest(
  serverId: string,
  remote: McpTool,
  policy: McpToolPolicy,
  acceptCardbushExtensions: boolean,
): ActionManifestTemplate {
  const metadata = remote._meta && typeof remote._meta === "object"
    ? remote._meta as Record<string, unknown>
    : {};
  const candidate = policy.actionManifest ?? (
    acceptCardbushExtensions ? metadata["cardbush/action_manifest"] : undefined
  );
  const parsed = actionManifestTemplateSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return {
    effect_kind: "external_mcp",
    operation: `mcp.${serverId}.${remote.name}`,
    risk: policy.permission === "allow" ? "configured_allow" : "requires_user_permission",
    owner: `mcp:${serverId}`,
    dispatch_phase: "execution",
    dispatch_scope: "external",
    dispatch_side_effect: "unknown",
    dispatch_mutating: true,
    dispatch_source: "product_mcp_policy",
    stage_modes: ["mixed"],
    output_kinds: ["mcp_content"],
    handoff_exports: [],
    evidence_hints: ["mcp_standard_content"],
  };
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
  acceptCardbushExtensions: boolean,
): ToolResult {
  if (output.isError === true) {
    return mcpFailure(
      context,
      output,
      resource,
      receiptId,
      "tool",
      "mcp_tool_error",
      mcpToolErrorMessage(output, resource),
      { resource },
    );
  }
  const parsed = acceptCardbushExtensions
    ? toolResultSchema.safeParse(output.structuredContent)
    : undefined;
  if (
    acceptCardbushExtensions &&
    !parsed?.success &&
    isCardbushToolResultEnvelope(output.structuredContent)
  ) {
    return mcpFailure(
      context,
      output,
      resource,
      receiptId,
      "protocol",
      "mcp_tool_result_invalid",
      `MCP tool ${resource} returned an invalid CardBush Tool result.`,
      { issues: parsed?.error.issues ?? [] },
    );
  }
  if (!parsed?.success) {
    return {
      protocol: BUSH_TOOL_RESULT_PROTOCOL,
      tool_call_id: context.toolCall.id,
      success: true,
      output: {
        authority: "mcp_standard",
        content: output.content ?? [],
        structuredContent: output.structuredContent ?? null,
        resource,
      },
      facts: [{
        protocol: BUSH_EXECUTION_FACT_PROTOCOL,
        receipt_id: receiptId,
        action_manifest_id: context.actionManifest.manifest_id,
        status: "completed",
        operation: context.actionManifest.operation,
        effect_kind: context.actionManifest.effect_kind,
        owner: context.actionManifest.owner,
        dispatch_scope: context.actionManifest.dispatch_scope,
        categories: ["mcp_standard_content", "non_authoritative"],
        paths: [],
        execution_success: true,
        semantic_success: null,
        verification_state: "unverified",
        error_code: "",
      }],
      artifacts: [],
      workspace_changes: [],
      guidance: [],
    };
  }
  if (!parsed.data.facts.some((fact) => fact.receipt_id === receiptId)) {
    return mcpFailure(
      context,
      output,
      resource,
      receiptId,
      "protocol",
      "mcp_tool_result_receipt_missing",
      `MCP tool ${resource} did not return the Runtime-issued receipt identity.`,
    );
  }
  return parsed.data;
}

function mcpFailure(
  context: ToolHandlerContext<unknown>,
  output: Record<string, unknown>,
  resource: string,
  receiptId: string,
  kind: "tool" | "protocol" | "transport",
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  executionSuccess = false,
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
      categories: [`mcp_${kind}_failure`],
      paths: [],
      execution_success: executionSuccess,
      semantic_success: false,
      verification_state: "failed",
      error_code: code,
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
    error: { kind, code, message, details },
  };
}

function isCardbushToolResultEnvelope(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { protocol?: unknown }).protocol === BUSH_TOOL_RESULT_PROTOCOL
  );
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

function mcpErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function mcpToolErrorMessage(
  output: Record<string, unknown>,
  resource: string,
): string {
  const content = Array.isArray(output.content) ? output.content : [];
  const text = content
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const candidate = item as Record<string, unknown>;
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text.trim()]
        : [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text
    ? boundedDiagnostic(text, 2_000)
    : `MCP tool ${resource} reported an error.`;
}

function boundedDiagnostic(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n… diagnostic middle omitted …\n";
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.floor(available * 0.4);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
}

function drainTransportStderr(
  transport: Transport,
  serverId: string,
  onServerStderr?: McpClientManagerOptions["onServerStderr"],
): void {
  const stderr = (transport as {
    stderr?: NodeJS.ReadableStream | null;
  }).stderr;
  if (!stderr || typeof stderr.on !== "function") return;
  if (!onServerStderr) {
    (stderr as NodeJS.ReadableStream & { resume?: () => void }).resume?.();
    return;
  }
  stderr.on("data", (chunk: unknown) => {
    const message = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    const normalized = message.trim();
    if (!normalized) return;
    onServerStderr({ serverId, message: normalized.slice(0, 8_192) });
  });
}

function isMcpConnectionFailure(error: unknown): boolean {
  const code = mcpErrorCode(error);
  return (
    code === SdkErrorCode.ConnectionClosed ||
    code === SdkErrorCode.SendFailed ||
    code === SdkErrorCode.NotConnected ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortErrorFromSignal(
  signal: AbortSignal | undefined,
  fallback: unknown,
): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim()
        ? reason
        : errorMessage(fallback),
  );
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeConnection(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  let clientCloseSucceeded = false;
  const clientSettled = await settleWithin(
    Promise.resolve().then(async () => {
      await client.close();
      clientCloseSucceeded = true;
    }),
    timeoutMs,
  );
  if (clientSettled && clientCloseSucceeded) return;
  const close = (transport as { close?: () => Promise<void> }).close;
  if (typeof close === "function") {
    await settleWithin(Promise.resolve().then(() => close.call(transport)), timeoutMs);
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
