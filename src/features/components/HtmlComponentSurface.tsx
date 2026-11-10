import { uiText } from '../../i18n';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HtmlComponentContext } from './HtmlComponentContext';
import { componentDocument } from './componentDocument';
import { componentProtocol, validateComponentText, type HtmlComponent } from './componentModel';
import { bookmarkUrl } from '../inspector/browserBookmarks';
import { componentId } from './componentId';
import { approvedOrigins, fetchComponentJson } from './componentNetwork';

import type { EventPresentation } from '@cardbush/bush-protocol';
type EventPageContext = Pick<EventPresentation['pages'][number], 'id' | 'title' | 'layout' | 'items'>;
export function HtmlComponentSurface({ component, active = true, eventPage, homeNetwork = false, onReady }: { component: HtmlComponent; active?: boolean; eventPage?: EventPageContext; homeNetwork?: boolean; onReady?:()=>void }) {
  const frame = useRef<HTMLIFrameElement>(null), host = useContext(HtmlComponentContext), latest = useRef(host);
  latest.current = host;
  const page = useRef(eventPage); page.current = eventPage;
  const visible = useRef(active); visible.current = active;
  const [error, setError] = useState(''), loads = useRef(0), mounted = useRef(true);
  const sites = homeNetwork && active && !eventPage ? approvedOrigins(component).join(' ') : '';
  const token = useMemo(() => componentId(), [component.id, component.html, sites]);
  const document = useMemo(() => componentDocument(component.html, token, Boolean(sites)), [component.html, token, sites]);
  const reply = (message: unknown) => frame.current?.contentWindow?.postMessage({ protocol: componentProtocol, token, ...message as object }, '*');
  const context = () => { const current = latest.current;
    if (page.current) {
      const {id, title, layout, items} = page.current;
      return {eventPage: {id, title, layout, items}};
    }
    return current ? { revision: current.revision, sessionId: current.sessionId, language: current.language, running: current.running } : null; };
  const publish = useRef(() => {});
  useEffect(() => {
    mounted.current = true; loads.current = 0; setError('');
    const requests = new AbortController();
    const replay = new Map<string, { input: string; result: Promise<unknown> }>(); let inFlight = 0;
    const handler = async (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !message || message.protocol !== componentProtocol || message.token !== token) return;
      if (typeof message.id !== 'string' || message.id.length > 100 || message.jsonrpc !== '2.0') return;
      try {
        if (new TextEncoder().encode(JSON.stringify(message)).length > 128000 || inFlight >= 8) throw new Error('REQUEST_LIMIT');
      } catch { reply({ id: message.id, error: 'REQUEST_LIMIT' }); return; }
      inFlight++;
      try {
        const params = message.params ?? {}; let result: unknown;
        const storageKey = 'cardbush.component-state.' + component.id;
        if (message.method === 'context.read') result = context();
        else if (message.method === 'net.fetchJson') {
          if (!visible.current || page.current || !sites) throw Error('CAPABILITY_DENIED');
          result = await fetchComponentJson(params.url, sites.split(' '), requests.signal);
        } else if (message.method === 'state.read') { const raw = page.current ? null : localStorage.getItem(storageKey); result = raw ? JSON.parse(raw) : null; }
        else if (message.method === 'state.write') {
          if (page.current) throw new Error('CAPABILITY_DENIED');
          if (!visible.current) throw new Error('INACTIVE_SURFACE');
          const json = JSON.stringify(params.value ?? null);
          if (new TextEncoder().encode(json).length > 16000) throw new Error('STATE_LIMIT');
          localStorage.setItem(storageKey, json); result = { saved: true };
        } else if (message.method === 'actions.invoke') {
          const current = latest.current;
          if (!visible.current) throw new Error('INACTIVE_SURFACE');
          if (page.current || !component.allowActions || !current) throw new Error('CAPABILITY_DENIED');
          if (params.contextRevision !== current.revision) throw new Error('STALE_CONTEXT');
          if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.length < 1 || params.idempotencyKey.length > 128) throw new Error('INVALID_IDEMPOTENCY_KEY');
          const key = current.revision + ':' + params.idempotencyKey, input = JSON.stringify([params.command, params.args]);
          const existing = replay.get(key);
          if (existing && existing.input !== input) throw new Error('IDEMPOTENCY_CONFLICT');
          if (existing) result = await existing.result;
          else {
            if (replay.size >= 128) throw new Error('ACTION_LIMIT');
            const action = Promise.resolve().then(async () => {
              const args = params.args ?? {};
              if (params.command === 'composer.fill') { current.fill(validateComponentText(args.text)); return { status: 'applied' }; }
              if (params.command === 'conversation.send') { const accepted = await current.send(validateComponentText(args.text)); if (accepted === false) throw new Error('NOT_ACCEPTED'); return { status: 'accepted' }; }
              if (params.command === 'browser.open') { const url = bookmarkUrl(args.url); if (!url) throw new Error('INVALID_URL'); current.openBrowser(url); return { status: 'opened' }; }
              throw new Error('UNKNOWN_COMMAND');
            });
            replay.set(key, { input, result: action }); result = await action;
          }
        } else throw new Error('UNKNOWN_METHOD');
        if (mounted.current) reply({ id: message.id, result });
      } catch (cause) { if (mounted.current) reply({ id: message.id, error: cause instanceof Error ? cause.message : 'FAILED' }); }
      finally { inFlight--; }
    };
    window.addEventListener('message', handler);
    return () => { mounted.current = false; requests.abort(); window.removeEventListener('message', handler); };
  }, [token, component.id, component.allowActions, sites]);
  useEffect(() => {
    const app = window.document.querySelector('.app'); let scheduled = 0;
    const update = () => {
      scheduled = 0; if (!frame.current || !app) return;
      const style = getComputedStyle(app);
      reply({ topic: 'theme.changed', value: {
        '--cb-background': style.getPropertyValue('--surface').trim(), '--cb-surface': style.getPropertyValue('--surface-alt').trim() || style.getPropertyValue('--surface').trim(),
        '--cb-text': style.getPropertyValue('--text').trim(), '--cb-muted': style.getPropertyValue('--text-soft').trim(),
        '--cb-border': style.getPropertyValue('--border').trim(), '--cb-accent': style.getPropertyValue('--accent').trim(),
        '--cb-font': style.fontFamily, '--cb-code-font': style.getPropertyValue('--code-font-family').trim() || 'monospace',
        '--cb-font-size': style.fontSize, '--cb-color-scheme': style.colorScheme,
        '--cb-reduced-motion': window.document.documentElement.dataset.reduceMotion === 'true' ? '1' : '0',
      } });
      reply({ topic: 'host.context', value: context() });
      reply({ topic: 'host.visibility', value: { visible: visible.current } });
      reply({ topic: 'host.resized', value: { width: frame.current.clientWidth, height: frame.current.clientHeight } });
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(update); };
    publish.current = update;
    const observer = new MutationObserver(schedule); if (app) observer.observe(app, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    const resize = new ResizeObserver(schedule); if (frame.current) resize.observe(frame.current);
    update();
    return () => { cancelAnimationFrame(scheduled); observer.disconnect(); resize.disconnect(); };
  }, [token]);
  useEffect(() => { publish.current(); }, [host?.revision, host?.language, host?.running, active, eventPage]);
  if (error) return <div className="html-component-error" role="alert">{error}</div>;
  return <iframe key={token} ref={frame} className="html-component-frame" title={component.title} srcDoc={document} sandbox="allow-scripts"
    referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    onLoad={() => { if (++loads.current > 1) { setError(uiText(host?.language)('htmlComponentSurface.componentNavigatedAwayFromItsSandboxDocument')); return; } publish.current(); onReady?.(); }} />;
}
