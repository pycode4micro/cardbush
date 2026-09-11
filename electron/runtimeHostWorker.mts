import {
  BUSH_RUNTIME_ERROR_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  SHUTDOWN_RUNTIME_COMMAND,
  REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcInboundMessage,
  extractRuntimeIpcProtocol,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingIdentitySchema,
  runtimeIpcOutboundMessageSchema,
  mcpSnapshotSchema,
  pluginProxyEnvironment, type McpServerSnapshot, type NetworkProxySettings,
  type RuntimeIpcOutboundMessage,
  type RuntimeProtocolError,
  AUTOMATION_COMMAND, runtimeSessionTurnRequestSchema, type RuntimeProviderBindingRef,
} from '@cardbush/bush-protocol';
import {
  FileRuntimeCheckpointStore,
  FileRuntimeEventPersistence,
  FileCoordinationPersistence,
  FileSessionEventPersistence,
  FileSubagentTaskPersistence,
  FileToolExecutionPersistence,
  InMemoryRuntimeEventLog,
  InMemoryRuntimeHost,
  CoordinationStore,
  SessionStore,
  registerSkillTools,
  SubagentTaskStore,
  ToolExecutionStore,
  ToolRegistry,
  type ModelProvider,
  type SubagentPermissionPolicy,
  AutomationScheduler,
} from '@cardbush/bush-runtime';
import { McpClientManager, McpOAuthCoordinator, type CredentialState } from '@cardbush/bush-mcp-client';
import { ProxyFetchPool } from './proxyFetch.mjs';
import { openPluginAgentMcp } from './pluginAgentMcp.mjs';
import { McpHostBridge, isMcpHostMessage } from './mcpHostBridge.js';
import {
  decodeProductSubagentConfig,
  defaultProductSubagentConfig,
  readCardbushSearchResultLimit,
} from '@cardbush/product-host';
import {
  FileProviderCapabilityStore,
  InMemoryProviderCapabilityStore,
  OpenAIResponsesProvider,
  OpenAIResponsesProviderRegistry,
  openAIResponsesCapabilityScope,
  type ProviderCapabilityStore,
} from '@cardbush/bush-provider-openai';
import {
  loadEnabledProductPluginSkillRoots,
  loadEnabledProductPluginMcpServers,
  loadEnabledProductPluginExtensions,
  type PluginRoot,
} from './productPlugins.js';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The Runtime Host must run as an Electron Utility Process.');
}

const operations = new Map<string, AbortController>();
const mcpHost = new McpHostBridge(message => parentPort.postMessage(message));
const pluginFetches = new ProxyFetchPool();
async function pluginNetwork(server: Pick<McpServerSnapshot, 'networkProxy' | 'pluginId'> & { id?: string }, signal?: AbortSignal) {
  let config = server.networkProxy;
  if (!config) {
    const all = await mcpHost.request<{ default: NetworkProxySettings; plugins: Record<string, NetworkProxySettings>; servers?: Record<string, NetworkProxySettings> }>('network.configuration', {}, signal);
    config = all.plugins[server.pluginId ?? ''] ?? all.servers?.[server.id ?? ''] ?? all.default;
  }
  const endpoint = await mcpHost.request<string>('network.route', config, signal);
  return { fetch: pluginFetches.forEndpoint(endpoint), env: pluginProxyEnvironment(endpoint) };
}
const mcpOAuth = new McpOAuthCoordinator({
  read: key => mcpHost.request<CredentialState | undefined>('credentials.read', { key }),
  write: (key, value) => mcpHost.request<void>('credentials.write', { key, value }),
}, url => mcpHost.request<void>('open-url', { url }), server => async (input, init) => (await pluginNetwork(server, init?.signal ?? undefined)).fetch(input, init));
const subscriptions = new Map<string, AbortController>();
let host: InMemoryRuntimeHost;
let providers: OpenAIResponsesProviderRegistry;
let mcp: McpClientManager;
let mcpUpdate: Promise<unknown> = Promise.resolve();
let effectiveMcp: ReturnType<typeof mcpSnapshotSchema.parse> | undefined;
let effectiveMcpContent = '';
let sourceMcpRevision = 0;

