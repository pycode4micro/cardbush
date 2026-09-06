const shellFenceLanguages = new Set([
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'shell',
  'cmd',
]);

const fileLikeExtensions = new Set([
  'bat',
  'cjs',
  'cmd',
  'css',
  'csv',
  'db',
  'gif',
  'htm',
  'html',
  'ico',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'mjs',
  'mp3',
  'mp4',
  'png',
  'ps1',
  'py',
  'sh',
  'sqlite',
  'svg',
  'ts',
  'tsx',
  'txt',
  'wav',
  'webm',
  'webp',
  'xml',
  'yaml',
  'yml',
]);

export function normalizeMarkdownContentForDisplay(content: string) {
  const normalized = content.replace(
    /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)$/gm,
    (line, indent: string, fence: string, rawInfo: string) => {
      const info = rawInfo.trim();
      if (!info) {
        return line;
      }

      const shellCommand = commandAfterShellFence(info);
      if (shellCommand) {
        return `${indent}${fence}${shellCommand.language}\n${shellCommand.command}`;
      }

      if (looksLikePathFenceContent(info)) {
        return `${indent}${fence}text\n${info}`;
      }

      return line;
    },
  );
  const withoutEmptyFences = normalized.replace(
    /^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n(?:[ \t]*\r?\n)*[ \t]*\1[ \t]*$/gm,
    '',
  );
  return transformMarkdownProse(withoutEmptyFences, normalizeEmphasizedBareLinks);
}

function normalizeEmphasizedBareLinks(value: string) {
  return value.replace(
    /(\*\*|__)(https?:\/\/[^\s<>()]+?)\1(?=$|[\s([{（【])/gi,
    (_match, marker: string, url: string) => `${marker}[${url}](${url})${marker}`,
  );
}

function transformMarkdownProse(
  content: string,
  transform: (value: string) => string,
) {
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  let fence: { marker: string; length: number } | null = null;
  return lines.map((line) => {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      return line;
    }
    return fence ? line : transformOutsideInlineCode(line, transform);
  }).join('');
}

function transformOutsideInlineCode(
  value: string,
  transform: (value: string) => string,
) {
  let cursor = 0;
  let openingTicks = 0;
  let result = '';
  for (const match of value.matchAll(/`+/g)) {
    const index = match.index ?? 0;
    const segment = value.slice(cursor, index);
    result += openingTicks === 0 ? transform(segment) : segment;
    result += match[0];
    if (openingTicks === 0) openingTicks = match[0].length;
    else if (match[0].length === openingTicks) openingTicks = 0;
    cursor = index + match[0].length;
  }
  const tail = value.slice(cursor);
  return result + (openingTicks === 0 ? transform(tail) : tail);
}

export function normalizeExecutionNarrationForDisplay(
  content: string,
  executionCount: number,
) {
  if (
    executionCount < 3 ||
    content.length < 180 ||
    (content.match(/\r?\n/g)?.length ?? 0) > 1
  ) {
    return content;
  }
  return content.replace(/([。！？])(?:[ \t]+)(?=\S)/g, '$1\n\n');
}

function commandAfterShellFence(info: string) {
  const [language, ...rest] = info.split(/\s+/);
  const command = rest.join(' ').trim();
  const normalized = language.toLowerCase();
  if (!command || !shellFenceLanguages.has(normalized)) {
    return null;
  }
  return { language: normalized, command };
}

function looksLikePathFenceContent(info: string) {
  const value = stripWrappingQuotes(info);
  return isAbsoluteLocalPath(value) || isFileUri(value) || isRelativeFilePath(value);
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function isFileUri(value: string) {
  return /^file:\/\//i.test(value);
}

function isRelativeFilePath(value: string) {
  if (!value || /\s/.test(value)) {
    return false;
  }
  const normalized = value.replaceAll('\\', '/');
  const basename = normalized.split('/').pop() ?? '';
  const extension = basename.includes('.')
    ? basename.split('.').pop()?.toLowerCase() ?? ''
    : '';
  return Boolean(extension && fileLikeExtensions.has(extension));
}
