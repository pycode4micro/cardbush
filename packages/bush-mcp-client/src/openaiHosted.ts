import { Client, StreamableHTTPClientTransport, type Transport, type Tool } from '@modelcontextprotocol/client';
import { OPENAI_HOSTED_PROTOCOL, type OpenAiAccess, type McpServerSnapshot } from '@cardbush/bush-protocol';
import { OpenAiAuthError, OpenAiHttpError } from './openaiAuth.js';

export type OpenAiTokenProvider = (request: { rejectedToken?: string; signal?: AbortSignal }) => Promise<OpenAiAccess>;
export function openAiToolVisible(tool: Tool, appId: string): boolean {
  // App-only tools stay connected for the iframe; the runtime controls model visibility.
  return tool._meta?.connector_id === appId;
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
    if (args[0]?.cursor === undefined) { allowed.clear(); }
    tools.forEach(tool => allowed.set(tool.name, tool));
    return { ...result, tools };
  };
  client.callTool = async (params, options) => {
    const tool = allowed.get(params.name);
    if (!tool) throw new Error('This tool does not belong to the selected OpenAI application.');
    // Use the server declaration, not a caller-supplied definition, for validation.
    const transport = client.transport;
    if (!transport) throw new Error('OpenAI application is not connected.');
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
}
/** Scope catalog declarations only; tool results pass through unchanged. */
export function attachOpenAiCatalogAdapter(transport: Transport, appId: string): void {
  const catalogs = new Set<string | number>();
  const send = transport.send.bind(transport), receive = transport.onmessage;
  transport.send = async (message, options) => {
    if ('method' in message && message.method === 'tools/list' && 'id' in message && message.id !== undefined) catalogs.add(message.id);
    if ('method' in message && message.method === 'notifications/cancelled') {
      const id = (message.params as { requestId: string | number }).requestId;
      catalogs.delete(id);
    }
    try { await send(message, options); }
    catch (error) { if ('id' in message && message.id !== undefined) { catalogs.delete(message.id); } throw error; }
  };
  transport.onmessage = (message, extra) => {
    if ('id' in message && message.id !== undefined) {
      const id = message.id;
      if (catalogs.delete(id) && 'result' in message && Array.isArray(message.result.tools)) {
        // Scope before SDK validation: another app's schema cannot invalidate this connection.
        // An empty JSON Schema has no constraints, so it is equivalent to an absent optional declaration.
        const tools = (message.result.tools as Tool[]).filter(tool => tool && openAiToolVisible(tool, appId)).map(tool => {
          if (!tool.outputSchema || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema) || Object.keys(tool.outputSchema).length) return tool;
          const { outputSchema, ...rest } = tool;
          return { ...rest, _meta: { ...tool._meta, 'cardbush/originalOutputSchema': outputSchema, 'cardbush/outputSchemaNormalization': 'empty_schema_omitted' } };
        });
        message = { ...message, result: { ...message.result, tools } };
      }

    }
    receive?.(message, extra);
  };
}
