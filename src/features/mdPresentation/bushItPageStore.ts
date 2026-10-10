import { useSyncExternalStore } from 'react';
import { parseMarkdownGraph } from './markdownGraph';
import { pageTitle } from './pageDocument';

export type BushItPage = { id: string; source: string; updatedAt: number; archived?: boolean; file?: { path: string; revision: string; text: string } };
type Pages = { pages: BushItPage[]; selectedId: string; error: string };
const key = 'cardbush.bush-it.pages.v1', listeners = new Set<() => void>();
const names = new WeakMap<BushItPage, string>();
let snapshot: Pages | undefined, timer: ReturnType<typeof setTimeout> | undefined;
function initial(): Pages {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Array.isArray(saved.pages) && saved.pages.every((page: BushItPage) => typeof page.id === 'string' && typeof page.source === 'string' && typeof page.updatedAt === 'number')) {
      return { pages: saved.pages, selectedId: saved.pages.find((page: BushItPage) => page.id === saved.selectedId && !page.archived)?.id || saved.pages.find((page: BushItPage) => !page.archived)?.id || '', error: '' };
    }
    const source = localStorage.getItem('cardbush.bush-it.draft') ?? localStorage.getItem('cardbush.md-presentation.draft') ?? '';
    const page = { id: crypto.randomUUID(), source, updatedAt: Date.now() }; return { pages: [page], selectedId: page.id, error: '' };
  } catch { const page = { id: crypto.randomUUID(), source: '', updatedAt: Date.now() }; return { pages: [page], selectedId: page.id, error: '' }; }
}
const read = () => snapshot ??= initial();
function notify() { listeners.forEach(listener => listener()); }
export function flushBushItPages() {
  clearTimeout(timer); timer = undefined;
  try { const { pages, selectedId } = read(); localStorage.setItem(key, JSON.stringify({ pages, selectedId })); if (snapshot!.error) { snapshot = { ...snapshot!, error: '' }; notify(); } }
  catch { snapshot = { ...read(), error: '页面无法自动保存，请将当前内容保存为 .md 文件。 / Could not store pages. Save your document as a .md file.' }; notify(); }
}
function publish(change: Partial<Pages>) { snapshot = { ...read(), ...change }; notify(); clearTimeout(timer); timer = setTimeout(flushBushItPages, 180); }
if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushBushItPages);
export function bushItPageName(page: BushItPage, language: 'zh' | 'en') {
  let title = names.get(page);
  if (title === undefined) {
    try { title = pageTitle(parseMarkdownGraph(page.source)).title; }
    catch { title = page.source.match(/^# (.+)$/m)?.[1] || ''; }
    names.set(page, title);
  }
  return title || (language === 'zh' ? '无标题页' : 'Untitled page');
}
export function createBushItPage(source = '', file?: BushItPage['file']) {
  const state = read(), page = { id: crypto.randomUUID(), source, updatedAt: Date.now(), ...(file ? { file } : {}) };
  publish({ pages: [...state.pages, page], selectedId: page.id }); return page.id;
}
export function updateBushItPage(id: string, patch: Partial<Pick<BushItPage, 'source' | 'file'>>) {
  publish({ pages: read().pages.map(page => page.id === id ? { ...page, ...patch, updatedAt: Date.now() } : page) });
}
export function selectBushItPage(id: string) { if (read().pages.some(page => page.id === id && !page.archived)) publish({ selectedId: id }); }
export function archiveBushItPage(id: string, archived = true) {
  const state = read(), pages = state.pages.map(page => page.id === id ? { ...page, archived } : page);
  publish({ pages, selectedId: archived && state.selectedId === id ? pages.find(page => !page.archived)?.id || '' : state.selectedId });
  if (!read().selectedId) createBushItPage();
}
export function useBushItPages() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read); }
