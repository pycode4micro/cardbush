import { Globe } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserIconUrl, browserSiteIcon, defaultBrowserSiteIcon, rememberBrowserSiteIcon, subscribeBrowserSiteIcons } from './browserSiteIcons';
import './browserSiteIcon.css';

export function BrowserSiteIcon({ url, icon, icons = [], revision = 0, size = 16 }: {
  url: string; icon?: string; icons?: readonly string[]; revision?: number; size?: number;
}) {
  const remembered = useSyncExternalStore(subscribeBrowserSiteIcons, () => browserSiteIcon(url), () => '');
  const candidates = [...new Set([browserIconUrl(icon), ...icons.slice(0, 8).map(browserIconUrl), remembered, defaultBrowserSiteIcon(url)].filter(Boolean))];
  // A new document / native favicon notification can recover the same URL that
  // failed earlier (for example while the page's network connection was starting).
  const key = JSON.stringify([url, revision, candidates]);
  const [failed, setFailed] = useState<{ key: string; urls: string[]; retried: boolean }>({ key: '', urls: [], retried: false });
  const source = candidates.find(value => failed.key !== key || !failed.urls.includes(value));
  const exhausted = !source && candidates.length > 0;
  const retried = failed.key === key && failed.retried;
  useEffect(() => {
    if (!exhausted || retried) return;
    // One delayed retry per page/icon update. A missing favicon must not poll
    // forever, and navigation/unmount cancels an old page's scheduled retry.
    const timer = window.setTimeout(() => setFailed({ key, urls: [], retried: true }), 1000);
    return () => window.clearTimeout(timer);
  }, [key, exhausted, retried]);
  return <span className="browser-site-icon" style={{ width: size, height: size }} aria-hidden="true">
    {source ? <img key={source} src={source} alt="" width={size} height={size} draggable={false}
      decoding="async" loading="lazy" referrerPolicy="no-referrer" onLoad={() => rememberBrowserSiteIcon(url, source)} onError={() => setFailed(current => ({
        key, urls: [...(current.key === key ? current.urls : []), source],
        retried: current.key === key && current.retried,
      }))}/> : <Globe size={size}/>}
  </span>;
}
