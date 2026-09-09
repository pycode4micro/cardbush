import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { mcpOAuthConfigSchema, mcpOAuthFromConfig, mcpServerSnapshotSchema } from '@cardbush/bush-protocol';
import type { McpCredentialStore } from '@cardbush/bush-mcp-client';
import type { CardbushAppsConfigStore, CardbushAppPluginConfig, ProductMcpConfigStore } from '@cardbush/product-host';
import { pluginRootForManifest, resolvePluginManifest } from './pluginManifest.js';
import { resolvePluginMcpConnection } from './pluginMcpConfiguration.mjs';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const optionalText = z.string().min(1).nullable().optional();
const oauthPatch = mcpOAuthConfigSchema.partial().extend({
  clientId: optionalText, clientSecretEnv: optionalText, clientSecretRef: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  callbackUrl: z.string().url().nullable().optional(), callbackPort: z.number().int().min(0).max(65535).nullable().optional(),
  resourceUrl: z.string().url().nullable().optional(), clientMetadataUrl: z.string().url().nullable().optional(), scopes: z.array(z.string()).nullable().optional(),
  client_id: optionalText, client_secret_env: optionalText, client_secret_ref: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  callback_url: z.string().url().nullable().optional(), callback_port: z.number().int().min(0).max(65535).nullable().optional(),
  oauth_resource: z.string().url().nullable().optional(), client_metadata_url: z.string().url().nullable().optional(),
}).strict();
const toolPolicy = z.object({ enabled: z.boolean().optional(), approval_mode: z.enum(['prompt', 'approve', 'deny']).optional(),
  parallel_safe: z.boolean().optional(), visible_to_child: z.boolean().optional() }).strict();
