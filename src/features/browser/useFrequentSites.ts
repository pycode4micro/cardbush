import { useEffect, useState } from 'react';
import type { BrowserFrequentSite } from '../../../electron/browserLibrary';

export function useFrequentSites() {
  const [sites, setSites] = useState<BrowserFrequentSite[]>([]);
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const api = window.cardbushDesktop?.browser;
    if (!api?.frequentSites) { setLoading(false); return; }
    let active = true, request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const next = await api.frequentSites();
        if (active && current === request) { setSites(next); setFailed(false); }
      } catch {
        if (active && current === request) { setSites([]); setFailed(true); }
      } finally { if (active && current === request) setLoading(false); }
    };
    const stop = api.onHistoryChanged?.(() => { void load(); });
    void load();
    return () => { active = false; stop?.(); };
  }, [revision]);
  return { sites, loading, failed, retry: () => { setLoading(true); setRevision(value => value + 1); } };
}
