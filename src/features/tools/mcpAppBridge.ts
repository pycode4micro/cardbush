/** The frame has an opaque origin. No credentials, host paths or runtime tokens cross this bridge. */
export type McpAppView = { token: string; html: string; meta: Record<string, any>; title?: string; serverTitle?: string; tool: Record<string, unknown>; input: unknown; result: any };
export function mcpAppTheme(element: Element | null = document.querySelector('.app')): 'light' | 'dark' {
  return getComputedStyle(element ?? document.documentElement).colorScheme.split(' ').includes('dark') ? 'dark' : 'light';
}
function origins(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string' && /^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(item) || typeof item === 'string' && /^wss:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(item)).join(' ');
}
export function mcpAppDocument(view: McpAppView, language: string, theme = mcpAppTheme()): string {
  const csp = view.meta.ui?.csp ?? {};
  const legacy = view.meta['openai/widgetCSP'] ?? {};
  const resources = origins(csp.resourceDomains ?? legacy.resource_domains);
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src blob: ${resources}; connect-src ${origins(csp.connectDomains ?? legacy.connect_domains) || "'none'"}; frame-src ${origins(csp.frameDomains ?? legacy.frame_domains) || "'none'"}; base-uri ${origins(csp.baseUriDomains) || "'none'"}; form-action 'none'; object-src 'none'`;
  const initial = JSON.stringify({ toolInput: view.input, toolOutput: view.result?.structuredContent ?? view.result, toolResponseMetadata: view.result?._meta ?? {}, widgetState: null, locale: language === 'zh' ? 'zh-CN' : 'en-US', theme, displayMode: 'inline', maxHeight: 900 }).replaceAll('<', '\\u003c');
  const shim = `(() => {
    // Host canvas defaults stay below provider CSS in the cascade. Matching the
    // host color scheme prevents Chromium painting white behind rounded widgets.
    const canvasStyle = document.createElement('style'); document.head.append(canvasStyle);
    const setCanvasTheme = theme => { canvasStyle.textContent = ':where(html){background-color:transparent;color:CanvasText;color-scheme:' + (theme === 'dark' ? 'dark' : 'light') + '}:where(body){margin:0;background-color:transparent}'; };
    setCanvasTheme(${JSON.stringify(theme === 'dark' ? 'dark' : 'light')});
    // Opaque sandbox documents cannot access browser sessionStorage. Give this
    // document a private, transient Web Storage surface without sharing an origin.
    try { void window.sessionStorage; } catch {
      const values = new Map();
      const methods = {
        get length() { return values.size; },
        getItem: key => values.get(String(key)) ?? null,
        setItem: (key, value) => { values.set(String(key), String(value)); },
        removeItem: key => { values.delete(String(key)); },
        clear: () => values.clear(),
        key: index => Array.from(values.keys())[Number(index) >>> 0] ?? null
      };
      for (const key of Object.keys(methods)) Object.defineProperty(methods, key, { enumerable: false });
      const storage = new Proxy(Object.create(methods), {
        get: (target, key) => key in target ? Reflect.get(target, key) : values.get(String(key)),
        set: (_target, key, value) => { values.set(String(key), String(value)); return true; },
        deleteProperty: (_target, key) => { values.delete(String(key)); return true; },
        has: (target, key) => key in target || values.has(String(key)),
        ownKeys: () => Array.from(values.keys()),
        getOwnPropertyDescriptor: (_target, key) => values.has(String(key)) ? { configurable: true, enumerable: true, writable: true, value: values.get(String(key)) } : undefined
      });
      Object.defineProperty(window, 'sessionStorage', { value: storage });
    }
    // Report native load/uncaught-script errors. Never inspect provider content
    // or infer whether its result is useful; leave the provider's handlers intact.
    addEventListener('error', event => {
      const target = event.target;
      const kind = target instanceof HTMLScriptElement && target.src ? 'script' : target instanceof HTMLLinkElement && target.relList.contains('stylesheet') ? 'stylesheet' : target === window && event.message ? 'runtime' : '';
      if (!kind) return;
      let detail = kind === 'runtime' ? event.message : '';
      if (kind !== 'runtime') try { const url = new URL(target.src || target.href); detail = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin + url.pathname : url.protocol; } catch {}
      parent.postMessage({ jsonrpc: '2.0', method: 'cardbush/notifications/interface-error', params: { kind, detail: detail.slice(0, 1000) } }, '*');
    }, true);
    let id = 0; const pending = new Map();
    const rpc = (method, params) => new Promise((resolve, reject) => { const key = 'openai-' + (++id); const timer = setTimeout(() => { pending.delete(key); reject(new Error('Host request timed out')); }, 120000); pending.set(key, { resolve, reject, timer }); parent.postMessage({ jsonrpc: '2.0', id: key, method, params }, '*'); });
    const api = ${initial};
    let manualHeight = false, sizeFrame = 0, reportedHeight = 0;
    const contentHeight = () => {
      const body = document.body; if (!body) return 0;
      const style = getComputedStyle(body);
      return Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height) + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
    };
    const reportHeight = height => { if (Number.isFinite(height) && height > 0) parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } }, '*'); };
    const scheduleSize = () => {
      if (sizeFrame) return;
      sizeFrame = requestAnimationFrame(() => {
        sizeFrame = 0; if (manualHeight || api.displayMode === 'fullscreen') return;
        const height = contentHeight(); if (height === reportedHeight) return;
        reportedHeight = height; reportHeight(height);
      });
    };
    addEventListener('DOMContentLoaded', () => {
      if (!document.body) return;
      new ResizeObserver(scheduleSize).observe(document.body);
      new MutationObserver(scheduleSize).observe(document.body, { subtree: true, childList: true, characterData: true });
      scheduleSize();
    }, { once: true });
    addEventListener('load', scheduleSize, true); addEventListener('resize', scheduleSize);
    Object.assign(api, {
      callTool: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
      sendFollowUpMessage: ({ prompt }) => rpc('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] }),
      setWidgetState: value => { api.widgetState = value; return rpc('ui/update-model-context', { structuredContent: { widgetState: value } }); },
      openExternal: ({ href }) => rpc('ui/open-link', { url: href }),
      requestDisplayMode: ({ mode }) => rpc('ui/request-display-mode', { mode }).then(result => { api.displayMode = result.mode; return result; }),
      notifyIntrinsicHeight: height => { manualHeight = true; reportHeight(height || contentHeight()); }
    }); window.openai = api;
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
      const message = event.data, entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
      if (message.method === 'ui/notifications/tool-result') { api.toolOutput = message.params.structuredContent ?? message.params; api.toolResponseMetadata = message.params._meta ?? {}; dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: api } })); }
      if (message.method === 'ui/notifications/host-context-changed') {
        const globals = { ...message.params }, dimensions = globals.containerDimensions;
        if (dimensions) globals.maxHeight = dimensions.height ?? dimensions.maxHeight ?? api.maxHeight;
        Object.assign(api, globals); setCanvasTheme(api.theme); scheduleSize();
        dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
      }
    });
  })();`;
  // CSP is the first parsed element and cannot be relaxed by resource-provided markup.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"><meta name="referrer" content="no-referrer"><script>${shim}</script>${view.html}`;
}
