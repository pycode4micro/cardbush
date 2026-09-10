import { useEffect, useRef, useState } from 'react';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { AppLanguage } from '../../types';
import { mcpAppDocument, type McpAppView } from './mcpAppBridge';
import './mcp-app.css';

async function command(input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const runtime = createDesktopRuntimeSession();
  try { return await runtime.client.command({ kind: 'runtime.mcp_app', payload: input }, value => value, signal); }
  finally { runtime.dispose(); }
}
type PendingAction = { text: string; label: string; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: Error) => void };
export function McpAppPanel({ sessionId, turnId, toolCallId, language }: { sessionId: string; turnId: string; toolCallId: string; language: AppLanguage }) {
  const [view, setView] = useState<McpAppView | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [permission, setPermission] = useState<any>(null), [pending, setPending] = useState<PendingAction | null>(null), [height, setHeight] = useState(400), [full, setFull] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), pendingRef = useRef<PendingAction | null>(null), opening = useRef<AbortController | null>(null);
  const frameLoads = useRef(0);
  const zh = language === 'zh';
  const close = () => { pendingRef.current?.reject(new Error('Interface closed.')); pendingRef.current = null; setPending(null); setView(null); setPermission(null); setFull(false); };
  useEffect(() => () => { opening.current?.abort(); pendingRef.current?.reject(new Error('Interface closed.')); }, []);
  useEffect(() => {
    if (!view) return;
    const controller = new AbortController(); let initialized = false, initializing = false, polling = false, activeCalls = 0;
    const send = (value: unknown) => frame.current?.contentWindow?.postMessage(value, '*');
    const requestUser = (text: string, label: string, run: () => Promise<unknown>) => new Promise((resolve, reject) => {
      if (pendingRef.current) { reject(new Error('Another interface request is awaiting a response.')); return; }
      const action = { text, label, run, resolve, reject }; pendingRef.current = action; setPending(action);
    });
    const listener = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string' || JSON.stringify(data).length > 128_000) return;
      const params = data.params ?? {};
      const respond = (result: unknown) => { if (data.id !== undefined) send({ jsonrpc: '2.0', id: data.id, result }); };
      try {
        if (data.method === 'ui/initialize') {
          initializing = true;
          respond({ protocolVersion: '2026-01-26', hostInfo: { name: 'CardBush', version: '1.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {} }, hostContext: { theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', locale: zh ? 'zh-CN' : 'en-US', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { maxHeight: 900 }, toolInfo: { tool: view.tool } } }); return;
        }
        if (data.method === 'ui/notifications/initialized') {
          if (!initializing || initialized) return; initialized = true;
          send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: view.input } });
          send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: view.result }); return;
        }
        const legacy = typeof data.id === 'string' && data.id.startsWith('openai-');
        if (!initialized && !legacy) throw new Error('Initialize the interface before sending requests.');
        if (data.method === 'ping' || data.method === 'notifications/message') { respond({}); return; }
        if (data.method === 'ui/notifications/size-changed') { if (Number.isFinite(params.height)) setHeight(Math.min(900, Math.max(160, params.height))); return; }
        if (data.method === 'ui/request-display-mode') { const mode = params.mode === 'fullscreen' ? 'fullscreen' : 'inline'; setFull(mode === 'fullscreen'); respond({ mode }); return; }
        if (data.method === 'tools/call' || data.method === 'resources/read') {
          if (activeCalls) throw new Error('Wait for the current interface action.'); activeCalls++;
          try { const result = await command({ action: data.method === 'resources/read' ? 'resource' : 'call', token: view.token, name: params.name, uri: params.uri, arguments: params.arguments ?? {} }, controller.signal); respond(result); }
          finally { activeCalls--; setPermission(null); } return;
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
      } catch (cause) { if (data.id !== undefined) send({ jsonrpc: '2.0', id: data.id, error: { code: -32000, message: cause instanceof Error ? cause.message : String(cause) } }); }
    };
    window.addEventListener('message', listener);
    const timer = setInterval(() => {
      if (!activeCalls || polling) return; polling = true;
      void command({ action: 'status', token: view.token }, controller.signal).then(value => { if (!controller.signal.aborted) setPermission(value.permission); }).catch(() => {}).finally(() => { polling = false; });
    }, 300);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('message', listener); void command({ action: 'close', token: view.token }).catch(() => {}); };
  }, [view, sessionId, zh]);
  if (!sessionId || !turnId || unavailable) return null;
  return <div className={`mcp-app-panel ${full ? 'fullscreen' : ''}`}>
    {!view && <button type="button" disabled={loading} onClick={async () => {
      setError(''); setLoading(true); const controller = new AbortController(); opening.current = controller;
      try { const result = await command({ action: 'open', sessionId, turnId, toolCallId }, controller.signal); if (!controller.signal.aborted) { if (result) { frameLoads.current = 0; setView(result); } else setUnavailable(true); } }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }}>{loading ? (zh ? '正在打开…' : 'Opening…') : (zh ? '打开插件界面' : 'Open plugin interface')}</button>}
    {error && <p role="alert">{error}</p>}
    {view && <><header><strong>{String(view.tool.name)}</strong><button type="button" onClick={close}>{zh ? '关闭界面' : 'Close interface'}</button></header>
      {permission && <div className="mcp-app-confirm" role="alert"><p>{permission.reason}</p><code>{JSON.stringify(permission.targets)}</code>{['allow_once', 'deny'].map(decision => <button type="button" key={decision} onClick={() => { void command({ action: 'answer', token: view.token, permissionId: permission.permissionId, decision }).catch(cause => setError(String(cause))); setPermission(null); }}>{decision === 'allow_once' ? (zh ? '允许本次' : 'Allow once') : (zh ? '拒绝' : 'Deny')}</button>)}</div>}
      {pending && <div className="mcp-app-confirm"><p>{pending.text}</p><button type="button" onClick={() => { pendingRef.current = null; setPending(null); void pending.run().then(pending.resolve, pending.reject); }}>{pending.label}</button><button type="button" onClick={() => { pending.reject(new Error('User declined.')); pendingRef.current = null; setPending(null); }}>{zh ? '取消' : 'Cancel'}</button></div>}
      <iframe ref={frame} name="cardbush-mcp-app" title={String(view.tool.name)} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => { if (++frameLoads.current > 1) { close(); setError(zh ? '界面页面已更换，请重新打开。' : 'The interface document changed. Reopen it to continue.'); } }} allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ height: full ? '100%' : height }} srcDoc={mcpAppDocument(view, language)} />
    </>}
  </div>;
}
