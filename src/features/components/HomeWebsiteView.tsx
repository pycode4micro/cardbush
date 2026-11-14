import { createElement, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { homeWebsitePartitionPrefix } from '../../../electron/homeWebsiteAddress';
import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';

/** Rendered by the trusted Home page only after the user selects an exact URL. */
export function HomeWebsiteView({url, back, open}: {url:string; back:()=>void; open?:(url:string)=>void}) {
  const t = uiText(useUiLanguage());
  const site = new URL(url);
  const guest = useRef<HTMLElement>(null);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const currentUrl = useRef(url);
  useLayoutEffect(() => {
    const view = guest.current!;
    const fail = (event: Event) => {
      const {isMainFrame, errorCode} = event as Event & {isMainFrame:boolean; errorCode:number};
      if (isMainFrame && errorCode !== -3) setFailure(true);
    };
    const crashed = () => setFailure(true);
    const navigated = (event: Event) => {
      const {url: destination, isMainFrame} = event as Event & {url:string; isMainFrame?:boolean};
      if (isMainFrame !== false && URL.parse(destination)?.origin === new URL(url).origin) currentUrl.current = destination;
    };
    view.addEventListener('did-fail-load', fail);
    view.addEventListener('render-process-gone', crashed);
    view.addEventListener('did-navigate', navigated);
    view.addEventListener('did-navigate-in-page', navigated);
    view.setAttribute('src', url);
    return () => {
      view.removeEventListener('did-fail-load', fail);
      view.removeEventListener('render-process-gone', crashed);
      view.removeEventListener('did-navigate', navigated);
      view.removeEventListener('did-navigate-in-page', navigated);
    };
  }, [url, attempt]);
  return <div className="component-embed-layout">
    <div className="component-embed-bar">
      <button type="button" data-embed-back onClick={back}><ArrowLeft aria-hidden="true"/>{t('homeComponents.backToComponent')}</button>
      {open && <button type="button" data-embed-open aria-label={t('homeLayout.openWebsite',{name:site.host})} onClick={() => open(currentUrl.current)}>
        <ExternalLink aria-hidden="true"/>{site.host}</button>}
    </div>
    {failure && <div className="component-site-error" role="alert">{t('homeComponents.websiteLoadFailed')}
      <button type="button" onClick={() => { setFailure(false); setAttempt(value => value + 1); }}>{t('common.retry')}</button></div>}
    {createElement('webview', {key:attempt, ref:guest, className:'component-site-guest', 'data-failed':failure || undefined,
      partition:homeWebsitePartitionPrefix + site.origin, allowpopups:'', title:site.host})}
  </div>;
}
