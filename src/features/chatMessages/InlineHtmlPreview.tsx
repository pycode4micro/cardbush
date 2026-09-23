import { createElement, memo, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, MoreHorizontal, Play, RotateCw, X } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { basename } from '../../shared/localPaths';
import { resolveFilePreview } from '../inspector/filePreviewRegistry';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { connectInlineHtmlPresentation, foldedHtmlHeight, type InlineHtmlLayout } from './inlineHtmlPresentation';
import { useInlineHtmlFileVersion } from './inlineHtmlFileVersions';
import { captureInlineHtmlReadingPosition } from './inlineHtmlReadingPosition';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';

/** Uses the same file adapter as the inspector; only an authored embed mounts it. */
export function isHtmlPreviewPath(path: string) {
  return resolveFilePreview(path)?.id === 'html';
}

const expandedHeightLimit = 2400;
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
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const [closed, setClosed] = useState(false);
  // Visible pages bypass buffer preloading, regardless of the Turn's age.
  const visible = pageVisible && !closed && (inViewport || (nearViewport && activated));
  const [revision, setRevision] = useState(0);
  const [layout, setLayout] = useState<InlineHtmlLayout>({ height: 360, blocks: [] });
  const { height } = layout;
  const [previewLimit, setPreviewLimit] = useState(previewHeightLimit);
  const [expanded, setExpanded] = useState(false);
  const [visualization, setVisualization] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastVersion = useRef(fileVersion);
  const reloadTicket = useRef(0);
  const restoreFrame = useRef(0);
  const readingPosition = useRef<{ anchor: ReturnType<typeof captureInlineHtmlReadingPosition>; scrollY: number } | undefined>(undefined);
  const currentVersion = useInlineHtmlFileVersion(path, visible && !host, fileVersion);
  const remoteFile = useConversationFileSource(path, visible && Boolean(host), { preview: true, revision });
  const source = host ? remoteFile.source : resolveFilePreview(path)?.source(path);
  const label = title || basename(path);
  const openFull = () => host ? host.openFile(path) : openInspector(path, label);
  const fileLink = host ? <button type="button" className="markdown-file-link" onClick={openFull}>{label}</button>
    : <LocalFileReferenceLink path={path} knownFileName={basename(path)}>{label}</LocalFileReferenceLink>;
  const zh = language === 'zh';
  const canExpand = visualization && height > previewLimit;
  const folded = canExpand && !expanded;
  const guestHeight = Math.min(expandedHeightLimit, height);
  const viewportHeight = folded ? foldedHtmlHeight(layout, previewLimit) : guestHeight;

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
        readingPosition.current?.anchor.restore();
        readingPosition.current = undefined;
      });
    });
  }, []);

  const reload = useCallback(async () => {
    const ticket = ++reloadTicket.current;
    setMenuOpen(false);
    if (stateRef.current === 'ready' && container.current) {
      readingPosition.current?.anchor.dispose();
      const position = { anchor: captureInlineHtmlReadingPosition(container.current), scrollY: 0 };
      readingPosition.current = position;
      setState('loading');
      try {
        const guest = frame.current as HTMLElement & { executeJavaScript(code: string): Promise<number> };
        position.scrollY = await guest.executeJavaScript('scrollY');
      } catch { /* A failed or navigating guest has no reading position. */ }
    }
    if (ticket !== reloadTicket.current) return;
    setState('loading');
    setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    if (!currentVersion) return;
    const previous = lastVersion.current;
    lastVersion.current = currentVersion;
    if (visible && previous !== undefined && previous !== currentVersion) void reload();
  }, [currentVersion, visible, reload]);

  useEffect(() => () => {
    reloadTicket.current++;
    cancelAnimationFrame(restoreFrame.current);
    readingPosition.current?.anchor.dispose();
    readingPosition.current = undefined;
  }, []);

  useEffect(() => {
    if (visible) return;
    // Invalidate pending guest reads as well as removing the webview itself.
    reloadTicket.current++;
    cancelAnimationFrame(restoreFrame.current);
    readingPosition.current?.anchor.dispose();
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
    if (!visible || !visualization) return;
    const resize = () => setPreviewLimit(previewHeightLimit());
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [visible, visualization]);

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
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const webview = frame.current;
    if (!visible || !webview) return;
    let settled = false;
    let failed = false;
    let disconnectPresentation: (() => void) | undefined;
    const deadline = window.setTimeout(() => fail(), 30000);
    const ready = () => {
      if (settled) return;
      settled = true;
      disconnectPresentation = connectInlineHtmlPresentation(webview, container.current!, value => {
        setLayout(value);
        restoreReadingPosition();
      }, mode => {
        setVisualization(mode);
        if (!mode) restoreReadingPosition();
      }, () => {
        if (failed) return;
        window.clearTimeout(deadline);
        setState('ready');
      });
      const scrollY = readingPosition.current?.scrollY;
      if (scrollY) void (webview as HTMLElement & { executeJavaScript(code: string): Promise<unknown> })
        .executeJavaScript(`scrollTo(0,${JSON.stringify(scrollY)})`).catch(() => {});
    };
    const fail = (event?: Event) => {
      const detail = event as (Event & { isMainFrame?: boolean; errorCode?: number }) | undefined;
      if (detail?.isMainFrame === false || detail?.errorCode === -3) return;
      failed = true;
      settled = true;
      window.clearTimeout(deadline);
      disconnectPresentation?.();
      readingPosition.current?.anchor.dispose();
      readingPosition.current = undefined;
      setVisualization(false);
      setState('failed');
    };
    const navigated = (event: Event) => {
      if (((event as Event & { httpResponseCode?: number }).httpResponseCode ?? 0) >= 400) fail();
    };
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-navigate', navigated);
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('render-process-gone', fail);
    return () => {
      failed = true;
      window.clearTimeout(deadline);
      disconnectPresentation?.();
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-navigate', navigated);
      webview.removeEventListener('did-fail-load', fail);
      webview.removeEventListener('render-process-gone', fail);
    };
  }, [visible, source, revision, restoreReadingPosition]);

  function toggleExpansion() {
    setExpanded(value => !value);
    if (!expanded) return;
    // A document taller than the expanded cap may have been scrolled inside its
    // guest. Folding must show the first chart again, not a cropped later plot.
    if (stateRef.current === 'ready') void (frame.current as HTMLElement & { executeJavaScript(code: string): Promise<unknown> })
      ?.executeJavaScript('scrollTo(0,0)').catch(() => {});
    const aboveViewport = (container.current?.getBoundingClientRect().top ?? 0) < 0;
    requestAnimationFrame(() => {
      if (aboveViewport) container.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
      expansionButton.current?.focus({ preventScroll: true });
    });
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
        <button className="inline-html-reopen" type="button" onClick={openPreview} aria-label={zh ? '打开 HTML 预览' : 'Open HTML preview'} title={zh ? '打开预览' : 'Open preview'}><Play size={13} /><span>{zh ? '预览' : 'Preview'}</span></button>
        <button type="button" onClick={openFull} aria-label={zh ? '在侧栏展开 HTML' : 'Open HTML in side panel'} title={zh ? '在侧栏展开' : 'Open in side panel'}><Maximize2 size={14} /></button>
      </span>
    </span>
  </span>;

  // Phrasing elements keep ![] valid inside Markdown paragraphs and memo links.
  return <span ref={container} className={`inline-html-preview${visualization ? ' is-visualization' : ''}${folded ? ' is-folded' : ''}${folded && viewportHeight < previewLimit ? ' is-section-folded' : ''}`} aria-label={label}>
    {visualization && <span className="inline-html-heading">
      <span>{zh ? '交互图表' : 'Interactive chart'}</span>
      <span className="inline-html-rule" aria-hidden="true" />
      {canExpand && expanded && <button className="inline-html-collapse-top" type="button" aria-expanded={true} aria-controls={viewportId}
        onClick={toggleExpansion}><ChevronUp size={14} />{zh ? '收起图表' : 'Collapse chart'}</button>}
      <button className="inline-html-menu-toggle" type="button" aria-label={zh ? '图表选项' : 'Visualization options'}
        aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={18} /></button>
      <button className="inline-html-close" type="button" onClick={closePreview} aria-label={zh ? '关闭 HTML 预览' : 'Close HTML preview'} title={zh ? '关闭预览' : 'Close preview'}><X size={14} /></button>
    </span>}
    <span className="inline-html-toolbar" hidden={visualization && !menuOpen && state !== 'failed'}>
      {fileLink}
      <span className="inline-html-actions">
        <button type="button" onClick={reload} aria-label={zh ? '重新加载 HTML' : 'Reload HTML'} title={zh ? '重新加载' : 'Reload'}><RotateCw size={14} /></button>
        <button type="button" onClick={() => { setMenuOpen(false); openFull(); }} aria-label={zh ? '在侧栏展开 HTML' : 'Open HTML in side panel'} title={zh ? '在侧栏展开' : 'Open in side panel'}><Maximize2 size={14} /></button>
        {!visualization && <button className="inline-html-close" type="button" onClick={closePreview} aria-label={zh ? '关闭 HTML 预览' : 'Close HTML preview'} title={zh ? '关闭预览' : 'Close preview'}><X size={14} /></button>}
      </span>
    </span>
    <span id={viewportId} className={`inline-html-viewport is-${visible ? state : 'suspended'}`} style={visualization ? { height: viewportHeight } : undefined} aria-busy={visible && state === 'loading'}>
      {visible && source && state !== 'failed' && createElement('webview', {
        key: `${source}:${revision}`,
        ref: frame,
        src: source,
        title: label,
        onFocus: () => setMenuOpen(false),
        className: 'inline-html-webview',
        // Keep one guest at its intrinsic height; folding must not reload or
        // reflow authored charts, reset filters, or create a nested scroll area.
        style: visualization ? { height: guestHeight } : undefined,
        webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
      })}
      {(!visible || state !== 'ready') && <span className="inline-html-status" role="status">
        {state === 'failed' ? <>
          <span>{zh ? '预览暂时无法加载' : 'Preview could not load'}</span>
          <button type="button" onClick={reload}>{zh ? '重试' : 'Retry'}</button>
        </> : <span>{!visible ? (zh ? '预览已暂停' : 'Preview suspended') : (zh ? 'HTML 预览' : 'HTML preview')}</span>}
      </span>}
    </span>
    {visualization && <span className="inline-html-footer">
      <span className="inline-html-rule" aria-hidden="true" />
      {!folded && <span>{height > expandedHeightLimit ? (zh ? '图内可继续滚动' : 'Scroll within chart for more') : (zh ? '图表结束' : 'End of chart')}</span>}
      {canExpand && <button ref={expansionButton} className="inline-html-expand-toggle" type="button" aria-expanded={expanded} aria-controls={viewportId}
        onClick={toggleExpansion}>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? (zh ? '收起图表' : 'Collapse chart') : (zh ? '展开图表' : 'Expand chart')}
      </button>}
      {expanded && height > expandedHeightLimit && <button className="inline-html-open-full" type="button" onClick={openFull}>
        <Maximize2 size={13} />{zh ? '在侧栏查看' : 'Open in side panel'}</button>}
      <span className="inline-html-rule" aria-hidden="true" />
    </span>}
  </span>;
});