async function handleMessage(input: unknown) {
  if (isMcpHostMessage(input)) { mcpHost.receive(input); return; }
  let message;
  try {
    message = decodeRuntimeIpcInboundMessage(input);
  } catch (error) {
    const received = extractRuntimeIpcProtocol(input);
    post({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'protocol_error',
      error: received !== BUSH_RUNTIME_IPC_PROTOCOL
        ? createProtocolVersionMismatchError(received)
        : runtimeError('protocol', 'invalid_ipc_message', errorMessage(error)),
    });
    return;
  }

  switch (message.type) {
    case 'command': {
      if (operations.has(message.operationId)) {
        postCommandError(
          message.operationId,
          runtimeError(
            'protocol',
            'duplicate_operation_id',
            `Operation ${message.operationId} already exists.`,
            message.operationId,
          ),
        );
        return;
      }
      const controller = new AbortController();
      operations.set(message.operationId, controller);
      try {
        const result = await executeRuntimeCommand(
          message.command,
          controller.signal,
        );
        post({
          protocol: BUSH_RUNTIME_IPC_PROTOCOL,
          type: 'command_response',
          operationId: message.operationId,
          ok: true,
          result,
        });
      } catch (error) {
        postCommandError(
          message.operationId,
          runtimeErrorFromUnknown(error, message.operationId, controller.signal.aborted),
        );
      } finally {
        operations.delete(message.operationId);
      }
      return;
    }
    case 'cancel_operation':
      operations.get(message.operationId)?.abort();
      return;
    case 'start_stream': {
      if (subscriptions.has(message.subscriptionId)) {
        postStreamError(
          message.subscriptionId,
          runtimeError(
            'protocol',
            'duplicate_subscription_id',
            `Subscription ${message.subscriptionId} already exists.`,
          ),
        );
        return;
      }
      const controller = new AbortController();
      subscriptions.set(message.subscriptionId, controller);
      void streamEvents(message.subscriptionId, message.request, controller);
      return;
    }
    case 'stop_stream':
      subscriptions.get(message.subscriptionId)?.abort();
      subscriptions.delete(message.subscriptionId);
      return;
  }
}

async function streamEvents(
  subscriptionId: string,
  request: {
    sessionId: string;
    turnId: string;
    cursor?: { afterSequence?: number; lastEventId?: string };
  },
  controller: AbortController,
) {
  try {
    for await (const event of host.openEventStream({
      ...request,
      signal: controller.signal,
    })) {
      post({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'stream_frame',
        subscriptionId,
        frame: { kind: 'event', event },
      });
    }
    post({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'stream_frame',
      subscriptionId,
      frame: { kind: 'end' },
    });
  } catch (error) {
    postStreamError(
      subscriptionId,
      runtimeError('runtime', 'runtime_stream_failed', errorMessage(error)),
    );
  } finally {
    subscriptions.delete(subscriptionId);
  }
}

function createEnvironmentProvider(
  capabilityStore: ProviderCapabilityStore,
): ModelProvider | undefined {
  const apiKey = process.env.CARDBUSH_RUNTIME_PROVIDER_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseURL = process.env.CARDBUSH_RUNTIME_PROVIDER_BASE_URL?.trim() || undefined;
  const config = {
    apiKey,
    baseURL,
    timeoutMs: positiveInteger(
      process.env.CARDBUSH_RUNTIME_PROVIDER_TIMEOUT_MS,
      undefined,
    ),
  };
  return new OpenAIResponsesProvider({
    ...config,
    capabilityStore,
    capabilityScope: openAIResponsesCapabilityScope(config),
  });
}

