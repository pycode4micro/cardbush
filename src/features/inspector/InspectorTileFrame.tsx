import { ArrowLeft, ArrowRight, GripHorizontal, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from './InspectorWebview';
import type { InspectorTab } from './inspectorTabs';
import { inspectorTabLabel, isInspectorBrowserTarget } from './inspectorTargets';
import { BrowserBookmarkButton } from './BrowserBookmarkButton';
import { BrowserTranslateButton } from './BrowserTranslateButton';
import { useInspectorTileDrag } from './useInspectorTileDrag';

export function InspectorTileFrame({ tab, language, navigation, handle, onSwap }: {
  tab: InspectorTab; language: AppLanguage; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onSwap: (from: string, x: number, y: number) => void;
}) {
  const zh = language === 'zh', resource = tab.kind === 'resource' ? tab.detail : null;
  const browser = resource && isInspectorBrowserTarget(resource.target, resource.mediaType);
  const title = resource ? navigation?.title || inspectorTabLabel(resource) : tab.kind !== 'resource' ? tab.title : '';
  const address = navigation?.url || resource?.target || '', [draft, setDraft] = useState(address);
  const drag = useInspectorTileDrag(tab.id, onSwap);
  useEffect(() => setDraft(address === 'about:blank' ? '' : address), [address]);

  return <div className="inspector-tile-frame" {...drag}>
    <div className="right-inspector-navigation">
      <button type="button" className="inspector-tile-drag" aria-label={zh ? '拖动交换页面位置' : 'Drag to swap pages'} title={zh ? '拖动交换页面位置' : 'Drag to swap pages'}>
        <GripHorizontal size={13}/>
      </button>
      {resource && <>
      <button type="button" className="inspector-tile-history" disabled={!navigation?.canGoBack} aria-label={zh ? '后退' : 'Back'} onClick={() => handle?.goBack()}><ArrowLeft size={14}/></button>
      <button type="button" className="inspector-tile-history" disabled={!navigation?.canGoForward} aria-label={zh ? '前进' : 'Forward'} onClick={() => handle?.goForward()}><ArrowRight size={14}/></button>
      <button type="button" aria-label={zh ? '刷新' : 'Reload'} onClick={() => handle?.reload()}><RefreshCw size={14}/></button>
      {browser ? <form className="right-inspector-address editable" onSubmit={event => { event.preventDefault(); handle?.navigate(draft); }}>
        <input aria-label={zh ? '网址' : 'Address'} value={draft} onChange={event => setDraft(event.target.value)} placeholder="https://"/>
        <BrowserBookmarkButton address={address} title={title} language={language}/>
        <BrowserTranslateButton address={address} language={language} state={navigation?.translation} loading={navigation?.loading} onClick={() => handle?.toggleTranslation()}/>
      </form> : <span className="inspector-tile-path" title={address}>{title}</span>}
      </>}
    </div>
  </div>;
}
