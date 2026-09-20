const maxErrorCharacters = 1600;

/** Keep native diagnostics, never the encoded script or PowerShell progress XML. */
export function formatComputerUseError(error: unknown): string {
  const source = error && typeof error === 'object'
    ? error as { message?: unknown; stderr?: unknown; killed?: boolean; code?: unknown }
    : {};
  if (source.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Computer Use exceeded its native output limit. The action may have partially completed; observe the target before retrying.';
  }
  if (source.killed) {
    return 'Computer Use timed out. The action may have partially completed; observe the target before deciding whether to retry.';
  }
  const message = typeof source.message === 'string' ? source.message : String(error);
  const stderr = typeof source.stderr === 'string' ? source.stderr
    : Buffer.isBuffer(source.stderr) ? source.stderr.toString('utf8') : '';
  let diagnostic = stderr.trim() || message;
  if (diagnostic.includes('#< CLIXML') || /<Objs\b/.test(diagnostic)) {
    const errors = [...diagnostic.matchAll(/<S\b[^>]*\bS=["']Error["'][^>]*>([\s\S]*?)<\/S>/g)];
    diagnostic = errors.length
      ? errors.map((match) => decodePowerShellXml(match[1]!)).join('')
      : diagnostic.split(/#< CLIXML|<Objs\b/)[0] ?? '';
  }
  diagnostic = diagnostic
    .replace(/^Command failed:[^\r\n]*(?:\r?\n|$)/gm, '')
    .replace(/-EncodedCommand\s+\S+/gi, '-EncodedCommand [omitted]')
    .replace(/[A-Za-z0-9+/=]{200,}/g, '[encoded data omitted]');
  const lines: string[] = [];
  for (const rawLine of diagnostic.split(/\r?\n/)) {
    const line = rawLine.trim();
    // PowerShell wraps FullyQualifiedErrorId across lines. Stop at the diagnostic
    // footer instead of leaking its unlabelled continuation back into the error.
    if (/^(?:\+|~|At line:|所在位置|CategoryInfo\s*:|FullyQualifiedErrorId\s*:)/i.test(line)) break;
    if (line) lines.push(line);
  }
  const result = [...new Set(lines)].join('\n').trim() || 'Computer Use could not complete the native command. Observe the target before retrying.';
  return result.length > maxErrorCharacters ? `${result.slice(0, maxErrorCharacters - 1)}…` : result;
}

function decodePowerShellXml(value: string): string {
  return value.replace(/&(?:lt|gt|amp|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const hex = entity.startsWith('&#x');
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
