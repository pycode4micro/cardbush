import { attachMcpResultFallback, McpResultValidationError } from "./resultFallback.js";
import { projectMcpResult } from './modelResult.js';
export { attachMcpResultFallback, McpResultValidationError } from "./resultFallback.js";
import { createHash } from "node:crypto";
import { McpInteractiveCalls, ScopedMcpClient, type McpElicitationHandler } from './elicitation.js';
import { McpOAuthCoordinator, McpAuthenticationRequired, McpOAuthConfigurationRequired, credentialKey } from './oauth.js';
import { mcpHeaderFetch } from './headerHelper.js';
import { createOpenAiTransport, scopeOpenAiClient, attachOpenAiCatalogAdapter, type OpenAiTokenProvider } from './openaiHosted.js';
import { OpenAiAuthError } from './openaiAuth.js';
export * from './openaiAuth.js';
export { createOpenAiTransport, type OpenAiTokenProvider } from './openaiHosted.js';
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
  recoveryAbort?: AbortController;
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

interface ConnectionUpdate {
  config: McpServerSnapshot;
  controller: AbortController;
  state: 'queued' | 'connecting' | 'waiting_for_catalog' | 'failed';
  connection?: ConnectedServer;
  error?: string;
}

export interface McpClientManagerOptions {
  network?: (server: McpServerSnapshot, signal?: AbortSignal) => Promise<{ fetch: typeof fetch; env: Record<string, string> }>;
  closeOAuthOnClose?: boolean;
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
  maxConcurrentConnections?: number;
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
  readonly #options: McpClientManagerOptions;
  readonly #openai?: McpClientManagerOptions['openai'];
  readonly #oauth?: McpOAuthCoordinator;
  readonly #interactive: McpInteractiveCalls;
  readonly #registry: ToolRegistry;
  readonly #canApply: () => boolean;
  readonly #createClient: (server: McpServerSnapshot) => Client;
  readonly #createTransport: (server: McpServerSnapshot, signal?: AbortSignal) => Transport | Promise<Transport>;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #closeTimeoutMs: number;
  readonly #maxConcurrentConnections: number;
  readonly #onServiceStateChange?: McpClientManagerOptions["onServiceStateChange"];
  readonly #onServerStderr?: McpClientManagerOptions["onServerStderr"];
  readonly #onAuthenticationRequired?: McpClientManagerOptions['onAuthenticationRequired'];
  #connections: ConnectedServer[] = [];
  #snapshot?: McpSnapshot;
  #pending?: McpSnapshot;
  #applicationError?: string;
  #retryTimer?: ReturnType<typeof setTimeout>;
  readonly #updates = new Map<string, ConnectionUpdate>();
  readonly #running = new Set<Promise<void>>();
  readonly #cleanup = new Set<Promise<void>>();
  readonly #observers = new Set<() => void>();
  #pumpScheduled = false;
  #atomicUpdate = false;
  #closed = false;

  refresh(serverId: string, snapshot: McpSnapshot): Promise<McpSnapshotResult> {
    return this.refreshServers([serverId], snapshot);
  }

  refreshServers(serverIds: string[], snapshot: McpSnapshot): Promise<McpSnapshotResult> {
    return this.#applyAndWait(snapshot, serverIds);
  }

