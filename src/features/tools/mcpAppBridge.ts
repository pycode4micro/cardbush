/** The frame has an opaque origin. No credentials, host paths or runtime tokens cross this bridge. */
export type McpAppView = { token: string; html: string; meta: Record<string, any>; tool: Record<string, unknown>; input: unknown; result: any };
function origins(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string' && /^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(item) || typeof item === 'string' && /^wss:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(item)).join(' ');
}
export function mcpAppDocument(view: McpAppView, language: string): string {
  const csp = view.meta.ui?.csp ?? {};
  const legacy = view.meta['openai/widgetCSP'] ?? {};
  const resources = origins(csp.resourceDomains ?? legacy.resource_domains);
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src blob: ${resources}; connect-src ${origins(csp.connectDomains ?? legacy.connect_domains) || "'none'"}; frame-src ${origins(csp.frameDomains ?? legacy.frame_domains) || "'none'"}; base-uri ${origins(csp.baseUriDomains) || "'none'"}; form-action 'none'; object-src 'none'`;
  const initial = JSON.stringify({ toolInput: view.input, toolOutput: view.result?.structuredContent ?? view.result, toolResponseMetadata: view.result?._meta ?? {}, widgetState: null, locale: language === 'zh' ? 'zh-CN' : 'en-US', theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', displayMode: 'inline', maxHeight: 900 }).replaceAll('<', '\\u003c');
  const shim = `(() => {
    let id = 0; const pending = new Map();
    const rpc = (method, params) => new Promise((resolve, reject) => { const key = 'openai-' + (++id); const timer = setTimeout(() => { pending.delete(key); reject(new Error('Host request timed out')); }, 120000); pending.set(key, { resolve, reject, timer }); parent.postMessage({ jsonrpc: '2.0', id: key, method, params }, '*'); });
    const api = ${initial};
    Object.assign(api, {
      callTool: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
      sendFollowUpMessage: ({ prompt }) => rpc('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] }),
      setWidgetState: value => { api.widgetState = value; return rpc('ui/update-model-context', { structuredContent: { widgetState: value } }); },
      openExternal: ({ href }) => rpc('ui/open-link', { url: href }),
      requestDisplayMode: ({ mode }) => rpc('ui/request-display-mode', { mode }).then(result => { api.displayMode = result.mode; return result; }),
      notifyIntrinsicHeight: height => parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: height || document.documentElement.scrollHeight } }, '*')
    }); window.openai = api;
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
      const message = event.data, entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
      if (message.method === 'ui/notifications/tool-result') { api.toolOutput = message.params.structuredContent ?? message.params; api.toolResponseMetadata = message.params._meta ?? {}; dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: api } })); }
    });
  })();`;
  // CSP is the first parsed element and cannot be relaxed by resource-provided markup.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"><meta name="referrer" content="no-referrer"><script>${shim}</script>${view.html}`;
}
