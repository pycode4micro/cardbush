import type { HtmlComponent } from '../components/componentModel';
import { websiteAddress } from '../../../electron/homeWebsiteAddress';
export { websiteAddress };

export const nativeSections = ['featured', 'events', 'projects', 'recent'] as const;
export type NativeSection = typeof nativeSections[number];
export type HomeDimensions = { width?: number; height?: number; column?: number };
export type HomeBlock = HomeDimensions & (
  | { kind: 'native'; id: NativeSection; hidden?: boolean }
  | { kind: 'html'; id: string }
  | { kind: 'web'; id: string; title: string; url: string }
);
export const homeLayoutKey = 'cardbush.home-layout.v1';
export const blockKey = (block: HomeBlock) => block.kind + ':' + block.id;
const defaults = (): HomeBlock[] => nativeSections.map(id => ({kind: 'native', id}));

export function readHomeLayout(): HomeBlock[] | undefined {
  try {
    const raw = localStorage.getItem(homeLayoutKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.blocks)) return;
    const seen = new Set<string>(), blocks: HomeBlock[] = [];
    for (const item of data.blocks) {
      if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(item.id)) continue;
      let block: HomeBlock;
      if (item.kind === 'native' && nativeSections.some(id => id === item.id)) block = {kind: 'native', id: item.id, hidden: item.hidden === true};
      else if (item.kind === 'html') block = {kind: 'html', id: item.id};
      else if (item.kind === 'web' && typeof item.url === 'string' && typeof item.title === 'string') {
        const url = websiteAddress(item.url);
        if (!url) continue;
        block = {kind: 'web', id: item.id, url, title: item.title.trim().slice(0, 80) || new URL(url).hostname};
      } else continue;
      if (seen.has(blockKey(block))) continue;
      seen.add(blockKey(block));
      if (Number.isInteger(item.width) && item.width >= 3 && item.width <= 12) block.width = item.width;
      if (Number.isInteger(item.height) && item.height >= 120 && item.height <= 1200) block.height = item.height;
      if (Number.isInteger(item.column) && item.column >= 1 && item.column <= 10) block.column = item.column;
      blocks.push(block);
    }
    return blocks;
  } catch { return; }
}

// Placement in the component library is authoritative, including changes published by the Agent.
// Keep references to temporarily unpinned widgets so pinning again restores their position.
export function reconcileHomeLayout(saved: HomeBlock[] | undefined, components: HtmlComponent[]): HomeBlock[] {
  const blocks = saved ?? defaults();
  const known = new Set(blocks.filter(block => block.kind === 'html').map(block => block.id));
  const extra = components.filter(item => item.home && !known.has(item.id)).map(item => ({kind: 'html' as const, id: item.id}));
  return saved ? [...blocks, ...extra] : [blocks[0], ...extra, ...blocks.slice(1)];
}

export function moveHomeBlock(blocks: HomeBlock[], source: string, target: string) {
  const from = blocks.findIndex(block => blockKey(block) === source);
  const to = blocks.findIndex(block => blockKey(block) === target);
  if (from === to || from < 0 || to < 0) return blocks;
  const next = [...blocks];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