  async invalidateOpenAiConnections(): Promise<void> {
    for (const [id, update] of [...this.#updates]) {
      if (update.config.transport.kind === 'stdio' || update.config.transport.auth !== 'openai') continue;
      this.#discardUpdate(id, update);
      this.#updates.set(id, { config: update.config, controller: new AbortController(), state: 'failed', error: 'OpenAI account changed; reconnect this application.' });
    }
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
    this.#options = options;
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
    this.#createTransport = options.createTransport ?? (async (server, signal) => {
      const network = await options.network?.(server, signal);
      signal?.throwIfAborted();
      return server.transport.kind !== 'stdio' && server.transport.auth === 'openai'
        ? createOpenAiTransport(server, this.#openai?.getToken, network?.fetch ?? this.#openai?.fetch)
        : createTransport(server, server.transport.kind !== 'stdio' && server.transport.auth !== 'none' && !Object.keys(server.transport.headers).some(key => key.toLowerCase() === 'authorization')
          ? this.#oauth?.provider(server) : undefined, network);
    });
    this.#wait = options.wait ?? delay;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    this.#maxConcurrentConnections = options.maxConcurrentConnections ?? 4;
    if (!Number.isSafeInteger(this.#maxConcurrentConnections) || this.#maxConcurrentConnections < 1) {
      throw new Error('maxConcurrentConnections must be a positive integer.');
    }
    this.#onServiceStateChange = options.onServiceStateChange;
    this.#onServerStderr = options.onServerStderr;
  }

  snapshot(): McpSnapshotResult | undefined {
    const desired = this.#pending ?? this.#snapshot;
    if (!desired) return undefined;
    const removed = this.#connections.filter(c => !desired.servers.some(s => s.id === c.config.id));
    const ids = [...desired.servers.map(s => s.id), ...removed.map(c => c.config.id)];
    const pendingServerIds = [...this.#updates].filter(([, update]) => update.state !== 'failed' || this.#applicationError).map(([id]) => id).concat(removed.map(c => c.config.id));
    const connecting = [...this.#updates.values()].some(update => update.state === 'queued' || update.state === 'connecting');
    return structuredClone({
      protocol: BUSH_MCP_SNAPSHOT_RESULT_PROTOCOL,
      snapshotId: desired.snapshotId,
      revision: this.#snapshot?.snapshotId === desired.snapshotId ? this.#snapshot.revision : desired.revision,
      applicationState: this.#pending ? (this.#applicationError ? 'failed' : 'pending') : 'applied',
      ...(this.#pending ? { pendingRevision: desired.revision, pendingServerIds,
        ...(!this.#applicationError ? { applicationPhase: connecting ? 'connecting' : 'waiting_for_idle' } : {}),
      } : {}),
      ...(this.#applicationError ? { applicationError: this.#applicationError } : {}),
      servers: ids.map(id => {
        const current = this.#connections.find(c => c.config.id === id);
        const update = this.#updates.get(id);
        const lastError = update?.error ?? update?.connection?.lastError ?? (!update ? current?.lastError : undefined);
        return {
          id,
          negotiatedProtocolVersion: current?.client.getNegotiatedProtocolVersion() ?? undefined,
          health: update?.state === 'failed' ? 'unavailable' : update?.connection?.health ?? current?.health ?? 'unavailable',
          restartAttempts: current?.restartAttempts ?? 0,
          ...(update ? { updateState: update.state } : removed.some(c => c.config.id === id) ? { updateState: 'waiting_for_catalog' } : {}),
          ...(lastError ? { lastError } : {}),
          // Only published tools belong to the active catalog, including while a replacement connects.
          tools: current?.tools.map(tool => ({ remoteName: tool.remote.name, runtimeName: tool.runtimeName })) ?? [],
        };
      }),
    }) as McpSnapshotResult;
  }

  /** Accept a configuration immediately; connection work and publication continue in the background. */
  submit(input: unknown, reconnectServerIds: readonly string[] = []): McpSnapshotResult {
    if (this.#closed) throw new Error('MCP manager is closed.');
    const snapshot = mcpSnapshotSchema.parse(input);
    const latest = this.#pending ?? this.#snapshot;
    if (latest?.snapshotId === snapshot.snapshotId) {
      if (snapshot.revision < latest.revision) throw new Error('MCP snapshot revision cannot move backwards.');
      if (snapshot.revision === latest.revision && fingerprint(snapshot) !== fingerprint(latest)) {
        throw new Error('MCP snapshot identity was reused with different content.');
      }
      if (snapshot.revision === latest.revision && !reconnectServerIds.length) {
        this.#queuePump();
        return this.snapshot()!;
      }
    }
    const reconnect = new Set(reconnectServerIds);
    const retryFailedTransaction = Boolean(this.#applicationError);
    this.#pending = snapshot;
    this.#applicationError = undefined;
    for (const [id, update] of this.#updates) {
      const config = snapshot.servers.find(server => server.id === id);
      if (!config || JSON.stringify(config) !== JSON.stringify(update.config) || reconnect.has(id) || (retryFailedTransaction && update.state === 'failed')) {
        this.#discardUpdate(id, update);
      }
    }
    for (const config of snapshot.servers) {
      if (this.#updates.has(config.id)) continue;
      const current = this.#connections.find(c => c.config.id === config.id && !c.retired);
      if (!reconnect.has(config.id) && current && JSON.stringify(current.config) === JSON.stringify(config)) continue;
      this.#updates.set(config.id, { config, controller: new AbortController(), state: 'queued' });
    }
    // Required changes retain the existing transaction guarantee. Ordinary optional services publish independently.
    this.#atomicUpdate = [...this.#updates.values()].some(update => update.config.required) ||
      this.#connections.some(c => c.config.required && !snapshot.servers.some(s => s.id === c.config.id));
    this.#queuePump();
    this.#notifyObservers();
    return this.snapshot()!;
  }

  /** Internal callers that need the catalog (for example an isolated agent) can explicitly await readiness. */
  apply(input: unknown): Promise<McpSnapshotResult> {
    return this.#applyAndWait(input);
  }

  async #applyAndWait(input: unknown, reconnectServerIds: readonly string[] = []): Promise<McpSnapshotResult> {
    this.submit(input, reconnectServerIds);
    while (!this.#closed) {
      if (this.#applicationError) {
        const error = this.#applicationError;
        await this.#drainCleanup();
        throw new Error(error);
      }
      if (!this.#pending || !this.#canApply()) break;
      await new Promise<void>(resolve => this.#observers.add(resolve));
    }
    await this.#drainCleanup();
    return this.snapshot()!;
  }

  #notifyObservers(): void {
    const observers = [...this.#observers];
    this.#observers.clear();
    observers.forEach(resolve => resolve());
  }

  #queuePump(): void {
    if (this.#closed || this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => { this.#pumpScheduled = false; this.#pump(); });
  }

  #pump(): void {
    if (this.#closed || !this.#pending || this.#applicationError) { this.#notifyObservers(); return; }
    this.#publishAvailable();
    if (!this.#applicationError) {
      for (const update of this.#updates.values()) {
        if (this.#running.size >= this.#maxConcurrentConnections) break;
        if (update.state !== 'queued') continue;
        update.state = 'connecting';
        const work = this.#connect(update.config, update.controller.signal).then(connection => {
          if (this.#closed || this.#updates.get(update.config.id) !== update) {
            this.#trackCleanup(this.#retireConnections([connection]));
            return;
          }
          update.connection = connection;
          update.state = 'waiting_for_catalog';
        }, error => {
          if (this.#closed || this.#updates.get(update.config.id) !== update) return;
          if (update.config.required) this.#failUpdate(error);
          else { update.state = 'failed'; update.error = errorMessage(error); }
        }).finally(() => { this.#running.delete(work); this.#pump(); });
        this.#running.add(work);
      }
    }
    this.#notifyObservers();
  }

  #publishAvailable(): void {
    const desired = this.#pending;
    if (!desired || this.#applicationError) return;
    if (!this.#canApply()) { this.#schedulePublication(); return; }
    if (this.#atomicUpdate && [...this.#updates.values()].some(update => !update.connection && update.state !== 'failed')) return;
    const next = desired.servers.flatMap(server => {
      const update = this.#updates.get(server.id);
      if (update?.state === 'failed') return [];
      const connection = update?.connection ?? this.#connections.find(c => c.config.id === server.id);
      return connection ? [connection] : [];
    });
    try {
      if (next.length !== this.#connections.length || next.some((connection, index) => connection !== this.#connections[index])) {
        this.#registry.replaceOwned('runtime_mcp', next.flatMap(connection => connection.tools.map(tool => this.#registration(connection, tool))));
      }
    } catch (error) { this.#failUpdate(error); return; }
    const previous = this.#connections;
    this.#connections = next;
    for (const [id, update] of this.#updates) if (update.connection && next.includes(update.connection)) this.#updates.delete(id);
    this.#trackCleanup(this.#retireConnections(previous.filter(connection => !next.includes(connection))));
    if ([...this.#updates.values()].every(update => update.state === 'failed')) {
      this.#snapshot = desired;
      this.#pending = undefined;
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #failUpdate(error: unknown): void {
    this.#applicationError = errorMessage(error);
    for (const [id, update] of [...this.#updates]) {
      this.#discardUpdate(id, update);
      this.#updates.set(id, { config: update.config, controller: new AbortController(), state: 'failed', error: this.#applicationError });
    }
  }

  #discardUpdate(id: string, update: ConnectionUpdate): void {
    this.#updates.delete(id);
    update.controller.abort(new Error('MCP connection update was superseded or cancelled.'));
    if (update.connection) this.#trackCleanup(this.#retireConnections([update.connection]));
  }

  #trackCleanup(work: Promise<void>): void {
    const settled = work.catch(() => undefined).finally(() => this.#cleanup.delete(settled));
    this.#cleanup.add(settled);
  }

  async #drainCleanup(): Promise<void> {
    while (this.#cleanup.size) await Promise.all(this.#cleanup);
  }

  #schedulePublication(): void {
    if (this.#closed || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; this.#pump(); }, 250);
    this.#retryTimer.unref?.();
  }

  fork(registry: ToolRegistry): McpClientManager {
    return new McpClientManager({ ...this.#options, registry, canApply: () => true, closeOAuthOnClose: false });
  }

  /** Agent startup may require authentication before a server can disclose any tools. */
  async prepareAgentScope(request: import('@cardbush/bush-protocol').RuntimeSessionTurnRequest, signal?: AbortSignal): Promise<void> {
    const reconnect: string[] = [];
    for (const connection of this.#connections) {
      if (connection.health === 'configuration_required') throw new McpOAuthConfigurationRequired(connection.lastError);
      if (connection.health === 'auth_required' && !connection.tools.length) {
        if (request.metadata.pluginAgentDontAsk || request.metadata.pluginAgentPermissionMode === 'dontAsk') throw new McpAuthenticationRequired();
        await this.#authenticate(connection, { sessionId: request.sessionId, turnId: request.turnId, signal,
          toolCall: { protocol: 'bush.tool_call.v1', id: `agent-mcp-setup-${connection.config.id}`, name: 'agent_mcp_connect', argumentsText: '{}' } });
        reconnect.push(connection.config.id);
      }
    }
    if (reconnect.length && this.#snapshot) await this.refreshServers(reconnect, { ...this.#snapshot, revision: this.#snapshot.revision + 1 });
    const unavailable = this.#connections.find(connection => connection.config.required && connection.health !== 'ready');
    if (unavailable) throw new Error(`Agent MCP ${unavailable.config.id}: ${unavailable.lastError || unavailable.health}`);
  }

  async close(): Promise<void> {
    if (this.#options.closeOAuthOnClose !== false) this.#oauth?.close();
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    for (const [id, update] of [...this.#updates]) this.#discardUpdate(id, update);
    this.#notifyObservers();
    const current = this.#connections;
    this.#connections = [];
    this.#snapshot = undefined;
    this.#pending = undefined;
    this.#registry.removeOwned("runtime_mcp");
    await Promise.all(this.#running);
    await this.#drainCleanup();
    await this.#retireConnections(current);
  }

  async #connect(config: McpServerSnapshot, signal?: AbortSignal): Promise<ConnectedServer> {
    const transport = await abortable(Promise.resolve(this.#createTransport(config, signal)), signal);
    signal?.throwIfAborted();
    const client = this.#createClient(config);
    this.#interactive.prepare(client);
    drainTransportStderr(transport, config.id, this.#onServerStderr);
    let closedDuringStartup = false;
    try {
      const connecting = client.connect(transport, { timeout: config.startupTimeoutMs ?? 15_000, signal });
      void connecting.then(() => {
        // Defensive cleanup for transports that finish starting after cancellation and close.
        if (signal?.aborted && closedDuringStartup) this.#trackCleanup(closeConnection(client, transport, this.#closeTimeoutMs));
      }, () => undefined);
      await abortable(connecting, signal);
      if (config.transport.kind !== 'stdio' && config.transport.auth === 'openai') attachOpenAiCatalogAdapter(transport, config.transport.openaiAppId!);
      attachMcpResultFallback(client, transport);
      const listed = await abortable(listToolCatalog(client, config.startupTimeoutMs, signal), signal);
      signal?.throwIfAborted();
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
      closedDuringStartup = true;
      signal?.throwIfAborted();
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
    const meta = tool.remote._meta ?? {};
    const ui = meta.ui as { resourceUri?: string; visibility?: string[] } | undefined;
    const resourceUri = ui?.resourceUri ?? meta['openai/outputTemplate'];
    return {
      registrationOwner: "runtime_mcp",
      mcpHook: {
        server: connection.config.id,
        tool: tool.remote.name,
        modelVisible: !ui?.visibility || ui.visibility.includes('model'),
        appCallable: ui ? !ui.visibility || ui.visibility.includes('app') : meta['openai/outputTemplate'] ? meta['openai/widgetAccessible'] === true : true,
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
      ...(typeof resourceUri === 'string' && resourceUri.startsWith('ui://') ? { mcpApp: {
        resourceUri,
        get connectionIdentity() { return !connection.retired && connection.health === 'ready' ? connection.client : undefined; },
        title: tool.remote.title ?? tool.remote.annotations?.title,
        serverTitle: connection.client.getServerVersion()?.title ?? connection.client.getServerVersion()?.name,
        readResource: async (uri: string, signal?: AbortSignal) => {
          if (connection.retired || connection.health !== 'ready') throw new Error('MCP UI service is no longer connected.');
          return connection.client.readResource({ uri }, { signal, timeout: 30_000 });
        },
      } } : {}),
      // UI-only metadata remains in native execution records, never in model context.
      renderModelResult: projectMcpResult,
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
                sdkCode: error instanceof McpResultValidationError ? error.sdkCode : mcpErrorCode(error),
                ...(error instanceof McpResultValidationError ? { rawResult: error.rawResult, resultValidationFailed: true } : {}),
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

  async #authenticate(connection: ConnectedServer, context: Pick<ToolHandlerContext<Record<string, unknown>>, 'sessionId' | 'turnId' | 'toolCall' | 'signal'>) {
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
      const recovery = new AbortController();
      connection.recoveryAbort = recovery;
      let transport: Transport | undefined;
      try {
        transport = await abortable(Promise.resolve(this.#createTransport(connection.config, recovery.signal)), recovery.signal);
        if (connection.retired) { await closeConnection(client, transport, this.#closeTimeoutMs); return; }
        drainTransportStderr(transport, connection.config.id, this.#onServerStderr);
        connection.pendingClient = client;
        connection.pendingTransport = transport;
        await client.connect(transport, { timeout: connection.config.startupTimeoutMs ?? 15_000 });
        if (connection.config.transport.kind !== 'stdio' && connection.config.transport.auth === 'openai') attachOpenAiCatalogAdapter(transport, connection.config.transport.openaiAppId!);
        attachMcpResultFallback(client, transport);
        const listed = await listToolCatalog(client, connection.config.startupTimeoutMs);
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
        if (connection.retired) { await settleWithin(client.close(), this.#closeTimeoutMs); return; }
        const authentication = authenticationFailure(error);
        connection.health = authentication?.health ?? "unavailable";
        connection.lastError = authentication?.error.message ?? errorMessage(error);
        this.#publishServiceState(connection, "cardbush_supervisor");
        if (transport) await closeConnection(client, transport, this.#closeTimeoutMs);
        else await settleWithin(client.close(), this.#closeTimeoutMs);
        if (authentication) { connection.restartPromise = undefined; return; }
      } finally {
        if (connection.recoveryAbort === recovery) connection.recoveryAbort = undefined;
      }
    }
  }

  async #retireConnections(connections: ConnectedServer[]): Promise<void> {
    connections.forEach((connection) => {
      connection.retired = true;
      connection.recoveryAbort?.abort();
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
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app', 'text/html+skybridge'] } } },
      versionNegotiation: {
        mode: server.versionMode === "modern"
          ? { pin: "2026-07-28" }
          : server.versionMode,
      },
    }, calls,
  );
}

export function createTransport(server: McpServerSnapshot, authProvider?: OAuthClientProvider, network?: { fetch: typeof fetch; env: Record<string, string> }): Transport {
  const transport = server.transport;
  if (transport.kind === "stdio") {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      cwd: transport.cwd,
      env: network ? { ...transport.env, ...network.env } : Object.keys(transport.env).length > 0 ? transport.env : undefined,
      stderr: "pipe",
    });
  }
  const requestInit = Object.keys(transport.headers).length > 0
    ? { headers: transport.headers }
    : undefined;
  const fetchWithHeaders = transport.headersHelper ? mcpHeaderFetch(transport.url,
    { ...transport.headersHelper, env: { ...transport.headersHelper.env, ...network?.env } }, network?.fetch) : network?.fetch;
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

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let onAbort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortErrorFromSignal(signal, 'MCP connection was cancelled.'));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function listToolCatalog(client: Client, timeoutMs = 60_000, signal?: AbortSignal): Promise<{ tools: McpTool[] }> {
  const tools: McpTool[] = [];
  const cursors = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let cursor: string | undefined;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('MCP tool catalog discovery timed out.');
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: remaining, signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('MCP tool catalog repeated a pagination cursor.');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return { tools };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
