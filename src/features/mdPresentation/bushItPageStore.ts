import { uiText } from '../../i18n';
import { useSyncExternalStore } from 'react';
import { parseMarkdownGraph } from './markdownGraph';
import { pageTitle } from './pageDocument';

export type BushItPage = { id: string; source: string; updatedAt: number; archived?: boolean; projectDir?: string; conversationRoot?: string; temporary?: boolean; draftNumber?: number; unloaded?: boolean; file?: { path: string; revision: string; text: string }; externalFile?: BushItPage['file'] };
type Pages = { pages: BushItPage[]; selectedId: string; error: string; projectDir: string; projects: string[]; sessions: Record<string, string>; sessionDrafts: Record<string, string> };
const emptyProjects = () => ({ projectDir: '', projects: [] as string[], sessions: {} as Record<string, string>, sessionDrafts: {} as Record<string, string> });
const key = 'cardbush.bush-it.pages.v1', listeners = new Set<() => void>();
const names = new WeakMap<BushItPage, string>();
let snapshot: Pages | undefined, timer: ReturnType<typeof setTimeout> | undefined;
export const isCreationDraftDirectory = (path: string) => /(?:^|[\\/])task-workspaces[\\/][a-z0-9-]+[\\/]*$/i.test(path);
function initial(): Pages {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Array.isArray(saved.pages) && saved.pages.every((page: BushItPage) => typeof page.id === 'string' && typeof page.source === 'string' && typeof page.updatedAt === 'number')) {
      const pages = saved.pages.map((page: BushItPage) => page.projectDir && isCreationDraftDirectory(page.projectDir)
        ? { ...page, projectDir: '', conversationRoot: page.conversationRoot || page.projectDir, temporary: true } : page);
      const projectDir = typeof saved.projectDir === 'string' && !isCreationDraftDirectory(saved.projectDir) ? saved.projectDir : '';
      return { ...emptyProjects(), projectDir, projects: Array.isArray(saved.projects) ? saved.projects.filter((item: unknown) => typeof item === 'string' && !isCreationDraftDirectory(item)) : [], sessions: saved.sessions && typeof saved.sessions === 'object' ? saved.sessions : {},
        sessionDrafts: saved.sessionDrafts && typeof saved.sessionDrafts === 'object' ? Object.fromEntries(Object.entries(saved.sessionDrafts).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('local-'))) : {},
        pages, selectedId: pages.find((page: BushItPage) => page.id === saved.selectedId && !page.archived)?.id || pages.find((page: BushItPage) => !page.archived && (page.projectDir || '') === projectDir)?.id || '', error: '' };
    }
    const source = localStorage.getItem('cardbush.bush-it.draft') ?? localStorage.getItem('cardbush.md-presentation.draft') ?? '';
    const page = { id: crypto.randomUUID(), source, updatedAt: Date.now() }; return { ...emptyProjects(), pages: [page], selectedId: page.id, error: '' };
  } catch { const page = { id: crypto.randomUUID(), source: '', updatedAt: Date.now() }; return { ...emptyProjects(), pages: [page], selectedId: page.id, error: '' }; }
}
const read = () => snapshot ??= initial();
export const getBushItPages = read;
function notify() { listeners.forEach(listener => listener()); }
export function flushBushItPages() {
  clearTimeout(timer); timer = undefined;
  try { const { error: _error, ...saved } = read();
    // Clean files already live on disk. Keep only their references across restarts;
    // duplicating every project's contents quickly exhausts localStorage.
    const pages = saved.pages.map(page => page.file && !page.externalFile && page.source === page.file.text
      ? { ...page, source: '', file: { ...page.file, text: '' }, unloaded: true } : page);
    localStorage.setItem(key, JSON.stringify({ ...saved, pages })); if (snapshot!.error) { snapshot = { ...snapshot!, error: '' }; notify(); } }
  catch { snapshot = { ...read(), error: uiText()('bushItPageStore.could_not_store_pages_save_your_document') }; notify(); }
}
function publish(change: Partial<Pages>) { snapshot = { ...read(), ...change }; notify(); clearTimeout(timer); timer = setTimeout(flushBushItPages, 180); }
if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushBushItPages);
export function bushItPageName(page: BushItPage, language: string) {
  let title = names.get(page);
  if (title === undefined) {
    try { title = pageTitle(parseMarkdownGraph(page.source)).title; }
    catch { title = page.source.match(/^# (.+)$/m)?.[1] || ''; }
    names.set(page, title);
  }
  return title || (!page.temporary && page.file?.path.split(/[\\/]/).pop()) || (page.draftNumber ? `${uiText(language)('bushItPageStore.untitled')} ${page.draftNumber}` : uiText(language)('bushItPageStore.untitledPage'));
}
export function createBushItPage(source = '', file?: BushItPage['file'], projectDir = '') {
  const state = read(), page = { id: crypto.randomUUID(), source, updatedAt: Date.now(), ...(file ? { file } : { temporary: true, draftNumber: Math.max(0, ...state.pages.map(page => page.draftNumber ?? 0)) + 1 }), ...(projectDir ? { projectDir } : {}) };
  publish({ pages: [...state.pages, page], selectedId: page.id, projectDir }); return page.id;
}
export function updateBushItPage(id: string, patch: Partial<Pick<BushItPage, 'source' | 'file' | 'projectDir' | 'conversationRoot' | 'externalFile' | 'unloaded' | 'temporary'>>) {
  publish({ pages: read().pages.map(page => page.id === id ? { ...page, ...patch, updatedAt: Date.now() } : page) });
}
export function selectBushItPage(id: string) { const page = read().pages.find(page => page.id === id && !page.archived); if (page) publish({ selectedId: id, projectDir: page.projectDir || '' }); }
export function selectCreationProject(projectDir: string) {
  const state = read(); publish({ projectDir, projects: projectDir ? [...new Set([...state.projects, projectDir])] : state.projects,
    selectedId: state.pages.find(page => !page.archived && (page.projectDir || '') === projectDir)?.id || '' });
}
export const creationSessionScope = (projectDir: string, page?: BushItPage) => projectDir ? `project:${projectDir}` : page ? `page:${page.id}` : '';
export function prepareCreationSession(scope: string) {
  const state = read(), existing = state.sessionDrafts[scope]; if (existing) return existing;
  const id = `local-${crypto.randomUUID()}`; publish({ sessionDrafts: { ...state.sessionDrafts, [scope]: id } }); return id;
}
export function setCreationSession(root: string, sessionId: string) { publish({ sessions: { ...read().sessions, [root]: sessionId },
  sessionDrafts: Object.fromEntries(Object.entries(read().sessionDrafts).filter(([, id]) => id !== sessionId)) }); }
export function archiveBushItPage(id: string, archived = true) {
  const state = read(), pages = state.pages.map(page => page.id === id ? { ...page, archived } : page);
  publish({ pages, selectedId: archived && state.selectedId === id ? pages.find(page => !page.archived)?.id || '' : state.selectedId });
  if (!read().selectedId) createBushItPage();
}
export function useBushItPages() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read); }
export function useCreationSessionId() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => {
    const state = read(), page = state.pages.find(page => page.id === state.selectedId && !page.archived);
    const root = state.projectDir || page?.conversationRoot || '';
    return state.sessions[root] || state.sessionDrafts[creationSessionScope(state.projectDir, page)] || '';
  });
}
