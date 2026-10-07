import { MoreVertical, Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from '../inspector/InspectorWebview';
import { BrowserLibraryDialog, type BrowserDialogKind } from './BrowserLibraryDialog';
import type { BrowserPageCommand } from '../../../electron/browserUi';
import { showUiError } from '../../shared/showUiError';
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss';
import './browserTools.css';

const zoomSteps = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export function BrowserMenu({ language, navigation, handle, onNavigate, onSettings }: {
  language: AppLanguage; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onNavigate: (url: string) => void; onSettings: () => void;
}) {
  const zh = language === 'zh', [open, setOpen] = useState(false), [dialog, setDialog] = useState<BrowserDialogKind | null>(null);
  const [zoom, setZoom] = useState(1), [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const guestId = navigation?.guestWebContentsId, enabled = Boolean(guestId && window.cardbushDesktop?.browser);
  const close = useCallback((focus = false) => { menu.current?.hidePopover(); setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); }, []);
  const containers = useMemo(() => [trigger, menu], []);
  const dismiss = useCallback((event?: Event) => close(event instanceof KeyboardEvent && event.key === 'Escape'), [close]);
  useOutsideDismiss(open, containers, dismiss);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(260, window.innerWidth - 24);
    Object.assign(menu.current.style, { top: `${rect.bottom + 6}px`, left: `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`, width: `${width}px`, maxHeight: `${Math.max(120, window.innerHeight - rect.bottom - 18)}px` });
    menu.current.showPopover(); menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const node = menu.current;
    const sync = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') setOpen(false); };
    node?.addEventListener('toggle', sync);
    return () => node?.removeEventListener('toggle', sync);
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [open, dismiss]);
  useEffect(() => {
    if (!open || !guestId) return;
    let active = true;
    window.cardbushDesktop?.browser?.page(guestId, { action: 'status' }).then(result => { if (active) setZoom(result.zoom); }, () => { if (active) setZoom(1); });
    return () => { active = false; };
  }, [open, guestId, navigation?.url]);
  const action = async (command: BrowserPageCommand, keepOpen = false) => {
    if (!guestId) return;
    if (!keepOpen) close(true);
    setBusy(true);
    try { const result = await window.cardbushDesktop?.browser?.page(guestId, command); if (result) setZoom(result.zoom); }
    catch (error) { close(); void showUiError(zh ? '浏览器操作失败' : 'Browser action failed', error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const showDialog = (kind: BrowserDialogKind) => { close(); setDialog(kind); };
  const item = (label: string, invoke: () => void, disabled = false) => <button type="button" role="menuitem" disabled={disabled} onClick={invoke}>{label}</button>;
  return <>
    <button ref={trigger} type="button" className="browser-menu-trigger" aria-label={zh ? '浏览器菜单' : 'Browser menu'} title={zh ? '浏览器菜单' : 'Browser menu'} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => open ? close() : setOpen(true)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}><MoreVertical size={17}/></button>
    <div ref={menu} id={id} popover="auto" role="menu" className="browser-menu-popover" aria-label={zh ? '浏览器菜单' : 'Browser menu'} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])], index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      {item(zh ? '在页面中查找' : 'Find in page', () => { close(); handle?.find?.(); }, !enabled)}
      {item(zh ? '打印…' : 'Print…', () => void action({ action: 'print' }), !enabled || busy)}
      <div role="separator"/>
      <div className="browser-menu-zoom"><span>{zh ? '缩放' : 'Zoom'}</span><button type="button" disabled={!enabled || busy || zoom <= .25} aria-label={zh ? '缩小网页' : 'Zoom out'} onClick={() => void action({ action: 'zoom', factor: [...zoomSteps].reverse().find(value => value < zoom - .01) ?? .25 }, true)}><Minus size={14}/></button>
        <output>{Math.round(zoom * 100)}%</output><button type="button" disabled={!enabled || busy || zoom >= 5} aria-label={zh ? '放大网页' : 'Zoom in'} onClick={() => void action({ action: 'zoom', factor: zoomSteps.find(value => value > zoom + .01) ?? 5 }, true)}><Plus size={14}/></button>
        <button type="button" disabled={!enabled || busy} aria-label={zh ? '重置为 100%' : 'Reset to 100%'} onClick={() => void action({ action: 'zoom', factor: 1 }, true)}><RotateCcw size={14}/></button></div>
      <div role="separator"/>
      {item(zh ? '显示 / 隐藏设备工具栏' : 'Toggle device toolbar', () => { close(); handle?.toggleDevice?.(); }, !enabled)}
      {item(zh ? '截取当前可见页面…' : 'Capture visible page…', () => void action({ action: 'screenshot' }), !enabled || busy)}
      <div role="separator"/>
      {item(zh ? '导入 Chrome / Edge 收藏夹…' : 'Import Chrome / Edge bookmarks…', () => showDialog('import'))}
      {item(zh ? '收藏夹' : 'Bookmarks', () => showDialog('bookmarks'))}
      {item(zh ? '下载' : 'Downloads', () => showDialog('downloads'))}
      {item(zh ? '历史记录' : 'History', () => showDialog('history'))}
      {item(zh ? '清除浏览数据…' : 'Clear browsing data…', () => showDialog('clear'))}
      <div role="separator"/>
      {item(zh ? '浏览器设置' : 'Browser settings', () => { close(); onSettings(); })}
    </div>
    {dialog && <BrowserLibraryDialog kind={dialog} language={language} guestId={guestId} url={navigation?.url} onClose={() => setDialog(null)} onNavigate={onNavigate}/>}
  </>;
}
