// Independent, memory-only experiment. No Codex binary, sessions or credential files.
// Protocol reference: openai/codex @ 9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a
// login/src/server.rs, login/src/auth/manager.rs, codex-mcp/src/mcp/mod.rs.
import { startOpenAiLogin, openAiAccess, readOpenAiJson } from '@cardbush/bush-mcp-client';
import { OPENAI_HOSTED_PROTOCOL } from '@cardbush/bush-protocol';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const OPENAI_PROBE_PROTOCOL = OPENAI_HOSTED_PROTOCOL;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// Only locally constructed diagnostics may cross the process boundary.
export class OpenAiProbeError extends Error {
  constructor(phase, status, serviceCode) {
    super(`OpenAI ${phase} request failed (HTTP ${status}). No credentials were saved.`);
    this.name = 'OpenAiProbeError';
    this.diagnostics = { phase, httpStatus: status, ...(serviceCode === 'no_biscuit_no_service' ? { serviceCode } : {}) };
  }
}

export class OpenAiProbeProtocolError extends Error {
  constructor(error, phase, facts) {
    super('OpenAI MCP protocol validation failed. Only structural diagnostics were retained.');
    this.name = 'OpenAiProbeProtocolError';
    this.diagnostics = { phase, ...(error instanceof ProtocolError ? { protocolCode: error.code } : {}), facts };
  }
}

function resultStructure(result, schema) {
  const valueType = value => value === undefined ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const content = result.structuredContent;
  const declared = Object.keys(record(schema?.properties));
  return { isError: result.isError === true, structuredContentType: valueType(content),
    // Field names are taken from the tool's declared schema, never from user data.
    declaredFieldsPresent: declared.filter(key => Object.hasOwn(record(content), key)),
    requiredFieldsMissing: (schema?.required ?? []).filter(key => !Object.hasOwn(record(content), key)),
    hasResultWrapper: Object.hasOwn(record(content), 'result'),
    contentTypes: Array.isArray(result.content) ? result.content.map(block => block.type) : [] };
}

const jsonResponse = readOpenAiJson;
export const accountRoutingHint = tokens => openAiAccess(tokens).accountId;
export const startOpenAiProbeLogin = startOpenAiLogin;

export async function probeOpenAiHostedTools(tokens, { appId, resourceName, fetch: request = globalThis.fetch, signal = AbortSignal.timeout(60_000), onProgress = () => {} } = {}) {
  const endpoint = new URL(OPENAI_PROBE_PROTOCOL.mcpEndpoint);
  const account = accountRoutingHint(tokens);
  const facts = { transport: 'direct_https_mcp', usesCodexProcess: false, usesCodexCredentialFiles: false, catalogReady: false, appCount: 0, targetToolCount: 0, readonlyCallSucceeded: false };
  let phase = 'mcp_initialize', selectedTool;
  const callRequestIds = new Set();
  const client = new Client({ name: 'cardbush_connector_probe', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: async (url, init) => {
    const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) throw new Error('Unexpected OpenAI connector request destination.');
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const message = JSON.parse(init.body);
      if (message.method === 'tools/call' && message.id !== undefined) callRequestIds.add(message.id);
    }
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]), headers: new Headers(init?.headers) });
    if (!response.ok && init?.method === 'POST') {
      const body = await jsonResponse(response).catch(() => ({}));
      throw new OpenAiProbeError('hosted_mcp', response.status, record(body).message);
    }
    return response;
  }, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}`, 'X-OpenAI-Product-Sku': 'codex', originator: 'cardbush_connector_probe', ...(account ? { 'ChatGPT-Account-ID': account } : {}) } } });
  const cancelled = () => { void client.close(); };
  signal.addEventListener('abort', cancelled, { once: true });
  try {
    signal.throwIfAborted(); await client.connect(transport);
    onProgress({ stage: 'mcp_connected' });
    // Record structural diagnostics while forwarding the original result unchanged.
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (callRequestIds.delete(message.id) && message.result) {
        facts.wireToolReply = resultStructure(message.result, selectedTool?.outputSchema);
        onProgress({ stage: 'readonly_wire_result', ...facts.wireToolReply });

      }
      receive?.(message, extra);
    };
    phase = 'tools_list';
    const tools = [], seen = new Set(); let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Repeated OpenAI tool catalog cursor.');
      if (cursor) seen.add(cursor);
      if (seen.size > 100 || tools.length > 10_000) throw new Error('OpenAI tool catalog exceeds probe bounds.');
    } while (cursor);
    const visible = tools.filter(tool => !Array.isArray(tool._meta?.ui?.visibility) || tool._meta.ui.visibility.includes('model'));
    facts.catalogReady = true;
    facts.appCount = new Set(visible.map(tool => tool._meta?.connector_id).filter(Boolean)).size;
    const target = visible.filter(tool => tool._meta?.connector_id === appId);
    facts.targetToolCount = target.length;
    facts.grantedScopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ') : null;
    onProgress({ stage: 'catalog_ready', appCount: facts.appCount, targetToolCount: facts.targetToolCount });
    if (!resourceName) return facts;
    const tool = target.find(tool => tool._meta?.resource_name === resourceName);
    if (!tool) throw new Error('The selected application/profile tool is not available for this OpenAI login.');
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true || (tool.inputSchema.required?.length ?? 0) > 0) {
      throw new Error('This probe only permits read-only tools with no required arguments.');
    }
    selectedTool = tool;
    phase = 'readonly_tool_call';
    onProgress({ stage: 'readonly_tool_selected', hasOutputSchema: Boolean(tool.outputSchema) });
    const result = await client.callTool({ name: tool.name, arguments: {} }, { signal, timeout: 60_000 });
    facts.readonlyCallSucceeded = result.isError !== true;
    facts.resultContentTypes = Array.isArray(result.content) ? result.content.map(block => block.type) : [];
    facts.hasStructuredContent = Boolean(result.structuredContent);
    // Account details and tool response text never enter diagnostics.
    if (result.isError) throw new Error('The OpenAI hosted tool returned an error. No response content was logged.');
    return facts;
  } catch (error) {
    if (error instanceof ProtocolError) throw new OpenAiProbeProtocolError(error, phase, facts);
    throw error;
  } finally { signal.removeEventListener('abort', cancelled); await client.close(); }
}
