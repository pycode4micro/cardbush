import { ChevronRight, Store } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PluginMarketEntry, PluginMarketPresentation } from '../../../electron/pluginMarketplaceTypes';

let active = 0;
const waiting: Array<() => void> = [];
async function loadPresentation(source: string, name: string) {
  if (active >= 6) await new Promise<void>(resolve => waiting.push(resolve));
  active++;
  try { return await window.cardbushDesktop?.pluginMarketPresentation?.(source, name); }
  finally { active--; waiting.shift()?.(); }
}

export function PluginMarketCard({ entry, sourceId, busy, zh, onOpen }: {
  entry: PluginMarketEntry; sourceId: string; busy: boolean; zh: boolean; onOpen: () => void;
}) {
  const element = useRef<HTMLElement>(null);
  const [metadata, setMetadata] = useState<PluginMarketPresentation>();
  const [failed, setFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setMetadata(undefined); setFailed(false); setDarkFailed(false);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(item => item.isIntersecting)) return;
      observer.disconnect();
      void loadPresentation(sourceId, entry.name).then(value => { if (!disposed) setMetadata(value); }).catch(() => undefined);
    }, { rootMargin: '200px' });
    if (element.current) observer.observe(element.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [sourceId, entry.name]);
  const logo = metadata?.logo || metadata?.logoDark;
  const darkLogo = metadata?.logoDark && metadata.logoDark !== logo && !darkFailed ? metadata.logoDark : '';
  return <article ref={element}><button className="plugin-featured-main" type="button" disabled={busy || !entry.available} onClick={onOpen}>
    <span className={`plugin-logo${darkLogo && !failed ? ' has-dark-logo' : ''}`}>{logo && !failed
      ? <><img className="plugin-logo-light" src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />
        {darkLogo && <img className="plugin-logo-dark" src={darkLogo} alt="" loading="lazy" onError={() => setDarkFailed(true)} />}</> : <Store size={22} />}</span>
    <span className="plugin-market-card-copy"><strong>{metadata?.displayName || entry.name}</strong>
      <small>{metadata?.description || entry.description || entry.category}</small>
      <span className="plugin-market-kind">{!entry.available ? entry.unavailableReason === 'policy' ? (zh ? '暂未开放' : 'Unavailable')
        : (zh ? '来源暂不支持' : 'Unsupported source') : entry.category || (zh ? '插件' : 'Plugin')}</span></span>
    <ChevronRight className="plugin-row-chevron" size={16} />
  </button></article>;
}
