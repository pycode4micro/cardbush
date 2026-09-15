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
    if (path && isAbsoluteLocalPath(path)) paths.push(path);
    else lines.push(line);
  }
  return { text: lines.join('\n').trim(), paths };
}

export function basename(value: string) {
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

function encodedLocalResourceUrl(value: string) {
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
