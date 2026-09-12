import { isAbsoluteLocalPath, stripWrappingQuotes } from './localPaths';
import { truncateText } from './text';

/** Plain text for compact titles; never render links or load their destinations. */
export function conversationDisplayTitle(value: string): string {
  const parts: string[] = [];
  // Keep code and escaped brackets literal. Link labels may contain escaped brackets.
  const tokens = /(`+)[\s\S]*?\1(?!`)|\\[^\r\n]|!?\[((?:\\.|[^\]\\\r\n])*)\]\(/g;
  let cursor = 0;
  for (const match of value.matchAll(tokens)) {
    if (match.index < cursor || match[2] === undefined) continue;
    const start = match.index + match[0].length;
    let end = linkDestinationEnd(value, start);
    if (end === -1) {
      // Older auto-titles were truncated inside the destination. Recover the
      // complete label without displaying the saved path fragment.
      const tail = value.slice(start);
      if (!/(?:…|\.{3})$/.test(tail) ||
        !/^(?:<|[A-Za-z]:[\\/]|\/|https?:|file:|cardbush-reference:)/i.test(tail)) continue;
      end = value.length;
    }
    let label = match[2].replace(/\\([\\[\]`*_])/g, '$1');
    if (/^\$[A-Za-z][\w.:-]*$/.test(label)) label = label.slice(1);
    if (value.slice(start).startsWith('cardbush-reference:') && label.startsWith('@')) label = label.slice(1);
    parts.push(value.slice(cursor, match.index), label);
    cursor = end;
  }
  parts.push(value.slice(cursor));
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Resolve references before truncating, consistently for live and restored chats. */
export function conversationTitleFromUserText(value: string): string {
  const readable = value.split(/\r?\n/).map(line => line.trim()).filter(line => {
    if (!line) return false;
    if (/^\/(?:model|goal|skill|new)(?:\s|$)/i.test(line)) return true;
    const path = stripWrappingQuotes(line.startsWith('@') ? line.slice(1).trim() : line);
    return !isAbsoluteLocalPath(path);
  }).join(' ');
  return truncateText(conversationDisplayTitle(readable || value), 48);
}

function linkDestinationEnd(value: string, start: number): number {
  let depth = 1;
  let angle = false;
  let quote = '';
  for (let index = start; index < value.length; index++) {
    const char = value[index];
    if (char === '\\') { index++; continue; }
    if (char === '\n' || char === '\r') return -1;
    if (angle) {
      if (char === '>') angle = false;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '<') {
      angle = true;
    } else if ((char === '"' || char === "'") && /\s/.test(value[index - 1])) {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && --depth === 0) {
      return index + 1;
    }
  }
  return -1;
}
