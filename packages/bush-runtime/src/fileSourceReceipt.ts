/** Decode only host-owned text envelopes. Callers must first check the native
 * tool identity; arbitrary MCP data is not a file observation. */
export function decodeFileSourceReceipt(text: string) {
  let locator: string | undefined, truncated = false;
  for (let depth = 0; depth < 3; depth++) {
    let data: any;
    try { data = JSON.parse(text); } catch { /* Text fields follow a JSON header. */ }
    if (data?.archived === true && typeof data.locator === 'string') {
      locator = data.locator; truncated = true;
      text = typeof data.preview === 'string' ? data.preview : '';
      continue;
    }
    const boundary = text.indexOf('\n\n');
    if (data === undefined && boundary >= 0) {
      try { data = JSON.parse(text.slice(0, boundary)); } catch { return; }
      if (data?.archived === true && data.format === 'text' && typeof data.locator === 'string') {
        locator = data.locator; truncated = true; text = text.slice(boundary + 2); continue;
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.isError || data.ok === false) return;
    const field = typeof data.instructions === 'string' || text.slice(boundary + 2).startsWith('[instructions]\n')
      ? 'instructions' : 'content';
    const marker = `\n\n[${field}]\n`;
    const offset = text.indexOf(marker);
    const content = offset >= 0 ? text.slice(offset + marker.length) : data[field];
    if (typeof content !== 'string' && data.unread !== true && data.source_read?.unread !== true) return;
    return { data, content: typeof content === 'string' ? content : '', truncated, locator };
  }
}

export interface FileSourceSpan { offset: number; length: number; start_line: number }

/** Even when no source text fits, keep its version and an explicit unread
 * observation inside the ordinary archive receipt. The ingress allocator
 * counts this minimum; it never needs to restore the omitted file body. */
export function projectFileSourceResult(value: unknown, maxChars: number): string | undefined {
  const result = value as Record<string, any> | null;
  if (!result || typeof result !== 'object') return;
  const source = result.source_read ?? result;
  if (typeof source.path !== 'string' || typeof source.sha256 !== 'string') return;
  const field = result.source_read ? 'instructions' : 'content';
  if (typeof result[field] !== 'string') return;
  const { [field]: content, ...metadata } = result.source_read
    ? { source_read: source, instructions: result.instructions } : result;
  const header = JSON.stringify(metadata) + `\n\n[${field}]\n`;
  if (maxChars > header.length) {
    let prefix = content.slice(0, maxChars - header.length);
    if (prefix.length < content.length && /[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return header + prefix;
  }
  const minimum = { path: source.path, sha256: source.sha256, start_line: source.start_line ?? 1, unread: true };
  return JSON.stringify(result.source_read ? { source_read: minimum } : minimum);
}

export function withFileSourceLocator(text: string, locator: string): string {
  const boundary = text.indexOf('\n\n');
  try {
    const header = JSON.parse(boundary < 0 ? text : text.slice(0, boundary));
    if (header && typeof header === 'object' && !Array.isArray(header) && (header.path || header.source_read)) {
      return JSON.stringify({ ...header, source_locator: locator }) + (boundary < 0 ? '' : text.slice(boundary));
    }
  } catch { /* Unstructured legacy/forked results are not file observations. */ }
  return text;
}

/** Select literal, complete source lines from a rendered command. Expansions,
 * dynamic output and host activation text are not claimed as file reads. */
export function literalSourceSpans(source: string, sourceOffset: number, startLine: number,
  renderedOffset: number, transform: (text: string) => string, wholeSource: string): FileSourceSpan[] {
  const spans: FileSourceSpan[] = [];
  let offset = 0, output = renderedOffset;
  let lineNumber = startLine + (wholeSource.slice(0, sourceOffset).match(/\r\n|\r|\n/g)?.length ?? 0);
  for (const line of source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []) {
    const rendered = transform(line);
    const absolute = sourceOffset + offset;
    const atStart = absolute === 0 || /[\r\n]/.test(wholeSource[absolute - 1]!);
    const atEnd = /[\r\n]$/.test(line) || absolute + line.length === wholeSource.length;
    if (atStart && atEnd && line === rendered) {
      const previous = spans.at(-1);
      if (previous && previous.offset + previous.length === output) previous.length += line.length;
      else spans.push({ offset: output, length: line.length, start_line: lineNumber });
    }
    output += rendered.length; offset += line.length;
    if (/[\r\n]$/.test(line)) lineNumber++;
  }
  return spans;
}
