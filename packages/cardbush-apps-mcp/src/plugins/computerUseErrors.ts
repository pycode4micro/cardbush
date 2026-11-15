const maxErrorCharacters = 1600;

export type ComputerUseExecution = 'not_dispatched' | 'dispatched' | 'unknown';
export type ComputerUseErrorCode =
  | 'user_takeover' | 'user_stopped' | 'window_changed' | 'window_unavailable'
  | 'stale_state' | 'display_changed' | 'observation_failed' | 'control_unavailable' | 'timeout'
  | 'application_control_blocked' | 'policy_blocked' | 'observation_required' | 'progress_unverified' | 'invalid_action' | 'computer_use_failed';
export interface ComputerUseFailureInfo {
  code: ComputerUseErrorCode;
  message: string;
  execution: ComputerUseExecution;
  details?: Record<string, unknown>;
}

export class ComputerUseFailure extends Error {
  readonly info: ComputerUseFailureInfo;

  constructor(code: ComputerUseErrorCode, message: string, execution: ComputerUseExecution = 'not_dispatched', details?: Record<string, unknown>) {
    super(message);
    this.name = 'ComputerUseFailure';
    this.info = { code, message, execution, ...(details ? { details } : {}) };
  }
}

/** Normalize native diagnostics while retaining dispatch uncertainty and the source of an interruption. */
export function computerUseFailure(error: unknown, execution?: ComputerUseExecution): ComputerUseFailure {
  if (error instanceof ComputerUseFailure) {
    return execution === undefined ? error : new ComputerUseFailure(error.info.code, error.message, execution, error.info.details);
  }
  const message = formatComputerUseError(error);
  let code: ComputerUseErrorCode = 'computer_use_failed';
  if (/0x8007(?:11c7|04ec|0241)\b|application\s+control\s+policy\s+has\s+blocked|blocked by group policy|应用程序控制策略.*阻止/i.test(message.replace(/\r?\n/g, ' '))) code = 'application_control_blocked';
  else if (/user.*(?:actively|taken over)|yielded.*user input/i.test(message)) code = 'user_takeover';
  else if (/stopped for this turn|ended desktop control for this turn/i.test(message)) code = 'user_stopped';
  else if (/timed out/i.test(message)) code = 'timeout';
  else if (/display layout or DPI changed|DPI changed during input|display is no longer available/i.test(message)) code = 'display_changed';
  else if (/no longer (?:available|exists)|empty bounds/i.test(message)) code = 'window_unavailable';
  else if (/foreground|bounds changed|identity changed|covered by another window|desktop changed/i.test(message)) code = 'window_changed';
  else if (/state_id|state targets|fresh target-specific observe/i.test(message)) code = 'stale_state';
  else if (/capture failed|observation was issued/i.test(message)) code = 'observation_failed';
  else if (/disabled|stopped.*loop|without visible progress|repeated preflight/i.test(message)) code = 'policy_blocked';
  else if (/already using|another.*(?:session|window)|presentation|native worker/i.test(message)) code = 'control_unavailable';
  else if (/unsupported|does not support|requires|outside/i.test(message)) code = 'invalid_action';
  return new ComputerUseFailure(code, message, execution ?? 'not_dispatched');
}

/** Keep native diagnostics, never the encoded script or PowerShell progress XML. */
export function formatComputerUseError(error: unknown): string {
  const source = error && typeof error === 'object'
    ? error as { message?: unknown; stderr?: unknown; killed?: boolean; code?: unknown }
    : {};
  if (source.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Computer Use exceeded its native output limit. The action may have partially completed.';
  }
  if (source.killed) {
    return 'Computer Use timed out. The action may have partially completed.';
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
