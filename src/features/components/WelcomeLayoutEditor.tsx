import { ChevronRight, GripHorizontal, LayoutGrid, MoveDiagonal2, RotateCcw, Trash2, Undo2, X, Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { AppLanguage } from '../../types';
import { componentTitle, defaultWelcomeIds, isBuiltinComponent, type ComponentCollection, type ComponentItem, type WelcomeLayout } from './componentModel';
import { WelcomePage } from './WelcomePage';
import { saveComponents } from './componentStore';
import { TopBar } from '../../components/TopBar';
import { alignPlacement, boundToolbar, layoutPoint, layoutSpace, type AlignmentGuide, type LayoutPoint } from './welcomeLayoutGeometry';
import { WelcomeComponentPreview } from './WelcomeComponentPreview';

type LayoutDrag = { pointerId: number; start: LayoutPoint; client: LayoutPoint; alt: boolean; moved: boolean } & (
  { kind: 'move' | 'resize'; id: string; before?: WelcomeLayout; basis: WelcomeLayout } |
  { kind: 'toolbar'; before: LayoutPoint | null; origin: LayoutPoint }
);

export function WelcomeLayoutEditor({ collection, language, onClose }: { collection: ComponentCollection; language: AppLanguage; onClose: () => void }) {
  const zh = language === 'zh';
  const [initial] = useState(() => structuredClone(collection));
  const [layout, setLayout] = useState<WelcomeLayout | undefined>(initial.welcomeLayout);
  const [history, setHistory] = useState<(WelcomeLayout | undefined)[]>([]);
  const [menu, setMenu] = useState<'components' | 'undo' | null>(null), [error, setError] = useState('');
  const [toolbarPosition, setToolbarPosition] = useState<LayoutPoint | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [preview, setPreview] = useState<{ item: ComponentItem; anchor: HTMLElement } | null>(null);
  const [guides, setGuides] = useState<AlignmentGuide[]>([]), [minHeight, setMinHeight] = useState(0);
  const canvas = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const latest = useRef(layout); latest.current = layout;
  const drag = useRef<LayoutDrag | null>(null);
  const applyLayout = (next: WelcomeLayout | undefined) => { latest.current = next; setLayout(next); };
  const ids = layout?.items.map(item => item.componentId) ?? defaultWelcomeIds;
  const remember = (before: WelcomeLayout | undefined) => setHistory(current => [...current.slice(-29), before]);
  const update = (next: WelcomeLayout | undefined) => { remember(layout); applyLayout(next); setError(''); };
  function snapshot(): WelcomeLayout {
    if (layout) return structuredClone(layout);
    const element = canvas.current!, space = layoutSpace(element);
    return { items: [...element.querySelectorAll<HTMLElement>('[data-welcome-component]')].map(slot => {
      const bounds = slot.getBoundingClientRect(), point = layoutPoint(space, bounds.left, bounds.top);
      return { componentId: slot.dataset.welcomeComponent!, x: point.x / space.width * 100,
        y: point.y, width: bounds.width / space.scaleX / space.width * 100, height: bounds.height / space.scaleY };
    }) };
  }
  function toggleComponent(item: ComponentItem) {
    const next = snapshot(), existing = next.items.some(current => current.componentId === item.id);
    next.items = existing ? next.items.filter(current => current.componentId !== item.id) : [...next.items, {
      componentId: item.id, x: 5, y: Math.max(70, ...next.items.map(current => current.y + current.height + 16)), width: item.width / 12 * 90, height: item.height,
    }];
    update(next);
  }
  function begin(event: PointerEvent, item: ComponentItem, kind: 'move' | 'resize') {
    if (event.button !== 0 || drag.current || !canvas.current) return;
    event.preventDefault(); event.stopPropagation(); setMenu(null); setPreview(null);
    const basis = snapshot();
    drag.current = { id: item.id, kind, pointerId: event.pointerId, start: layoutPoint(layoutSpace(canvas.current), event.clientX, event.clientY),
      client: { x: event.clientX, y: event.clientY }, alt: event.altKey, moved: false, before: layout, basis };
    setMinHeight(Math.max(canvas.current.scrollHeight, ...basis.items.map(current => current.y + current.height + 20)));
    root.current?.setPointerCapture(event.pointerId);
    document.body.classList.add('component-layout-editing');
    applyLayout(basis);
  }
  function toolbarBounds(point: LayoutPoint) {
    const element = root.current!, bar = toolbar.current!;
    return boundToolbar(point, { width: element.clientWidth, height: element.clientHeight },
      { width: bar.offsetWidth, height: bar.offsetHeight }, (element.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 50) + 8);
  }
  function beginToolbar(event: PointerEvent) {
    if (event.button !== 0 || drag.current || !root.current || !toolbar.current) return;
    event.preventDefault(); setMenu(null); setPreview(null);
    const space = layoutSpace(root.current), rect = toolbar.current.getBoundingClientRect();
    drag.current = { kind: 'toolbar', pointerId: event.pointerId, start: layoutPoint(space, event.clientX, event.clientY),
      client: { x: event.clientX, y: event.clientY }, alt: false, moved: false, before: toolbarPosition, origin: layoutPoint(space, rect.left, rect.top) };
    root.current.setPointerCapture(event.pointerId); document.body.classList.add('component-layout-editing');
  }
  function moveDrag(clientX: number, clientY: number, alt: boolean) {
    const state = drag.current; if (!state) return;
    state.client = { x: clientX, y: clientY }; state.alt = alt;
    const space = layoutSpace(state.kind === 'toolbar' ? root.current! : canvas.current!);
    const point = layoutPoint(space, clientX, clientY), delta = { x: point.x - state.start.x, y: point.y - state.start.y };
    if (!state.moved && Math.hypot(delta.x * space.scaleX, delta.y * space.scaleY) < 2) return;
    state.moved = true;
    if (state.kind === 'toolbar') { setToolbarPosition(toolbarBounds({ x: state.origin.x + delta.x, y: state.origin.y + delta.y })); return; }
    const selected = state.basis.items.find(item => item.componentId === state.id)!;
    const aligned = alignPlacement(selected, state.basis.items, state.kind, delta, space, !alt);
    applyLayout({ items: state.basis.items.map(item => item.componentId === state.id ? aligned.placement : item) });
    setGuides(aligned.guides);
  }
  function releaseDrag() {
    const state = drag.current; drag.current = null;
    setGuides([]); setMinHeight(0); document.body.classList.remove('component-layout-editing');
    if (state && root.current?.hasPointerCapture(state.pointerId)) root.current.releasePointerCapture(state.pointerId);
  }
  function cancelDrag() {
    const state = drag.current;
    if (state?.kind === 'toolbar') setToolbarPosition(state.before);
    else if (state) applyLayout(state.before);
    releaseDrag();
  }
  useLayoutEffect(() => {
    const element = root.current!, bar = toolbar.current!;
    const resize = () => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
      setToolbarPosition(current => { if (!current) return null; const next = toolbarBounds(current); return next.x === current.x && next.y === current.y ? current : next; });
    };
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => { if (!toolbar.current?.contains(event.target as Node)) { setMenu(null); setPreview(null); } };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (drag.current) cancelDrag(); else if (menu) setMenu(null); else onClose();
    };
    window.addEventListener('pointerdown', outside); window.addEventListener('blur', cancelDrag); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('blur', cancelDrag); window.removeEventListener('keydown', escape); };
  }, [menu, onClose]);
  useEffect(() => () => document.body.classList.remove('component-layout-editing'), []);
  return <div className="welcome-layout-editor" ref={root} role="region" aria-label={zh ? '编辑新会话布局' : 'Edit new conversation layout'}
    onPointerMove={event => {
      if (drag.current?.pointerId === event.pointerId) moveDrag(event.clientX, event.clientY, event.altKey);
    }}
    onScrollCapture={event => { const state = drag.current; if (state && state.kind !== 'toolbar' && event.target === canvas.current) moveDrag(state.client.x, state.client.y, state.alt); }}
    onPointerUp={event => {
      const state = drag.current; if (!state || state.pointerId !== event.pointerId) return;
      moveDrag(event.clientX, event.clientY, event.altKey);
      if (state.kind !== 'toolbar') {
        if (JSON.stringify(latest.current) !== JSON.stringify(state.basis)) remember(state.before); else applyLayout(state.before);
      }
      releaseDrag();
    }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
    <TopBar title="cardbush" language={language} inspectorOpen={false}/>
    <div className="welcome-editor-page">
      <WelcomePage language={language} collection={initial} layout={layout} editing canvasRef={canvas} minHeight={minHeight} onMove={(event, item) => begin(event, item, 'move')}
        overlay={<div className="welcome-alignment-guides" aria-hidden="true">{guides.map(guide => <div key={`${guide.axis}:${guide.position}`}
          className={`welcome-alignment-guide ${guide.axis}`} style={guide.axis === 'x' ? { left: guide.position } : { top: guide.position }}/>)}</div>}
        controls={item => <>
        <div className="welcome-layout-handles">
          <button type="button" className="welcome-layout-drag" aria-label={`${zh ? '移动' : 'Move'} ${componentTitle(item, language)}`} onPointerDown={event => begin(event, item, 'move')}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault(); const next = snapshot(); next.items = next.items.map(current => current.componentId !== item.id ? current : {
                ...current, x: Math.max(0, Math.min(100 - current.width, current.x + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))),
                y: Math.max(0, Math.min(10000, current.y + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0))),
              }); update(next);
            }}><GripHorizontal size={14}/>{componentTitle(item, language)}</button>
          {isBuiltinComponent(item) && item.builtin === 'input' && <div className="component-input-choices" role="group" aria-label={zh ? '输入框样式' : 'Composer style'}>
            {(['standard', 'simple'] as const).map(style => <button type="button" key={style} aria-pressed={(layout?.items.find(current => current.componentId === item.id)?.inputStyle ?? item.inputStyle ?? 'standard') === style}
              onClick={() => { const next = snapshot(); next.items = next.items.map(current => current.componentId === item.id ? { ...current, inputStyle: style } : current); update(next); }}>
              {style === 'standard' ? zh ? '标准' : 'Standard' : zh ? '精简' : 'Simple'}</button>)}
          </div>}
          <button type="button" title={zh ? '从页面移除' : 'Remove from page'} onClick={() => toggleComponent(item)}><X size={13}/></button>
        </div>
        <button type="button" className="welcome-layout-resize" aria-label={`${zh ? '调整大小' : 'Resize'} ${componentTitle(item, language)}`} onPointerDown={event => begin(event, item, 'resize')}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); const next = snapshot(); next.items = next.items.map(current => current.componentId !== item.id ? current : {
              ...current, width: Math.max(10, Math.min(100 - current.x, current.width + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))),
              height: Math.max(40, Math.min(1200, current.height + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0))),
            }); update(next);
          }}><MoveDiagonal2 size={14}/></button>
      </>}/>
    </div>
    <div className={`welcome-layout-toolbar${(toolbarPosition?.y ?? 70) > viewport.height / 2 ? ' menus-above' : ''}`} ref={toolbar} role="toolbar" aria-label={zh ? '布局操作' : 'Layout actions'}
      style={toolbarPosition ? { left: toolbarPosition.x, top: toolbarPosition.y, transform: 'none' } : undefined}>
      <button type="button" className="welcome-layout-pill welcome-toolbar-drag" aria-label={zh ? '移动编辑工具栏' : 'Move editing toolbar'}
        title={zh ? '拖动工具栏，或使用方向键移动' : 'Drag toolbar, or move with arrow keys'} onPointerDown={beginToolbar}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); const rect = toolbar.current!.getBoundingClientRect(), point = layoutPoint(layoutSpace(root.current!), rect.left, rect.top);
          setToolbarPosition(toolbarBounds({ x: point.x + (event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0),
            y: point.y + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0) })); setMenu(null); setPreview(null);
        }}><GripHorizontal size={14}/></button>
      <div className="welcome-toolbar-group">
        <button type="button" className="welcome-layout-pill" aria-expanded={menu === 'components'} onClick={() => { setPreview(null); setMenu(menu === 'components' ? null : 'components'); }}><LayoutGrid size={15}/>{zh ? '组件' : 'Components'}</button>
        {menu === 'components' && <div className="welcome-layout-menu welcome-component-picker" aria-label={zh ? '可用组件' : 'Available components'}
          onMouseLeave={() => setPreview(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null); }}>
          {initial.items.map(item => <button type="button" key={item.id} aria-pressed={ids.includes(item.id)} onClick={() => toggleComponent(item)}
            aria-describedby={preview?.item.id === item.id ? 'welcome-component-preview' : undefined}
            onMouseEnter={event => setPreview({ item, anchor: event.currentTarget })} onFocus={event => setPreview({ item, anchor: event.currentTarget })}>
            <span>{componentTitle(item, language)}</span>{ids.includes(item.id) && <Check size={14}/>}</button>)}
        </div>}
      </div>
      <div className="welcome-toolbar-group">
        <div className="welcome-layout-pill welcome-undo-split">
          <button type="button" disabled={!history.length} onClick={() => { setLayout(history.at(-1)); setHistory(current => current.slice(0, -1)); setError(''); }}><Undo2 size={15}/>{zh ? '撤回' : 'Undo'}</button>
          <button type="button" aria-label={zh ? '更多布局操作' : 'More layout actions'} aria-expanded={menu === 'undo'} onClick={() => setMenu(menu === 'undo' ? null : 'undo')}><ChevronRight size={14}/></button>
        </div>
        {menu === 'undo' && <div className="welcome-layout-menu">
          <button type="button" onClick={() => { update(initial.welcomeLayout); setMenu(null); }}><RotateCcw size={14}/>{zh ? '重置到开始状态' : 'Reset to starting layout'}</button>
          <button type="button" className="danger" onClick={() => { update({ items: [] }); setMenu(null); }}><Trash2 size={14}/>{zh ? '清空' : 'Clear'}</button>
        </div>}
      </div>
      <button type="button" className="welcome-layout-pill" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
      <button type="button" className="welcome-layout-pill save" onClick={() => {
        try { saveComponents({ ...initial, welcomeLayout: layout }, initial.revision); onClose(); }
        catch (cause) { setError(String(cause).includes('REVISION_CONFLICT')
          ? zh ? '布局已在其他窗口更新，请取消后重新编辑。' : 'The layout changed in another window. Cancel and reopen.'
          : zh ? '布局保存失败，请重试。' : 'Unable to save the layout. Please retry.'); }
      }}>{zh ? '保存' : 'Save'}</button>
      {error && <p className="welcome-layout-error" role="alert">{error}</p>}
    </div>
    {menu === 'components' && preview && <WelcomeComponentPreview key={preview.item.id} item={isBuiltinComponent(preview.item) && preview.item.builtin === 'input'
      ? { ...preview.item, inputStyle: layout?.items.find(item => item.componentId === preview.item.id)?.inputStyle ?? preview.item.inputStyle } : preview.item}
      language={language} anchor={preview.anchor}/>}
  </div>;
}
