import { createElement, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, MoreHorizontal } from 'lucide-react';
import { homeWebsitePartitionPrefix } from '../../../electron/homeWebsiteAddress';
import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';

/** The host admits the URL from a declared component origin or a saved website. */
export function HomeWebsiteView({url, back, open, status}: {url:string; back?:()=>void; open?:(url:string)=>void; status?:(state:'loaded'|'failed')=>void}) {
  const t = uiText(useUiLanguage());
  const site = new URL(url);
  const guest = useRef<HTMLElement>(null);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const currentUrl = useRef(url);
  const report = useRef(status); report.current = status;
  useLayoutEffect(() => {
    const view = guest.current!;
    let failed = false;
    const failure = () => {
      if (failed) return;
      failed = true; setFailure(true); report.current?.('failed');
    };
    const fail = (event: Event) => {
      const {isMainFrame, errorCode} = event as Event & {isMainFrame:boolean; errorCode:number};
      if (isMainFrame && errorCode !== -3) failure();
    };
    const crashed = () => failure();
    // Chromium also finishes loading its error document after did-fail-load.
    const loaded = () => { if (!failed) report.current?.('loaded'); };
    const navigated = (event: Event) => {
      const {url: destination, isMainFrame} = event as Event & {url:string; isMainFrame?:boolean};
      if (isMainFrame !== false && URL.parse(destination)?.origin === new URL(url).origin) currentUrl.current = destination;
    };
    view.addEventListener('did-fail-load', fail);
    view.addEventListener('did-finish-load', loaded);
    view.addEventListener('render-process-gone', crashed);
    view.addEventListener('did-navigate', navigated);
    view.addEventListener('did-navigate-in-page', navigated);
    view.setAttribute('src', url);
    return () => {
      view.removeEventListener('did-fail-load', fail);
      view.removeEventListener('did-finish-load', loaded);
      view.removeEventListener('render-process-gone', crashed);
      view.removeEventListener('did-navigate', navigated);
      view.removeEventListener('did-navigate-in-page', navigated);
    };
  }, [url, attempt]);
  return <div className="component-website-layout">
    {(back || open) && <details className="component-website-menu">
      <summary aria-label={t('homeComponents.websiteMenu')}><MoreHorizontal aria-hidden="true"/></summary>
      <div>
      {back && <button type="button" data-embed-back onClick={back}><ArrowLeft aria-hidden="true"/>{t('homeComponents.backToComponent')}</button>}
      {open && <button type="button" data-embed-open aria-label={t('homeLayout.openWebsite',{name:site.host})} onClick={() => open(currentUrl.current)}>
        <ExternalLink aria-hidden="true"/>{site.host}</button>}
      </div>
    </details>}
    {failure && <div className="component-site-error" role="alert">{t('homeComponents.websiteLoadFailed')}
      <button type="button" onClick={() => { setFailure(false); setAttempt(value => value + 1); }}>{t('common.retry')}</button></div>}
    {createElement('webview', {key:attempt, ref:guest, className:'component-site-guest', 'data-failed':failure || undefined,
      partition:homeWebsitePartitionPrefix + site.origin, allowpopups:'', title:site.host})}
  </div>;
}
