import { uiText } from '../../i18n';
import { ArrowDown, ArrowUp, RotateCw, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import type { AppLanguage } from '../../types';
import './browserTools.css';

export type BrowserPageToolsHandle = { find: () => void; toggleDevice: () => void };
type Guest = HTMLElement & {
  getWebContentsId?: () => number;
  findInPage?: (text: string, options?: { forward?: boolean; findNext?: boolean }) => number;
  stopFindInPage?: (action: 'clearSelection') => void;
};

export const BrowserPageTools = forwardRef<BrowserPageToolsHandle, { webviewRef: RefObject<Guest | null>; revision: number; language: AppLanguage }>(function BrowserPageTools({ webviewRef, revision, language }, ref) {
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState('');
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [device, setDevice] = useState(false), [width, setWidth] = useState('390'), [height, setHeight] = useState('844');
  const [error, setError] = useState(''), input = useRef<HTMLInputElement>(null), request = useRef(0);
  const emulated = useRef<number | null>(null);
  const search = useCallback((forward = true, next = false) => {
    const guest = webviewRef.current;
    try {
      if (!query) { guest?.stopFindInPage?.('clearSelection'); setMatches({ current: 0, total: 0 }); return; }
      request.current = guest?.findInPage?.(query, { forward, findNext: !next }) ?? 0;
    } catch (cause) { setError(String(cause)); }
  }, [query, webviewRef]);
  const closeFind = () => { setFindOpen(false); try { webviewRef.current?.stopFindInPage?.('clearSelection'); } catch { /* Closing guest. */ } };
  const showFind = useCallback(() => { setFindOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, []);
  useImperativeHandle(ref, () => ({ find: showFind, toggleDevice: () => setDevice(value => !value) }), [showFind]);
  useEffect(() => {
    const guest = webviewRef.current;
    const found = (event: Event) => {
      const result = (event as Event & { result: { requestId: number; activeMatchOrdinal: number; matches: number } }).result;
      if (result?.requestId === request.current) setMatches({ current: result.activeMatchOrdinal, total: result.matches });
    };
    guest?.addEventListener('found-in-page', found);
    const stop = window.cardbushDesktop?.browser?.onFind(id => { try { if (guest?.getWebContentsId?.() === id) showFind(); } catch { /* Guest not ready. */ } });
    return () => { guest?.removeEventListener('found-in-page', found); stop?.(); };
  }, [webviewRef, revision, showFind]);
  useEffect(() => {
    if (!findOpen) return;
    setMatches({ current: 0, total: 0 });
    const timer = window.setTimeout(() => search(), 120);
    return () => window.clearTimeout(timer);
  }, [findOpen, search]);
  useEffect(() => {
    const guest = webviewRef.current, api = window.cardbushDesktop?.browser;
    if (!guest || !api || !device && emulated.current === null) return;
    let active = true, timer = 0;
    const apply = () => {
      try {
        const id = guest.getWebContentsId?.();
        if (!id) return;
        if (!device && emulated.current !== id) { emulated.current = null; return; }
        const w = Number(width), h = Number(height), rect = guest.getBoundingClientRect();
        if (device && (!Number.isInteger(w) || !Number.isInteger(h) || w < 240 || w > 3840 || h < 240 || h > 3840 || rect.width < 1 || rect.height < 1)) return;
        emulated.current = device ? id : null;
        void api.page(id, { action: 'device', size: device ? { width: w, height: h, scale: Math.max(.05, Math.min(1, rect.width / w, rect.height / h)) } : null })
          .then(() => { if (active) setError(''); }, cause => { if (active) setError(String(cause)); });
      } catch { /* Wait for the guest to become ready. */ }
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(apply, 100); };
    const observer = new ResizeObserver(schedule);
    if (device) observer.observe(guest);
    guest.addEventListener('dom-ready', schedule);
    schedule();
    return () => { active = false; window.clearTimeout(timer); observer.disconnect(); guest.removeEventListener('dom-ready', schedule); };
  }, [webviewRef, revision, device, width, height]);
  return <>
    {findOpen && <div className="browser-find-bar" role="search" aria-label={uiText(language)('browserMenu.findInPage')}>
      <input ref={input} autoFocus value={query} aria-label={uiText(language)('browserPageTools.findText')} placeholder={uiText(language)('browserMenu.findInPage')} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); search(!event.shiftKey, true); } if (event.key === 'Escape') { event.stopPropagation(); closeFind(); } }}/>
      <output aria-live="polite">{matches.current} / {matches.total}</output>
      <button type="button" disabled={!query} aria-label={uiText(language)('browserPageTools.previousMatch')} onClick={() => search(false, true)}><ArrowUp size={15}/></button>
      <button type="button" disabled={!query} aria-label={uiText(language)('browserPageTools.nextMatch')} onClick={() => search(true, true)}><ArrowDown size={15}/></button>
      <button type="button" aria-label={uiText(language)('browserPageTools.closeFind')} onClick={closeFind}><X size={15}/></button>
    </div>}
    {device && <div className="browser-device-bar" aria-label={uiText(language)('browserPageTools.deviceToolbar')}>
      <select aria-label={uiText(language)('browserPageTools.deviceSize')} value={['390x844', '768x1024', '1440x900'].includes(`${width}x${height}`) ? `${width}x${height}` : 'custom'} onChange={event => { if (event.target.value === 'custom') return; const [w, h] = event.target.value.split('x'); setWidth(w); setHeight(h); }}>
        <option value="custom">{uiText(language)('browserPageTools.responsive')}</option><option value="390x844">{uiText(language)('browserPageTools.phone')} · 390 × 844</option><option value="768x1024">{uiText(language)('browserPageTools.tablet')} · 768 × 1024</option><option value="1440x900">{uiText(language)('browserPageTools.desktop')} · 1440 × 900</option>
      </select>
      <input type="number" min={240} max={3840} aria-label={uiText(language)('browserPageTools.viewportWidth')} value={width} onChange={event => setWidth(event.target.value)}/><span>×</span>
      <input type="number" min={240} max={3840} aria-label={uiText(language)('browserPageTools.viewportHeight')} value={height} onChange={event => setHeight(event.target.value)}/>
      <button type="button" aria-label={uiText(language)('browserPageTools.rotateDevice')} onClick={() => { setWidth(height); setHeight(width); }}><RotateCw size={15}/></button>
      <button type="button" aria-label={uiText(language)('browserPageTools.closeDeviceToolbar')} onClick={() => setDevice(false)}><X size={15}/></button>
    </div>}
    {error && (findOpen || device) && <div className="browser-inline-error" role="alert">{error}</div>}
  </>;
});
