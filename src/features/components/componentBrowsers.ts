import { approvedWebsiteUrl } from '../../../assets/skills/cardbush-docs/scripts/component-origins.mjs';

export type ComponentBrowser = { id: string; url: string; revision: number;
  x: number; y: number; width: number; height: number;
  clipX: number; clipY: number; clipWidth: number; clipHeight: number };

/** Geometry is measured inside the component, but cannot escape its host frame. */
export function componentBrowsers(input: unknown, origins: string[], width: number, height: number): ComponentBrowser[] {
  if (!Array.isArray(input) || input.length > 8) return [];
  const ids = new Set<string>();
  return input.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const item = value as ComponentBrowser, url = approvedWebsiteUrl(item.url, origins);
    if (!url || typeof item.id !== 'string' || !/^browser-\d{1,6}$/.test(item.id) || ids.has(item.id) ||
        !Number.isSafeInteger(item.revision) || item.revision < 0 ||
        ![item.x,item.y,item.width,item.height,item.clipX,item.clipY,item.clipWidth,item.clipHeight].every(Number.isFinite) ||
        item.width <= 0 || item.height <= 0 || item.width > 8192 || item.height > 8192) return [];
    const left = Math.max(0,item.x,item.clipX), top = Math.max(0,item.y,item.clipY);
    const right = Math.min(width,item.x+item.width,item.clipX+item.clipWidth);
    const bottom = Math.min(height,item.y+item.height,item.clipY+item.clipHeight);
    if (right <= left || bottom <= top) return [];
    ids.add(item.id);
    return [{...item,url,clipX:left,clipY:top,clipWidth:right-left,clipHeight:bottom-top}];
  });
}
