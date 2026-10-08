import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { browserWebUrl } from './browserImport';

export type BrowserVisit = { id: string; url: string; title: string; visitedAt: number; visits: number };
export type BrowserFrequentSite = { url: string; title: string; visitedAt: number; visits: number };
export type BrowserDownload = { id: string; url: string; name: string; path: string; received: number; total: number; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; paused: boolean; startedAt: number };
type Library = { history: BrowserVisit[]; downloads: BrowserDownload[] };
export type BrowserLibraryPage<T> = { items: T[]; total: number; nextOffset?: number };

/** Bounded, local-only metadata. Downloaded files are never removed by clearing this index. */
export class BrowserLibrary {
  private pending: Promise<unknown> = Promise.resolve();
  private loaded?: Promise<Library>;
  constructor(readonly file: string, private readonly onHistoryChanged?: () => void) {}
  private load() {
    return this.loaded ??= readFile(this.file, 'utf8').then(text => {
      const data = JSON.parse(text);
      if (!Array.isArray(data.history) || !Array.isArray(data.downloads)) throw Error('浏览器记录文件损坏。Browser library is unreadable.');
      return { history: data.history.filter((item: BrowserVisit) => browserWebUrl(item.url)).slice(0, 5000),
        downloads: data.downloads.slice(0, 1000).map((item: BrowserDownload) => ({ ...item, state: item.state === 'progressing' ? 'interrupted' : item.state, paused: false })) } as Library;
    }, error => { if (error.code !== 'ENOENT') throw error; return { history: [], downloads: [] }; });
  }
  private edit(action: (data: Library) => void, historyChanged = false) {
    const operation = this.pending.then(async () => {
      const old = await this.load(), data = { history: [...old.history], downloads: [...old.downloads] };
      action(data);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.file), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, this.file); break; }
          catch (error) {
            // Windows indexers/antivirus briefly hold freshly written files.
            if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      } finally { await unlink(temporary).catch(() => {}); }
      this.loaded = Promise.resolve(data);
      if (historyChanged) this.onHistoryChanged?.();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  visit(url: string, title: string, count = true) {
    const normalized = browserWebUrl(url);
    if (!normalized) return Promise.resolve();
    return this.edit(data => {
      const existing = data.history.find(item => item.url === normalized);
      if (!count && !existing) return;
      const item = { id: existing?.id ?? randomUUID(), url: normalized, title: (title || normalized).slice(0, 500),
        visitedAt: count ? Date.now() : existing!.visitedAt, visits: (existing?.visits ?? 0) + Number(count) };
      data.history = [item, ...data.history.filter(row => row.url !== normalized)].sort((a, b) => b.visitedAt - a.visitedAt).slice(0, 5000);
    }, true);
  }
  async frequentSites(): Promise<BrowserFrequentSite[]> {
    await this.pending;
    const sites = new Map<string, BrowserFrequentSite>();
    for (const visit of (await this.load()).history) {
      const url = new URL(visit.url), previous = sites.get(url.origin);
      // Aggregate the whole retained history, not only its first recent page.
      // Site shortcuts omit paths, searches and fragments from visited pages.
      sites.set(url.origin, { url: `${url.origin}/`, title: url.host.replace(/^www\./, ''),
        visits: (previous?.visits ?? 0) + (Number.isFinite(visit.visits) ? Math.max(1, visit.visits) : 1),
        visitedAt: Math.max(previous?.visitedAt ?? 0, Number.isFinite(visit.visitedAt) ? visit.visitedAt : 0) });
    }
    return [...sites.values()].sort((a, b) => b.visits - a.visits || b.visitedAt - a.visitedAt || a.url.localeCompare(b.url)).slice(0, 8);
  }
  download(item: BrowserDownload) {
    return this.edit(data => { data.downloads = [{ ...item }, ...data.downloads.filter(row => row.id !== item.id)].slice(0, 1000); });
  }
  async list<T extends keyof Library>(kind: T, query = '', offset = 0): Promise<BrowserLibraryPage<Library[T][number]>> {
    await this.pending;
    const data = await this.load(), needle = query.toLocaleLowerCase().slice(0, 300);
    const rows = data[kind].filter(item => `${item.url} ${'title' in item ? item.title : item.name}`.toLocaleLowerCase().includes(needle));
    const start = Math.max(0, Math.trunc(offset) || 0), end = start + 50;
    return { items: rows.slice(start, end), total: rows.length, ...(end < rows.length ? { nextOffset: end } : {}) } as BrowserLibraryPage<Library[T][number]>;
  }
  async findDownload(id: string) { await this.pending; return (await this.load()).downloads.find(item => item.id === id); }
  removeVisit(id: string) { return this.edit(data => { data.history = data.history.filter(item => item.id !== id); }, true); }
  clear(history: boolean, downloads: boolean) {
    return this.edit(data => { if (history) data.history = []; if (downloads) data.downloads = data.downloads.filter(item => item.state === 'progressing'); }, history);
  }
}
