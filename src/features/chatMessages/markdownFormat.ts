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
  return content.replace(
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
