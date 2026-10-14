export type FilePatch = { kind: 'add' | 'update' | 'delete'; path: string; moveTo?: string; lines: string[] };

/** Codex-style patch envelope; exact contexts, no fuzzy or partial application. */
export function parseWorkspacePatch(text: string): FilePatch[] {
  if (text.length > 2 * 1024 * 1024) throw new Error('Patch exceeds 2 MiB. Split it into related batches.');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Use *** Begin Patch and *** End Patch.');
  const files: FilePatch[] = [];
  for (let i = 0; i < lines.length;) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw new Error('Expected *** Add/Update/Delete File: path.');
    const kind = header[1]!.toLowerCase() as FilePatch['kind'], path = header[2]!.trim();
    if (!path || path.includes('\0')) throw new Error('Invalid patch path.');
    const file: FilePatch = { kind, path, lines: [] };
    if (lines[i]?.startsWith('*** Move to: ')) { file.moveTo = lines[i++]!.slice(13).trim(); if (kind !== 'update' || !file.moveTo) throw new Error('Move to requires an update and a target path.'); }
    while (i < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i]!)) file.lines.push(lines[i++]!);
    if (kind === 'delete' && file.lines.length) throw new Error('Delete File has no body.');
    if (kind === 'add' && file.lines.some(line => !line.startsWith('+'))) throw new Error('Prefix every added line with +.');
    files.push(file);
  }
  if (!files.length || files.length > 64) throw new Error('A patch must contain 1–64 files.');
  return files;
}

export function applyFilePatch(file: FilePatch, before: string): string {
  if (file.kind === 'add') return file.lines.map(line => line.slice(1)).join('\n') + (file.lines.length ? '\n' : '');
  if (file.kind === 'delete') return '';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const original = before.replace(/\r\n/g, '\n').split('\n');
  const trailing = original.at(-1) === ''; if (trailing) original.pop();
  const output: string[] = []; let cursor = 0, i = 0;
  while (i < file.lines.length) {
    const header = file.lines[i++]!;
    if (!header.startsWith('@@')) throw new Error('Update hunks must start with @@ and exact context.');
    const anchor = header.slice(2).trim();
    const removed: string[] = [], added: string[] = []; let atEnd = false;
    while (i < file.lines.length && !file.lines[i]!.startsWith('@@')) {
      const line = file.lines[i++]!;
      if (line === '*** End of File') { atEnd = true; if (i !== file.lines.length) throw new Error('End of File must finish the update.'); break; }
      if (line.startsWith(' ') || line === '') { removed.push(line.slice(1)); added.push(line.slice(1)); }
      else if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
      else throw new Error('Hunk lines must start with space, + or -.');
    }
    let searchStart = cursor;
    if (anchor && !/^[-+]\d/.test(anchor)) {
      const matches = original.map((line, index) => line.trim() === anchor && index >= cursor ? index : -1).filter(index => index >= 0);
      if (matches.length !== 1) throw new Error(`Patch anchor is missing or ambiguous: ${anchor}`);
      searchStart = matches[0]!;
    }
    const matches: number[] = [];
    for (let start = searchStart; start <= original.length - removed.length; start++) {
      if (atEnd && start + removed.length !== original.length) continue;
      if (removed.every((line, index) => original[start + index] === line)) matches.push(start);
    }
    if (!removed.length && original.length && !atEnd) throw new Error('An insertion into an existing file requires context or End of File.');
    if (matches.length !== 1) throw new Error(`Patch context for ${file.path} is missing or ambiguous; read the current file and supply more exact context.`);
    output.push(...original.slice(cursor, matches[0]), ...added); cursor = matches[0]! + removed.length;
  }
  if (!file.lines.length && !file.moveTo) throw new Error('Update contains no hunks.');
  output.push(...original.slice(cursor));
  return output.join(eol) + (trailing || !before && output.length ? eol : '');
}
