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

const bareLinkPunctuation = /[，。；：！？、（）【】《》〈〉「」『』〔〕［］｛｝“”‘’…]/u;

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
    (match, marker: string, url: string) => bareLinkPunctuation.test(url)
      ? match
      : `${marker}[${url}](${url})${marker}`,
  );
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

type MarkdownParser = (content: string) => MarkdownNode;

/** Apply prose boundaries only to implicit GFM links, after native Markdown parsing. */
export function remarkAutolinkBoundaries(this: { parse: MarkdownParser }) {
  const parse: MarkdownParser = (content) => this.parse(content);
  return (tree: MarkdownNode, file: { value: unknown }) => {
    let source = String(file.value);
    let parsed = tree;
    while (true) {
      const edits: Array<{ start: number; end: number; content: string }> = [];
      collectAutolinkEdits(parsed, source, parse, edits);
      if (edits.length === 0) break;
      let cursor = 0;
      const parts: string[] = [];
      for (const edit of edits) {
        parts.push(source.slice(cursor, edit.start), edit.content);
        cursor = edit.end;
      }
      source = parts.join('') + source.slice(cursor);
      // Reparse the complete source: a greedy link can consume just the opening
      // backtick/emphasis marker while its closing marker lives in another node.
      parsed = parse(source);
    }
    repairAutolinkBoundaries(parsed, source, parse);
    if (parsed !== tree) clearMarkdownPositions(parsed);
    return parsed;
  };
}

function collectAutolinkEdits(
  node: MarkdownNode,
  source: string,
  parse: MarkdownParser,
  edits: Array<{ start: number; end: number; content: string }>,
) {
  const literal = bareAutolinkLiteral(node, source);
  const boundary = literal?.search(bareLinkPunctuation) ?? -1;
  const start = node.position?.start.offset;
  if (literal && boundary > 0 && start !== undefined) {
    const prefix = literal.slice(0, boundary);
    const link = parse(prefix).children?.[0]?.children?.[0];
    const label = link?.children?.[0]?.value;
    if (link?.type === 'link' && link.url && label && prefix.startsWith(label)) {
      edits.push({
        start,
        end: start + label.length,
        content: explicitMarkdownLink(label, link.url),
      });
    }
  }
  if (node.type !== 'link' && node.type !== 'linkReference') {
    node.children?.forEach((child) => collectAutolinkEdits(child, source, parse, edits));
  }
}

function explicitMarkdownLink(label: string, url: string) {
  const escapeEntities = (value: string) => value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const text = escapeEntities(label.replace(/[\\`*_[\]]/g, '\\$&'));
  const destination = escapeEntities(url.replaceAll('\\', '\\\\'));
  return `[${text}](<${destination}>)`;
}

function repairAutolinkBoundaries(
  node: MarkdownNode,
  source: string,
  parse: MarkdownParser,
) {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  node.children = node.children.flatMap((child) => {
    const literal = bareAutolinkLiteral(child, source);
    const boundary = literal?.search(bareLinkPunctuation) ?? -1;
    if (literal && boundary > 0) {
      // GFM's fallback (notably www after CJK punctuation) can create links with
      // no source offsets. Keep that repair in the AST instead of guessing a range.
      return [literal.slice(0, boundary), literal.slice(boundary)].flatMap((part) => {
        const parsed = parse(part);
        repairAutolinkBoundaries(parsed, part, parse);
        const paragraph = parsed.children?.[0];
        if (parsed.children?.length !== 1 || paragraph?.type !== 'paragraph') {
          return [{ type: 'text', value: part }];
        }
        // Fragment offsets do not refer to the original message.
        clearMarkdownPositions(paragraph);
        return paragraph.children ?? [];
      });
    }
    repairAutolinkBoundaries(child, source, parse);
    return [child];
  });
}

function bareAutolinkLiteral(node: MarkdownNode, source: string) {
  const label = node.children?.[0];
  if (node.type !== 'link' || node.children?.length !== 1 || label?.type !== 'text') {
    return null;
  }
  const value = label.value ?? '';
  if (!/^(?:https?:\/\/|www\.)/i.test(value) ||
    (node.url !== value && node.url !== `http://${value}`)) return null;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  // Explicit [label](url) and <url> syntax owns its full destination, even when
  // it contains punctuation. GFM's fallback-generated links have no positions.
  if (start !== undefined && end !== undefined && source.slice(start, end) !== value) {
    return null;
  }
  return value;
}

function clearMarkdownPositions(node: MarkdownNode) {
  delete node.position;
  node.children?.forEach(clearMarkdownPositions);
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
