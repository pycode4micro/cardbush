import { createHash } from "node:crypto";
import { McpInteractiveCalls, ScopedMcpClient, type McpElicitationHandler } from './elicitation.js';
import { McpOAuthCoordinator, McpAuthenticationRequired, McpOAuthConfigurationRequired, credentialKey } from './oauth.js';
import { mcpHeaderFetch } from './headerHelper.js';
import { createOpenAiTransport, scopeOpenAiClient, attachOpenAiResultAdapter, type OpenAiTokenProvider } from './openaiHosted.js';
import { OpenAiAuthError } from './openaiAuth.js';
export * from './openaiAuth.js';
export { createOpenAiResultNormalizer, createOpenAiTransport, type OpenAiTokenProvider } from './openaiHosted.js';
export { McpOAuthCoordinator, credentialKey, McpAuthenticationRequired, McpOAuthConfigurationRequired, type McpCredentialStore, type CredentialState } from './oauth.js';
export type { McpElicitationHandler } from './elicitation.js';
export { validateMcpFormResponse } from './elicitation.js';

import {
  Client,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type Tool as McpTool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL,
  actionManifestTemplateSchema,
  mcpSnapshotSchema,
  type McpServerSnapshot,
  type McpSnapshot,
  type McpSnapshotResult,
  type McpToolPolicy,
  type ActionManifestTemplate,
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
  health: "ready" | "restarting" | "unavailable" | "auth_required" | "configuration_required";
  restartAttempts: number;
  lastError?: string;
  restartPromise?: Promise<void>;
  authorization?: Promise<void>;
  authorizationAbort?: AbortController;
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
  openai?: { getToken: OpenAiTokenProvider; fetch?: typeof fetch };
  oauth?: McpOAuthCoordinator;
  onElicitation?: McpElicitationHandler;
  onAuthenticationRequired?: (request: { serverId: string; sessionId: string; turnId: string; toolCallId: string }, signal: AbortSignal) => Promise<boolean>;
  registry: ToolRegistry;
  canApply?: () => boolean;
  createClient?: (server: McpServerSnapshot) => Client;
  createTransport?: (server: McpServerSnapshot) => Transport;
  wait?: (milliseconds: number) => Promise<void>;
  closeTimeoutMs?: number;
  onServiceStateChange?: (state: {
    serverId: string;
    health: "ready" | "restarting" | "unavailable" | "auth_required" | "configuration_required";
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
  readonly #openai?: McpClientManagerOptions['openai'];
  readonly #oauth?: McpOAuthCoordinator;
  readonly #interactive: McpInteractiveCalls;
  readonly #registry: ToolRegistry;
  readonly #canApply: () => boolean;
  readonly #createClient: (server: McpServerSnapshot) => Client;
  readonly #createTransport: (server: McpServerSnapshot) => Transport;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #closeTimeoutMs: number;
  readonly #onServiceStateChange?: McpClientManagerOptions["onServiceStateChange"];
  readonly #onServerStderr?: McpClientManagerOptions["onServerStderr"];
  readonly #onAuthenticationRequired?: McpClientManagerOptions['onAuthenticationRequired'];
  #connections: ConnectedServer[] = [];
  #snapshot?: McpSnapshot;
  #result?: McpSnapshotResult;
  #pending?: McpSnapshot;
  #applicationError?: string;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly #forceReconnect = new Set<string>();

  refresh(serverId: string, snapshot: McpSnapshot): Promise<McpSnapshotResult> {
    return this.refreshServers([serverId], snapshot);
  }

  refreshServers(serverIds: string[], snapshot: McpSnapshot): Promise<McpSnapshotResult> {
    serverIds.forEach(id => this.#forceReconnect.add(id));
    return this.apply(snapshot);
  }

  async invalidateOpenAiConnections(): Promise<void> {
    await Promise.all(this.#connections.filter(item => item.config.transport.kind !== 'stdio' && item.config.transport.auth === 'openai').map(async connection => {
      connection.health = 'auth_required'; connection.lastError = 'OpenAI account changed; reconnect after current tasks finish.';
      connection.authorizationAbort?.abort();
      this.#publishServiceState(connection, 'cardbush_supervisor');
      await closeConnection(connection.client, connection.transport, this.#closeTimeoutMs);
    }));
  }

  /** Manual and tool-initiated login report failures through the same connection state. */
  async login(server: McpServerSnapshot, signal?: AbortSignal): Promise<void> {
    if (server.transport.kind !== 'stdio' && server.transport.auth === 'openai') {
      throw new OpenAiAuthError();
    }
    if (!this.#oauth) throw new McpAuthenticationRequired();
    try { await this.#oauth.login(server, signal); }
    catch (error) {
      const connection = this.#connections.find(item => item.config.id === server.id);
      // A late failure from an older configuration must not overwrite its replacement.
      if (connection && server.transport.kind !== 'stdio' && connection.config.transport.kind !== 'stdio'
        && credentialKey(connection.config) === credentialKey(server)) this.#recordAuthenticationFailure(connection, error);
      throw error;
    }
  }

  constructor(options: McpClientManagerOptions) {
    this.#openai = options.openai;
    this.#oauth = options.oauth;
    this.#onAuthenticationRequired = options.onAuthenticationRequired;
    this.#interactive = new McpInteractiveCalls(options.onElicitation);
    this.#registry = options.registry;
    this.#canApply = options.canApply ?? (() => true);
    this.#createClient = server => {
      const client = options.createClient?.(server) ?? createClient(server, this.#interactive);
      if (server.transport.kind !== 'stdio' && server.transport.auth === 'openai') scopeOpenAiClient(client, server.transport.openaiAppId!);
      return client;
    };
    this.#createTransport = options.createTransport ?? (server => server.transport.kind !== 'stdio' && server.transport.auth === 'openai'
      ? createOpenAiTransport(server, this.#openai?.getToken, this.#openai?.fetch) : createTransport(server,
      server.transport.kind !== 'stdio' && server.transport.auth !== 'none' && !Object.keys(server.transport.headers).some(key => key.toLowerCase() === 'authorization')
        ? this.#oauth?.provider(server) : undefined));
    this.#wait = options.wait ?? delay;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    this.#onServiceStateChange = options.onServiceStateChange;
    this.#onServerStderr = options.onServerStderr;
  }

  snapshot(): McpSnapshotResult | undefined {
    const result = this.#result ?? (this.#pending ? {
      protocol: BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL,
      snapshotId: this.#pending.snapshotId,
      revision: this.#pending.revision,
      servers: [],
    } : undefined);
    if (!result) return undefined;
    return structuredClone({
      ...result,
      applicationState: this.#pending ? (this.#applicationError ? "failed" : "pending") : "applied",
      ...(this.#pending ? { pendingRevision: this.#pending.revision } : {}),
      ...(this.#applicationError ? { applicationError: this.#applicationError } : {}),
      servers: result.servers.map((server) => {
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

  apply(input: unknown): Promise<McpSnapshotResult> {
    const snapshot = mcpSnapshotSchema.parse(input);
    const operation = this.#queue.then(() => this.#apply(snapshot));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #apply(snapshot: McpSnapshot): Promise<McpSnapshotResult> {
    if (this.#closed) throw new Error("MCP manager is closed.");
    const latest = this.#pending ?? this.#snapshot;
    if (latest?.snapshotId === snapshot.snapshotId && snapshot.revision < latest.revision) {
      throw new Error("MCP snapshot revision cannot move backwards.");
    }
    if (latest?.snapshotId === snapshot.snapshotId && snapshot.revision === latest.revision &&
        fingerprint(snapshot) !== fingerprint(latest)) {
      throw new Error("MCP snapshot identity was reused with different content.");
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

    this.#pending = snapshot;
    this.#applicationError = undefined;
    if (!this.#canApply()) {
      this.#scheduleRetry();
      return this.snapshot()!;
    }

    const next: ConnectedServer[] = [];
    const created: ConnectedServer[] = [];
    try {
      for (const server of snapshot.servers) {
        const reusable = this.#connections.find((connection) =>
          connection.config.id === server.id && !connection.retired && !this.#forceReconnect.has(server.id) &&
          connection.health === "ready" && JSON.stringify(connection.config) === JSON.stringify(server),
        );
        const connection = reusable ?? await this.#connect(server);
        next.push(connection);
        if (!reusable) created.push(connection);
      }
      // A new turn may have started while the transports were connecting.
      if (this.#closed || !this.#canApply()) {
        await this.#retireConnections(created);
        this.#scheduleRetry();
        return this.snapshot()!;
      }
      const registrations = next.flatMap((connection) =>
        connection.tools.map((tool) => this.#registration(connection, tool)),
      );
      this.#registry.replaceOwned("runtime_mcp", registrations);
    } catch (error) {
      await this.#retireConnections(created);
      this.#applicationError = errorMessage(error);
      this.#scheduleRetry(5_000);
      throw error;
    }

    const previous = this.#connections;
    this.#connections = next;
    this.#snapshot = snapshot;
    this.#pending = undefined;
    this.#forceReconnect.clear();
    this.#applicationError = undefined;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
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
    await this.#retireConnections(previous.filter((connection) => !next.includes(connection)));
    return this.snapshot()!;
  }

  #scheduleRetry(delayMs = 250): void {
    if (this.#closed || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#pending && !this.#closed) void this.apply(this.#pending).catch(() => undefined);
    }, delayMs);
    this.#retryTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#oauth?.close();
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    await this.#queue;
    const current = this.#connections;
    this.#connections = [];
    this.#snapshot = undefined;
    this.#result = undefined;
    this.#pending = undefined;
    this.#registry.removeOwned("runtime_mcp");
    await this.#retireConnections(current);
  }

  async #connect(config: McpServerSnapshot): Promise<ConnectedServer> {
    const client = this.#createClient(config);
    this.#interactive.prepare(client);
    const transport = this.#createTransport(config);
    drainTransportStderr(transport, config.id, this.#onServerStderr);
    try {
      await client.connect(transport, { timeout: config.startupTimeoutMs ?? 15_000 });
      if (config.transport.kind !== 'stdio' && config.transport.auth === 'openai') attachOpenAiResultAdapter(client, transport);
      const listed = await client.listTools();
      if (config.transport.kind !== 'stdio' && config.transport.auth === 'openai' && !listed.tools.length) throw new McpOAuthConfigurationRequired('This application is not available in the signed-in OpenAI account. Connect it in ChatGPT Apps, then reconnect.');
      const exposed = config.exposeTools ? new Set(config.exposeTools) : undefined;
      const tools = listed.tools
        .filter((tool) => (!exposed || exposed.has(tool.name)) && !config.disabledTools?.includes(tool.name) && config.toolPolicies[tool.name]?.enabled !== false)
        .map((remote) => {
          const policy = config.toolPolicies[remote.name] ?? config.defaultToolPolicy;
          return {
            remote,
            runtimeName: runtimeToolName(config.id, remote.name),
            policy,
            manifest: explicitActionManifest(
              config.id,
              remote.name,
              policy,
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
      const authentication = authenticationFailure(error);
      // Keep sign-in/configuration failures visible and recoverable even for required services.
      if (!config.required || authentication) return { config, client, transport, tools: [], health: authentication?.health ?? 'unavailable',
        restartAttempts: 0, retired: false, lastError: authentication?.error.message ?? errorMessage(error) };
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
      mcpHook: {
        server: connection.config.id,
        tool: tool.remote.name,
        call: async (input, options) => {
          if (connection.retired || connection.health !== 'ready') throw new Error(`MCP service ${connection.config.id} is not connected.`);
          try { return await this.#interactive.run(connection.client, { serverId: connection.config.id, sessionId: options.request.sessionId, turnId: options.request.turnId, signal: options.signal },
            Math.min(options.timeoutMs, connection.config.toolTimeoutMs ?? 60_000), signal => connection.client.callTool({ name: tool.remote.name, arguments: input,
            _meta: mcpRequestMetadata({ requestId: options.request.requestId, sessionId: options.request.sessionId, turnId: options.request.turnId, turn: { request: options.request, contextMessages: [] } }, connection.config.id, tool.remote) },
          { signal, timeout: 2_147_483_647, toolDefinition: tool.remote })); }
          catch (error) { this.#recordAuthenticationFailure(connection, error); throw error; }
        },
      },
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
      authorize: () => {
        if (tool.policy.permission === "allow") {
          return { kind: "allow" as const };
        }
        const capabilityId = `capability:mcp:${createHash("sha256")
          .update(resource)
          .digest("hex")}`;
        return {
          kind: "ask" as const,
          request: {
            reason: "The selected external MCP tool requires explicit permission.",
            actions: ["external_tool_call"],
            targets: [{ kind: "mcp_resource" as const, value: resource }],
            capabilityIds: [capabilityId],
          },
        };
      },
      execute: async (context) => {
        if (connection.health === 'configuration_required') throw new McpOAuthConfigurationRequired(connection.lastError);
        if (connection.health !== "ready" && connection.health !== 'auth_required') {
          throw codedMcpError(
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
          );
        }
        const activeClient = connection.client;
        let candidate;
        const invoke = () => this.#interactive.run(activeClient, { serverId: connection.config.id, sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id, signal: context.signal },
            connection.config.toolTimeoutMs ?? 60_000, signal => activeClient.callTool(
            {
              name: tool.remote.name,
              arguments: context.input,
              _meta: mcpRequestMetadata(context, connection.config.id, tool.remote),
            },
            {
              signal,
              timeout: 2_147_483_647,
              toolDefinition: tool.remote,
            },
          ));
        try {
          let authorized = false;
          if (connection.health === 'auth_required') { await this.#authenticate(connection, context); authorized = true; }
          try { candidate = await invoke(); }
          catch (error) {
            const failure = this.#recordAuthenticationFailure(connection, error);
            if (authorized || failure?.health !== 'auth_required') throw error;
            await this.#authenticate(connection, context);
            // Only an authentication rejection is retried, once, with the original input.
            candidate = await invoke();
          }
        } catch (error) {
          const authentication = this.#recordAuthenticationFailure(connection, error);
          if (authentication) throw authentication.error;
          if (context.signal?.aborted || isAbortError(error)) {
            throw abortErrorFromSignal(context.signal, error);
          }
          if (!isMcpConnectionFailure(error)) {
            throw codedMcpError(
              "mcp_protocol_error",
              errorMessage(error),
              {
                resource,
                sdkCode: mcpErrorCode(error),
              },
            );
          }
          this.#invalidateConnection(connection, activeClient, error);
          throw codedMcpError(
            "mcp_service_connection_lost",
            `MCP service ${connection.config.id} lost its connection and is being restarted.`,
            {
              serverId: connection.config.id,
              health: "restarting",
              transportKind: connection.config.transport.kind,
              recoveryOwner: "cardbush_supervisor",
              retryable: true,
            },
          );
        }
        return candidate;
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

  #recordAuthenticationFailure(connection: ConnectedServer, error: unknown) {
    const failure = authenticationFailure(error);
    if (failure && !connection.retired) {
      const changed = connection.health !== failure.health || connection.lastError !== failure.error.message;
      connection.health = failure.health;
      connection.lastError = failure.error.message;
      if (changed) this.#publishServiceState(connection, 'cardbush_supervisor');
    }
    return failure;
  }

  async #authenticate(connection: ConnectedServer, context: ToolHandlerContext<Record<string, unknown>>) {
    // Reauthentication changes the shared account and requires fresh app-scoped sessions.
    // The account settings own that transition; never resume an old session after login.
    if (connection.config.transport.kind !== 'stdio' && connection.config.transport.auth === 'openai') throw new OpenAiAuthError();
    if (!this.#oauth || !this.#onAuthenticationRequired) throw new McpAuthenticationRequired();
    if (!connection.authorization) {
      const client = connection.client, controller = new AbortController();
      connection.authorizationAbort = controller;
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      connection.authorization = (async () => {
        signal.throwIfAborted();
        const accepted = await this.#onAuthenticationRequired!({ serverId: connection.config.id, sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id }, signal);
        signal.throwIfAborted();
        if (!accepted) throw new McpAuthenticationRequired();
        await this.login(connection.config, signal);
        signal.throwIfAborted();
        if (connection.retired || connection.client !== client) throw new Error('The MCP connection changed during sign-in.');
        connection.health = 'ready'; connection.lastError = undefined;
        this.#publishServiceState(connection, 'cardbush_supervisor');
      })().finally(() => { connection.authorization = undefined; connection.authorizationAbort = undefined; });
    }
    // A second caller can stop waiting without cancelling the originating task's login.
    const pending = connection.authorization;
    if (!context.signal) return pending;
    const signal = context.signal;
    let abort!: () => void;
    try { await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(abortErrorFromSignal(signal, 'MCP sign-in was cancelled.'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]); } finally { signal.removeEventListener('abort', abort); }
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
      this.#interactive.prepare(client);
      const transport = this.#createTransport(connection.config);
      drainTransportStderr(
        transport,
        connection.config.id,
        this.#onServerStderr,
      );
      connection.pendingClient = client;
      connection.pendingTransport = transport;
      try {
        await client.connect(transport, { timeout: connection.config.startupTimeoutMs ?? 15_000 });
        if (connection.config.transport.kind !== 'stdio' && connection.config.transport.auth === 'openai') attachOpenAiResultAdapter(client, transport);
        const listed = await client.listTools();
        const byName = new Map(listed.tools.map((remote) => [remote.name, remote]));
        const missing = connection.tools.filter((tool) => !byName.has(tool.remote.name));
        if (missing.length > 0) {
          if (connection.config.transport.kind !== 'stdio' && connection.config.transport.auth === 'openai') {
            throw new McpOAuthConfigurationRequired('OpenAI application tools changed or access was removed. Refresh the application connection.');
          }
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
        const authentication = authenticationFailure(error);
        connection.health = authentication?.health ?? "unavailable";
        connection.lastError = authentication?.error.message ?? errorMessage(error);
        this.#publishServiceState(connection, "cardbush_supervisor");
        await closeConnection(client, transport, this.#closeTimeoutMs);
        if (authentication) { connection.restartPromise = undefined; return; }
      }
    }
  }

  async #retireConnections(connections: ConnectedServer[]): Promise<void> {
    connections.forEach((connection) => {
      connection.retired = true;
      connection.authorizationAbort?.abort();
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
  context: Pick<ToolHandlerContext<unknown>, 'requestId' | 'sessionId' | 'turnId' | 'turn'>,
  serverId: string,
  tool: McpTool,
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
  const sessionTitle = typeof declared.sessionTitle === "string"
    ? declared.sessionTitle.trim().slice(0, 80)
    : "";
  const chromeScoped = serverId === "chrome_devtools" &&
    tool._meta?.["cardbush/plugin_id"] === "chrome";
  return {
    filesystem_roots: filesystemRoots,
    ...(transportChannel ? { transport_channel: transportChannel } : {}),
    ...(chromeScoped ? {
      cardbush_session_id: context.sessionId,
      cardbush_turn_id: context.turnId,
      cardbush_request_id: context.requestId,
      ...(sessionTitle ? { cardbush_session_title: sessionTitle } : {}),
    } : {}),
  };
}

function explicitActionManifest(
  serverId: string,
  remoteName: string,
  policy: McpToolPolicy,
): ActionManifestTemplate {
  const parsed = actionManifestTemplateSchema.safeParse(policy.actionManifest);
  if (parsed.success) return parsed.data;
  return {
    effect_kind: "external_mcp",
    operation: `mcp.${serverId}.${remoteName}`,
    risk: policy.permission === "allow" ? "configured_allow" : "requires_user_permission",
    owner: `mcp:${serverId}`,
    dispatch_scope: "external",
    mutating: true,
  };
}

function createClient(server: McpServerSnapshot, calls: McpInteractiveCalls): Client {
  return new ScopedMcpClient(
    { name: "cardbush-runtime", version: "0.1.0" },
    {
      versionNegotiation: {
        mode: server.versionMode === "modern"
          ? { pin: "2026-07-28" }
          : server.versionMode,
      },
    }, calls,
  );
}

export function createTransport(server: McpServerSnapshot, authProvider?: OAuthClientProvider): Transport {
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
  const fetchWithHeaders = transport.headersHelper ? mcpHeaderFetch(transport.url, transport.headersHelper) : undefined;
  if (transport.kind === "sse") {
    return new SSEClientTransport(new URL(transport.url), { requestInit, authProvider, fetch: fetchWithHeaders });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), { requestInit, authProvider, fetch: fetchWithHeaders });
}

function authenticationFailure(error: unknown) {
  if (error instanceof McpOAuthConfigurationRequired || (error as { code?: unknown })?.code === 'mcp_oauth_configuration_required') return { health: 'configuration_required' as const, error: error as Error };
  if (error instanceof OpenAiAuthError) return { health: 'auth_required' as const, error };
  if (error instanceof UnauthorizedError || mcpErrorCode(error) === SdkErrorCode.ClientHttpAuthentication || (error as { code?: unknown })?.code === 'mcp_auth_required') return { health: 'auth_required' as const, error: new McpAuthenticationRequired() };
  return undefined;
}

function codedMcpError(
  code: string,
  message: string,
  details: Record<string, unknown>,
): Error & { code: string; details: Record<string, unknown> } {
  return Object.assign(new Error(message), { code, details });
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
