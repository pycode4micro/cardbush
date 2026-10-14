import { applyFilePatch, parseWorkspacePatch } from '@cardbush/bush-protocol';

export type FileEditPreview = { source: string; cursor: number };
type Fields = { values: Record<string, string | number | boolean>; complete: Set<string> };
/** Decode a flat JSON prefix without guessing unfinished escapes, field names or numbers. */
export function partialEditInput(input: string): Fields | undefined {
  let i = 0;
  const ws = () => { while (/\s/.test(input[i] ?? '') && i < input.length) i++; };
  const string = (): { value: string; complete: boolean } | undefined => {
    if (input[i++] !== '"') return;
    let value = '';
    while (i < input.length) {
      const char = input[i++];
      if (char === '"') return { value, complete: true };
      if (char.charCodeAt(0) < 32) return;
      if (char !== '\\') { value += char; continue; }
      if (i === input.length) break;
      const escape = input[i++], escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape === 'u') {
        if (input.length - i < 4) break;
        const hex = input.slice(i, i + 4); if (!/^[a-f0-9]{4}$/i.test(hex)) return;
        value += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else if (escape in escapes) value += escapes[escape]; else return;
    }
    return { value: value.replace(/[\uD800-\uDBFF]$/, ''), complete: false };
  };
  ws(); if (input[i++] !== '{') return;
  const result: Fields = { values: Object.create(null), complete: new Set() };
  while (i < input.length) {
    ws(); if (input[i] === '}') return result;
    if (input[i] !== '"') return i === input.length ? result : undefined;
    const key = string(); if (!key) return; if (!key.complete) return result;
    if (Object.hasOwn(result.values, key.value)) return;
    ws(); if (i === input.length) return result; if (input[i++] !== ':') return;
    ws(); if (i === input.length) return result;
    if (input[i] === '"') {
      const value = string(); if (!value) return;
      result.values[key.value] = value.value;
      if (!value.complete) return result;
    } else {
      const start = i; while (i < input.length && !/[,}\s]/.test(input[i])) i++;
      if (i === input.length) return result;
      const token = input.slice(start, i);
      if (/^(true|false)$/.test(token)) result.values[key.value] = token === 'true';
      else if (/^-?\d+$/.test(token)) result.values[key.value] = Number(token); else return;
    }
    result.complete.add(key.value); ws();
    if (i === input.length || input[i] === '}') return result;
    if (input[i++] !== ',') return;
  }
  return result;
}

export function previewPath(path: string, root: string) {
  if (!path || path.includes('\0') || /^[a-z][a-z0-9+.-]+:\/\//i.test(path)) return '';
  let value = path.replaceAll('\\', '/');
  if (!/^(?:[a-z]:\/|\/)/i.test(value)) value = `${root.replaceAll('\\', '/')}/${value}`;
  const prefix = value.startsWith('//') ? '//' : value.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of value.split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
  value = prefix + parts.join('/');
  return /^[a-z]:/i.test(value) || prefix === '//' ? value.toLowerCase() : value;
}

export function changedRange(before: string, after: string) {
  let start = 0, end = after.length, oldEnd = before.length;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end > start && oldEnd > start && before[oldEnd - 1] === after[end - 1]) { oldEnd--; end--; }
  return { start, end, oldEnd };
}

export function previewFileEdit(tool: string, input: string, base: string, path: string, root: string): FileEditPreview | undefined {
  if (input.length > 2 * 1024 * 1024 || !/\.(?:md|markdown)$/i.test(path)) return;
  const fields = partialEditInput(input); if (!fields) return;
  const { values: value, complete } = fields;
  if (value.encoding !== undefined && !['utf8', 'utf-8'].includes(String(value.encoding).toLowerCase())) return;
  if (tool === 'apply_patch') {
    if (typeof value.patch !== 'string') return;
    let patch = value.patch.replace(/\r\n/g, '\n');
    // Incomplete control/context/removal lines cannot yet identify a safe target.
    // A partial added line can be shown once its preceding context is unique.
    if (!complete.has('patch') && !patch.endsWith('\n') && !patch.slice(patch.lastIndexOf('\n') + 1).startsWith('+')) patch = patch.slice(0, patch.lastIndexOf('\n') + 1);
    if (!patch.trimEnd().endsWith('*** End Patch')) patch = patch.replace(/\n$/, '') + '\n*** End Patch';
    try {
      const files = parseWorkspacePatch(patch).filter(file => previewPath(file.path, root) === previewPath(path, root));
      if (files.length !== 1 || files[0].kind === 'delete' || files[0].moveTo) return;
      const source = applyFilePatch(files[0], base);
      return { source, cursor: changedRange(base, source).end };
    } catch { return; }
  }
  if (!complete.has('path') || previewPath(String(value.path), root) !== previewPath(path, root)) return;
  if (tool === 'write_file' && typeof value.content === 'string') return { source: value.content, cursor: value.content.length };
  if (tool !== 'edit_file' || typeof value.new_text !== 'string') return;
  const replacement = value.new_text;
  if (complete.has('old_text') && typeof value.old_text === 'string' && value.old_text) {
    if (value.start_line !== undefined || value.end_line !== undefined) return;
    const start = base.indexOf(value.old_text); if (start < 0) return;
    const multiple = base.indexOf(value.old_text, start + value.old_text.length) >= 0;
    if (multiple && value.replace_all !== true) return;
    return { source: value.replace_all === true ? base.replaceAll(value.old_text, () => replacement) : base.slice(0, start) + replacement + base.slice(start + value.old_text.length), cursor: start + replacement.length };
  }
  if (value.old_text !== undefined || !complete.has('start_line') || !complete.has('end_line') || !complete.has('expected_sha256')) return;
  const start = Number(value.start_line), end = Number(value.end_line), lines = base.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length || !/^[a-f0-9]{64}$/i.test(String(value.expected_sha256))) return;
  const prefix = lines.slice(0, start - 1).join('');
  return { source: prefix + replacement + lines.slice(end).join(''), cursor: prefix.length + replacement.length };
}
