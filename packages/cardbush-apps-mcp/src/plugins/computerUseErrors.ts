const maxErrorCharacters = 1600;

export type ComputerUseExecution = 'not_dispatched' | 'dispatched' | 'unknown';
export type ComputerUseErrorCode =
  | 'user_takeover' | 'user_stopped' | 'window_changed' | 'window_unavailable'
  | 'stale_state' | 'observation_failed' | 'control_unavailable' | 'timeout'
  | 'policy_blocked' | 'observation_required' | 'progress_unverified' | 'invalid_action' | 'computer_use_failed';
export interface ComputerUseFailureInfo {
  code: ComputerUseErrorCode;
  message: string;
  execution: ComputerUseExecution;
  recovery: string;
  details?: Record<string, unknown>;
}

const recovery: Record<ComputerUseErrorCode, string> = {
  user_takeover: 'Let the user finish, then observe once. Do not repeatedly retry or sleep-poll for control.',
  user_stopped: 'Desktop control ended for this turn. Return to the user; do not bypass the stop.',
  window_changed: 'Inspect the returned observation or observe the exact target. A foreground change alone is not user input. Do not replay an action whose execution is unknown.',
  window_unavailable: 'Discover windows and select the intended target again. Do not assume a same-process window is the same task.',
  stale_state: 'Observe the exact target again and use the new one-use state_id.',
  observation_failed: 'The action may already have run. Obtain a fresh observation before further input; do not repeat the action to recover its screenshot.',
  control_unavailable: 'Release conflicting control or report the unavailable native worker. Do not send input through another route to bypass control.',
  timeout: 'Observe the target to determine what completed before deciding whether to retry.',
  policy_blocked: 'Desktop input is blocked for this turn. Finish and return to the user; observing another window or calling finish does not reset the block.',
  observation_required: 'Let any user interaction finish, then observe the exact target once before further input.',
  progress_unverified: 'Observe the same target once and inspect the result. One different corrective action is allowed; stop if it still produces no verified progress. Do not replay input or change APIs to evade the guard.',
  invalid_action: 'Correct the action using fresh observed capabilities.',
  computer_use_failed: 'Inspect the error and obtain a fresh observation before deciding whether another action is appropriate.',
};

export class ComputerUseFailure extends Error {
  readonly info: ComputerUseFailureInfo;

  constructor(code: ComputerUseErrorCode, message: string, execution: ComputerUseExecution = 'not_dispatched', details?: Record<string, unknown>) {
    super(message);
    this.name = 'ComputerUseFailure';
    this.info = { code, message, execution, recovery: recovery[code], ...(details ? { details } : {}) };
  }
}

/** Normalize native diagnostics while retaining dispatch uncertainty and the source of an interruption. */
export function computerUseFailure(error: unknown, execution?: ComputerUseExecution): ComputerUseFailure {
  if (error instanceof ComputerUseFailure) {
    return execution === undefined ? error : new ComputerUseFailure(error.info.code, error.message, execution, error.info.details);
  }
  const message = formatComputerUseError(error);
  let code: ComputerUseErrorCode = 'computer_use_failed';
  if (/user.*(?:actively|taken over)|yielded.*user input/i.test(message)) code = 'user_takeover';
  else if (/stopped for this turn|ended desktop control for this turn/i.test(message)) code = 'user_stopped';
  else if (/timed out/i.test(message)) code = 'timeout';
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
