import { ArrowLeft, ArrowRight, GripHorizontal, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from './InspectorWebview';
import type { InspectorTab } from './inspectorTabs';
import { inspectorTabLabel, isInspectorBrowserTarget } from './inspectorTargets';
import { BrowserBookmarkButton } from './BrowserBookmarkButton';

export function InspectorTileFrame({ tab, language, navigation, handle, onSwap }: {
  tab: InspectorTab; language: AppLanguage; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onSwap: (from: string, x: number, y: number) => void;
}) {
  const zh = language === 'zh', resource = tab.kind === 'resource' ? tab.detail : null;
  const browser = resource && isInspectorBrowserTarget(resource.target, resource.mediaType);
  const title = resource ? navigation?.title || inspectorTabLabel(resource) : tab.kind !== 'resource' ? tab.title : '';
  const address = navigation?.url || resource?.target || '', [draft, setDraft] = useState(address);
  const cancelDrag = useRef<(() => void) | null>(null);
  const swapRef = useRef(onSwap); swapRef.current = onSwap;
  useEffect(() => setDraft(address === 'about:blank' ? '' : address), [address]);
  useEffect(() => () => cancelDrag.current?.(), []);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cancelDrag.current?.();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    const finish = () => {
      cancelDrag.current = null;
      document.body.classList.remove('inspector-layout-resizing');
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', finish);
      if (handle.isConnected && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    // Native guests can change event targets while dragging; finish at window level.
    const release = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      finish();
      if (Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) > 5) {
        swapRef.current(tab.id, upEvent.clientX, upEvent.clientY);
      }
    };
    const cancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) finish(); };
    cancelDrag.current = finish;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('inspector-layout-resizing');
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', finish);
  };

  return <div className="inspector-tile-frame">
    <div className="right-inspector-navigation">
      <button type="button" className="inspector-tile-drag" aria-label={zh ? '拖动交换页面位置' : 'Drag to swap pages'} title={zh ? '拖动交换页面位置' : 'Drag to swap pages'}
        onPointerDown={beginDrag} onLostPointerCapture={() => cancelDrag.current?.()}>
        <GripHorizontal size={13}/>
      </button>
      {resource && <>
      <button type="button" className="inspector-tile-history" disabled={!navigation?.canGoBack} aria-label={zh ? '后退' : 'Back'} onClick={() => handle?.goBack()}><ArrowLeft size={14}/></button>
      <button type="button" className="inspector-tile-history" disabled={!navigation?.canGoForward} aria-label={zh ? '前进' : 'Forward'} onClick={() => handle?.goForward()}><ArrowRight size={14}/></button>
      <button type="button" aria-label={zh ? '刷新' : 'Reload'} onClick={() => handle?.reload()}><RefreshCw size={14}/></button>
      {browser ? <form className="right-inspector-address editable" onSubmit={event => { event.preventDefault(); handle?.navigate(draft); }}>
        <input aria-label={zh ? '网址' : 'Address'} value={draft} onChange={event => setDraft(event.target.value)} placeholder="https://"/>
        <BrowserBookmarkButton address={address} title={title} language={language}/>
      </form> : <span className="inspector-tile-path" title={address}>{title}</span>}
      </>}
    </div>
  </div>;
}
