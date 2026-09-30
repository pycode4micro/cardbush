export function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function isImagePath(value: string) {
  return /\.(png|apng|avif|jpe?g|webp|gif|bmp|ico)(?:[?#].*)?$/i.test(
    stripWrappingQuotes(value.trim()),
  );
}

export function isVideoPath(value: string) {
  return /\.(mp4|m4v|webm|ogv|mov)(?:[?#].*)?$/i.test(
    stripWrappingQuotes(value.trim()),
  );
}

export function isAudioPath(value: string) {
  return /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:[?#].*)?$/i.test(
    stripWrappingQuotes(value.trim()),
  );
}

export function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

export type ResourceTargetKind = 'local-file' | 'ssh-file' | 'url' | 'inline' | 'unsupported';

/** Byte sources use an allowlist. An internal reference or unknown scheme is never a path. */
export function resourceTargetKind(value: string): ResourceTargetKind {
  const target = stripWrappingQuotes(value);
  if (!target || /[\x00-\x1f\x7f]/.test(target)) return 'unsupported';
  if (isAbsoluteLocalPath(target)) return 'local-file';
  if (/^data:[^,]+,/i.test(target) || /^blob:/i.test(target)) return 'inline';
  try {
    const url = new URL(target);
    if (/^https?:\/\//i.test(target) && url.hostname) return 'url';
    if (/^cardbush-file:\/\//i.test(target) && !url.username && !url.password) return 'url';
    if (/^file:\/\//i.test(target) && !url.username && !url.password && !url.port && !url.search && !url.hash) {
      if (!/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname))) return 'local-file';
    }
    if (/^ssh:\/\/[a-z0-9-]+\/[^?#]*$/.test(target) && !/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname))) return 'ssh-file';
  } catch { /* Invalid or relative targets require explicit resolution by the caller. */ }
  return 'unsupported';
}

export function isLocalFileResource(value: string) {
  return resourceTargetKind(value) === 'local-file';
}

export function mediaResourceUrl(value: string) {
  const target = stripWrappingQuotes(value);
  const kind = resourceTargetKind(target);
  return kind === 'local-file' || kind === 'ssh-file' ? fileUrl(target)
    : kind === 'url' || kind === 'inline' ? target : '';
}

/** Only explicit @ references outside code attach files; ordinary path text stays authored text. */
export function splitExplicitAttachmentMentions(content: string) {
  const paths: string[] = [], lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push(line);
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      lines.push(line);
      continue;
    }
    const mention = /^ {0,3}@(.+)$/.exec(line);
    const path = mention ? stripWrappingQuotes(mention[1]) : '';
    if (path && (isAbsoluteLocalPath(path) || path.startsWith('ssh://'))) paths.push(path);
    else lines.push(line);
  }
  return { text: lines.join('\n').trim(), paths };
}

export function basename(value: string) {
  if (value.startsWith('ssh://')) { try { value = decodeURIComponent(new URL(value).pathname); } catch { /* Retain invalid input for display. */ } }
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || value;
}

/** URL query strings are not filename suffixes; local '#' and '%' stay literal. */
export function resourceBasename(value: string) {
  const source = stripWrappingQuotes(value);
  if (/^data:/i.test(source)) return '';
  if (/^(?:https?|file|cardbush-file):\/\//i.test(source)) {
    try { return decodeURIComponent(basename(new URL(source).pathname)); }
    catch { return ''; }
  }
  return basename(source);
}

export function samePath(left: string, right: string) {
  if (left.startsWith('ssh://') || right.startsWith('ssh://')) return left === right;
  return (
    left.replaceAll('\\', '/').toLowerCase() ===
    right.replaceAll('\\', '/').toLowerCase()
  );
}

export function compactPath(value?: string) {
  if (!value) {
    return '~';
  }
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function fileUrl(value: string) {
  const normalized = stripWrappingQuotes(value.trim());
  const kind = resourceTargetKind(normalized);
  if (kind === 'ssh-file') return `cardbush-file://ssh-file/?path=${encodeURIComponent(normalized)}`;
  if (kind === 'url' && /^cardbush-file:/i.test(normalized)) return normalized;
  if (kind !== 'local-file') return '';
  if (/^file:\/\//i.test(normalized)) {
    if (!window.cardbushDesktop) {
      return normalized;
    }
    try {
      const parsed = new URL(normalized);
      const hostPrefix = parsed.hostname ? `//${parsed.hostname}` : '';
      return encodedLocalResourceUrl(
        `${hostPrefix}${decodeURIComponent(parsed.pathname)}`,
      );
    } catch {
      return normalized;
    }
  }
  return encodedLocalResourceUrl(normalized);
}

function encodedLocalResourceUrl(value: string) {
  const normalized = value.replaceAll('\\', '/');
  const network = normalized.startsWith('//');
  const pathValue = normalized.replace(/^\/+/, '');
  const encodedPath = pathValue
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  const scheme = window.cardbushDesktop ? 'cardbush-file' : 'file';
  return `${scheme}://${network ? '' : '/'}${encodedPath}`;
}
