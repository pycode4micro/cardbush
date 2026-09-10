import { Client, StreamableHTTPClientTransport, type Transport, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { OPENAI_HOSTED_PROTOCOL, type OpenAiAccess, type McpServerSnapshot } from '@cardbush/bush-protocol';
import { OpenAiAuthError, OpenAiHttpError } from './openaiAuth.js';

export type OpenAiTokenProvider = (request: { rejectedToken?: string; signal?: AbortSignal }) => Promise<OpenAiAccess>;
export function openAiToolVisible(tool: Tool, appId: string): boolean {
  // App-only tools stay connected for the iframe; the runtime controls model visibility.
  return tool._meta?.connector_id === appId;
}
/** Restore the declared envelope only when the entire original schema validates. */
export function createOpenAiResultNormalizer(tool: Pick<Tool, 'outputSchema'>, validator = new AjvJsonSchemaValidator()) {
  const unchanged = (result: CallToolResult) => ({ result, normalized: false });
  const schema = tool.outputSchema;
  if (schema?.type !== 'object' || Object.keys(schema.properties ?? {}).length !== 1 || !Object.hasOwn(schema.properties!, 'result') ||
      !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== 'result') return unchanged;
  let validate: ReturnType<AjvJsonSchemaValidator['getValidator']>;
  try { validate = validator.getValidator(schema); } catch { return unchanged; }
  return (result: CallToolResult) => {
    const content = result.structuredContent;
    if (result.isError || content === undefined || validate(content).valid ||
        (content && typeof content === 'object' && Object.hasOwn(content, 'result'))) return unchanged(result);
    const candidate = { result: content };
    return validate(candidate).valid ? { result: { ...result, structuredContent: candidate }, normalized: true } : unchanged(result);
  };
}

/** Credentials are requested privately per HTTP operation and never enter a configuration snapshot. */
export function createOpenAiTransport(config: McpServerSnapshot, tokenProvider?: OpenAiTokenProvider, request: typeof fetch = fetch): Transport {
  if (config.transport.kind !== 'streamable_http' || config.transport.url !== OPENAI_HOSTED_PROTOCOL.mcpEndpoint ||
      config.transport.auth !== 'openai' || !config.transport.openaiAppId || Object.keys(config.transport.headers).length ||
      config.transport.oauth || config.transport.headersHelper) throw new Error('Invalid OpenAI hosted transport.');
  let generation: number | undefined;
  return new StreamableHTTPClientTransport(new URL(OPENAI_HOSTED_PROTOCOL.mcpEndpoint), { fetch: async (url, init) => {
    const destination = String(url);
    if (destination !== OPENAI_HOSTED_PROTOCOL.mcpEndpoint) throw new Error('Unexpected OpenAI request destination.');
    if (!tokenProvider) throw new OpenAiAuthError();
    let access = await tokenProvider({ signal: init?.signal ?? undefined });
    for (let attempt = 0; attempt < 2; attempt++) {
      init?.signal?.throwIfAborted();
      if (generation !== undefined && generation !== access.generation) throw new Error('OpenAI account changed. Refresh this application connection after current tasks finish.');
      generation = access.generation;
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${access.accessToken}`);
      headers.set('X-OpenAI-Product-Sku', 'codex'); headers.set('originator', 'cardbush');
      if (access.accountId) headers.set('ChatGPT-Account-ID', access.accountId); else headers.delete('ChatGPT-Account-ID');
      let response;
      try { response = await request(url, { ...init, headers, redirect: 'error', credentials: 'omit' }); }
      catch (error) { if (init?.signal?.aborted) throw error; throw new Error('OpenAI connection failed. Check the network and try again.'); }
      if (response.status === 401) {
        await response.body?.cancel();
        if (attempt) throw new OpenAiAuthError();
        access = await tokenProvider({ rejectedToken: access.accessToken, signal: init?.signal ?? undefined });
        continue;
      }
      if (!response.ok && init?.method === 'POST') { await response.body?.cancel(); throw new OpenAiHttpError(response.status); }
      return response;
    }
    throw new OpenAiAuthError();
  } });
}

/** Scope the public client surface as well as the registry; other applications cannot be invoked. */
export function scopeOpenAiClient(client: Client, appId: string): void {
  const list = client.listTools.bind(client), call = client.callTool.bind(client);
  const allowed = new Map<string, Tool>();
  client.listTools = async (...args) => {
    const result = await list(...args);
    const tools = result.tools.filter(tool => openAiToolVisible(tool, appId));
    if (!args[0]?.cursor) { allowed.clear(); normalizers.get(client)!.clear(); }
    tools.forEach(tool => allowed.set(tool.name, tool));
    return { ...result, tools };
  };
  client.callTool = async (params, options) => {
    const tool = allowed.get(params.name);
    if (!tool) throw new Error('This tool does not belong to the selected OpenAI application.');
    // Use the server declaration, not a caller-supplied definition, for validation.
    const transport = client.transport;
    if (!transport) throw new Error('OpenAI application is not connected.');
    // The transport adapter makes a copy; ordinary SDK schema validation remains enabled.
    const cached = normalizers.get(client)!;
    if (!cached.has(params.name)) cached.set(params.name, createOpenAiResultNormalizer(tool));
    return call(params, { ...options, toolDefinition: tool });
  };
  const readResource = client.readResource.bind(client);
  client.readResource = async (params, options) => {
    const permitted = [...allowed.values()].some(tool => {
      const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
      return params.uri === ui?.resourceUri || params.uri === tool._meta?.['openai/outputTemplate'];
    });
    if (!permitted) throw new Error('This UI resource does not belong to the selected OpenAI application.');
    return readResource(params, options);
  };
  normalizers.set(client, new Map());
}
const normalizers = new WeakMap<Client, Map<string, ReturnType<typeof createOpenAiResultNormalizer>>>();

/** Adapt only replies correlated with this client's own scoped tool requests. */
export function attachOpenAiResultAdapter(client: Client, transport: Transport): void {
  const pending = new Map<string | number, ReturnType<typeof createOpenAiResultNormalizer>>();
  const send = transport.send.bind(transport), receive = transport.onmessage;
  transport.send = async (message, options) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message && message.id !== undefined) {
      const normalize = normalizers.get(client)?.get(String((message.params as { name?: string })?.name));
      if (normalize) pending.set(message.id, normalize);
    }
    if ('method' in message && message.method === 'notifications/cancelled') pending.delete((message.params as { requestId: string | number }).requestId);
    try { await send(message, options); }
    catch (error) { if ('id' in message && message.id !== undefined) pending.delete(message.id); throw error; }
  };
  transport.onmessage = (message, extra) => {
    if ('id' in message && message.id !== undefined) {
      const normalize = pending.get(message.id); pending.delete(message.id);
      if (normalize && 'result' in message) {
        const adapted = normalize(message.result as CallToolResult);
        if (adapted?.normalized) {
          // Retain explicit normalization provenance without changing the original content blocks.
          receive?.({ ...message, result: { ...adapted.result, _meta: { ...adapted.result._meta, 'cardbush/outputNormalization': 'validated_declared_result_envelope' } } }, extra);
          return;
        }
      }
    }
    receive?.(message, extra);
  };
}
