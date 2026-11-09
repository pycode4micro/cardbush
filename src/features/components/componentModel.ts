export const componentProtocol = 'cardbush.html-surface/1';
export const componentStorageKey = 'cardbush.html_components.v1';
export const maxComponentBytes = 256 * 1024;
export type HtmlComponent = { id: string; title: string; html: string; allowActions: boolean;
  width: number; height: number; order: number; home?: boolean };
export type ComponentCollection = { version: 1; revision: number; items: HtmlComponent[] };
export const defaultComponents: ComponentCollection = {version: 1, revision: 0, items: []};

// Import user-authored components from the previous local library once.
export function normalizeComponents(value: unknown): ComponentCollection {
  const input = value as Partial<ComponentCollection> & {welcomeLayout?: {items?: {componentId: string}[]}};
  if (!input || input.version !== 1 || !Array.isArray(input.items)) return defaultComponents;
  const seen = new Set<string>();
  const items = input.items.filter(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(item.id) || item.id.startsWith('system-') ||
      seen.has(item.id) || typeof item.html !== 'string' || new TextEncoder().encode(item.html).length > maxComponentBytes) return false;
    seen.add(item.id); return true;
  }).map(item => ({id: item.id, title: String(item.title || 'HTML').trim().slice(0, 80), html: item.html, allowActions: item.allowActions === true,
    width: Math.max(3, Math.min(12, Math.round(item.width) || 6)), height: Math.max(120, Math.min(1200, Math.round(item.height) || 280)),
    order: Number.isFinite(item.order) ? item.order : 0,
    home: item.home === true || (item.home === undefined && Array.isArray(input.welcomeLayout?.items) && input.welcomeLayout.items.some(place => place?.componentId === item.id))}));
  return {version: 1, revision: Number(input.revision) || 0, items: items.sort((a,b) => a.order - b.order)};
}

export function validateComponentText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 32000) throw new Error('INVALID_ARGUMENT');
  return value;
}
