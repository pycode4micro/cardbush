import { uiText } from '../../i18n';
import { GripHorizontal, RefreshCw, ScanLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from './InspectorWebview';
import type { InspectorTab } from './inspectorTabs';
import { inspectorTabLabel, isInspectorBrowserTarget } from './inspectorTargets';
import { BrowserBookmarkButton } from './BrowserBookmarkButton';
import { BrowserInstallButton } from '../browser/BrowserInstallButton';
import { useInspectorTileDrag } from './useInspectorTileDrag';
import { InspectorHistoryButtons } from './InspectorHistoryButtons';

export function InspectorTileFrame({ tab, language, navigation, handle, onStep, onSwap, regionSelected, onSelectRegion }: {
  tab: InspectorTab; language: AppLanguage; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onSwap: (from: string, x: number, y: number) => void;
  onStep?: (id: string, step: 'back' | 'forward') => void;
  regionSelected?: boolean; onSelectRegion?: () => void;
}) {
  const resource = tab.kind === 'resource' ? tab.detail : null;
  const browser = resource && isInspectorBrowserTarget(resource.target, resource.mediaType);
  const title = resource ? navigation?.title || inspectorTabLabel(resource) : tab.kind !== 'resource' ? tab.title : '';
  const address = navigation?.url || resource?.target || '', [draft, setDraft] = useState(address);
  const drag = useInspectorTileDrag(tab.id, onSwap);
  useEffect(() => setDraft(address === 'about:blank' ? '' : address), [address]);

  return <div className="inspector-tile-frame" {...drag}>
    <div className="right-inspector-navigation">
      <button type="button" className="inspector-tile-drag" aria-label={uiText(language)('inspectorTileFrame.dragToSwapPages')}>
        <GripHorizontal size={13}/>
      </button>
      {(resource || (tab.kind === 'history' && tab.backToStart)) &&
        <InspectorHistoryButtons tab={tab} language={language} navigation={navigation} handle={handle} onStep={onStep}/>}
      {tab.kind === 'history' && tab.backToStart && <span className="inspector-tile-path">{tab.title}</span>}
      {resource && <>
      <button type="button" aria-label={uiText(language)('inspectorTileFrame.reload')} onClick={() => handle?.reload()}><RefreshCw size={14}/></button>
      {browser ? <form className="right-inspector-address editable" onSubmit={event => { event.preventDefault(); handle?.navigate(draft); }}>
        <input aria-label={uiText(language)('app.address')} value={draft} onChange={event => setDraft(event.target.value)} placeholder={uiText(language)('app.searchOrEnterAddress')}/>
        <BrowserInstallButton language={language} navigation={navigation}/>
        <BrowserBookmarkButton address={address} title={title} language={language}/>
      </form> : <span className="inspector-tile-path" title={address}>{title}</span>}
      <button type="button" aria-label={uiText(language)('app.selectARegionForAi')} aria-pressed={!!regionSelected} onClick={onSelectRegion}><ScanLine size={14}/></button>
      </>}
    </div>
  </div>;
}