async function executeRuntimeCommand(
  command: { kind: string; payload: unknown },
  signal: AbortSignal,
) {
  if (command.kind === AUTOMATION_COMMAND) {
    if (!automation) throw new Error('Persistent automation storage is unavailable.');
    return automation.manage(command.payload);
  }
  if (command.kind === 'runtime.automation_start') { automation?.start(); return { started: Boolean(automation) }; }
  if (command.kind === SHUTDOWN_RUNTIME_COMMAND) {
    for (const controller of operations.values()) {
      if (controller.signal !== signal) controller.abort();
    }
    await host.sendCommand(command, signal);
    await automation?.close();
    const deadline = Date.now() + 5_000;
    while (host.hasActiveTurns() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await mcp.close();
    await pluginFetches.close();
    return { accepted: true, drained: !host.hasActiveTurns() };
  }
  if (command.kind === UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.upsert(runtimeProviderBindingConfigSchema.parse(command.payload));
  }
  if (command.kind === REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.remove(runtimeProviderBindingIdentitySchema.parse(command.payload));
  }
  if (command.kind === APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    const operation = mcpUpdate.then(async () => {
      const source = mcpSnapshotSchema.parse(command.payload);
      // A late UI read must not overwrite a newer saved configuration.
      if (source.snapshotId === effectiveMcp?.snapshotId && source.revision < sourceMcpRevision) {
        const current = mcp.snapshot();
        return current ? { ...current, configurationRevision: sourceMcpRevision } : null;
      }
      const pluginServers = await loadEnabledProductPluginMcpServers(
        pluginRoots, process.env.CARDBUSH_APPS_CONFIG_PATH?.trim() ?? '', source.servers,
      );
      const combined = mcpSnapshotSchema.parse(withBundledAppsServer({
        ...source, servers: [...source.servers, ...pluginServers],
      }));
      if (process.env.CARDBUSH_MCP_DESKTOP_BRIDGE === '1') {
        const network = await mcpHost.request<{ default: NetworkProxySettings; plugins: Record<string, NetworkProxySettings>; servers?: Record<string, NetworkProxySettings> }>('network.configuration', {}, signal);
        combined.servers = combined.servers.map(server => ({
          ...server, networkProxy: server.id === 'cardbush_management' ? { mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' } : network.plugins[server.pluginId ?? ''] ?? network.servers?.[server.id] ?? network.default,
        }));
      }
      const content = JSON.stringify({ snapshotId: combined.snapshotId, servers: combined.servers });
      const revision = effectiveMcp && content === effectiveMcpContent
        ? effectiveMcp.revision : Math.max(combined.revision, (effectiveMcp?.revision ?? 0) + 1);
      effectiveMcp = { ...combined, revision };
      effectiveMcpContent = content;
      sourceMcpRevision = source.revision;
      const result = mcp.submit(effectiveMcp);
      return { ...result, configurationRevision: sourceMcpRevision };
    });
    mcpUpdate = operation.catch(() => undefined);
    return operation;
  }
  if (command.kind === GET_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    const current = mcp.snapshot();
    return current ? { ...current, configurationRevision: sourceMcpRevision } : null;
  }
  if (command.kind === 'runtime.openai_account_changed') {
    await mcp.invalidateOpenAiConnections();
    const operation = mcpUpdate.then(async () => {
      if (!effectiveMcp) return null;
      const ids = effectiveMcp.servers.filter(server => server.transport.kind !== 'stdio' && server.transport.auth === 'openai').map(server => server.id);
      effectiveMcp = { ...effectiveMcp, revision: effectiveMcp.revision + 1 };
      return { ...mcp.submit(effectiveMcp, ids), configurationRevision: sourceMcpRevision };
    });
    mcpUpdate = operation.catch(() => undefined); return operation;
  }
  if (['runtime.mcp_login', 'runtime.mcp_logout', 'runtime.mcp_cancel_login', 'runtime.mcp_reconnect'].includes(command.kind)) {
    const id = String((command.payload as { serverId?: unknown })?.serverId ?? '');
    if (command.kind === 'runtime.mcp_cancel_login') { mcpOAuth.cancel(id); return { cancelled: true }; }
    const server = effectiveMcp?.servers.find(item => item.id === id);
    if (!server) throw new Error('This MCP service is not enabled. Enable it before connecting.');
    if (server.transport.kind !== 'stdio' && server.transport.auth === 'openai' && command.kind !== 'runtime.mcp_reconnect') {
      throw new Error('Manage the shared OpenAI login in CardBush plugin settings.');
    }
    if (command.kind === 'runtime.mcp_login') await mcp.login(server, signal);
    if (command.kind === 'runtime.mcp_logout') await mcpOAuth.logout(server);
    const operation = mcpUpdate.then(async () => {
      signal?.throwIfAborted();
      const current = effectiveMcp?.servers.find(item => item.id === id);
      if (!current || JSON.stringify(current.transport) !== JSON.stringify(server.transport)) throw new Error('This MCP connection changed during sign-in. Use the latest saved connection.');
      effectiveMcp = { ...effectiveMcp!, revision: effectiveMcp!.revision + 1 };
      return { ...mcp.submit(effectiveMcp, [id]), configurationRevision: sourceMcpRevision };
    });
    mcpUpdate = operation.catch(() => undefined);
    return operation;
  }
  return host.sendCommand(command, signal);
}

function withBundledAppsServer(input: unknown): unknown {
  const managementUrl = process.env.CARDBUSH_MCP_MANAGEMENT_URL?.trim();
  const managementToken = process.env.CARDBUSH_MCP_MANAGEMENT_TOKEN?.trim();
  const appsEntry = process.env.CARDBUSH_APPS_MCP_ENTRY?.trim();
  const chromeConnectorEntry = process.env.CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY?.trim();
  const chromeRemoteDebuggingEntry = process.env.CARDBUSH_CHROME_REMOTE_DEBUGGING_MCP_ENTRY?.trim();
  if (!managementUrl && !appsEntry && !chromeConnectorEntry && !chromeRemoteDebuggingEntry) return input;
  const snapshot = object(input, 'MCP snapshot must be an object.');
  const configured = Array.isArray(snapshot.servers) ? snapshot.servers : [];
  const reservedIds = new Set(['cardbush_apps', 'chrome_devtools', 'cardbush_management']);
  const overridden = configured.find((candidate) =>
    candidate && typeof candidate === 'object' && reservedIds.has(String((candidate as { id?: unknown }).id ?? ''))
  );
  if (overridden && typeof overridden === 'object') {
    throw new Error(`${String((overridden as { id?: unknown }).id)} is a bundled MCP server id and cannot be overridden.`);
  }
  const appsConfigPath = process.env.CARDBUSH_APPS_CONFIG_PATH?.trim();
  const appsConfig = readBundledAppsConfig(appsConfigPath);
  const sourceRevision = Number(snapshot.revision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
    throw new Error('MCP snapshot revision must be a positive integer.');
  }
  const revision = sourceRevision * 1_000_000 + appsConfig.revision;
  const bundled = [];
  if (managementUrl) {
    if (!managementToken) throw new Error('CardBush MCP management authentication is missing.');
    bundled.push({
      id: 'cardbush_management',
      toolTimeoutMs: 5 * 60_000,
      transport: { kind: 'streamable_http', url: managementUrl,
        headers: { Authorization: `Bearer ${managementToken}` } },
      defaultToolPolicy: { permission: 'ask', parallelSafe: false, visibleToChild: true },
      toolPolicies: {
        list_mcp_servers: { permission: 'allow', parallelSafe: true, visibleToChild: true },
        list_plugin_connections: { permission: 'allow', parallelSafe: true, visibleToChild: true },
      },
    });
  }
  if (!appsConfig.serviceEnabled) return { ...snapshot, revision, servers: [...bundled, ...configured] };
  if (appsEntry) {
    bundled.push({
      id: 'cardbush_apps',
      pluginId: 'computer-use',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [appsEntry],
        env: runtimeChildEnvironment({
          ELECTRON_RUN_AS_NODE: '1',
          ...(appsConfigPath ? { CARDBUSH_APPS_CONFIG_PATH: appsConfigPath } : {}),
          // The bundled Apps process reads its config at launch. Only that
          // connection needs replacement when its effective config changes.
          CARDBUSH_APPS_CONFIG_FINGERPRINT: appsConfig.fingerprint,
        }),
      },
      versionMode: 'auto',
      defaultToolPolicy: {
        permission: 'ask',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    });
  }
  const chromeEntry = appsConfig.chromeConnectionMode === 'remote_debugging'
    ? chromeRemoteDebuggingEntry
    : chromeConnectorEntry;
  if (chromeEntry && appsConfig.enabledPluginIds.has('chrome')) {
    const remoteDebugging = appsConfig.chromeConnectionMode === 'remote_debugging';
    bundled.push({
      id: 'chrome_devtools',
      pluginId: 'chrome',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: remoteDebugging
          ? [
              chromeEntry,
              '--no-usage-statistics',
              '--no-performance-crux',
              // Advanced compatibility mode only. It never launches a
              // separate profile and only attaches to an opted-in Chrome.
              '--auto-connect',
            ]
          : [chromeEntry],
        env: runtimeChildEnvironment({
          ELECTRON_RUN_AS_NODE: '1',
          ...(remoteDebugging ? {
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          } : {
            CARDBUSH_CHROME_CONNECTOR_CONFIG:
              process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG?.trim() ?? '',
          }),
        }),
      },
      versionMode: 'auto',
      restartBackoffMs: 500,
      defaultToolPolicy: {
        // The connector extension enforces per-tab/per-site consent. Avoid a
        // duplicate CardBush permission prompt for every browser command.
        permission: remoteDebugging ? 'ask' : 'allow',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    });
    console.error(JSON.stringify({
      type: 'runtime_chrome_connection',
      requestedMode: appsConfig.chromeConnectionMode,
      effectiveMode: appsConfig.chromeConnectionMode,
      reason: remoteDebugging ? 'advanced_remote_debugging' : 'extension_native_messaging',
    }));
  }
  return {
    ...snapshot,
    revision,
    servers: [...bundled, ...configured],
  };
}

function readBundledAppsConfig(path: string | undefined): {
  serviceEnabled: boolean;
  revision: number;
  enabledPluginIds: Set<string>;
  chromeConnectionMode: 'connector' | 'remote_debugging';
  fingerprint: string;
} {
  if (!path) {
    return {
      serviceEnabled: true,
      revision: 1,
      enabledPluginIds: new Set(),
      chromeConnectionMode: 'connector',
      fingerprint: '',
    };
  }
  if (!isAbsolute(path)) throw new Error('CARDBUSH_APPS_CONFIG_PATH must be absolute.');
  try {
    const value = object(JSON.parse(readFileSync(path, 'utf8')), 'Apps config must be an object.');
    if (typeof value.serviceEnabled !== 'boolean') {
      throw new Error('Apps config serviceEnabled must be a boolean.');
    }
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision >= 1_000_000) {
      throw new Error('Apps config revision must be a positive integer below 1000000.');
    }
    const plugins = Array.isArray(value.plugins) ? value.plugins : [];
    const enabledPluginIds = new Set(plugins.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const plugin = candidate as Record<string, unknown>;
      const id = String(plugin.id ?? '').trim().replaceAll('_', '-');
      return id && plugin.installed === true && plugin.enabled === true ? [id] : [];
    }));
    const chromePlugin = plugins.find((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      return String((candidate as Record<string, unknown>).id ?? '').replaceAll('_', '-') === 'chrome';
    }) as Record<string, unknown> | undefined;
    const chromeConfig = chromePlugin?.config && typeof chromePlugin.config === 'object' &&
      !Array.isArray(chromePlugin.config)
      ? chromePlugin.config as Record<string, unknown>
      : {};
    const chromeConnectionMode = chromeConfig.connectionMode === 'remote_debugging'
      ? 'remote_debugging' as const
      : 'connector' as const;
    return {
      serviceEnabled: value.serviceEnabled,
      revision,
      enabledPluginIds,
      chromeConnectionMode,
      fingerprint: createHash('sha256').update(JSON.stringify({
        serviceEnabled: value.serviceEnabled,
        plugins: plugins.filter((candidate) => candidate && typeof candidate === 'object' &&
          ['computer-use', 'computer_use'].includes(String((candidate as Record<string, unknown>).id))),
      })).digest('hex'),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        serviceEnabled: true,
        revision: 1,
        enabledPluginIds: new Set(),
        chromeConnectionMode: 'connector',
        fingerprint: '',
      };
    }
    throw error;
  }
}

