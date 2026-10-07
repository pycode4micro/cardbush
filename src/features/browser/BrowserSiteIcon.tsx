import { Globe2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { browserIconUrl, browserSiteIcon, defaultBrowserSiteIcon, subscribeBrowserSiteIcons } from './browserSiteIcons';
import './browserSiteIcon.css';

export function BrowserSiteIcon({ url, icon, size = 16 }: { url: string; icon?: string; size?: number }) {
  const remembered = useSyncExternalStore(subscribeBrowserSiteIcons, () => browserSiteIcon(url), () => '');
  const candidates = [...new Set([browserIconUrl(icon), remembered, defaultBrowserSiteIcon(url)].filter(Boolean))];
  const key = JSON.stringify(candidates);
  const [failed, setFailed] = useState<{ key: string; urls: string[] }>({ key: '', urls: [] });
  const source = candidates.find(value => failed.key !== key || !failed.urls.includes(value));
  return <span className="browser-site-icon" style={{ width: size, height: size }} aria-hidden="true">
    {source ? <img key={source} src={source} alt="" width={size} height={size} draggable={false}
      decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(current => ({
        key, urls: [...(current.key === key ? current.urls : []), source],
      }))}/> : <Globe2 size={size}/>}
  </span>;
}
