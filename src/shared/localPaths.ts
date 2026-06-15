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

export function stripLooseWrappingQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, '');
}

export function isImagePath(value: string) {
  return /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(stripWrappingQuotes(value.trim()));
}

export function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

export function basename(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || value;
}

export function samePath(left: string, right: string) {
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
  if (/^file:\/\//i.test(normalized)) {
    if (!window.cardbushDesktop) {
      return normalized;
    }
    try {
      const parsed = new URL(normalized);
      const hostPrefix = parsed.hostname ? `/${parsed.hostname}` : '';
      return encodedLocalResourceUrl(
        `${hostPrefix}${decodeURIComponent(parsed.pathname)}`,
      );
    } catch {
      return normalized;
    }
  }
  return encodedLocalResourceUrl(normalized);
}

export function encodedLocalResourceUrl(value: string) {
  const pathValue = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encodedPath = pathValue
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  const scheme = window.cardbushDesktop ? 'cardbush-file' : 'file';
  return `${scheme}:///${encodedPath}`;
}