function runtimeChildEnvironment(extra: Record<string, string>): Record<string, string> {
  const inheritedKeys = [
    'APPDATA',
    'HOME',
    'LOCALAPPDATA',
    'PATH',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ];
  const inherited = Object.fromEntries(inheritedKeys.flatMap((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value ? [[key, value]] : [];
  }));
  return { ...inherited, ...extra };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function readSubagentPermissionPolicy(path: string | undefined): SubagentPermissionPolicy {
  const fallback = defaultProductSubagentConfig();
  if (!path) return {
    permissionRouting: fallback.permissionRouting,
    childPermissionMode: fallback.childPermissionMode,
    model: { mode: 'inherit' },
    disabledTools: fallback.disabledTools,
  };
  if (!isAbsolute(path)) throw new Error('CARDBUSH_SUBAGENT_CONFIG_PATH must be absolute.');
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(fallback, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return {
        permissionRouting: fallback.permissionRouting,
        childPermissionMode: fallback.childPermissionMode,
        model: { mode: 'inherit' },
        disabledTools: fallback.disabledTools,
      };
    }
    throw error;
  }
  const config = decodeProductSubagentConfig(payload);
  if (JSON.stringify(payload) !== JSON.stringify(config)) {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (config.permissionRouting === 'parent' && config.childPermissionMode !== 'task_free') {
    process.stderr.write(`${JSON.stringify({
      code: 'subagent_elevated_permission_mode',
      message: `Subagent childPermissionMode is ${config.childPermissionMode}; child Agents may operate beyond project-scoped task_free boundaries.`,
    })}\n`);
  }
  return {
    permissionRouting: config.permissionRouting,
    childPermissionMode: config.childPermissionMode,
    model: { mode: 'inherit' },
    disabledTools: config.disabledTools,
  };
}

const runtimeStateRoot = process.env.CARDBUSH_RUNTIME_STATE_ROOT?.trim();
if (runtimeStateRoot && !isAbsolute(runtimeStateRoot)) {
  throw new Error('CARDBUSH_RUNTIME_STATE_ROOT must be an absolute path.');
}
const subagentPermissionPolicy = readSubagentPermissionPolicy(
  process.env.CARDBUSH_SUBAGENT_CONFIG_PATH?.trim(),
);
const eventLog = runtimeStateRoot
  ? new InMemoryRuntimeEventLog({
      persistence: new FileRuntimeEventPersistence({
        root: join(runtimeStateRoot, 'events'),
        onRecoveryIssue: (issue) => {
          process.stderr.write(`${JSON.stringify(issue)}\n`);
        },
      }),
    })
  : undefined;
const checkpointStore = runtimeStateRoot
  ? new FileRuntimeCheckpointStore(join(runtimeStateRoot, 'checkpoints'))
  : undefined;
const sessionPersistence = runtimeStateRoot
  ? new FileSessionEventPersistence({
      root: join(runtimeStateRoot, 'sessions'),
      onRecoveryIssue: (issue) => {
        process.stderr.write(`${JSON.stringify(issue)}\n`);
      },
    })
  : undefined;
const toolExecutionPersistence = runtimeStateRoot
  ? new FileToolExecutionPersistence({
      root: join(runtimeStateRoot, 'tool-executions'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;
const coordinationPersistence = runtimeStateRoot
  ? new FileCoordinationPersistence({
      root: join(runtimeStateRoot, 'coordination'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;
const subagentPersistence = runtimeStateRoot
  ? new FileSubagentTaskPersistence({
      root: join(runtimeStateRoot, 'subagents'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;

const providerCapabilityStore = runtimeStateRoot
  ? new FileProviderCapabilityStore(join(runtimeStateRoot, 'provider-capabilities.json'))
  : new InMemoryProviderCapabilityStore();
providers = new OpenAIResponsesProviderRegistry({
  fallbackProvider: createEnvironmentProvider(providerCapabilityStore),
  capabilityStore: providerCapabilityStore,
});

const toolRegistry = new ToolRegistry();
const loadSearchResultLimit = () => readCardbushSearchResultLimit(process.env.CARDBUSH_APPS_CONFIG_PATH?.trim());
const skillRoots = skillRootsFromEnvironment();
const pluginRoots = pluginRootsFromEnvironment();
const automation = runtimeStateRoot ? new AutomationScheduler({
  path: join(runtimeStateRoot, 'scheduler', 'automations.json'),
  canRun: sessionId => !host.hasActiveSession(sessionId),
  changed: () => { void mcpHost.request('automation.changed', {}).catch(() => {}); },
  onError: error => process.stderr.write(`${JSON.stringify({ code: 'automation_error', message: errorMessage(error) })}\n`),
  run: async (job, run, context, signal) => {
    signal.throwIfAborted();
    const session = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: job.sessionId } }, signal);
    if (!session) throw new Error('The target conversation was removed.');
    if (job.plugin) {
      const extensions = await loadEnabledProductPluginExtensions(pluginRoots, process.env.CARDBUSH_APPS_CONFIG_PATH?.trim() ?? '');
      if (!extensions.hooks.some(hook => hook.id === job.plugin!.hookId && hook.definitionHash === job.plugin!.definitionHash && hook.trusted === true)) throw new Error('The originating plugin hook is disabled, changed, or no longer trusted.');
    }
    const selected = await mcpHost.request<{ model: string; binding: RuntimeProviderBindingRef; maxContextTokens?: number; maxOutputTokens?: number }>('automation.prepare-model', { modelId: context.providerBinding?.bindingId ?? context.model }, signal);
    signal.throwIfAborted();
    const allowed = new Set(context.tools.map(tool => tool.name));
    const request = runtimeSessionTurnRequestSchema.parse({ ...context,
      protocol: 'bush.session_turn_request.v1', sessionId: job.sessionId, turnId: run.turnId, requestId: `request_${run.id}`,
      model: selected.model, providerBinding: selected.binding,
      maxOutputTokens: selected.maxOutputTokens ?? context.maxOutputTokens,
      tools: toolRegistry.definitions().filter(tool => allowed.has(tool.name)),
      prefixMessages: [...context.prefixMessages, { role: 'developer', name: 'automation_context', content:
        `This turn was activated by the saved automation ${JSON.stringify(job.name)}. Trigger: ${run.reason}. Current time: ${new Date().toISOString()}. Time zone: ${job.timeZone}. Execute its saved prompt in this conversation. Do not infer a request to create further automations. Existing permissions still apply.` }],
      inputMessages: [{ messageId: `message_${run.id}`, createdAt: new Date().toISOString(), message: { role: 'user', name: 'automation_prompt', content: job.prompt } }],
      sessionMetadata: {},
      metadata: { ...context.metadata, automationRunId: run.id, automationId: job.id,
        ...(selected.maxContextTokens ? { maxContextTokens: selected.maxContextTokens } : {}) },
    });
    const result = await host.runSessionTurn(request, { signal });
    if (result.kind !== 'turn_terminal') throw new Error('Automation did not produce a terminal result.');
    return { status: result.payload.status, reason: result.payload.reason };
  },
}) : undefined;
if (skillRoots.length > 0 || pluginRoots.length > 0) {
  registerSkillTools(toolRegistry, async () => {
    try {
      const activePluginRoots = await loadEnabledProductPluginSkillRoots(
        pluginRoots,
        process.env.CARDBUSH_APPS_CONFIG_PATH?.trim() ?? '',
      );
      return [
        ...skillRoots.slice(0, 1),
        ...activePluginRoots,
        ...skillRoots.slice(1),
      ];
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        code: 'runtime_plugin_skill_discovery_failed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`);
      return skillRoots;
    }
  }, loadSearchResultLimit);
}

host = new InMemoryRuntimeHost({
  loadSearchResultLimit,
  ...(process.env.CARDBUSH_MCP_DESKTOP_BRIDGE === '1' ? { pluginNetwork: (pluginId: string) => pluginNetwork({ pluginId }) } : {}),
  automation,
  provider: providers,
  toolRegistry,
  dataRoot: runtimeStateRoot,
  eventLog,
  checkpointStore,
  sessionStore: new SessionStore({ persistence: sessionPersistence }),
  toolExecutionStore: new ToolExecutionStore({
    persistence: toolExecutionPersistence,
  }),
  coordinationStore: new CoordinationStore({
    persistence: coordinationPersistence,
  }),
  subagentTaskStore: new SubagentTaskStore({
    persistence: subagentPersistence,
  }),
  durableRecovery: Boolean(runtimeStateRoot),
  durableSessions: Boolean(runtimeStateRoot),
  durableCoordination: Boolean(runtimeStateRoot),
  durableSubagentTasks: Boolean(runtimeStateRoot),
  subagentPermissionPolicy,
  loadPluginExtensions: () => loadEnabledProductPluginExtensions(pluginRoots, process.env.CARDBUSH_APPS_CONFIG_PATH?.trim() ?? ''),
  openAgentMcpScope: (agent, request, signal) => openPluginAgentMcp(mcp, agent, request, signal),
  requestBackgroundPermission: async (input, signal) => {
    const result = await mcpHost.request<{ action: string; content?: { allow?: boolean } }>('elicitation', {
      serverId: 'cardbush_background_agent', sessionId: input.sessionId, turnId: input.turnId, toolCallId: input.toolCallId,
      params: { mode: 'form', message: `${input.reason}\n${input.targets.map(target => target.value).join('\n')}`, requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: '允许后台 Agent 执行本次操作 / Allow this background Agent action', default: false } }, required: ['allow'] } },
    }, signal);
    return result.action === 'accept' && result.content?.allow === true;
  },
  settleOrphanedTurns: Boolean(runtimeStateRoot),
  additionalSupportedCommands: [
    AUTOMATION_COMMAND,
    UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
    REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
    APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
    GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  ],
  additionalFeatures: [
    "product_mcp_snapshot",
    "mcp_protocol_2",
    "bundled_cardbush_apps_mcp",
    "native_image_inputs",
  ],
  hostId: `electron-utility-${process.pid}`,
  runtimeVersion: '0.1.0',
  // Keep transient provider failures alive by default; an explicit positive cap is optional.
  maxAttempts: process.env.CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS?.trim()
    ? positiveInteger(process.env.CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS, 5)
    : null,
  onRecoveryError: (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: 'runtime_checkpoint_cleanup_failed', message: error.message })}\n`,
    );
  },
});
mcp = new McpClientManager({
  ...(process.env.CARDBUSH_MCP_DESKTOP_BRIDGE === '1' ? {
    network: pluginNetwork,
    oauth: mcpOAuth,
    openai: {
      getToken: input => mcpHost.request('openai.access-token', { rejectedToken: input.rejectedToken }, input.signal),
    },
    onElicitation: (({ signal: _signal, ...input }, signal) => mcpHost.request('elicitation', input, signal)) as import('@cardbush/bush-mcp-client').McpElicitationHandler,
    onAuthenticationRequired: async (input, signal) => (await mcpHost.request<{ action: string }>('authentication', input, signal)).action === 'accept',
  } : {}),
  registry: toolRegistry,
  canApply: () => !host.hasActiveTurns(),
  onServiceStateChange: (state) => {
    process.stderr.write(`${JSON.stringify({
      code: 'runtime_mcp_service_state',
      ...state,
    })}\n`);
  },
  onServerStderr: (entry) => {
    process.stderr.write(`${JSON.stringify({
      code: 'runtime_mcp_stderr',
      ...entry,
    })}\n`);
  },
});

function skillRootsFromEnvironment(): string[] {
  const raw = process.env.CARDBUSH_RUNTIME_SKILL_ROOTS?.trim();
  if (!raw) return [];
  let roots: unknown;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('CARDBUSH_RUNTIME_SKILL_ROOTS must be a JSON array.');
  }
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Every Runtime Skill root must be an absolute path.');
  }
  return roots;
}

function pluginRootsFromEnvironment(): PluginRoot[] {
  const raw = process.env.CARDBUSH_RUNTIME_PLUGIN_ROOTS?.trim();
  if (!raw) return [];
  let roots: unknown;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('CARDBUSH_RUNTIME_PLUGIN_ROOTS must be a JSON array.');
  }
  if (!Array.isArray(roots)) {
    throw new Error('CARDBUSH_RUNTIME_PLUGIN_ROOTS must be a JSON array.');
  }
  return roots.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Every Runtime plugin root must be an object.');
    }
    const root = candidate as Record<string, unknown>;
    if (typeof root.path !== 'string' || !isAbsolute(root.path) ||
        (root.source !== 'bundled' && root.source !== 'user')) {
      throw new Error('Every Runtime plugin root must have an absolute path and valid source.');
    }
    return { path: root.path, source: root.source };
  });
}

parentPort.on('message', (messageEvent) => {
  void handleMessage(messageEvent.data);
});

post({
  protocol: BUSH_RUNTIME_IPC_PROTOCOL,
  type: 'ready',
  capabilities: host.capabilities(),
});

function post(message: RuntimeIpcOutboundMessage) {
  parentPort.postMessage(runtimeIpcOutboundMessageSchema.parse(message));
}

function postCommandError(operationId: string, error: RuntimeProtocolError) {
  post({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'command_response',
    operationId,
    ok: false,
    error,
  });
}

function postStreamError(subscriptionId: string, error: RuntimeProtocolError) {
  post({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'stream_frame',
    subscriptionId,
    frame: { kind: 'error', error },
  });
}

function runtimeError(
  kind: RuntimeProtocolError['kind'],
  code: string,
  message: string,
  requestId?: string,
): RuntimeProtocolError {
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    kind,
    code,
    message,
    retryable: false,
    details: {},
    requestId,
  };
}

function runtimeErrorFromUnknown(
  error: unknown,
  requestId?: string,
  cancelled = false,
): RuntimeProtocolError {
  if (cancelled) {
    return runtimeError('cancelled', 'operation_cancelled', errorMessage(error), requestId);
  }
  const value = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = typeof value.code === 'string' && value.code.trim()
    ? value.code.trim()
    : 'runtime_command_failed';
  const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? value.details as Record<string, unknown>
    : {};
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    kind: value.kind === 'protocol' || value.kind === 'transport' ||
      value.kind === 'runtime' || value.kind === 'cancelled'
      ? value.kind
      : 'runtime',
    code,
    message: errorMessage(error),
    retryable: value.retryable === true,
    details,
    requestId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(
  input: string | undefined,
  fallback: number,
): number;
function positiveInteger(
  input: string | undefined,
  fallback: undefined,
): number | undefined;
function positiveInteger(
  input: string | undefined,
  fallback: number | undefined,
): number | undefined {
  const value = Number(input);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
