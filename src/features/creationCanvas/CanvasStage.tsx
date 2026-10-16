import { Expand, GripVertical, Hand, Maximize2, Plus, Scan, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { CanvasItem, CanvasSnapshot, CreationCanvas } from '@cardbush/bush-protocol';
import { HtmlComponentSurface } from '../components/HtmlComponentSurface';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { InspectorWebview } from '../inspector/InspectorWebview';
import { inspectorSource } from '../inspector/inspectorTargets';
import { openInspector } from '../inspector/inspectorEvents';
import { canvasFileTarget } from './canvasModel';
import { adjustCanvasFrame, equalCanvasFrames, zoomCanvasPan, type AlignmentGuide, type ResizeHandle } from './canvasGeometry';
import '../components/components.css';

const ignoreNavigation = () => {};
const resizeHandles: { key: ResizeHandle; x: number; y: number; zh: string; en: string }[] = [
  { key: 'nw', x: 0, y: 0, zh: '左上角', en: 'top left' }, { key: 'n', x: 50, y: 0, zh: '上边', en: 'top' },
  { key: 'ne', x: 100, y: 0, zh: '右上角', en: 'top right' }, { key: 'e', x: 100, y: 50, zh: '右边', en: 'right' },
  { key: 'se', x: 100, y: 100, zh: '右下角', en: 'bottom right' }, { key: 's', x: 50, y: 100, zh: '下边', en: 'bottom' },
  { key: 'sw', x: 0, y: 100, zh: '左下角', en: 'bottom left' }, { key: 'w', x: 0, y: 50, zh: '左边', en: 'left' },
];
type ItemDraft = { id: string; frame: CanvasItem['frame'] };
type Gesture = { pointer: number; x: number; y: number } & (
  { kind: 'item'; id: string; frame: CanvasItem['frame']; handle?: ResizeHandle; revision: string; zoom: number }
  | { kind: 'pan'; pan: { x: number; y: number } }
);
const resizeCursor = (handle?: ResizeHandle) => !handle ? 'grabbing' : ({ nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }[handle] + '-resize');

export function CanvasStage({ snapshot, language, selectedId, onSelect, onChange, onOpenFile, onAdd, onChat, onViewport, onError }: {
  snapshot: CanvasSnapshot; language: 'zh' | 'en'; selectedId?: string; onSelect: (id?: string) => void;
  onChange: (document: CreationCanvas, revision: string) => Promise<void>; onOpenFile: (item: CanvasItem, region: boolean) => void;
  onAdd: () => void; onChat: () => void; onViewport: (value: { width: number; height: number; zoom: number }) => void; onError: (message: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 1000, height: 700 });
  const [zoomOverride, setZoomOverride] = useState<number>(), [pan, setPan] = useState({ x: 0, y: 0 });
  const [draft, setDraft] = useState<ItemDraft>(), [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const [dragging, setDragging] = useState(false), [panMode, setPanMode] = useState(false), [spaceHeld, setSpaceHeld] = useState(false);
  const liveFrame = useRef<ItemDraft | undefined>(undefined), gesture = useRef<Gesture | undefined>(undefined), saving = useRef(false);
  const document = snapshot.document;
  const fit = Math.min(1, (size.width - 112) / document.width, (size.height - 144) / document.height);
  const zoom = Math.max(.02, Math.min(2, zoomOverride ?? fit));
  const rgb = document.background.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const light = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150;
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const panReady = panMode || spaceHeld;
  const releasePointer = () => {
    const pointer = gesture.current?.pointer;
    gesture.current = undefined;
    if (pointer !== undefined && viewport.current?.hasPointerCapture(pointer)) viewport.current.releasePointerCapture(pointer);
  };
  const cancel = () => { releasePointer(); liveFrame.current = undefined; setDraft(undefined); setGuides([]); setDragging(false); };
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setSize({ width: root.clientWidth, height: root.clientHeight }));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => onViewport({ ...size, zoom }), [size, zoom, onViewport]);
  useEffect(() => {
    cancelRef.current(); setZoomOverride(undefined); setPan({ x: 0, y: 0 }); setPanMode(false); setSpaceHeld(false);
  }, [snapshot.path]);
  useEffect(() => {
    const reset = () => { cancelRef.current(); setSpaceHeld(false); };
    const keyUp = (event: globalThis.KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && (gesture.current || viewport.current?.parentElement?.contains(globalThis.document.activeElement))) {
        reset(); setPanMode(false);
      }
    };
    window.addEventListener('blur', reset); window.addEventListener('keyup', keyUp); window.addEventListener('keydown', keyDown);
    return () => { window.removeEventListener('blur', reset); window.removeEventListener('keyup', keyUp); window.removeEventListener('keydown', keyDown); };
  }, []);
  const changeZoom = (next: number, anchor = { x: 0, y: 0 }) => {
    if (gesture.current) return;
    next = Math.max(.02, Math.min(2, next));
    setPan(value => zoomCanvasPan(value, zoom, next, anchor)); setZoomOverride(next);
  };
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const wheel = (event: WheelEvent) => {
      // Embedded documents retain their own scrolling and controls.
      if ((event.target as Element).closest('.canvas-item-content') && !panReady) return;
      event.preventDefault();
      if (gesture.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = root.getBoundingClientRect();
        changeZoom(zoom * Math.exp(-event.deltaY * unit * .002), { x: event.clientX - rect.left - size.width / 2, y: event.clientY - rect.top - (size.height - 56) / 2 });
      } else {
        setPan(value => ({ x: value.x - (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit, y: value.y - (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit }));
      }
    };
    root.addEventListener('wheel', wheel, { passive: false });
    return () => root.removeEventListener('wheel', wheel);
  }, [zoom, size, panReady]);

  const capture = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); viewport.current?.setPointerCapture(event.pointerId); setDragging(true); };
  const start = (event: PointerEvent, item: CanvasItem, handle?: ResizeHandle) => {
    if (event.button !== 0 || saving.current || gesture.current) return;
    capture(event); onSelect(item.id);
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    gesture.current = { kind: 'item', id: item.id, x: event.clientX, y: event.clientY, frame: item.frame, handle, revision: snapshot.revision, pointer: event.pointerId, zoom };
    liveFrame.current = { id: item.id, frame: item.frame }; setDraft(liveFrame.current);
  };
  const startPan = (event: PointerEvent) => {
    if (gesture.current || (event.button !== 0 && event.button !== 1)) return;
    const blank = (event.target as Element).matches('.canvas-stage, .canvas-size, .canvas-plane, .canvas-pan-catcher');
    if (event.button !== 1 && !panReady && !blank) return;
    capture(event);
    viewport.current?.focus({ preventScroll: true });
    if (event.button === 0 && !panReady) onSelect(undefined);
    gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, pan, pointer: event.pointerId };
  };
  const move = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    if (g.kind === 'pan') { setPan({ x: g.pan.x + event.clientX - g.x, y: g.pan.y + event.clientY - g.y }); return; }
    if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < 2 && liveFrame.current && equalCanvasFrames(liveFrame.current.frame, g.frame)) return;
    const result = adjustCanvasFrame({ frame: g.frame, dx: (event.clientX - g.x) / g.zoom, dy: (event.clientY - g.y) / g.zoom, handle: g.handle,
      bounds: document, peers: document.items.filter(item => item.id !== g.id).map(item => item.frame), zoom: g.zoom, snap: !event.altKey });
    liveFrame.current = { id: g.id, frame: result.frame }; setDraft(liveFrame.current); setGuides(result.guides);
  };
  const finish = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const latest = liveFrame.current;
    releasePointer(); liveFrame.current = undefined; setDragging(false); setGuides([]);
    if (g.kind !== 'item' || !latest || equalCanvasFrames(g.frame, latest.frame)) { setDraft(undefined); return; }
    if (g.revision !== snapshot.revision) {
      setDraft(undefined); onError(t('画板刚刚更新，请重新调整这个内容。', 'The canvas changed. Please adjust this item again.')); return;
    }
    // Keep the final frame visible until the saved snapshot arrives.
    saving.current = true;
    void onChange({ ...document, items: document.items.map(item => item.id === g.id ? { ...item, frame: latest.frame } : item) }, g.revision)
      .catch(() => {}).finally(() => { saving.current = false; setDraft(value => value === latest ? undefined : value); });
  };
  const keyboardAdjust = (event: KeyboardEvent, item: CanvasItem, handle?: ResizeHandle) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    if (saving.current || gesture.current) return;
    const amount = event.shiftKey ? 10 : 1;
    const result = adjustCanvasFrame({ frame: item.frame, dx: delta[0] * amount, dy: delta[1] * amount, handle, bounds: document, snap: false });
    if (equalCanvasFrames(item.frame, result.frame)) return;
    saving.current = true;
    void onChange({ ...document, items: document.items.map(value => value.id === item.id ? { ...value, frame: result.frame } : value) }, snapshot.revision)
      .catch(() => {}).finally(() => { saving.current = false; });
  };
  const activeHandle = gesture.current?.kind === 'item' ? gesture.current.handle : undefined;
  return <div className="canvas-stage-shell">
    <div className={'canvas-stage' + (panReady ? ' pan-ready' : '')} ref={viewport} tabIndex={0}
      aria-label={t('画板，拖动空白处平移', 'Canvas, drag empty space to pan')}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current) cancel(); }}
      onPointerDownCapture={event => { if (event.button === 1 || panReady) startPan(event); }}
      onPointerDown={startPan}
      onKeyDown={event => {
        if (event.code === 'Space' && (event.target === event.currentTarget || (event.target as Element).closest('.canvas-item-tools, .canvas-item-resize'))) {
          event.preventDefault(); setSpaceHeld(true);
        }
      }}>
      {dragging && <div className="canvas-drag-shield" style={{ cursor: resizeCursor(activeHandle) }}/>}
      {panReady && <div className="canvas-pan-catcher"/>}
      <div className="canvas-size" style={{ width: document.width * zoom, height: document.height * zoom,
        left: (size.width - document.width * zoom) / 2 + pan.x, top: (size.height - 56 - document.height * zoom) / 2 + pan.y }}>
        <div className="canvas-board-label" aria-hidden="true">{t('画板', 'Canvas')}<span>{document.width} × {document.height}</span></div>
        <div className="canvas-plane" data-canvas-width={document.width} data-canvas-height={document.height}
          style={{ width: document.width, height: document.height, backgroundColor: document.background, color: light ? '#252525' : '#e5e5e5',
            transform: `scale(${zoom})`, '--canvas-inverse-zoom': 1 / zoom, '--canvas-line': `${1 / zoom}px`,
            '--canvas-paper': document.background, '--canvas-dot': light ? '#0000001a' : '#ffffff18', '--canvas-grid-size': `${24 / zoom}px` } as CSSProperties}>
          {document.items.map(item => {
            const frame = draft?.id === item.id ? draft.frame : item.frame, active = selectedId === item.id;
            return <article key={item.id} data-canvas-item={item.id} data-canvas-source={item.kind === 'file' ? item.source : undefined}
              className={`canvas-item${active ? ' selected' : ''}${draft?.id === item.id && dragging ? ' adjusting' : ''}`}
              style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
              onPointerDownCapture={() => onSelect(item.id)} onFocusCapture={() => onSelect(item.id)}>
              <div className="canvas-item-tools" style={{ width: Math.max(72, frame.width * zoom) }}>
                <button className="canvas-item-move" aria-label={t('移动内容', 'Move item')}
                  title={t('拖动标题移动 · 方向键微调 · Alt 暂停吸附', 'Drag title to move · Arrow keys to nudge · Alt to bypass snapping')}
                  onPointerDown={event => start(event, item)} onKeyDown={event => keyboardAdjust(event, item)}>
                  <GripVertical size={14}/><span>{item.title || item.kind}{item.reference?.mode === 'snapshot' ? t(' · 选区快照', ' · Excerpt snapshot') : ''}</span>
                </button>
                <div className="canvas-item-actions">
                  {item.kind === 'file' && <><button aria-label={t('引用局部', 'Reference a region')} onClick={() => onOpenFile(item, true)}><Scan size={14}/></button><button aria-label={t('展开文件', 'Expand file')} onClick={() => onOpenFile(item, false)}><Expand size={14}/></button></>}
                  <button aria-label={t('移出画板', 'Remove from canvas')} onClick={() => void onChange({ ...document, items: document.items.filter(value => value.id !== item.id) }, snapshot.revision).catch(() => {})}><Trash2 size={14}/></button>
                </div>
              </div>
              <div className="canvas-item-content"><CanvasItemContent item={item} manifest={snapshot.path} language={language} resourceRevision={snapshot.resources?.[item.id]} onActivate={onSelect}/></div>
              {resizeHandles.map(handle => <button key={handle.key} className={`canvas-item-resize resize-${handle.key}`} data-resize-handle={handle.key}
                aria-label={handle.key === 'se' ? t('调整大小', 'Resize item') : `${t('调整大小', 'Resize item')}：${t(handle.zh, handle.en)}`}
                title={`${t('调整大小', 'Resize item')} · ${t(handle.zh, handle.en)}`}
                style={{ left: `${handle.x}%`, top: `${handle.y}%`, cursor: resizeCursor(handle.key) }} tabIndex={active ? 0 : -1}
                onPointerDown={event => start(event, item, handle.key)} onKeyDown={event => keyboardAdjust(event, item, handle.key)}/>)}
              {active && <div className="canvas-item-measure" aria-hidden="true">{dragging && draft?.id === item.id && !activeHandle
                ? `X ${Math.round(frame.x)} · Y ${Math.round(frame.y)}` : `${Math.round(frame.width)} × ${Math.round(frame.height)}`}</div>}
            </article>;
          })}
          <div className="canvas-guides" aria-hidden="true">{guides.map(guide => <div key={guide.axis} className={`canvas-guide canvas-guide-${guide.axis}`} style={guide.axis === 'x'
            ? { left: guide.position, top: guide.start, height: guide.end - guide.start }
            : { top: guide.position, left: guide.start, width: guide.end - guide.start }}/>)}</div>
        </div>
      </div>
      {!document.items.length && <div className="canvas-empty"><h1>{t('从一个想法开始', 'Start with an idea')}</h1><p>{t('让 Agent 把文件、内容和互动，放进你的空间。', 'Ask your agent to bring files, content and interactions into your space.')}</p><div><button onClick={onChat}>{t('描述你想创建的空间', 'Describe your space')}</button><button onClick={onAdd}><Plus size={16}/>{t('加入文件', 'Add files')}</button></div><small>PPT · XLSX · Markdown · DOCX · PDF · HTML · {t('图片与影音', 'Images & media')}</small></div>}
    </div>
    <div className="canvas-zoom" aria-label={t('缩放画板', 'Canvas zoom')}>
      <button aria-label={t('平移画板', 'Pan canvas')} aria-pressed={panMode} title={t('平移画板，也可拖动空白处', 'Pan canvas, or drag empty space')} onClick={() => setPanMode(value => !value)}><Hand size={15}/></button>
      <i aria-hidden="true"/>
      <button aria-label={t('缩小', 'Zoom out')} onClick={() => changeZoom(zoom - .1)}><ZoomOut size={15}/></button><span>{Math.round(zoom * 100)}%</span>
      <button aria-label={t('放大', 'Zoom in')} onClick={() => changeZoom(zoom + .1)}><ZoomIn size={15}/></button>
      <button aria-label={t('适应窗口', 'Fit canvas')} title={t('适应窗口并回到画板中心', 'Fit and centre canvas')} onClick={() => { cancel(); setZoomOverride(undefined); setPan({ x: 0, y: 0 }); }}><Maximize2 size={15}/></button>
    </div>
  </div>;
}
const CanvasItemContent = memo(function CanvasItemContent({ item, manifest, language, resourceRevision, onActivate }: { item: CanvasItem; manifest: string; language: 'zh' | 'en'; resourceRevision?: string; onActivate: (id: string) => void }) {
  const component = useMemo(() => item.kind === 'html' ? { id: item.id, title: item.title, html: item.html, width: 12, height: item.frame.height, order: 0, allowActions: false } : null, [item]);
  if (component) return <HtmlComponentSurface component={component}/>;
  if (item.kind === 'markdown') return <MessageFileReferenceScope workspaceRoot={manifest.replace(/[\\/][^\\/]+$/, '')}><div className="canvas-markdown"><MarkdownContent content={item.markdown} language={language} compactImages={false}/></div></MessageFileReferenceScope>;
  if (item.kind !== 'file') return null;
  const target = canvasFileTarget(item.source, manifest);
  return <InspectorWebview identity={item.id} target={target} source={inspectorSource(target)} title={item.title} language={language} resourceRevision={resourceRevision} onActivate={onActivate} onNavigationStateChange={ignoreNavigation} onOpenTarget={detail => openInspector(detail.target, detail.title)}/>;
});
