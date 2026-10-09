import { useRef, useState } from 'react';

type OpenFile = { path: string; text: string; revision: string };
export function useMarkdownFile() {
  const [file, setFile] = useState<OpenFile | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const perform = async (operation: () => Promise<OpenFile | null | undefined>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { return await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { lock.current = false; setBusy(false); }
  };
  const api = () => { const value = window.cardbushDesktop?.markdownFile; if (!value) throw Error('请在 CardBush 桌面端打开 Markdown 文件。'); return value; };
  return { file, busy, error, accept: setFile, clear: () => { setFile(null); setError(''); },
    open: () => perform(() => api()({ action: 'open' })),
    reload: () => perform(() => api()({ action: 'reload', path: file?.path })),
    save: (text: string, name: string, asNew = false) => perform(async () => { const result = await api()({ action: 'save', text, name, ...(!asNew && file ? { path: file.path, revision: file.revision } : {}) }); if (result) setFile(result); return result; }),
  };
}
