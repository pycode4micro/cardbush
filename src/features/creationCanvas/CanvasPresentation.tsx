import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { CanvasItem, CanvasSnapshot } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import { HtmlComponentContext } from '../components/HtmlComponentContext';
import { CanvasItemContent } from './CanvasStage';
import { fitCanvasPresentation } from './canvasGeometry';

const ignoreActivation = () => {};
type Mode = 'pages' | 'continuous';
type Layout = 'canvas' | 'regions';

export function CanvasPresentation({ snapshot, language, initialId, onClose }: {
  snapshot: CanvasSnapshot; language: string; initialId?: string; onClose: () => void;
}) {
  const t = uiText(language), titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null), screen = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
  const items = useMemo(() => [...snapshot.document.items].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x), [snapshot.document.items]);
  const [mode, setMode] = useState<Mode>('pages'), [currentId, setCurrentId] = useState(initialId);
  const [layout, setLayout] = useState<Layout>('canvas');
  const [size, setSize] = useState({ width: 1, height: 1 });
  const canvas = useMemo(() => fitCanvasPresentation(size, items, mode === 'continuous'), [size, items, mode]);
  const canvasReadingY = useRef(0);
  const index = Math.max(0, items.findIndex(item => item.id === currentId));
  const [fullscreen, setFullscreen] = useState(false), [error, setError] = useState('');
  const number = new Intl.NumberFormat(language);
  const pageLabel = (page: number) => t('canvasPresentation.pageCount', { page: number.format(page + 1), count: number.format(items.length) });
  const navigationHint = t(layout === 'regions' ? 'canvasPresentation.navigationHint' : mode === 'continuous' ? 'canvasPresentation.canvasScrollHint' : 'canvasPresentation.canvasFitHint');
  const rgb = snapshot.document.background.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const light = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150;

  useEffect(() => {
    const node = dialog.current!, surface = screen.current!, opener = document.activeElement as HTMLElement | null;
    node.showModal();
    const changed = () => setFullscreen(document.fullscreenElement === surface);
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement === surface) void document.exitFullscreen().catch(() => {});
      node.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const node = viewport.current!;
    const resize = () => {
      const style = getComputedStyle(node);
      setSize({ width: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) });
    };
    resize(); const observer = new ResizeObserver(resize); observer.observe(node);
    return () => observer.disconnect();
  }, [layout]);
  useLayoutEffect(() => {
    if (layout === 'canvas' && viewport.current) viewport.current.scrollTop = mode === 'continuous' ? canvasReadingY.current * canvas.scale : 0;
  }, [layout, mode, canvas.scale]);
  const scrollToPage = (page: number) => {
    const root = viewport.current, node = root?.querySelectorAll<HTMLElement>('.canvas-presentation-page')[page];
    if (root && node) root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top;
  };
  // Changing modes preserves the current region, including when the window resizes.
  const activeIndex = useRef(index); activeIndex.current = index;
  useLayoutEffect(() => {
    if (layout !== 'regions' || mode !== 'continuous' || !viewport.current) return;
    scrollToPage(activeIndex.current);
    const observer = new ResizeObserver(() => scrollToPage(activeIndex.current));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [layout, mode, items]);
  const go = (page: number) => {
    const next = Math.max(0, Math.min(items.length - 1, page));
    setCurrentId(items[next]?.id);
    if (mode === 'continuous') scrollToPage(next);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true], .canvas-presentation-content')) return;
    if (layout === 'canvas') {
      const root = viewport.current;
      if (mode !== 'continuous' || !root) return;
      const movement = { ArrowUp: -.1, ArrowDown: .1, PageUp: -.9, PageDown: .9 }[event.key];
      const space = event.code === 'Space' && !(event.target as HTMLElement).closest('button');
      if (movement !== undefined || space || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        root.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? root.scrollHeight
          : root.scrollTop + root.clientHeight * (movement ?? (event.shiftKey ? -.9 : .9));
      }
      return;
    }
    const next = { ArrowLeft: index - 1, ArrowUp: index - 1, PageUp: index - 1, ArrowRight: index + 1, ArrowDown: index + 1, PageDown: index + 1, Home: 0, End: items.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); go(next); }
    else if (event.code === 'Space' && !(event.target as HTMLElement).closest('button')) { event.preventDefault(); go(index + (event.shiftKey ? -1 : 1)); }
  };
  const toggleFullscreen = async () => {
    setError('');
    try {
      if (document.fullscreenElement === screen.current) await document.exitFullscreen();
      else await screen.current?.requestFullscreen();
    } catch { setError(t('canvasPresentation.fullscreenUnavailable')); }
  };
  return <dialog ref={dialog} className="canvas-presentation" data-mode={mode} data-layout={layout} data-light-paper={light}
    style={{ '--canvas-paper': snapshot.document.background } as CSSProperties} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={keyDown}
    onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="canvas-presentation-screen" ref={screen}>
    <div className="canvas-presentation-window-drag" aria-hidden="true"/>
    <header className="canvas-presentation-toolbar">
      <h1 id={titleId}>{snapshot.document.title || t('canvasSidebar.untitledCanvas')}</h1>
      <div className="canvas-presentation-modes" role="group" aria-label={t('canvasPresentation.layout')}>
        <button aria-pressed={layout === 'canvas'} onClick={() => setLayout('canvas')}>{t('canvasPresentation.originalLayout')}</button>
        <button aria-pressed={layout === 'regions'} onClick={() => setLayout('regions')}>{t('canvasPresentation.byRegion')}</button>
      </div>
      <div className="canvas-presentation-modes" role="group" aria-label={t('canvasPresentation.mode')}>
        <button aria-pressed={mode === 'pages'} onClick={() => setMode('pages')}>{t(layout === 'canvas' ? 'canvasPresentation.singlePage' : 'canvasPresentation.pages')}</button>
        <button aria-pressed={mode === 'continuous'} onClick={() => setMode('continuous')}>{t(layout === 'canvas' ? 'canvasPresentation.continuousCanvas' : 'canvasPresentation.continuous')}</button>
      </div>
      <button className="canvas-presentation-icon" aria-label={t(fullscreen ? 'canvasPresentation.exitFullscreen' : 'canvasPresentation.fullscreen')} title={t(fullscreen ? 'canvasPresentation.exitFullscreen' : 'canvasPresentation.fullscreen')} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2/> : <Maximize2/>}</button>
      <button className="canvas-presentation-icon" autoFocus aria-label={t('canvasPresentation.close')} title={t('canvasPresentation.close')} onClick={onClose}><X/></button>
    </header>
    {error && <p className="canvas-presentation-error" role="alert">{error}</p>}
    <HtmlComponentContext.Provider value={null}>
      <div className="canvas-presentation-viewport" ref={viewport} tabIndex={0} aria-label={navigationHint} onScroll={() => {
        if (mode !== 'continuous' || !viewport.current) return;
        if (layout === 'canvas') { canvasReadingY.current = viewport.current.scrollTop / canvas.scale; return; }
        const root = viewport.current, center = root.getBoundingClientRect().top + root.clientHeight / 2;
        const closest = Array.from(root.querySelectorAll('.canvas-presentation-page')).reduce((best, node, candidate) => {
          const rect = node.getBoundingClientRect(), distance = Math.abs(rect.top + rect.height / 2 - center);
          return distance < best.distance ? { index: candidate, distance } : best;
        }, { index: 0, distance: Infinity });
        setCurrentId(items[closest.index]?.id);
      }}>
        <div className="canvas-presentation-layout" hidden={!items.length} style={layout === 'canvas' ? { width: canvas.width, height: canvas.height } : undefined}>
          {items.map((item, page) => <PresentationPage key={item.id} item={item} snapshot={snapshot} language={language}
            label={layout === 'canvas' ? item.title || pageLabel(page) : pageLabel(page)} hidden={layout === 'regions' && mode === 'pages' && page !== index}
            active={layout === 'canvas' || page === index} canvasScale={layout === 'canvas' ? canvas.scale : undefined}
            frame={layout === 'canvas' ? { left: (item.frame.x - canvas.x) * canvas.scale, top: (item.frame.y - canvas.y) * canvas.scale,
              width: item.frame.width * canvas.scale, height: item.frame.height * canvas.scale, zIndex: snapshot.document.items.indexOf(item) + 1 } : undefined}/>) }
        </div>
        {!items.length && <p className="canvas-presentation-empty">{t('canvasPresentation.empty')}</p>}
      </div>
    </HtmlComponentContext.Provider>
    <footer className="canvas-presentation-navigation">
      {layout === 'regions' && <button className="canvas-presentation-icon" aria-label={t('canvasPresentation.previous')} title={t('canvasPresentation.previous')} disabled={!index} onClick={() => go(index - 1)}><ChevronLeft/></button>}
      <span role="status" aria-live="polite">{!items.length ? t('canvasPresentation.empty') : layout === 'regions' ? pageLabel(index) : t('canvasPresentation.canvasCount', { count: number.format(items.length) })}</span>
      {layout === 'regions' && <button className="canvas-presentation-icon" aria-label={t('canvasPresentation.next')} title={t('canvasPresentation.next')} disabled={index >= items.length - 1} onClick={() => go(index + 1)}><ChevronRight/></button>}
      <small>{navigationHint}</small>
    </footer>
    </div>
  </dialog>;
}

