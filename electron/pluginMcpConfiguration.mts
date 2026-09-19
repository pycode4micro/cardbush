import { resolve } from 'node:path';
import { MissingPluginEnvironmentError, pluginHostEnvironment } from './pluginEnvironment.js';
import { mcpOAuthFromConfig, OPENAI_HOSTED_PROTOCOL, usesOpenAiHostedConnection } from '@cardbush/bush-protocol';
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;

/** One resolver for runtime loading and configuration/credential validation. */
export function resolvePluginMcpConnection(pluginId: string, name: string, root: string,
  declarations: Json, registeredApps: Json, configured: unknown, standalone: Json[] = [], dataRoot?: string) {
  const settings = record(configured);
  let declaration = record(declarations[name]);
  const required = (settings.required ?? record(registeredApps[name]).required ?? declaration.required) === true;
  let configuration: Json = { ...settings, required };
  const missing = () => {
    if (required) throw new Error(`Plugin ${pluginId} requires MCP connection ${name}. Configure and enable that connection in plugin settings.`);
    return null;
  };
  if (settings.enabled === false) return missing();
  const appId = record(registeredApps[name]).id;
  if (usesOpenAiHostedConnection(appId, settings)) {
    const configured = pluginMcpServer(pluginId, name, root, { type: 'http', url: OPENAI_HOSTED_PROTOCOL.mcpEndpoint }, { ...settings, connection: undefined, required }, dataRoot);
    return configured ? { ...configured, versionMode: 'legacy', transport: {
      kind: 'streamable_http', url: OPENAI_HOSTED_PROTOCOL.mcpEndpoint, headers: {}, auth: 'openai', openaiAppId: appId,
    } } : null;
  }
  if (Object.hasOwn(registeredApps, name) && settings.server) {
    const binding = standalone.find(item => item.id === settings.server && item.enabled !== false);
    if (!binding) return missing();
    const transport = record(binding.transport);
    declaration = { ...transport, type: transport.kind };
    configuration = { ...configuration, connection: undefined };
  } else if (!Object.hasOwn(declarations, name) && !record(settings.connection).url) return missing();
  return pluginMcpServer(pluginId, name, root, declaration, configuration, dataRoot);
}

/** Package declarations describe transport; user-owned plugin config alone grants tool approval. */
export function pluginMcpServer(pluginId: string, name: string, root: string, declaration: Json, configured: unknown, dataRoot?: string) {
  const policy = record(configured);
  if (policy.enabled === false) return null;
  const server = { ...declaration, ...Object.fromEntries(Object.entries(record(policy.connection)).filter(([, value]) => value !== undefined)) };
  const hostEnv = pluginHostEnvironment(pluginId, root, dataRoot);
  const missing = new Set<string>();
  const expand = (value: unknown) => text(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, variable, fallback) => {
    const value = hostEnv[variable] ?? process.env[variable];
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing.add(variable); return '';
  });
  const stringMap = (value: unknown) => Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, expand(item)]));
  const kind = text(server.type ?? server.transport) || (server.url ? 'streamable_http' : 'stdio');
  if (!['stdio', 'http', 'streamable_http', 'streamable-http', 'sse'].includes(kind)) throw new Error(`Unsupported MCP transport in plugin ${pluginId}: ${kind}`);
  const headers = { ...stringMap(server.http_headers), ...stringMap(server.headers) };
  for (const [name, variable] of Object.entries(record(server.env_http_headers))) if (process.env[text(variable)]) headers[name] = process.env[text(variable)]!;
  if (server.bearer_token_env_var && process.env[text(server.bearer_token_env_var)]) headers.Authorization = `Bearer ${process.env[text(server.bearer_token_env_var)]}`;
  const oauth = mcpOAuthFromConfig({ scopes: server.scopes, oauth_resource: server.oauth_resource }, server.oauth, policy.oauth);
  const helper = server.http_headers_helper ?? server.headersHelper;
  const helperOptions = record(helper);
  const toolPolicy = (item: Json) => ({ permission: (item.approval_mode ?? policy.default_tools_approval_mode) === 'approve' ? 'allow' : 'ask',
    ...(item.enabled === false || item.approval_mode === 'deny' ? { enabled: false } : {}),
    parallelSafe: item.parallel_safe === true, visibleToChild: item.visible_to_child !== false });
  const env = { ...stringMap(server.env), ...hostEnv };
  const result = {
    id: `plugin_${pluginId.replaceAll('.', '_')}_${name}`,
    pluginId,
    transport: kind === 'stdio' ? { kind, command: expand(server.command), args: (strings(server.args) ?? []).map(expand), cwd: server.cwd ? resolve(root, expand(server.cwd)) : root, env }
      : { kind: kind === 'sse' ? 'sse' : 'streamable_http', url: expand(server.url), headers,
        ...(helper ? { headersHelper: { command: expand(typeof helper === 'string' ? helper : helperOptions.command), cwd: helperOptions.cwd ? resolve(root, expand(helperOptions.cwd)) : root, env: { ...env, ...stringMap(helperOptions.env), ...hostEnv } } } : {}),
        auth: server.auth === 'none' ? 'none' : 'oauth', oauth },
    defaultToolPolicy: toolPolicy({}),
    toolPolicies: Object.fromEntries(Object.entries(record(policy.tools)).map(([name, item]) => [name, toolPolicy(record(item))])),
    ...(strings(policy.enabled_tools) ? { exposeTools: strings(policy.enabled_tools) } : {}),
    ...(strings(policy.disabled_tools) ? { disabledTools: strings(policy.disabled_tools) } : {}),
    ...(Number(server.tool_timeout_sec) > 0 ? { toolTimeoutMs: Number(server.tool_timeout_sec) * 1000 } : {}),
    ...(Number(server.startup_timeout_sec) > 0 ? { startupTimeoutMs: Number(server.startup_timeout_sec) * 1000 } : {}),
    required: (policy.required ?? server.required) === true,
  };
  if (missing.size) throw new MissingPluginEnvironmentError(pluginId, name, missing, result.required);
  return result;
}
