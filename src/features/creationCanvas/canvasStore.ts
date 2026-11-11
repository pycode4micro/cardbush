import { uiText } from '../../i18n';
import { useSyncExternalStore } from 'react';
import { emptyCanvas, type CanvasSnapshot, type CreationCanvas } from '@cardbush/bush-protocol';
import { bushItPageName, getBushItPages, type BushItPage } from '../mdPresentation/bushItPageStore';
import { inspectorTargetIdentity } from '../inspector/inspectorTargets';

export type CanvasEntry = { id: string; title: string; sessionId: string; sessionCreated?: boolean; root?: string; path?: string; seed?: CreationCanvas; legacyPageId?: string; archived?: boolean; updatedAt: number; editingId?: string; team?: { id: string; revision: number } };
type Library = { canvases: CanvasEntry[]; selectedId: string; error: string };
const key = 'cardbush.creation-canvases.v1', listeners = new Set<() => void>();
let state: Library | undefined;
const pending = new Map<string, Promise<CanvasSnapshot>>();
function entry(seed = emptyCanvas()): CanvasEntry { return { id: crypto.randomUUID(), sessionId: `local-${crypto.randomUUID()}`, title: seed.title, seed, updatedAt: Date.now() }; }
export function getCanvases(): Library {
  if (state) return state;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Array.isArray(saved.canvases) && saved.canvases.every((item: CanvasEntry) => typeof item.id === 'string' && typeof item.sessionId === 'string' && typeof item.title === 'string'))
      return state = { canvases: saved.canvases, selectedId: saved.selectedId, error: '' };
  } catch { /* Keep the original store intact if it cannot be decoded. */ }
  // Keep a reference until first open rather than duplicating every legacy draft in localStorage.
  const canvases = getBushItPages().pages.filter(page => !page.archived && (page.file || page.source.trim()))
    .map(page => ({ ...entry(), title: bushItPageName(page, 'zh'), seed: undefined, legacyPageId: page.id } as CanvasEntry));
  if (!canvases.length) canvases.push(entry());
  state = { canvases, selectedId: canvases[0].id, error: '' };
  persist(); return state;
}
function persist() {
  try { localStorage.setItem(key, JSON.stringify(state)); if (state) state = { ...state, error: '' }; }
  catch { if (state) state = { ...state, error: uiText()('canvasStore.could_not_save_the_canvas_library_export') }; }
}
function publish(value: Library) { state = value; persist(); listeners.forEach(listener => listener()); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function legacyDocument(page: BushItPage) {
  const seed = emptyCanvas(bushItPageName(page, 'zh')), frame = { x: 80, y: 60, width: 1000, height: 800 };
  seed.items = [page.file && (page.unloaded || page.source === page.file.text)
    ? { id: 'document', kind: 'file', title: seed.title, source: page.file.path, frame }
    : { id: 'document', kind: 'markdown', title: seed.title, markdown: page.source, frame }];
  return seed;
}
export function useCanvases() { return useSyncExternalStore(subscribe, getCanvases, getCanvases); }
export function useCanvasSessionId() { const library = useCanvases(); return library.canvases.find(item => item.id === library.selectedId && !item.archived)?.sessionId || ''; }
export function createCanvas(seed?: CreationCanvas) { const item = entry(seed); publish({ ...getCanvases(), canvases: [...getCanvases().canvases, item], selectedId: item.id }); return item.id; }
export function selectCanvas(id: string) { if (getCanvases().canvases.some(item => item.id === id && !item.archived)) publish({ ...getCanvases(), selectedId: id }); }
export function closeCanvas(id: string) {
  const library = getCanvases();
  if (library.selectedId === id) publish({ ...library, selectedId: '' });
}
export async function deleteCanvas(id: string, snapshot: CanvasSnapshot) {
  const result = await window.cardbushDesktop!.creationCanvas({ action: 'delete', path: snapshot.path, expectedRevision: snapshot.revision });
  if (!result) return;
  const library = getCanvases();
  publish({ ...library, canvases: library.canvases.filter(item => item.id !== id),
    selectedId: library.selectedId === id ? '' : library.selectedId });
}
export async function openCanvasFile(path?: string) {
  const desktop = window.cardbushDesktop;
  if (!desktop?.creationCanvas) throw Error(uiText()('canvasStore.restart_the_updated_cardbush_app'));
  const result = await desktop.creationCanvas(path ? { action: 'read', path } : { action: 'open' });
  if (!result || !('document' in result)) return false;
  acceptCanvas(result);
  return true;
}
export function updateCanvasEntry(id: string, change: Partial<CanvasEntry>) { publish({ ...getCanvases(), canvases: getCanvases().canvases.map(item => item.id === id ? { ...item, ...change } : item) }); }
export function archiveCanvas(id: string, archived: boolean) {
  const canvases = getCanvases().canvases.map(item => item.id === id ? { ...item, archived } : item);
  const active = getCanvases().selectedId;
  const selectedId = archived && id === active ? canvases.find(item => !item.archived)?.id || '' : active;
  publish({ ...getCanvases(), canvases, selectedId });
}
export function acceptCanvas(snapshot: CanvasSnapshot) {
  const library = getCanvases();
  const old = library.canvases.find(item => item.path && inspectorTargetIdentity(item.path) === inspectorTargetIdentity(snapshot.path));
  if (old) {
    publish({ ...library, selectedId: old.id, canvases: library.canvases.map(item => item === old
      ? { ...item, archived: false, title: snapshot.document.title, updatedAt: Date.now() } : item) });
    return;
  }
  const item = entry(); item.path = snapshot.path; item.seed = undefined; item.title = snapshot.document.title;
  publish({ ...getCanvases(), canvases: [...getCanvases().canvases, item], selectedId: item.id });
}
export async function prepareCanvas(id: string): Promise<CanvasSnapshot> {
  const existing = pending.get(id); if (existing) return existing;
  const task = (async () => {
    const item = getCanvases().canvases.find(item => item.id === id);
    if (!item) throw Error(uiText()('canvasStore.canvas_is_unavailable'));
    const desktop = window.cardbushDesktop;
    if (!desktop?.creationCanvas) throw Error(uiText()('canvasStore.restart_the_updated_cardbush_app'));
    const root = item.root || await desktop.ensureTaskWorkspace(item.sessionId);
    const legacy = item.legacyPageId ? getBushItPages().pages.find(page => page.id === item.legacyPageId) : undefined;
    const result = await desktop.creationCanvas(item.path ? { action: 'read', path: item.path } : { action: 'create', root, document: legacy ? legacyDocument(legacy) : item.seed });
    if (!result || !('document' in result)) throw Error(uiText()('canvasStore.could_not_load_the_canvas'));
    updateCanvasEntry(id, { root, path: result.path, seed: undefined, legacyPageId: undefined, title: result.document.title });
    return result;
  })();
  pending.set(id, task); try { return await task; } finally { pending.delete(id); }
}
