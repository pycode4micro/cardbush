import { basename, fileUrl, isAbsoluteLocalPath, isAudioPath, isImagePath, isVideoPath, stripWrappingQuotes } from '../../shared/localPaths';
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
    return inspectorSource(inspectorMarkdownPath(value));
  }
  if (/^cardbush-file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (['office-preview', 'text-preview'].includes(parsed.hostname.toLowerCase())) {
        return value;
      }
      return inspectorSource(inspectorMarkdownPath(value));
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
  return /\.(?:md|markdown)$/i.test(inspectorMarkdownPath(target));
}

export function inspectorMediaTarget(target: string): { kind: 'image' | 'video' | 'audio'; path: string; source: string } | null {
  const path = inspectorMarkdownPath(target);
  if (!isAbsoluteLocalPath(path)) return null;
  // This is a decoded filesystem path: '#' belongs to the filename, not a URL fragment.
  const extension = path.slice(path.lastIndexOf('.'));
  const kind = isImagePath(extension) || /^\.svg$/i.test(extension) ? 'image'
    : isVideoPath(extension) ? 'video' : isAudioPath(extension) ? 'audio' : null;
  return kind ? { kind, path, source: fileUrl(path) } : null;
}

export function parentDirectory(value: string) {
  const normalized = value.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return lastSeparator > 0 ? normalized.slice(0, lastSeparator) : normalized;
}

function isOfficeDocumentPath(value: string) {
  return /\.(?:docx?|xlsx?|pptx?)$/i.test(value);
}

function officeDocumentPreviewUrl(value: string) {
  return `cardbush-file://office-preview/?path=${encodeURIComponent(value)}`;
}

function textFilePreviewUrl(value: string) {
  return `cardbush-file://text-preview/?path=${encodeURIComponent(value)}`;
}

function usesNativeFilePreview(value: string) {
  return /\.(?:html?|xhtml|pdf|svg|png|apng|avif|jpe?g|gif|webp|bmp|ico|mp3|m4a|mp4|m4v|mov|ogv|aac|wav|ogg|oga|opus|flac|webm)$/i.test(
    value,
  );
}

function localFilePreviewUrl(value: string) {
  if (value.startsWith('\\\\')) {
    const [host, ...parts] = value.slice(2).replaceAll('\\', '/').split('/');
    return `file://${host}/${parts.map(encodeURIComponent).join('/')}`;
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encoded = normalized
    .split('/')
    .map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part))
    .join('/');
  return `file:///${encoded}`;
}
