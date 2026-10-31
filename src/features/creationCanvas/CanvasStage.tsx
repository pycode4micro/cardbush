import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
import { Expand, FilePenLine, GripVertical, Hand, Maximize2, MessageCircle, Pin, PinOff, Plus, Scan, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { CanvasItem, CanvasSnapshot, CreationCanvas } from '@cardbush/bush-protocol';
import { HtmlComponentSurface } from '../components/HtmlComponentSurface';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { InspectorWebview } from '../inspector/InspectorWebview';
import { inspectorSource } from '../inspector/inspectorTargets';
import { openInspector } from '../inspector/inspectorEvents';
import { canvasFileTarget, editableCanvasMarkdown } from './canvasModel';
import { CanvasZoomValue } from './CanvasZoomValue';
import { adjustCanvasFrame, canvasEditBounds, updateCanvasFrame, equalCanvasFrames, fitCanvasViewport, zoomCanvasPan, type AlignmentGuide, type ResizeHandle } from './canvasGeometry';
import '../components/components.css';

const ignoreNavigation = () => {};
const resizeHandles: { key: ResizeHandle; x: number; y: number; labelKey: MessageKey }[] = [
  { key: 'nw', x: 0, y: 0, labelKey: 'canvasStage.top_left' as const }, { key: 'n', x: 50, y: 0, labelKey: 'canvasStage.top' as const },
  { key: 'ne', x: 100, y: 0, labelKey: 'canvasStage.top_right' as const }, { key: 'e', x: 100, y: 50, labelKey: 'canvasStage.right' as const },
  { key: 'se', x: 100, y: 100, labelKey: 'canvasStage.bottom_right' as const }, { key: 's', x: 50, y: 100, labelKey: 'canvasStage.bottom' as const },
  { key: 'sw', x: 0, y: 100, labelKey: 'canvasStage.bottom_left' as const }, { key: 'w', x: 0, y: 50, labelKey: 'canvasStage.left' as const },
];
type ItemDraft = { id: string; frame: CanvasItem['frame'] };
type Gesture = { pointer: number; x: number; y: number } & (
  { kind: 'item'; id: string; frame: CanvasItem['frame']; handle?: ResizeHandle; revision: string; zoom: number }
  | { kind: 'pan'; pan: { x: number; y: number } }
);
const resizeCursor = (handle?: ResizeHandle) => !handle ? 'grabbing' : ({ nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }[handle] + '-resize');

export function CanvasStage({ snapshot, language, selectedId, onSelect, onChange, onOpenFile, onEditMarkdown, onAdd, onChat, onDiscuss, onVersion, onDesktop, busy, suspended = false, onViewport, onError }: {
  snapshot: CanvasSnapshot; language: string; selectedId?: string; onSelect: (id?: string) => void;
  onChange: (document: CreationCanvas, revision: string) => Promise<void>; onOpenFile: (item: CanvasItem, region: boolean) => void;
  onEditMarkdown?: (item: CanvasItem) => void;
  onDiscuss?: (item: CanvasItem) => void; onVersion?: (item: CanvasItem) => void; onDesktop?: () => void; busy?: boolean; suspended?: boolean;
  onAdd: () => void; onChat: () => void; onViewport: (value: { width: number; height: number; zoom: number }) => void; onError: (message: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 1000, height: 700 });
  const measuredSize = useRef(size);
  const viewGeneration = useRef(0);
  const [inset, setInset] = useState(14);
  const [zoomOverride, setZoomOverride] = useState<number | undefined>(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [manualFit, setManualFit] = useState<ReturnType<typeof fitCanvasViewport>>();
  const [editingFit, setEditingFit] = useState<ReturnType<typeof fitCanvasViewport>>();
  const [draft, setDraft] = useState<ItemDraft>(), [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const [dragging, setDragging] = useState(false), [panMode, setPanMode] = useState(false), [spaceHeld, setSpaceHeld] = useState(false);
  const liveFrame = useRef<ItemDraft | undefined>(undefined), gesture = useRef<Gesture | undefined>(undefined), saving = useRef(false);
  const document = snapshot.document;
  const fit = manualFit ?? editingFit ?? fitCanvasViewport(size, document, inset, zoomOverride);
  const zoom = zoomOverride ?? fit.zoom;
  const lockView = () => setManualFit(fit);
  const rgb = document.background.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const light = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150;
  const panReady = panMode || spaceHeld;
  const releasePointer = () => {
    const pointer = gesture.current?.pointer;
    gesture.current = undefined;
    if (pointer !== undefined && viewport.current?.hasPointerCapture(pointer)) viewport.current.releasePointerCapture(pointer);
  };
  const cancel = () => { releasePointer(); liveFrame.current = undefined; setDraft(undefined); setGuides([]); setDragging(false); setEditingFit(undefined); };
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    const root = viewport.current;
    if (!root || suspended) return;
    const observer = new ResizeObserver(() => {
      if (!root.clientWidth || !root.clientHeight || globalThis.document.fullscreenElement?.closest('.canvas-presentation')) return;
      const next = { width: root.clientWidth, height: root.clientHeight };
      if (next.width !== measuredSize.current.width || next.height !== measuredSize.current.height) {
        measuredSize.current = next; viewGeneration.current++; cancelRef.current();
        setManualFit(undefined); setPan({ x: 0, y: 0 }); setSize(next);
      }
      setInset(parseFloat(getComputedStyle(root).getPropertyValue('--canvas-inset')) || 14);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [suspended]);
  useEffect(() => onViewport({ ...size, zoom }), [size, zoom, onViewport]);
  useEffect(() => {
    viewGeneration.current++;
    cancelRef.current(); setManualFit(undefined); setZoomOverride(1); setPan({ x: 0, y: 0 }); setPanMode(false); setSpaceHeld(false);
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
  const changeZoom = (next: number, anchor = { x: size.width / 2 - fit.origin.x, y: size.height / 2 - fit.origin.y }) => {
    if (gesture.current || saving.current) return;
    lockView();
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
      if (gesture.current || saving.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = root.getBoundingClientRect();
        changeZoom(zoom * Math.exp(-event.deltaY * unit * .002), { x: event.clientX - rect.left - fit.origin.x, y: event.clientY - rect.top - fit.origin.y });
      } else {
        lockView();
        setPan(value => ({ x: value.x - (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit, y: value.y - (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit }));
      }
    };
    root.addEventListener('wheel', wheel, { passive: false });
    return () => root.removeEventListener('wheel', wheel);
  }, [zoom, size, panReady, inset, fit.origin.x, fit.origin.y]);

  const capture = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); viewport.current?.setPointerCapture(event.pointerId); setDragging(true); };
  const start = (event: PointerEvent, item: CanvasItem, handle?: ResizeHandle) => {
    if (event.button !== 0 || saving.current || gesture.current) return;
    capture(event); onSelect(item.id);
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    gesture.current = { kind: 'item', id: item.id, x: event.clientX, y: event.clientY, frame: item.frame, handle, revision: snapshot.revision, pointer: event.pointerId, zoom };
    liveFrame.current = { id: item.id, frame: item.frame }; setDraft(liveFrame.current);
  };
  const startPan = (event: PointerEvent) => {
    if (gesture.current || saving.current || (event.button !== 0 && event.button !== 1)) return;
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
    if (g.kind === 'pan') {
      if (event.clientX !== g.x || event.clientY !== g.y) lockView();
      setPan({ x: g.pan.x + event.clientX - g.x, y: g.pan.y + event.clientY - g.y }); return;
    }
    if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < 2 && liveFrame.current && equalCanvasFrames(liveFrame.current.frame, g.frame)) return;
    // Hold the camera only for this edit, so changing a frame does not disable auto-fit.
    setEditingFit(value => value ?? fit);
    const result = adjustCanvasFrame({ frame: g.frame, dx: (event.clientX - g.x) / g.zoom, dy: (event.clientY - g.y) / g.zoom, handle: g.handle,
      bounds: canvasEditBounds(document), peers: document.items.filter(item => item.id !== g.id).map(item => item.frame), zoom: g.zoom, snap: !event.altKey, snapToBounds: false });
    liveFrame.current = { id: g.id, frame: result.frame }; setDraft(liveFrame.current); setGuides(result.guides);
  };
  const saveFrame = async (id: string, frame: CanvasItem['frame'], revision: string) => {
    const generation = viewGeneration.current;
    const next = updateCanvasFrame(document, id, frame);
    await onChange(next.document, revision);
    // Rebasing the file coordinates must not move the other regions on screen.
    if (generation === viewGeneration.current && manualFit && (next.offset.x || next.offset.y)) setPan(value => ({ x: value.x - next.offset.x * zoom, y: value.y - next.offset.y * zoom }));
  };
  const finish = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const latest = liveFrame.current;
    releasePointer(); liveFrame.current = undefined; setDragging(false); setGuides([]);
    if (g.kind !== 'item' || !latest || equalCanvasFrames(g.frame, latest.frame)) { setDraft(undefined); setEditingFit(undefined); return; }
    if (g.revision !== snapshot.revision) {
      setDraft(undefined); setEditingFit(undefined); onError(uiText(language)('canvasStage.theCanvasChangedPleaseAdjustThisItem')); return;
    }
    // Keep the final frame visible until the saved snapshot arrives.
    saving.current = true;
    void saveFrame(g.id, latest.frame, g.revision)
      .catch(() => {}).finally(() => { saving.current = false; setDraft(value => value === latest ? undefined : value); setEditingFit(undefined); });
  };
  const keyboardAdjust = (event: KeyboardEvent, item: CanvasItem, handle?: ResizeHandle) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    if (saving.current || gesture.current) return;
    const amount = event.shiftKey ? 10 : 1;
    const result = adjustCanvasFrame({ frame: item.frame, dx: delta[0] * amount, dy: delta[1] * amount, handle, bounds: canvasEditBounds(document), snap: false });
    if (equalCanvasFrames(item.frame, result.frame)) return;
    saving.current = true;
    void saveFrame(item.id, result.frame, snapshot.revision)
      .catch(() => {}).finally(() => { saving.current = false; });
  };
  const activeHandle = gesture.current?.kind === 'item' ? gesture.current.handle : undefined;
  const origin = { x: fit.origin.x + pan.x, y: fit.origin.y + pan.y };
  return <div className="canvas-stage-shell">
    <div className={'canvas-stage' + (panReady ? ' pan-ready' : '')} ref={viewport} tabIndex={0} data-light-paper={light}
      style={{ '--canvas-paper': document.background, backgroundPosition: `${origin.x}px ${origin.y}px` } as CSSProperties}
      aria-label={uiText(language)('canvasStage.canvasDragEmptySpaceToPan')}
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
        left: origin.x, top: origin.y }}>
        <div className="canvas-plane" data-canvas-width={document.width} data-canvas-height={document.height}
          style={{ width: document.width, height: document.height,
            transform: `scale(${zoom})`, '--canvas-inverse-zoom': 1 / zoom, '--canvas-line': `${1 / zoom}px` } as CSSProperties}>
          {document.items.map(item => {
            const frame = draft?.id === item.id ? draft.frame : item.frame, active = selectedId === item.id;
            return <article key={item.id} data-canvas-item={item.id} data-canvas-source={item.kind === 'file' ? item.source : undefined}
              className={`canvas-item${active ? ' selected' : ''}${draft?.id === item.id && dragging ? ' adjusting' : ''}`}
              style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height,
                '--canvas-item-screen-width': `${frame.width * zoom}px`, '--canvas-item-screen-height': `${frame.height * zoom}px` } as CSSProperties}
              onPointerDownCapture={() => onSelect(item.id)} onFocusCapture={() => onSelect(item.id)}>
              <div className="canvas-item-tools">
                <button className="canvas-item-move" aria-label={uiText(language)('canvasStage.moveItem')}
                  title={uiText(language)('canvasStage.dragTitleToMoveArrowKeysTo')}
                  onPointerDown={event => start(event, item)} onKeyDown={event => keyboardAdjust(event, item)}>
                  <GripVertical size={14}/><span>{item.title || item.kind}{item.reference?.mode === 'snapshot' ? uiText(language)('canvasStage.excerptSnapshot') : ''}</span>
                  {item.fixed && <Pin size={12} aria-label={uiText(language)('canvasStage.fixedVersion')}><title>{new Date(item.fixed.capturedAt).toLocaleString()}</title></Pin>}
                </button>
                <div className="canvas-item-actions">
                  {onDiscuss && <button aria-label={uiText(language)('canvasStage.discussRegion')} title={uiText(language)('canvasStage.discussRegion')} onClick={() => onDiscuss(item)}><MessageCircle size={14}/></button>}
                  {onVersion && <button disabled={busy} aria-label={item.fixed ? uiText(language)('canvasStage.resumeUpdates') : uiText(language)('canvasStage.fixThisVersion')} title={item.fixed ? uiText(language)('canvasStage.resumeFollowingTheOriginalContent') : uiText(language)('canvasStage.keepAnIndependentVersionForComparison')} onClick={() => onVersion(item)}>{item.fixed ? <PinOff size={14}/> : <Pin size={14}/>}</button>}
                  {onEditMarkdown && editableCanvasMarkdown(item) && <button aria-label={uiText(language)('canvasStage.editMarkdown')} title={uiText(language)('canvasStage.editMarkdown')} onClick={() => onEditMarkdown(item)}><FilePenLine size={14}/></button>}
                  {item.kind === 'file' && <><button aria-label={uiText(language)('canvasStage.referenceARegion')} onClick={() => onOpenFile(item, true)}><Scan size={14}/></button><button aria-label={uiText(language)('canvasStage.expandFile')} onClick={() => onOpenFile(item, false)}><Expand size={14}/></button></>}
                  <button aria-label={uiText(language)('canvasStage.removeFromCanvas')} onClick={() => void onChange({ ...document, items: document.items.filter(value => value.id !== item.id) }, snapshot.revision).catch(() => {})}><Trash2 size={14}/></button>
                </div>
              </div>
              <div className="canvas-item-content"><CanvasItemContent item={item} manifest={snapshot.path} language={language} resourceRevision={snapshot.resources?.[item.id]} onActivate={onSelect}/></div>
              {resizeHandles.map(handle => <button key={handle.key} className={`canvas-item-resize resize-${handle.key}`} data-resize-handle={handle.key}
                aria-label={handle.key === 'se' ? uiText(language)('canvasStage.resizeItem') : `${uiText(language)('canvasStage.resizeItem')}：${uiText(language)(handle.labelKey)}`}
                title={`${uiText(language)('canvasStage.resizeItem')} · ${uiText(language)(handle.labelKey)}`}
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
      {!document.items.length && <div className="canvas-empty"><h1>{uiText(language)('welcomeSuggestions.startWithAnIdea')}</h1><p>{uiText(language)('canvasStage.askYourAgentToBringFilesContent')}</p><div><button onClick={onChat}>{uiText(language)('canvasStage.describeYourSpace')}</button><button onClick={onAdd}><Plus size={16}/>{uiText(language)('canvasStage.addFiles')}</button></div><small>{uiText(language)('canvasStage.ppt_xlsx_markdown_docx_pdf_html')}{uiText(language)('canvasStage.imagesMedia')}</small>{onDesktop && <button className="canvas-desktop-starter" disabled={busy} onClick={onDesktop}>{uiText(language)('canvasStage.startWithACardbushDevelopmentDesk')}</button>}</div>}
    </div>
    <div className="canvas-zoom" aria-label={uiText(language)('canvasStage.canvasZoom')}>
      <button aria-label={uiText(language)('canvasStage.panCanvas')} aria-pressed={panMode} title={uiText(language)('canvasStage.panCanvasOrDragEmptySpace')} onClick={() => setPanMode(value => !value)}><Hand size={15}/></button>
      <i aria-hidden="true"/>
      <button aria-label={uiText(language)('image.zoomOutHint')} onClick={() => changeZoom(zoom - .1)}><ZoomOut size={15}/></button>
      <CanvasZoomValue key={snapshot.path} zoom={zoom} language={language} onChange={changeZoom}/>
      <button aria-label={uiText(language)('image.zoomInHint')} onClick={() => changeZoom(zoom + .1)}><ZoomIn size={15}/></button>
      <button aria-label={uiText(language)('canvasStage.fitCanvas')} aria-pressed={zoomOverride === undefined && !manualFit} title={uiText(language)('canvasStage.fitAndAlignCanvas')} onClick={() => { viewGeneration.current++; cancel(); setManualFit(undefined); setZoomOverride(undefined); setPan({ x: 0, y: 0 }); }}><Maximize2 size={15}/></button>
    </div>
  </div>;
}
export const CanvasItemContent = memo(function CanvasItemContent({ item, manifest, language, resourceRevision, onActivate, active = true }: { item: CanvasItem; manifest: string; language: string; resourceRevision?: string; onActivate: (id: string) => void; active?: boolean }) {
  const component = useMemo(() => item.kind === 'html' ? { id: item.id, title: item.title, html: item.html, width: 12, height: item.frame.height, order: 0, allowActions: false } : null, [item]);
  if (component) return <HtmlComponentSurface component={component} active={active}/>;
  if (item.kind === 'markdown') return <MessageFileReferenceScope workspaceRoot={manifest.replace(/[\\/][^\\/]+$/, '')}><div className="canvas-markdown"><MarkdownContent content={item.markdown} language={language} compactImages={false}/></div></MessageFileReferenceScope>;
  if (item.kind !== 'file') return null;
  const target = canvasFileTarget(item.source, manifest);
  return <InspectorWebview identity={item.id} target={target} source={inspectorSource(target)} title={item.title} language={language} resourceRevision={resourceRevision} onActivate={onActivate} onNavigationStateChange={ignoreNavigation} onOpenTarget={detail => openInspector(detail.target, detail.title)}/>;
});
