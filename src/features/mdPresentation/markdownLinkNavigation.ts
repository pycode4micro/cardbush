import { openInspector } from '../inspector/inspectorEvents';

/** Route links through the existing browser/OS integrations, never the editor URL. */
export async function openMarkdownExternalLink(href: string, label: string) {
  const value = href.trim();
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
    const url = new URL(value, 'https://cardbush.invalid');
    if (!/^https?:$/.test(url.protocol)) return false;
    openInspector(url.href, label || url.hostname);
    return true;
  }
  if (/^(mailto|tel):/i.test(value)) {
    if (window.cardbushDesktop?.openExternal) await window.cardbushDesktop.openExternal(value);
    else window.open(value, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