export const pluginConnectionSettingsSchema = z.object({
  provider: z.enum(['openai', 'direct']).nullable().optional().describe('For registered apps: openai uses the shared OpenAI account, direct uses package/user transport. Clear an existing server binding with server:null when selecting openai. Other direct settings are preserved.'),
  enabled: z.boolean().optional(), required: z.boolean().optional(), server: optionalText,
  default_tools_approval_mode: z.enum(['prompt', 'approve']).optional(),
  enabled_tools: z.array(z.string().min(1)).nullable().optional(), disabled_tools: z.array(z.string().min(1)).nullable().optional(),
  tools: z.record(z.string(), toolPolicy.nullable()).optional(), oauth: oauthPatch.optional(),
  connection: z.object({ url: z.string().url().nullable().optional(), auth: z.enum(['oauth', 'none']).optional() }).strict().optional(),
}).strict();
export const pluginConnectionIdentitySchema = z.object({ pluginId: z.string().min(1), componentId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict();
export const configurePluginConnectionSchema = pluginConnectionIdentitySchema.extend({ settings: pluginConnectionSettingsSchema });
const saveSchema = z.object({ pluginId: z.string().min(1), expectedRevision: z.number().int().positive(),
  // Keep existing transport overrides and extension fields when editing another
  // setting. The shared runtime resolver validates the effective connection.
  connections: z.record(z.string(), z.record(z.string(), z.unknown())),
  secrets: z.record(z.string(), z.string().trim().min(1).max(8192).nullable()).optional(),
}).strict();
export type ConfigurePluginConnectionInput = z.infer<typeof configurePluginConnectionSchema>;
export type PluginConnectionIdentity = z.infer<typeof pluginConnectionIdentitySchema>;
export type SavePluginConnectionsInput = z.infer<typeof saveSchema>;
export type ClientCredentialsPrompt = { serverId: string; endpoint: string; clientId: string };
export type ClientCredentialsAnswer = { action: string; content?: { clientId: string; clientSecret: string } };

/** The existing Apps store owns configuration; the desktop vault owns only secret bytes. */
export class PluginConnectionManager {
  constructor(private readonly options: {
    apps: CardbushAppsConfigStore; mcp: ProductMcpConfigStore; credentials?: McpCredentialStore;
    refresh: () => Promise<unknown>; runtime: () => Promise<{ runtime: unknown; runtimeError?: string }>;
    requestCredentials?: (input: ClientCredentialsPrompt, signal: AbortSignal) => Promise<ClientCredentialsAnswer>;
  }) {}

  async list(pluginId?: string) {
    const config = await this.options.apps.read();
    const plugins = config.plugins.filter(plugin => plugin.installed && !['chrome', 'computer-use'].includes(plugin.id) && (!pluginId || plugin.id === pluginId));
    const connections = [];
    for (const plugin of plugins) for (const component of plugin.components.filter(item => item.kind === 'mcp' || item.kind === 'app')) {
      const settings = record(record(plugin.config.mcp_servers)[component.id]);
      let effective, configurationError;
      try { effective = await this.resolve(plugin, component.id, { ...settings, required: false }); }
      catch (error) { configurationError = error instanceof Error ? error.message : String(error); }
      connections.push({ pluginId: plugin.id, componentId: component.id, name: component.name,
        serverId: `plugin_${plugin.id.replaceAll('.', '_')}_${component.id}`, pluginEnabled: plugin.enabled,
        settings: publicSettings(settings),
        effective: effective ? { transport: effective.transport.kind, ...(effective.transport.kind === 'stdio' ? {} : {
          auth: effective.transport.auth, openaiAppId: effective.transport.openaiAppId,
          endpoint: effective.transport.url, oauth: effective.transport.oauth,
          hasCredentialReference: Boolean(effective.transport.oauth?.clientSecretRef),
        }) } : null, ...(configurationError ? { configurationError } : {}) });
    }
    return { configurationRevision: config.revision, connections, ...await this.runtimeStatus() };
  }

  async configure(candidate: unknown, signal?: AbortSignal) {
    const input = configurePluginConnectionSchema.parse(candidate);
    const { plugin } = await this.current(input.pluginId, input.expectedRevision);
    this.component(plugin, input.componentId);
    const connections = { ...record(plugin.config.mcp_servers) };
    const prior = record(connections[input.componentId]);
    const settings = merge(prior, input.settings);
    for (const key of ['oauth', 'connection', 'tools']) {
      if (input.settings[key as keyof typeof input.settings] !== undefined) settings[key] = merge(record(prior[key]), record(input.settings[key as keyof typeof input.settings]));
    }
    if (input.settings.oauth) settings.oauth = mcpOAuthFromConfig(settings.oauth, input.settings.oauth);
    if (input.settings.tools) {
      const policies = merge(record(prior.tools), input.settings.tools);
      for (const [name, policy] of Object.entries(input.settings.tools)) if (policy !== null) policies[name] = merge(record(record(prior.tools)[name]), policy);
      settings.tools = policies;
    }
    connections[input.componentId] = settings;
    return publicReceipt(await this.save({ pluginId: input.pluginId, expectedRevision: input.expectedRevision, connections }, signal));
  }

  async save(candidate: unknown, signal?: AbortSignal) {
    const input = saveSchema.parse(candidate);
    const { config, plugin } = await this.current(input.pluginId, input.expectedRevision);
    const connections: Json = structuredClone(input.connections);
    const created: string[] = [];
    try {
      for (const [name, raw] of Object.entries(connections)) {
        this.component(plugin, name);
        const settings = record(raw);
        if (settings.oauth) settings.oauth = mcpOAuthFromConfig(settings.oauth);
        await this.resolve(plugin, name, { ...settings, required: false });
      }
      for (const [name, value] of Object.entries(input.secrets ?? {})) {
        this.component(plugin, name);
        const settings = record(connections[name]);
        if (value === null) {
          const oauth = mcpOAuthFromConfig(settings.oauth); delete oauth.clientSecretRef;
          settings.oauth = oauth; connections[name] = settings; continue;
        }
        if (!this.options.credentials) throw new Error('Secure credential storage is unavailable.');
        const server = await this.resolve(plugin, name, { ...settings, enabled: true, required: true });
        if (!server || server.transport.kind === 'stdio' || server.transport.auth === 'openai') throw new Error('Client credentials require a directly configured HTTP MCP endpoint.');
        const clientId = server.transport.oauth?.clientId;
        if (!clientId || /^<[^<>]+>$/.test(clientId.trim())) throw new Error('Enter a valid OAuth client ID before saving the client secret.');
        signal?.throwIfAborted();
        const ref = randomBytes(32).toString('hex');
        await this.options.credentials.write(ref, { clientSecret: { value, url: new URL(server.transport.url).href, clientId } });
        created.push(ref);
        settings.oauth = mcpOAuthFromConfig(settings.oauth, { clientSecretRef: ref });
        connections[name] = settings;
      }
      signal?.throwIfAborted();
      const saved = await this.options.apps.write({ expectedRevision: input.expectedRevision, serviceEnabled: config.serviceEnabled,
        plugins: [{ id: plugin.id, installed: plugin.installed, enabled: plugin.enabled, config: { ...plugin.config, mcp_servers: connections } }] });
      created.length = 0; // Config now owns the references; never roll them back on refresh failure.
      let applicationError;
      try { await this.options.refresh(); } catch (error) { applicationError = error instanceof Error ? error.message : String(error); }
      return { saved: true, configurationRevision: saved.revision, connections,
        ...await this.runtimeStatus(), ...(applicationError ? { applicationError } : {}) };
    } finally {
      for (const ref of created) await this.options.credentials?.write(ref, undefined);
    }
  }

  async requestCredentials(candidate: unknown, signal: AbortSignal) {
    const input = pluginConnectionIdentitySchema.parse(candidate);
    const { plugin } = await this.current(input.pluginId, input.expectedRevision);
    this.component(plugin, input.componentId);
    const connections = { ...record(plugin.config.mcp_servers) };
    const settings = record(connections[input.componentId]);
    const server = await this.resolve(plugin, input.componentId, { ...settings, enabled: true, required: true });
    if (!server || server.transport.kind === 'stdio' || server.transport.auth === 'openai') throw new Error('Client credentials require a directly configured HTTP MCP endpoint.');
    if (!this.options.requestCredentials) throw new Error('The desktop credential form is unavailable.');
    const clientId = server.transport.oauth?.clientId ?? '';
    const answer = await this.options.requestCredentials({ serverId: server.id, endpoint: server.transport.url,
      clientId: /^<[^<>]+>$/.test(clientId.trim()) ? '' : clientId }, signal);
    signal.throwIfAborted();
    if (answer.action !== 'accept' || !answer.content) return { saved: false, action: answer.action };
    settings.oauth = mcpOAuthFromConfig(settings.oauth, { clientId: answer.content.clientId });
    connections[input.componentId] = settings;
    return publicReceipt(await this.save({ pluginId: input.pluginId, expectedRevision: input.expectedRevision, connections,
      secrets: { [input.componentId]: answer.content.clientSecret } }, signal));
  }

  private async current(pluginId: string, expectedRevision: number) {
    const config = await this.options.apps.read();
    if (config.revision !== expectedRevision) throw new Error('Plugin configuration changed; refresh before saving again.');
    const plugin = config.plugins.find(plugin => plugin.id === pluginId && plugin.installed);
    if (!plugin || ['chrome', 'computer-use'].includes(plugin.id)) throw new Error('This plugin has no externally configurable MCP connections.');
    return { config, plugin };
  }
  private async runtimeStatus() {
    try { return await this.options.runtime(); }
    catch (error) { return { runtime: null, runtimeError: error instanceof Error ? error.message : String(error) }; }
  }
  private component(plugin: CardbushAppPluginConfig, name: string) {
    if (!plugin.components.some(item => item.id === name && (item.kind === 'mcp' || item.kind === 'app'))) throw new Error('Unknown plugin MCP connection.');
  }
  private async resolve(plugin: CardbushAppPluginConfig, name: string, settings: Json) {
    const root = pluginRootForManifest(plugin.manifestPath);
    const manifest = await resolvePluginManifest(root);
    const configured = await this.options.mcp.read();
    const standalone = configured.servers.map(server => ({ ...server, transport: server.transport === 'stdio' ? {
      kind: 'stdio', command: server.command, args: server.args, cwd: server.cwd, env: server.env,
    } : { kind: server.transport === 'sse' ? 'sse' : 'streamable_http', url: server.url, headers: server.headers,
      oauth: mcpOAuthFromConfig(server.oauth), auth: server.auth } }));
    const value = resolvePluginMcpConnection(plugin.id, name, root, record(manifest.manifest.mcpServers), manifest.registeredApps, settings, standalone);
    return value ? mcpServerSnapshotSchema.parse(value) : null;
  }
}

function merge(prior: Json, patch: Json): Json {
  const result = { ...prior };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete result[key]; else result[key] = value; }
  return result;
}

function publicSettings(settings: Json) {
  const connection = record(settings.connection);
  return { enabled: settings.enabled, required: settings.required, server: settings.server, provider: settings.provider,
    default_tools_approval_mode: settings.default_tools_approval_mode, enabled_tools: settings.enabled_tools,
    disabled_tools: settings.disabled_tools, oauth: mcpOAuthFromConfig(settings.oauth),
    tools: Object.fromEntries(Object.entries(record(settings.tools)).map(([name, value]) => {
      const policy = record(value);
      return [name, { enabled: policy.enabled, approval_mode: policy.approval_mode,
        parallel_safe: policy.parallel_safe, visible_to_child: policy.visible_to_child }];
    })),
    connection: { url: connection.url, auth: connection.auth },
  };
}

function publicReceipt<T extends { connections: Json }>(result: T) {
  return { ...result, connections: Object.fromEntries(Object.entries(result.connections).map(([name, settings]) => [name, publicSettings(record(settings))])) };
}
