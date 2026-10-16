import { api } from './api';
import { generatedImagePath } from './artifacts';

type ArchiveStatus = { id: string; filename: string; state: 'ready' | 'queued' | 'streaming' | 'completed' | 'failed'; completed: number; total: number; error?: string };

/** The browser download manager writes the stream to disk without a full-size JS Blob. */
export async function downloadArtifactArchive(sources: string[], sessionId: string, valid: () => boolean, signal: AbortSignal,
  progress: (completed: number, total: number) => void) {
  const paths = [...new Set(sources.map(source => {
    const path = generatedImagePath(source);
    if (!path) throw new Error('只能下载当前账号生成的图片。');
    return path;
  }))];
  if (!paths.length) throw new Error('本轮暂无可下载产物。');
  const check = () => { signal.throwIfAborted(); if (!valid()) throw new Error('账号已切换，下载已取消。'); };
  check();
  const ticket = await api<ArchiveStatus>('/files/archives', 'POST', { sessionId, paths }, signal);
  check();
  if (!/^[a-f0-9]{64}$/.test(ticket.id)) throw new Error('下载暂时无法开始，请重试。');
  const path = `/files/archives/${ticket.id}`, anchor = document.createElement('a');
  anchor.href = '/api/web/v1' + path; anchor.download = ticket.filename;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
  // Only small status JSON is fetched here; image bytes never enter React or IndexedDB.
  let failures = 0;
  const startedAt = Date.now();
  while (true) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    check();
    let status: ArchiveStatus;
    try { status = await api<ArchiveStatus>(`${path}/status`, 'GET', undefined, signal); failures = 0; }
    catch (error) { check(); if (++failures < 3) continue; throw new Error('下载状态暂时不可用，请查看浏览器下载列表。', { cause: error }); }
    check(); progress(status.completed, status.total);
    if (status.state === 'ready' && Date.now() - startedAt > 30_000) throw new Error('下载未启动，请允许浏览器下载后重试。');
    if (status.state === 'completed') return;
    if (status.state === 'failed') throw new Error(status.error || '下载已中断，请重试。');
  }
}
