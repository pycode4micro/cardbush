import { uiText } from '../../i18n';
import { createElement, memo, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, MoreHorizontal, Play, RotateCw, X } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { basename } from '../../shared/localPaths';
import { isWindowVisible, watchWindowVisibility } from '../../shared/windowVisibility';
import { resolveFilePreview } from '../inspector/filePreviewRegistry';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { connectInlineHtmlPresentation, foldedHtmlHeight, type InlineHtmlLayout } from './inlineHtmlPresentation';
import { useInlineHtmlFileVersion } from './inlineHtmlFileVersions';
import { captureInlineHtmlReadingPosition } from './inlineHtmlReadingPosition';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { connectInlineHtmlGuestDiagnostics, observeInlineHtmlDiagnostics, type InlineHtmlDiagnostics } from './inlineHtmlDiagnostics';

/** Uses the same file adapter as the inspector; only an authored embed mounts it. */
export function isHtmlPreviewPath(path: string) {
  return resolveFilePreview(path)?.id === 'html';
}

const scrollRetentionMs = 750;
const previewHeightLimit = () => Math.min(520, Math.max(220, Math.round(window.innerHeight * 0.6)));

export const InlineHtmlPreview = memo(function InlineHtmlPreview({ path, title, language, fileVersion }: {
  path: string; title?: string; language: AppLanguage; fileVersion?: string;
}) {
  const host = useContext(ConversationHostContext);
  const container = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLElement>(null);
  const expansionButton = useRef<HTMLButtonElement>(null);
  const viewportId = useId();
  const [inViewport, setInViewport] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const [activated, setActivated] = useState(false);
  const [retained, setRetained] = useState(false);
  const [pageVisible, setPageVisible] = useState(isWindowVisible);
  const [closed, setClosed] = useState(false);
  // Visible pages bypass buffer preloading, regardless of the Turn's age.
  const requested = inViewport || (nearViewport && activated);
  // Scrolling across the buffer is not a new document. Keep the guest briefly
  // so boundary jitter and a quick scroll back retain its painted surface/state.
  const visible = pageVisible && !closed && (requested || retained);
  const [revision, setRevision] = useState(0);
  const [layout, setLayout] = useState<InlineHtmlLayout>({ height: 360, blocks: [] });
  const [measured, setMeasured] = useState(false);
  const { height } = layout;
  const [previewLimit, setPreviewLimit] = useState(previewHeightLimit);
  const [expanded, setExpanded] = useState(false);
  const [visualization, setVisualization] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastVersion = useRef(fileVersion);
  const restoreFrame = useRef(0);
  const readingPosition = useRef<ReturnType<typeof captureInlineHtmlReadingPosition> | undefined>(undefined);
  const currentVersion = useInlineHtmlFileVersion(path, visible && !host, fileVersion);
  const remoteFile = useConversationFileSource(path, visible && Boolean(host), { preview: true, revision });
  const source = host ? remoteFile.source : resolveFilePreview(path)?.source(path);
  const label = title || basename(path);
  const openFull = () => host ? host.openFile(path) : openInspector(path, label);
  const fileLink = host ? <button type="button" className="markdown-file-link" onClick={openFull}>{label}</button>
    : <LocalFileReferenceLink path={path} knownFileName={basename(path)}>{label}</LocalFileReferenceLink>;

  const canExpand = measured && state !== 'failed' && height > previewLimit;
  const folded = canExpand && !expanded;
  const guestHeight = height;
  const viewportHeight = folded ? foldedHtmlHeight(layout, previewLimit) : guestHeight;
  const diagnostics = useRef<InlineHtmlDiagnostics | undefined>(undefined);
  const diagnosticState = useRef({});
  diagnosticState.current = { inViewport, nearViewport, activated, retained, pageVisible, closed, requested, visible,
    revision, state, visualization, expanded, height, viewportHeight, guestHeight, previewLimit };

  useEffect(() => {
    if (!container.current) return;
    diagnostics.current = observeInlineHtmlDiagnostics(container.current, path, () => diagnosticState.current);
    return () => { diagnostics.current?.dispose(); diagnostics.current = undefined; };
  }, [path]);

  useEffect(() => {
    diagnostics.current?.record('state');
  }, [inViewport, nearViewport, activated, retained, pageVisible, closed, visible, revision, state, visualization, expanded, height, viewportHeight]);

  useEffect(() => {
    diagnostics.current?.record('source-change', { available: Boolean(source) });
  }, [source]);

  useEffect(() => { if (remoteFile.error) setState('failed'); }, [remoteFile.error]);

  useEffect(() => window.cardbushDesktop?.onInspectorOpenLink?.(detail => {
    const guest = frame.current as (HTMLElement & { getWebContentsId(): number }) | null;
    if (!guest || !visible) return;
    try {
      if (guest.getWebContentsId() !== detail.guestWebContentsId) return;
      const target = new URL(detail.target);
      if (host && source && target.protocol === 'cardbush-agent:' && target.host === new URL(source).host) {
        const targetPath = decodeURIComponent(target.pathname);
        host.openFile(path.startsWith('/') ? targetPath : targetPath.slice(1));
      } else if (/^https?:$/.test(target.protocol) || !host) openInspector(detail.target, detail.target);
    } catch { /* The guest may have been suspended while the link was opening. */ }
  }), [host, source, visible, path]);

  const restoreReadingPosition = useCallback(() => {
    if (!readingPosition.current) return;
    cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = requestAnimationFrame(() => {
      restoreFrame.current = requestAnimationFrame(() => {
        readingPosition.current?.restore();
        readingPosition.current = undefined;
      });
    });
  }, []);

  const reload = useCallback((reason = 'manual') => {
    diagnostics.current?.record('reload-request', { reason });
    setMenuOpen(false);
    if (stateRef.current === 'ready' && container.current) {
      readingPosition.current?.dispose();
      readingPosition.current = captureInlineHtmlReadingPosition(container.current);
    }
    setState('loading');
    setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    if (!currentVersion) return;
    const previous = lastVersion.current;
    lastVersion.current = currentVersion;
    if (visible && previous !== undefined && previous !== currentVersion) void reload('file-version');
  }, [currentVersion, visible, reload]);

  useEffect(() => () => {
    cancelAnimationFrame(restoreFrame.current);
    readingPosition.current?.dispose();
    readingPosition.current = undefined;
  }, []);

  useEffect(() => {
    if (visible) return;
    cancelAnimationFrame(restoreFrame.current);
    readingPosition.current?.dispose();
    readingPosition.current = undefined;
    setState('loading');
    setMenuOpen(false);
  }, [visible]);

  useEffect(() => {
    if (closed || !pageVisible || (!nearViewport && !inViewport)) { setActivated(false); return; }
    if (inViewport) { setActivated(true); return; }
    if (activated) return;
    // Give the current viewport a head start before warming adjacent pages.
    const delay = window.setTimeout(() => setActivated(true), 250);
    return () => window.clearTimeout(delay);
  }, [closed, pageVisible, nearViewport, inViewport, activated]);

  useEffect(() => {
    if (closed || !pageVisible) { setRetained(false); return; }
    if (requested) { setRetained(true); return; }
    if (!retained) return;
    const timeout = window.setTimeout(() => setRetained(false), scrollRetentionMs);
    return () => window.clearTimeout(timeout);
  }, [closed, pageVisible, requested, retained]);

  useEffect(() => {
    if (!visible) return;
    const resize = () => setPreviewLimit(previewHeightLimit());
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [visible]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      container.current?.querySelector<HTMLButtonElement>('.inline-html-menu-toggle')?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let scroller = host.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    // A placeholder retains layout outside the buffer; guests and scripts do not.
    const observer = new IntersectionObserver(entries => {
      diagnostics.current?.record('intersection', { ratio: entries[0]?.intersectionRatio, intersecting: entries[0]?.isIntersecting });
      setInViewport(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0));
    });
    observer.observe(host);
    let bufferObserver: IntersectionObserver | undefined;
    let previousHeight = -1;
    const resize = () => {
      const height = Math.round(scroller?.clientHeight || window.innerHeight);
      if (height === previousHeight) return;
      previousHeight = height;
      bufferObserver?.disconnect();
      bufferObserver = new IntersectionObserver(entries => {
        diagnostics.current?.record('buffer-intersection', { ratio: entries[0]?.intersectionRatio, intersecting: entries[0]?.isIntersecting });
        setNearViewport(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0));
      }, { root: scroller, rootMargin: `${height}px 0px` });
      bufferObserver.observe(host);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(scroller ?? document.documentElement);
    window.addEventListener('resize', resize);
    resize();
    return () => {
      observer.disconnect(); bufferObserver?.disconnect(); resizeObserver.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(isWindowVisible());
    const unwatchVisibility = watchWindowVisibility(update);
    update();
    return unwatchVisibility;
  }, []);

  useEffect(() => {
    const webview = frame.current;
    if (!visible || !webview) return;
    let settled = false;
    let failed = false;
    let disconnectPresentation: (() => void) | undefined;
    let disconnectGuestDiagnostics: (() => void) | undefined;
    const deadline = window.setTimeout(() => fail(), 30000);
    const ready = () => {
      diagnostics.current?.record('dom-ready', { settled });
      if (settled) return;
      settled = true;
      if (diagnostics.current) disconnectGuestDiagnostics = connectInlineHtmlGuestDiagnostics(
        webview as HTMLElement & { executeJavaScript(code: string): Promise<unknown> }, diagnostics.current);
      disconnectPresentation = connectInlineHtmlPresentation(webview, container.current!, value => {
        setMeasured(true);
        setLayout(value);
        restoreReadingPosition();
      }, mode => {
        setVisualization(mode);
      }, () => {
        if (failed) return;
        window.clearTimeout(deadline);
        setState('ready');
      }, (event, detail) => diagnostics.current?.record(event, detail));
    };
    const fail = (event?: Event) => {
      const detail = event as (Event & { isMainFrame?: boolean; errorCode?: number }) | undefined;
      diagnostics.current?.record('guest-failed', { failure: event?.type ?? 'deadline', code: detail?.errorCode, mainFrame: detail?.isMainFrame });
      if (detail?.isMainFrame === false || detail?.errorCode === -3) return;
      failed = true;
      settled = true;
      window.clearTimeout(deadline);
      disconnectPresentation?.();
      readingPosition.current?.dispose();
      readingPosition.current = undefined;
      setVisualization(false);
      setState('failed');
    };
    const navigated = (event: Event) => {
      diagnostics.current?.record('did-navigate', { code: (event as Event & { httpResponseCode?: number }).httpResponseCode });
      if (((event as Event & { httpResponseCode?: number }).httpResponseCode ?? 0) >= 400) fail();
    };
    const loading = (event: Event) => diagnostics.current?.record(event.type);
    webview.addEventListener('did-start-loading', loading);
    webview.addEventListener('did-stop-loading', loading);
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-navigate', navigated);
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('render-process-gone', fail);
    return () => {
      failed = true;
      window.clearTimeout(deadline);
      disconnectPresentation?.();
      diagnostics.current?.record('guest-disconnect');
      disconnectGuestDiagnostics?.();
      webview.removeEventListener('did-start-loading', loading);
      webview.removeEventListener('did-stop-loading', loading);
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-navigate', navigated);
      webview.removeEventListener('did-fail-load', fail);
      webview.removeEventListener('render-process-gone', fail);
    };
  }, [visible, source, revision, restoreReadingPosition]);

  function toggleExpansion(trigger: HTMLButtonElement) {
    // Reveal content below the current reading position. A bottom collapse
    // keeps that control in place; a top collapse keeps the document's top.
    // Never reset a second scroll offset or jump the whole preview into view.
    const anchor = expanded && trigger === expansionButton.current ? trigger : container.current;
    preserveScrollPositionForToggle(anchor, () => setExpanded(value => !value));
    if (expanded) expansionButton.current?.focus({ preventScroll: true });
  }

  const closePreview = () => {
    preserveScrollPositionForToggle(container.current, () => {
      setClosed(true);
      setMenuOpen(false);
    });
    container.current?.querySelector<HTMLButtonElement>('.inline-html-reopen')?.focus({ preventScroll: true });
  };
  const openPreview = () => {
    setState('loading');
    setClosed(false);
  };

  if (closed) return <span ref={container} className="inline-html-preview is-closed" aria-label={label}>
    <span className="inline-html-toolbar">
      {fileLink}
      <span className="inline-html-actions">
        <button className="inline-html-reopen" type="button" onClick={openPreview} aria-label={uiText(language)('inlineHtmlPreview.openHtmlPreview')}><Play size={13} /><span>{uiText(language)('inlineHtmlPreview.preview')}</span></button>
        <button type="button" onClick={openFull} aria-label={uiText(language)('inlineHtmlPreview.openHtmlInSidePanel')}><Maximize2 size={14} /></button>
      </span>
    </span>
  </span>;

  // Phrasing elements keep ![] valid inside Markdown paragraphs and memo links.
  return <span ref={container} className={`inline-html-preview${visualization ? ' is-visualization' : ''}${folded ? ' is-folded' : ''}${folded && viewportHeight < previewLimit ? ' is-section-folded' : ''}`} aria-label={label}>
    {visualization && <span className="inline-html-heading">
      {canExpand && expanded && <button className="inline-html-collapse-top" type="button" aria-expanded={true} aria-controls={viewportId}
        onClick={event => toggleExpansion(event.currentTarget)}><ChevronUp size={14} />{uiText(language)('shadowTemporaryChat.collapse')}</button>}
      <button className="inline-html-menu-toggle" type="button" aria-label={uiText(language)('inlineHtmlPreview.previewOptions')}
        aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={18} /></button>
      <button className="inline-html-close" type="button" onClick={closePreview} aria-label={uiText(language)('inlineHtmlPreview.closeHtmlPreview')}><X size={14} /></button>
    </span>}
    <span className="inline-html-toolbar" hidden={visualization && !menuOpen && state !== 'failed'}>
      {fileLink}
      <span className="inline-html-actions">
        <button type="button" onClick={() => void reload()} aria-label={uiText(language)('inlineHtmlPreview.reloadHtml')}><RotateCw size={14} /></button>
        <button type="button" onClick={() => { setMenuOpen(false); openFull(); }} aria-label={uiText(language)('inlineHtmlPreview.openHtmlInSidePanel')}><Maximize2 size={14} /></button>
        {!visualization && <button className="inline-html-close" type="button" onClick={closePreview} aria-label={uiText(language)('inlineHtmlPreview.closeHtmlPreview')}><X size={14} /></button>}
      </span>
    </span>
    <span id={viewportId} className={`inline-html-viewport is-${visible ? state : 'suspended'}`} style={{ height: viewportHeight }} aria-busy={visible && state === 'loading'}>
      {visible && source && state !== 'failed' && createElement('webview', {
        key: `${source}:${revision}`,
        ref: frame,
        src: source,
        'aria-label': label,
        onFocus: () => setMenuOpen(false),
        className: 'inline-html-webview',
        // Keep one guest at its intrinsic height; folding must not reload or
        // reflow authored content, reset controls, or create a nested scroll area.
        style: { height: guestHeight },
        webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
      })}
      {(!visible || state !== 'ready') && <span className="inline-html-status" role="status">
        {state === 'failed' ? <>
          <span>{uiText(language)('inlineHtmlPreview.previewCouldNotLoad')}</span>
          <button type="button" onClick={() => void reload()}>{uiText(language)('common.retry')}</button>
        </> : <span>{!visible ? (uiText(language)('inlineHtmlPreview.previewSuspended')) : (uiText(language)('inlineHtmlPreview.htmlPreview'))}</span>}
      </span>}
    </span>
    {canExpand && <span className="inline-html-footer">
      <button ref={expansionButton} className="inline-html-expand-toggle" type="button" aria-expanded={expanded} aria-controls={viewportId}
        onClick={event => toggleExpansion(event.currentTarget)}>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? (uiText(language)('shadowTemporaryChat.collapse')) : (uiText(language)('inlineHtmlPreview.expand'))}
      </button>
    </span>}
  </span>;
});
