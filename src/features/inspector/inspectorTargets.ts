import { basename, fileUrl, stripWrappingQuotes } from '../../shared/localPaths';
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
  if (/^file:\/\//i.test(value)) {
    if (isOfficeDocumentPath(value)) return officeDocumentPreviewUrl(value);
    return usesNativeFilePreview(value) ? value : textFilePreviewUrl(value);
  }
  if (/^cardbush-file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (['office-preview', 'text-preview'].includes(parsed.hostname.toLowerCase())) {
        return value;
      }
      return localFilePreviewUrl(decodeURIComponent(parsed.pathname));
    } catch {
      return value;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    if (isOfficeDocumentPath(value)) {
      return officeDocumentPreviewUrl(value);
    }
    return usesNativeFilePreview(value)
      ? localFilePreviewUrl(value)
      : textFilePreviewUrl(value);
  }
  if (isOfficeDocumentPath(value)) {
    return officeDocumentPreviewUrl(value);
  }
  return usesNativeFilePreview(value) ? fileUrl(value) : textFilePreviewUrl(value);
}

export function inspectorMarkdownPath(target: string) {
  const value = stripWrappingQuotes(target.trim());
  if (/^cardbush-file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (['text-preview', 'office-preview'].includes(parsed.hostname.toLowerCase())) {
        return inspectorMarkdownPath(parsed.searchParams.get('path') ?? '');
      }
      const decoded = decodeURIComponent(parsed.pathname);
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
  return /\.(?:md|markdown)$/i.test(inspectorMarkdownPath(target).split(/[?#]/, 1)[0]);
}

export function parentDirectory(value: string) {
  const normalized = value.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return lastSeparator > 0 ? normalized.slice(0, lastSeparator) : normalized;
}

function isOfficeDocumentPath(value: string) {
  return /\.(?:docx?|xlsx?|pptx?)$/i.test(value.split(/[?#]/, 1)[0]);
}

function officeDocumentPreviewUrl(value: string) {
  return `cardbush-file://office-preview/?path=${encodeURIComponent(value)}`;
}

function textFilePreviewUrl(value: string) {
  return `cardbush-file://text-preview/?path=${encodeURIComponent(value)}`;
}

function usesNativeFilePreview(value: string) {
  return /\.(?:html?|xhtml|pdf|svg|png|jpe?g|gif|webp|bmp|ico|mp3|m4a|mp4|aac|wav|ogg|oga|opus|flac|webm)$/i.test(
    value.split(/[?#]/, 1)[0],
  );
}

function localFilePreviewUrl(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encoded = normalized
    .split('/')
    .map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part))
    .join('/');
  return `file:///${encoded}`;
}
