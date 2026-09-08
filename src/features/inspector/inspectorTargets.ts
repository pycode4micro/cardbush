import { basename, fileUrl, isAbsoluteLocalPath, stripWrappingQuotes } from '../../shared/localPaths';
import { resolveFilePreview } from './filePreviewRegistry';
import type { InspectorOpenDetail } from './inspectorEvents';

export function inspectorTargetIdentity(target: string) {
  const value = stripWrappingQuotes(target.trim());
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return value.replace(/\//g, '\\').toLowerCase();
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return value;
    }
  }
  return value;
}

export function isInspectorBrowserTarget(target: string) {
  const value = stripWrappingQuotes(target.trim());
  return /^https?:\/\//i.test(value) || /^about:blank(?:[?#]|$)/i.test(value);
}

export function normalizeInspectorBrowserAddress(address: string) {
  const value = stripWrappingQuotes(address.trim());
  if (!value) return '';
  if (/^about:blank(?:[?#]|$)/i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

export function inspectorTabLabel(detail: InspectorOpenDetail) {
  const target = stripWrappingQuotes(detail.target.trim());
  const title = detail.title?.trim();
  if (title && title !== target) return title;
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      const pathLabel = url.pathname === '/'
        ? ''
        : url.pathname.replace(/\/$/, '').split('/').pop() || '';
      return pathLabel ? `${url.host} · ${pathLabel}` : url.host;
    } catch {
      return target;
    }
  }
  return basename(target) || target;
}

export function inspectorSource(target: string) {
  const value = stripWrappingQuotes(target.trim());
  if (/^about:blank(?:[?#]|$)/i.test(value)) {
    return 'about:blank';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const path = inspectorFilePath(value);
  const adapter = resolveFilePreview(path);
  // An unknown local file has no navigable source. The inspector displays its
  // fallback component without sending arbitrary bytes to a text parser/guest.
  if (!adapter) return 'about:blank';
  return adapter.source(path, value);
}

export function inspectorFilePath(target: string) {
  const value = stripWrappingQuotes(target.trim());
  if (/^cardbush-file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (['text-preview', 'office-preview', 'model-preview'].includes(parsed.hostname.toLowerCase())) {
        return inspectorFilePath(parsed.searchParams.get('path') ?? '');
      }
      const decoded = decodeURIComponent(parsed.pathname);
      if (/^[a-z]$/i.test(parsed.hostname)) {
        return `${parsed.hostname.toUpperCase()}:${decoded.replaceAll('/', '\\')}`;
      }
      if (parsed.hostname) {
        return `\\\\${decodeURIComponent(parsed.hostname)}${decoded.replaceAll('/', '\\')}`;
      }
      return decoded.replace(/^\/([a-zA-Z]:)/, '$1').replaceAll('/', '\\');
    } catch {
      return '';
    }
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const decoded = decodeURIComponent(parsed.pathname);
      return parsed.hostname
        ? `\\\\${parsed.hostname}${decoded.replaceAll('/', '\\')}`
        : decoded.replace(/^\/([a-zA-Z]:)/, '$1').replaceAll('/', '\\');
    } catch {
      return '';
    }
  }
  return value;
}

export function isMarkdownInspectorTarget(target: string) {
  return !isInspectorBrowserTarget(target) && resolveFilePreview(inspectorFilePath(target))?.renderer === 'markdown';
}

export function inspectorMediaTarget(target: string): { kind: 'image' | 'video' | 'audio'; path: string; source: string } | null {
  const path = inspectorFilePath(target);
  if (!isAbsoluteLocalPath(path)) return null;
  const kind = resolveFilePreview(path)?.renderer;
  return kind === 'image' || kind === 'video' || kind === 'audio'
    ? { kind, path, source: fileUrl(path) } : null;
}

export function parentDirectory(value: string) {
  const normalized = value.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return lastSeparator > 0 ? normalized.slice(0, lastSeparator) : normalized;
}
