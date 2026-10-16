import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';
import { ArrowUp, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AppLanguage, ChatMessage } from '../../types';
import { MarkdownContent } from '../chatMessages';
import { queryPreviewRegion, regionPrompt, type PreviewRegion, type RegionPoint, type RegionQuery, type RegionRect } from './regionSelection';
import { hasOpenModal } from './useQuickInputDismiss';
import './regionSelection.css';

export type RegionGuest = HTMLElement & { executeJavaScript?: (script: string) => Promise<unknown>; getWebContentsId?: () => number };
export type RegionConversation = { scope: string; busy: boolean; error?: string | null; messages: ChatMessage[]; send: (text: UserPromptInput) => Promise<boolean>; saveImage?: (data: string) => Promise<string> };

export function InspectorRegionSelection({ surface, guest, enabled, language, target, revision, conversation, onClose, onRefresh, onReference }: {
  surface: RefObject<HTMLDivElement | null>; guest: RefObject<RegionGuest | null>; enabled: boolean; language: AppLanguage;
  target: string; revision: string; conversation?: RegionConversation; onClose: () => void; onRefresh?: () => void;
  onReference?: (region: PreviewRegion, image: string) => Promise<void>;
}) {
  const zh = language === 'zh', layer = useRef<HTMLDivElement>(null), form = useRef<HTMLFormElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const hitArea = useRef<HTMLDivElement>(null), wheel = useRef<(event: WheelEvent) => void>(() => {});
  const capturing = useRef<number | null>(null);
  const [hover, setHover] = useState<PreviewRegion | null>(null), [selection, setSelection] = useState<PreviewRegion | null>(null);
  const [box, setBox] = useState<RegionRect | null>(null), [anchor, setAnchor] = useState<RegionPoint>({ x: 0, y: 0 });
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [preparing, setPreparing] = useState(false), [sending, setSending] = useState(false);
  const [image, setImage] = useState(''), [sent, setSent] = useState<{ baseline: Set<string>; requestId: string } | null>(null), [position, setPosition] = useState({ left: 0, top: 0 });
  const gesture = useRef<{ start: RegionPoint; last: RegionPoint; pointerId: number } | null>(null), request = useRef(0), hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scope = conversation?.scope, currentScope = useRef(scope); currentScope.current = scope;
  const reset = () => { request.current++; clearTimeout(hoverTimer.current); hoverTimer.current = undefined; gesture.current = null; setHover(null); setSelection(null); setBox(null); setImage(''); setPreparing(false); setError(''); setSent(null); };
  useEffect(() => { reset(); setDraft(''); setSending(false); }, [scope, target, revision, enabled]);
  useEffect(() => () => { request.current++; clearTimeout(hoverTimer.current); }, []);
  useEffect(() => {
    if (!enabled || !surface.current) return;
    const element = surface.current;
    const changed = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest('[data-region-ui]')) reset(); };
    element.addEventListener('scroll', changed, true);
    element.addEventListener('cardbush-preview-layout', changed);
    let width = surface.current.clientWidth, height = surface.current.clientHeight;
    const observer = new ResizeObserver(() => {
      if (!surface.current) return;
      const nextWidth = surface.current.clientWidth, nextHeight = surface.current.clientHeight;
      if (Math.abs(width - nextWidth) > 1 || Math.abs(height - nextHeight) > 1) reset();
      width = nextWidth; height = nextHeight;
    });
    observer.observe(surface.current); return () => { observer.disconnect(); element.removeEventListener('scroll', changed, true); element.removeEventListener('cardbush-preview-layout', changed); };
  }, [enabled]);
  const query = async (value: RegionQuery): Promise<PreviewRegion | null> => {
    const root = surface.current;
    if (!root) return null;
    if (!guest.current) return queryPreviewRegion(value, root);
    const bounds = root.getBoundingClientRect(), at = guest.current.getBoundingClientRect();
    const dimensions = await guest.current.executeJavaScript?.('({width:innerWidth,height:innerHeight})') as { width: number; height: number } | undefined;
    if (!dimensions?.width || !at.width || !at.height) return null;
    const sx = dimensions.width / at.width, sy = dimensions.height / at.height;
    const payload = { ...value, point: { x: (value.point.x + bounds.x - at.x) * sx, y: (value.point.y + bounds.y - at.y) * sy },
      ...(value.box ? { box: { x: (value.box.x + bounds.x - at.x) * sx, y: (value.box.y + bounds.y - at.y) * sy, width: value.box.width * sx, height: value.box.height * sy } } : {}) };
    const result = await guest.current.executeJavaScript?.(`(${queryPreviewRegion.toString()})(${JSON.stringify(payload)})`) as PreviewRegion | null;
    if (!result) return null;
    const r = result.rect;
    if (![r?.x, r?.y, r?.width, r?.height].every(Number.isFinite)) throw Error(zh ? '无法定位该区域，请重新框选。' : 'Unable to locate this region. Select it again.');
    return { ...result, rect: { x: r.x / sx + at.x - bounds.x, y: r.y / sy + at.y - bounds.y, width: r.width / sx, height: r.height / sy } };
  };
  const choose = async (point: RegionPoint, custom?: RegionRect) => {
    const token = ++request.current; clearTimeout(hoverTimer.current); hoverTimer.current = undefined; setPreparing(true); setError(''); setImage(''); setSent(null);
    try {
      const result = await query({ point, box: custom });
      if (token !== request.current) return;
      if (!result) { setPreparing(false); return; }
      setSelection(result); setHover(null); setAnchor(point); setBox(null);
      // Hide host overlays only for the frame captured; the underlying preview stays mounted.
      if (layer.current) { capturing.current = token; layer.current.dataset.capturing = 'true'; }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (token !== request.current) return;
      const root = surface.current!, bounds = root.getBoundingClientRect(), guestBounds = guest.current?.getBoundingClientRect();
      const rect = guestBounds
        ? { x: (result.rect.x + bounds.x - guestBounds.x) / guestBounds.width, y: (result.rect.y + bounds.y - guestBounds.y) / guestBounds.height, width: result.rect.width / guestBounds.width, height: result.rect.height / guestBounds.height }
        : { x: (result.rect.x + bounds.x) / innerWidth, y: (result.rect.y + bounds.y) / innerHeight, width: result.rect.width / innerWidth, height: result.rect.height / innerHeight };
      const capture = window.cardbushDesktop?.captureInspectorRegion;
      if (!capture) throw Error(zh ? '当前环境暂不支持区域截图。' : 'Region capture is unavailable in this environment.');
      const data = await capture({ rect, guestId: guest.current?.getWebContentsId?.() });
      if (token === request.current) { setImage(data); input.current?.focus({ preventScroll: true }); }
    } catch (cause) { if (token === request.current) setError(String((cause as Error).message)); }
    finally { if (capturing.current === token) { if (layer.current) delete layer.current.dataset.capturing; capturing.current = null; } if (token === request.current) setPreparing(false); }
  };
  useLayoutEffect(() => {
    if (!selection || !surface.current || !form.current) return;
    const place = () => {
      const area = surface.current!.getBoundingClientRect(), r = form.current!.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(anchor.x + 16, area.width - r.width - 8)), top: Math.max(8, Math.min(anchor.y + 12, area.height - r.height - 8)) });
    };
    place(); const observer = new ResizeObserver(place); observer.observe(form.current); observer.observe(surface.current);
    return () => observer.disconnect();
  }, [selection, anchor]);
  useEffect(() => {
    if (!enabled) return;
    const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape' || event.isComposing || hasOpenModal()) return; event.preventDefault(); event.stopPropagation(); if (selection) reset(); else onClose(); };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [enabled, selection, onClose]);
  const submit = async () => {
    if (!draft.trim() || !selection || !conversation || preparing || sending || !image) return;
    const sender = conversation, selected = selection, text = draft, screenshot = image, token = request.current;
    setSending(true); setError('');
    const baseline = new Set(sender.messages.map(message => message.id));
    const requestId = crypto.randomUUID();
    try {
      const path = sender.saveImage ? await sender.saveImage(screenshot) : (await window.cardbushDesktop!.saveImageDataUrl(screenshot, '选区.png', { copyToClipboard: false })).path;
      if (currentScope.current !== sender.scope || token !== request.current) return;
      const accepted = await sender.send(regionPrompt(text, target, selected, path, requestId));
      if (currentScope.current !== sender.scope || token !== request.current) return;
      if (accepted) { setDraft(''); setSent({ baseline, requestId }); } else setError(zh ? '尚未发送，请检查当前会话或模型配置后重试。' : 'Not sent. Check the conversation or model settings and retry.');
    } catch (cause) { if (token === request.current) setError(String((cause as Error).message)); }
    finally { if (currentScope.current === sender.scope) setSending(false); }
  };
  wheel.current = event => {
    event.preventDefault();
    if (sending || !surface.current) return;
    const bounds = surface.current.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
    reset();
    void query({ point: { x: event.clientX - bounds.x, y: event.clientY - bounds.y },
      scroll: { x: (event.shiftKey ? event.deltaY : event.deltaX) * unit, y: (event.shiftKey ? 0 : event.deltaY) * unit } }).catch(() => {});
  };
  useEffect(() => {
    const area = hitArea.current;
    if (!enabled || !area) return;
    const handler = (event: WheelEvent) => wheel.current(event);
    area.addEventListener('wheel', handler, { passive: false });
    return () => area.removeEventListener('wheel', handler);
  }, [enabled]);
  if (!enabled) return null;
  const visible = box || selection?.rect || hover?.rect;
  const messages = conversation?.messages ?? [];
  const userIndex = sent ? messages.findIndex(message => message.role === 'user' && !sent.baseline.has(message.id) &&
    readUserPrompt(message.content, message.metadata).context?.some(context => context.kind === 'preview-selection' && context.requestId === sent.requestId)) : -1;
  const user = messages[userIndex];
  const nextUser = messages.findIndex((message, index) => index > userIndex && message.role === 'user');
  // A queued selection must not display the still-running previous turn's reply.
  const replies = userIndex < 0 ? [] : user.turnId ? messages.filter(message => message.turnId === user.turnId)
    : messages.slice(userIndex + 1, nextUser < 0 ? undefined : nextUser);
  const reply = replies.filter(message => message.role === 'assistant' && message.content?.trim()).at(-1);
  const localPoint = (event: { clientX: number; clientY: number }) => { const at = surface.current!.getBoundingClientRect(); return { x: Math.max(0, Math.min(at.width, event.clientX - at.x)), y: Math.max(0, Math.min(at.height, event.clientY - at.y)) }; };
  return <div ref={layer} className="inspector-region-layer" data-region-ui>
    <div ref={hitArea} className="inspector-region-hit-area" aria-label={zh ? '点击内容块或拖动框选区域' : 'Click a block or drag to select a region'}
      onPointerMove={event => {
        const point = localPoint(event), drag = gesture.current;
        if (drag) { drag.last = point; if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 5) setBox({ x: Math.min(point.x, drag.start.x), y: Math.min(point.y, drag.start.y), width: Math.abs(point.x - drag.start.x), height: Math.abs(point.y - drag.start.y) }); return; }
        if (selection || hoverTimer.current) return;
        const token = ++request.current;
        hoverTimer.current = setTimeout(() => { hoverTimer.current = undefined; void query({ point }).then(region => { if (token === request.current) setHover(region); }).catch(() => {}); }, 70);
      }}
      onPointerLeave={() => { if (!gesture.current && !selection && !preparing) { request.current++; setHover(null); } }}
      onPointerDown={event => { if (event.button !== 0 || sending || gesture.current) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); request.current++; clearTimeout(hoverTimer.current); hoverTimer.current = undefined; gesture.current = { start: localPoint(event), last: localPoint(event), pointerId: event.pointerId }; setSent(null); }}
      onPointerUp={event => { const drag = gesture.current; if (event.button !== 0 || !drag || drag.pointerId !== event.pointerId) return; gesture.current = null; const end = localPoint(event); const custom = Math.hypot(end.x - drag.start.x, end.y - drag.start.y) > 5 ? { x: Math.min(end.x, drag.start.x), y: Math.min(end.y, drag.start.y), width: Math.max(2, Math.abs(end.x - drag.start.x)), height: Math.max(2, Math.abs(end.y - drag.start.y)) } : undefined; void choose(end, custom); }}
      onPointerCancel={reset}
      onContextMenu={event => event.preventDefault()}/>
    <div className="inspector-region-help">{zh ? '点击选择 · 拖动框选 · Esc 退出' : 'Click a block · Drag a region · Esc to exit'}<button type="button" aria-label={zh ? '退出框选' : 'Exit selection'} onClick={onClose}><X size={14}/></button></div>
    {visible && <div className={`inspector-region-outline${selection ? ' selected' : ''}`} style={{ left: visible.x, top: visible.y, width: visible.width, height: visible.height }}/>}
    {selection && <form ref={form} className="inspector-region-conversation" style={position} aria-label={zh ? '选区 AI 对话' : 'Region AI conversation'} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><span>{selection.page ? `${zh ? '第' : 'Page '}${selection.page}${zh ? '页 · ' : ' · '}` : ''}{selection.sheet ? selection.label : selection.custom ? (zh ? '自定义区域' : 'Custom region') : (zh ? '所选内容' : 'Selected content')}</span><button type="button" aria-label={zh ? '关闭选区对话' : 'Close region conversation'} onClick={reset}><X size={14}/></button></header>
      {reply && <div className="inspector-region-reply"><MarkdownContent content={reply.content} language={language}/></div>}
      {sent && !conversation?.busy && onRefresh && <button className="inspector-region-refresh" type="button" onClick={onRefresh}><RefreshCw size={13}/>{zh ? '刷新预览' : 'Refresh preview'}</button>}
      {sent && !reply && <p className="inspector-region-status"><Check size={13}/>{zh ? '已发送到当前会话' : 'Sent to the current conversation'}</p>}
      {error && <p role="alert">{error}</p>}
      {sent && conversation?.error && <p role="alert">{conversation.error}</p>}
      {onReference && <button type="button" disabled={!image || preparing || sending} onClick={() => {
        setSending(true); setError(''); void onReference(selection, image).then(reset, cause => setError(String((cause as Error).message))).finally(() => setSending(false));
      }}>{zh ? '引用到画板' : 'Reference on canvas'}</button>}
      {!conversation && !onReference && <p role="status">{zh ? '请先打开一个可对话的会话，再发送选区要求。' : 'Open a conversation before sending region instructions.'}</p>}
      <textarea ref={input} value={draft} rows={2} aria-label={zh ? '选区修改要求' : 'Region instructions'} placeholder={zh ? '想怎么修改这里？' : 'How should this region change?'} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
      <footer><span>{preparing ? (zh ? '正在准备选区…' : 'Preparing region…') : conversation?.busy ? (zh ? '处理中' : 'Working') : (zh ? 'Enter 发送 · Shift+Enter 换行' : 'Enter to send · Shift+Enter for newline')}</span><button type="submit" disabled={!draft.trim() || !image || preparing || sending || !conversation} aria-label={zh ? '发送选区要求' : 'Send region instructions'}>{preparing || sending ? <LoaderCircle className="spinning" size={17}/> : <ArrowUp size={17}/>}</button></footer>
    </form>}
  </div>;
}