function PresentationPage({ item, snapshot, language, label, hidden, active, canvasScale, frame }: {
  item: CanvasItem; snapshot: CanvasSnapshot; language: string; label: string; hidden: boolean; active: boolean;
  canvasScale?: number; frame?: CSSProperties;
}) {
  const body = useRef<HTMLDivElement>(null), [pageScale, setScale] = useState(1);
  const scale = canvasScale ?? pageScale;
  // Keep visited pages mounted so HTML interactions survive page and mode changes.
  const [visited, setVisited] = useState(!hidden);
  useEffect(() => { if (!hidden) setVisited(true); }, [hidden]);
  useLayoutEffect(() => {
    if (canvasScale !== undefined) return;
    const node = body.current!;
    const resize = () => {
      if (!node.clientWidth || !node.clientHeight) return;
      setScale(Math.min(node.clientWidth / item.frame.width, node.clientHeight / item.frame.height));
    };
    resize(); const observer = new ResizeObserver(resize); observer.observe(node);
    return () => observer.disconnect();
  }, [item.frame.width, item.frame.height, hidden, canvasScale]);
  return <section className="canvas-presentation-page" data-presentation-item={item.id} hidden={hidden} aria-label={label} style={frame}>
    <h2>{item.title || label}</h2>
    <div className="canvas-presentation-page-body" ref={body}>
      <div className="canvas-presentation-paper" style={{ width: item.frame.width * scale, height: item.frame.height * scale }}>
        <div className="canvas-presentation-content canvas-item-content" style={{ width: item.frame.width, height: item.frame.height, transform: `scale(${scale})` }}>
          {(visited || !hidden) && <CanvasItemContent item={item} manifest={snapshot.path} language={language}
            resourceRevision={snapshot.resources?.[item.id]} active={active} onActivate={ignoreActivation}/>}
        </div>
      </div>
    </div>
  </section>;
}
