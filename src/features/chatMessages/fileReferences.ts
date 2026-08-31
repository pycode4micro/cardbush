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
const bareWindowsAbsolutePathPattern = /[a-z]:[\\/][^\s<>:"|?*`\r\n,;，。；：、(){}\[\]]+/gi;
const bareUncAbsolutePathPattern = /\\\\[^\s<>:"|?*`\r\n,;，。；：、(){}\[\]]+/g;
const barePosixAbsolutePathPattern = /\/(?:[\w@.+~-]+\/)+[\w@.+~-]+/g;

export function localFileReference(
  value: string,
  workspaceRoot = '',
): LocalFileReference | null {
  const cleaned = cleanFileReferenceValue(value);
  if (!cleaned || !looksLikeFilePath(cleaned)) {
    return null;
  }
  const withoutLocation = cleaned.replace(trailingLocationPattern, '');
  const resolvedPath = isAbsoluteLocalPath(withoutLocation)
    ? withoutLocation
    : resolveWorkspaceRelativePath(withoutLocation, workspaceRoot);
  if (!resolvedPath) {
    return null;
  }
  return {
    path: resolvedPath,
    label: basename(resolvedPath),
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

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

/**
 * CardBush's local-file behavior is a Markdown AST extension. Standard Markdown
 * syntax is parsed first, so links, code and other native nodes are never
 * rewritten as source text merely to add local file navigation.
 */
export function remarkLocalFileReferences(options: { workspaceRoot?: string } = {}) {
  const workspaceRoot = options.workspaceRoot ?? '';
  return (tree: MarkdownNode) => {
    visitMarkdownText(tree, workspaceRoot);
  };
}

function visitMarkdownText(node: MarkdownNode, workspaceRoot: string) {
  if (!node.children || markdownNativeBoundary(node.type)) {
    return;
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    if (child.type === 'text' && typeof child.value === 'string') {
      const replacement = localFileMarkdownNodes(child.value, workspaceRoot);
      if (replacement) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }
    visitMarkdownText(child, workspaceRoot);
  }
}

function markdownNativeBoundary(type: string) {
  return type === 'link' ||
    type === 'linkReference' ||
    type === 'definition' ||
    type === 'code' ||
    type === 'inlineCode' ||
    type === 'html';
}

function localFileMarkdownNodes(value: string, workspaceRoot: string): MarkdownNode[] | null {
  const matches = [
    ...value.matchAll(windowsFilePattern),
    ...value.matchAll(relativeFilePattern),
    ...value.matchAll(bareWindowsAbsolutePathPattern),
    ...value.matchAll(bareUncAbsolutePathPattern),
    ...value.matchAll(barePosixAbsolutePathPattern),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  if (matches.length === 0) {
    return null;
  }
  let cursor = 0;
  const result: MarkdownNode[] = [];
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index < cursor) {
      continue;
    }
    if (isInsideWebUrl(value, index)) {
      continue;
    }
    const reference = localFileReference(match[0], workspaceRoot);
    if (!reference) {
      continue;
    }
    if (index > cursor) {
      result.push({ type: 'text', value: value.slice(cursor, index) });
    }
    result.push({
      type: 'link',
      url: localFileReferenceHref(reference.path),
      children: [{ type: 'text', value: reference.label }],
    });
    cursor = index + match[0].length;
  }
  if (result.length === 0) {
    return null;
  }
  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) });
  }
  return result;
}

function isInsideWebUrl(value: string, index: number) {
  for (const match of value.matchAll(/https?:\/\/[^\s<>()（）\[\]【】]+/gi)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (index >= start && index < end) {
      return true;
    }
  }
  return false;
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

function resolveWorkspaceRelativePath(value: string, workspaceRoot: string) {
  const rawRoot = stripWrappingQuotes(workspaceRoot.trim());
  const root = rawRoot === '/' || /^[a-zA-Z]:[\\/]$/.test(rawRoot)
    ? rawRoot
    : rawRoot.replace(/[\\/]+$/, '');
  if (!root || !isAbsoluteLocalPath(root)) {
    return '';
  }
  const segments = value
    .replace(/^[.][\\/]/, '')
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '..' || segment.includes(':'))
  ) {
    return '';
  }
  const separator = root.includes('\\') ? '\\' : '/';
  const prefix = root.endsWith('\\') || root.endsWith('/')
    ? root
    : `${root}${separator}`;
  return `${prefix}${segments.join(separator)}`;
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
  if (isAbsoluteLocalPath(withoutLocation)) {
    return true;
  }
  if (!fileExtensionPattern.test(withoutLocation)) {
    return false;
  }
  return /[\\/]/.test(withoutLocation);
}
