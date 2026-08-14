import { basename, isAbsoluteLocalPath, stripWrappingQuotes } from '../../shared/localPaths';

export const localFileReferenceScheme = 'cardbush-local-file:';

export type LocalFileReference = {
  path: string;
  label: string;
};

const fileExtensionPattern = /\.[a-z0-9][a-z0-9._-]{0,15}$/i;
const trailingLocationPattern = /:(\d+)(?::(\d+))?$/;
const relativeFilePattern = /(?:\.{0,2}[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[a-z0-9][a-z0-9._-]{0,15}(?::\d+(?::\d+)?)?/gi;
const windowsFilePattern = /[a-z]:[\\/](?:[^<>:"|?*\r\n`]+[\\/])*[^<>:"|?*\r\n`]+\.[a-z0-9][a-z0-9._-]{0,15}(?::\d+(?::\d+)?)?/gi;

export function localFileReference(
  value: string,
  _workspaceRoot = '',
): LocalFileReference | null {
  const cleaned = cleanFileReferenceValue(value);
  if (!cleaned || !looksLikeFilePath(cleaned)) {
    return null;
  }
  const withoutLocation = cleaned.replace(trailingLocationPattern, '');
  if (!isAbsoluteLocalPath(withoutLocation)) {
    return null;
  }
  return {
    path: withoutLocation,
    label: basename(withoutLocation),
  };
}

export function localFileReferenceHref(path: string) {
  return `${localFileReferenceScheme}${encodeURIComponent(path)}`;
}

export function localFileReferenceFromHref(href: string) {
  if (!href.startsWith(localFileReferenceScheme)) {
    return '';
  }
  try {
    const path = decodeURIComponent(href.slice(localFileReferenceScheme.length));
    return isAbsoluteLocalPath(path) ? path : '';
  } catch {
    return '';
  }
}

export function linkifyLocalFileReferences(content: string, _workspaceRoot = '') {
  return content
    .split(/(```[\s\S]*?```)/g)
    .map((fencedBlock, fencedIndex) => {
      if (fencedIndex % 2 === 1) {
        return fencedBlock;
      }
      return fencedBlock
        .split(/(`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g)
        .map((protectedBlock, protectedIndex) => {
          if (protectedIndex % 2 === 1) {
            return protectedBlock;
          }
          return linkifyTextSegment(protectedBlock);
        })
        .join('');
    })
    .join('');
}

function linkifyTextSegment(value: string) {
  const matches = [
    ...value.matchAll(windowsFilePattern),
    ...value.matchAll(relativeFilePattern),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  if (matches.length === 0) {
    return value;
  }
  let cursor = 0;
  let result = '';
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index < cursor) {
      continue;
    }
    if (isInsideBareWebUrl(value, index)) {
      continue;
    }
    const reference = localFileReference(match[0]);
    if (!reference) {
      continue;
    }
    result += value.slice(cursor, index);
    result += `[${escapeMarkdownLabel(reference.label)}](${localFileReferenceHref(reference.path)})`;
    cursor = index + match[0].length;
  }
  return result + value.slice(cursor);
}

function isInsideBareWebUrl(value: string, index: number) {
  const tokenStart = Math.max(
    value.lastIndexOf(' ', index - 1),
    value.lastIndexOf('\n', index - 1),
    value.lastIndexOf('\t', index - 1),
  ) + 1;
  return /^https?:\/\//i.test(value.slice(tokenStart, index));
}

function cleanFileReferenceValue(value: string) {
  const unwrapped = stripWrappingQuotes(value.trim());
  const localValue = /^file:\/\//i.test(unwrapped)
    ? localPathFromFileUrl(unwrapped)
    : decodeFileReference(unwrapped);
  return localValue
    .replace(/[),.;，。；]+$/, '')
    .trim();
}

function localPathFromFileUrl(value: string) {
  try {
    const parsed = new URL(value);
    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.hostname) {
      return `\\\\${parsed.hostname}${pathname.replaceAll('/', '\\')}`;
    }
    return pathname.replace(/^\/([a-zA-Z]:)/, '$1').replaceAll('/', '\\');
  } catch {
    return decodeFileReference(value.replace(/^file:\/\//i, ''));
  }
}

function decodeFileReference(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeFilePath(value: string) {
  const withoutLocation = value.replace(trailingLocationPattern, '');
  if (!fileExtensionPattern.test(withoutLocation)) {
    return false;
  }
  return isAbsoluteLocalPath(withoutLocation) || /[\\/]/.test(withoutLocation);
}

function escapeMarkdownLabel(value: string) {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]');
}
