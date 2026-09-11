import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Loader2, Maximize2, Minimize2, PanelsTopLeft, RotateCw, X } from 'lucide-react';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { AppLanguage } from '../../types';
import { mcpAppDocument, mcpAppTheme, type McpAppView } from './mcpAppBridge';
import './mcp-app.css';

export async function mcpAppCommand(input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  if (input.action === 'open') {
    await window.cardbushDesktop?.preparePluginUiNetwork?.();
    signal?.throwIfAborted();
  }
  const runtime = createDesktopRuntimeSession();
  try { return await runtime.client.command({ kind: 'runtime.mcp_app', payload: input }, value => value, signal); }
  finally { runtime.dispose(); }
}
const command = mcpAppCommand;
type PendingAction = { text: string; label: string; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: Error) => void };
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function staleInterface(cause: unknown) {
  const error = cause as { fact?: { code?: string }; code?: string } | null;
  return ['mcp_app_expired', 'mcp_app_connection_changed'].includes(error?.fact?.code ?? error?.code ?? '');
}
export function McpAppPanel({ sessionId, turnId, toolCallId, title, serverTitle, language, autoOpen = false }: { sessionId: string; turnId: string; toolCallId: string; title?: string; serverTitle?: string; language: AppLanguage; autoOpen?: boolean }) {
  const [view, setView] = useState<McpAppView | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(autoOpen);
  const answeredPermissions = useRef(new Set<string>());
  const [documentFailure, setDocumentFailure] = useState<{ kind: 'runtime' | 'resource'; detail: string } | null>(null);
  const [permission, setPermission] = useState<any>(null), [pending, setPending] = useState<PendingAction | null>(null), [height, setHeight] = useState(320), [full, setFull] = useState(false);
  const [inlineSpace, setInlineSpace] = useState(0), [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [frameReady, setFrameReady] = useState(false), [slow, setSlow] = useState(false), [theme, setTheme] = useState(mcpAppTheme);
  const panel = useRef<HTMLDialogElement>(null), viewport = useRef<HTMLDivElement>(null), fullRef = useRef(false), recoveries = useRef(0);
  const activeToken = useRef<string | null>(null), currentLanguage = useRef(language); currentLanguage.current = language;
  const frame = useRef<HTMLIFrameElement>(null), pendingRef = useRef<PendingAction | null>(null), opening = useRef<AbortController | null>(null);
  const frameLoads = useRef(0);
  const zh = language === 'zh';
  const setDisplayMode = useCallback((expanded: boolean) => {
    if (expanded && !fullRef.current) setInlineSpace(panel.current?.getBoundingClientRect().height ?? 0);
    fullRef.current = expanded; setFull(expanded);
  }, []);
  // The same dialog/iframe enters the browser's top layer, escaping message
  // containment without moving DOM nodes or recreating the plugin document.
  useLayoutEffect(() => {
    const element = panel.current; if (!element) return;
    const focused = document.activeElement;
    if (full) { if (element.open) element.close(); element.showModal(); }
    else { if (element.matches(':modal')) element.close(); element.open = true; }
    if (focused instanceof HTMLElement && element.contains(focused)) focused.focus({ preventScroll: true });
  }, [full, sessionId, turnId]);
  useLayoutEffect(() => { const element = panel.current; return () => element?.close(); }, []);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const update = () => {
      const size = { width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) };
      setViewportSize(previous => previous.width === size.width && previous.height === size.height ? previous : size);
    };
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [view, loading]);
  const hostContext = useRef(() => ({}));
  hostContext.current = () => ({ theme, locale: zh ? 'zh-CN' : 'en-US', displayMode: fullRef.current ? 'fullscreen' : 'inline', availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: viewport.current?.clientWidth ?? 0, ...(fullRef.current ? { height: viewport.current?.clientHeight ?? 0 } : { maxHeight: 900 }) } });
  const open = useCallback(async (recovering = false) => {
    if (opening.current && !opening.current.signal.aborted) return;
    if (!recovering) recoveries.current = 0;
    activeToken.current = null;
    pendingRef.current?.reject(new Error('Interface reopened.')); pendingRef.current = null;
    setPending(null); setPermission(null); setView(null); setFrameReady(false);
    setError(''); setDocumentFailure(null); setLoading(true); const controller = new AbortController(); opening.current = controller;
    try {
      let result;
      for (;;) {
        try { result = await command({ action: 'open', sessionId, turnId, toolCallId }, controller.signal); break; }
        catch (cause) {
          if (!controller.signal.aborted && staleInterface(cause) && recoveries.current === 0) { recoveries.current++; continue; }
          throw cause;
        }
      }
      if (controller.signal.aborted) { if (result?.token) void command({ action: 'close', token: result.token }).catch(() => {}); return; }
      if (result) { frameLoads.current = 0; activeToken.current = result.token; setView(result); }
      else setError(currentLanguage.current === 'zh' ? '此插件界面目前不可用。' : 'This plugin interface is currently unavailable.');
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally { if (opening.current === controller) opening.current = null; if (!controller.signal.aborted) setLoading(false); }
  }, [sessionId, turnId, toolCallId]);
  const handleError = useCallback((cause: unknown, token?: string) => {
    if (token && activeToken.current !== token) return;
    if (staleInterface(cause) && recoveries.current === 0) { recoveries.current++; void open(true); }
    else setError(errorMessage(cause));
  }, [open]);
  const close = () => { activeToken.current = null; opening.current?.abort(); setLoading(false); pendingRef.current?.reject(new Error('Interface closed.')); pendingRef.current = null; setPending(null); setView(null); setDocumentFailure(null); setPermission(null); setDisplayMode(false); };
  // Keep srcdoc stable across progress renders, resizing and host theme changes.
  const frameDocument = useMemo(() => view ? mcpAppDocument(view, language) : '', [view]);
  useEffect(() => {
    const root = panel.current?.closest('.app') ?? document.documentElement;
    const update = () => setTheme(mcpAppTheme(root)); update();
    const observer = new MutationObserver(update); observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: hostContext.current() }, '*');
  }, [theme, zh, full, viewportSize, frameReady]);
  const waiting = loading || !!view && !frameReady;
  useEffect(() => { setSlow(false); if (!waiting) return; const timer = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(timer); }, [waiting]);
  useEffect(() => { if (autoOpen) void open(); }, [autoOpen, open]);
  useEffect(() => () => { activeToken.current = null; opening.current?.abort(); pendingRef.current?.reject(new Error('Interface closed.')); }, []);
  useEffect(() => { if (!view) return; return () => { void command({ action: 'close', token: view.token }).catch(() => {}); }; }, [view]);
  useEffect(() => {
    if (!view) return;
    const controller = new AbortController(); let initialized = false, initializing = false, polling = false, activeCalls = 0, failureReported = false;
    answeredPermissions.current = new Set();
    const send = (value: unknown) => {
      if (!controller.signal.aborted && activeToken.current === view.token) frame.current?.contentWindow?.postMessage(value, '*');
    };
    const requestUser = (text: string, label: string, run: () => Promise<unknown>) => new Promise((resolve, reject) => {
      if (pendingRef.current) { reject(new Error('Another interface request is awaiting a response.')); return; }
      const action = { text, label, run, resolve, reject }; pendingRef.current = action; setPending(action);
    });
    const listener = async (event: MessageEvent) => {
      const zh = currentLanguage.current === 'zh';
      if (activeToken.current !== view.token || event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string' || JSON.stringify(data).length > 128_000) return;
      const params = data.params ?? {};
      const respond = (result: unknown) => { if (data.id !== undefined) send({ jsonrpc: '2.0', id: data.id, result }); };
      try {
        if (data.method === 'cardbush/notifications/interface-error') {
          if (failureReported || !['script', 'stylesheet', 'runtime'].includes(params.kind) || typeof params.detail !== 'string') return;
          failureReported = true;
          const detail = `${params.kind}: ${params.detail.slice(0, 1000)}`;
          setDocumentFailure({ kind: params.kind === 'runtime' ? 'runtime' : 'resource', detail });
          void command({ action: 'observe', token: view.token, event: 'failed', detail: `Interface document error (${detail}).` }).catch(() => {});
          return;
        }
        if (data.method === 'ui/initialize') {
          initializing = true;
          respond({ protocolVersion: '2026-01-26', hostInfo: { name: 'CardBush', version: '1.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {} }, hostContext: { ...hostContext.current(), toolInfo: { tool: view.tool } } }); return;
        }
        if (data.method === 'ui/notifications/initialized') {
          if (!initializing || initialized) return; initialized = true;
          void command({ action: 'observe', token: view.token, event: 'initialized' }).catch(cause => { if (!controller.signal.aborted) handleError(cause, view.token); });
          send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: view.input } });
          send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: view.result }); return;
        }
        // Size notifications are also sent by legacy widgets without a handshake.
        if (data.method === 'ui/notifications/size-changed') { if (!fullRef.current && Number.isFinite(params.height)) setHeight(Math.min(900, Math.max(160, Math.ceil(params.height)))); return; }
        const legacy = typeof data.id === 'string' && data.id.startsWith('openai-');
        if (!initialized && !legacy) throw new Error('Initialize the interface before sending requests.');
        if (data.method === 'ping' || data.method === 'notifications/message') { respond({}); return; }
        if (data.method === 'ui/request-display-mode') { const mode = params.mode === 'fullscreen' ? 'fullscreen' : 'inline'; setDisplayMode(mode === 'fullscreen'); respond({ mode }); return; }
        if (data.method === 'tools/call' || data.method === 'resources/read') {
          // Runtime owns the per-interface queue and permission lifecycle.
          activeCalls++;
          try { const result = await command({ action: data.method === 'resources/read' ? 'resource' : 'call', token: view.token, name: params.name, uri: params.uri, arguments: params.arguments ?? {} }, controller.signal); respond(result); }
          finally { activeCalls--; if (!activeCalls && !controller.signal.aborted && activeToken.current === view.token) setPermission(null); } return;
        }
        if (data.method === 'ui/update-model-context') { respond(await command({ action: 'context', token: view.token, context: params }, controller.signal)); return; }
        if (data.method === 'ui/message') {
          const content = Array.isArray(params.content) ? params.content : [params.content];
          const text = content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n');
          if (!text.trim() || text.length > 32_000 || params.role && params.role !== 'user') throw new Error('The interface message must be user text up to 32,000 characters.');
          respond(await requestUser(text, zh ? '发送到会话' : 'Send to conversation', async () => {
            await new Promise<void>((resolve, reject) => window.dispatchEvent(new CustomEvent('cardbush:mcp-app-message', { detail: { sessionId, text, resolve, reject } })));
            return {};
          })); return;
        }
        if (data.method === 'ui/open-link') {
          const url = new URL(params.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) links can be opened.');
          respond(await requestUser(url.href, zh ? '打开链接' : 'Open link', async () => { await window.cardbushDesktop?.openExternal(url.href); return {}; })); return;
        }
        throw new Error(`Unsupported MCP interface method: ${data.method}`);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (data.id !== undefined) send({ jsonrpc: '2.0', id: data.id, error: { code: -32000, message: errorMessage(cause) } });
        if (staleInterface(cause)) handleError(cause, view.token);
      }
    };
    window.addEventListener('message', listener);
    const timer = setInterval(() => {
      if (!activeCalls || polling) return; polling = true;
      void command({ action: 'status', token: view.token }, controller.signal).then(value => {
        if (!controller.signal.aborted && activeToken.current === view.token && activeCalls) {
          setPermission(value.permission && !answeredPermissions.current.has(value.permission.permissionId) ? value.permission : null);
        }
      }).catch(() => {}).finally(() => { polling = false; });
    }, 300);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('message', listener); };
  }, [view, sessionId, handleError, setDisplayMode]);
  if (!sessionId || !turnId) return null;
  const displayTitle = title || view?.title || serverTitle || view?.serverTitle || (zh ? '插件界面' : 'Plugin interface');
  const prefersBorder = (view?.meta.ui?.prefersBorder ?? view?.meta['openai/widgetPrefersBorder']) !== false;
  return <div className="mcp-app-anchor" style={full ? { height: inlineSpace } : undefined}><dialog ref={panel} className={`mcp-app-panel ${full ? 'fullscreen' : ''} ${prefersBorder ? '' : 'unframed'}`} aria-label={displayTitle} aria-modal={full || undefined} onCancel={event => { event.preventDefault(); setDisplayMode(false); }}>
    <header className="mcp-app-heading">
      <span className="mcp-app-title" title={view ? String(view.tool.name) : undefined}><PanelsTopLeft size={16} /><strong>{displayTitle}</strong></span>
      <span className="mcp-app-actions">
        {view && <><button type="button" title={zh ? '重新加载' : 'Reload'} aria-label={zh ? '重新加载' : 'Reload'} onClick={() => void open()}><RotateCw size={14} /></button><button type="button" title={full ? (zh ? '收起' : 'Collapse') : (zh ? '展开视图' : 'Expand view')} aria-label={full ? (zh ? '收起' : 'Collapse') : (zh ? '展开视图' : 'Expand view')} onClick={() => setDisplayMode(!fullRef.current)}>{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></>}
        {(view || loading) && <button type="button" title={waiting ? (zh ? '取消加载' : 'Cancel loading') : (zh ? '关闭界面' : 'Close interface')} aria-label={waiting ? (zh ? '取消加载' : 'Cancel loading') : (zh ? '关闭界面' : 'Close interface')} onClick={close}><X size={16} /></button>}
      </span>
    </header>
    {(error || documentFailure) && <div className="mcp-app-error" role="alert"><CircleAlert size={16} /><div><p>{error ? (zh ? '界面暂时未能加载' : 'Unable to load the interface') : documentFailure?.kind === 'runtime' ? (zh ? '插件界面运行出错，可重试。' : 'The plugin interface encountered an error. Try again.') : (zh ? '部分界面资源加载失败，可重试。' : 'Some interface resources failed to load. Try again.')}</p><details><summary>{zh ? '查看详情' : 'Details'}</summary><pre>{error || documentFailure?.detail}</pre></details></div><button type="button" onClick={() => void open()}><RotateCw size={13} />{zh ? '重试' : 'Retry'}</button></div>}
    {!view && !loading && !error && <button className="mcp-app-reopen" type="button" onClick={() => void open()}>{zh ? '打开插件界面' : 'Open plugin interface'}</button>}
    {view && <>
      {permission && <div className="mcp-app-confirm" role="alert"><p>{permission.reason}</p><code>{JSON.stringify(permission.targets)}</code>{['allow_once', 'deny'].map(decision => <button type="button" key={decision} onClick={() => {
        const permissionId = permission.permissionId; answeredPermissions.current.add(permissionId);
        void command({ action: 'answer', token: view.token, permissionId, decision }).catch(cause => { if (activeToken.current === view.token) answeredPermissions.current.delete(permissionId); handleError(cause, view.token); }); setPermission(null);
      }}>{decision === 'allow_once' ? (zh ? '允许本次' : 'Allow once') : (zh ? '拒绝' : 'Deny')}</button>)}</div>}
      {pending && <div className="mcp-app-confirm"><p>{pending.text}</p><button type="button" onClick={() => { pendingRef.current = null; setPending(null); void pending.run().then(pending.resolve, pending.reject); }}>{pending.label}</button><button type="button" onClick={() => { pending.reject(new Error('User declined.')); pendingRef.current = null; setPending(null); }}>{zh ? '取消' : 'Cancel'}</button></div>}
    </>}
    {(loading || view) && <div ref={viewport} className={`mcp-app-viewport ${frameReady ? 'is-loaded' : ''}`} style={{ height: full ? undefined : height }} aria-busy={waiting}>
      {waiting && <div className="mcp-app-loading" role="status"><div className="mcp-app-skeleton" aria-hidden="true"><i /><i /><i /></div><span><Loader2 size={14} />{slow ? (zh ? '加载较慢，可稍后重试' : 'Taking longer than usual') : (zh ? '正在载入界面' : 'Loading interface')}</span></div>}
      {view && <iframe key={view.token} ref={frame} name="cardbush-mcp-app" title={displayTitle} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => {
        if (activeToken.current !== view.token) return;
        if (++frameLoads.current > 1) {
          void command({ action: 'observe', token: view.token, event: 'failed', detail: 'Interface document navigated away.' }).catch(() => {}); close();
          setError(zh ? '界面页面已更换，请重新打开。' : 'The interface document changed. Reopen it to continue.');
        } else { setFrameReady(true); void command({ action: 'observe', token: view.token, event: 'frame_loaded' }).catch(cause => handleError(cause, view.token)); }
      }} onError={() => { setError(zh ? '插件界面加载失败，可重试。' : 'Interface failed to load. Try again.'); setFrameReady(true); void command({ action: 'observe', token: view.token, event: 'failed', detail: 'Iframe load error.' }).catch(() => {}); }} allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcDoc={frameDocument} />}
    </div>}
  </dialog></div>;
}
