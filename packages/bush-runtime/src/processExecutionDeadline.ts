import type { GuardedProcess } from './processResourceGuard.js';

/** Command budgets exclude bounded sandbox setup and revocation. A preparation
 * failure must not masquerade as a slow search or a slow file read. */
export function processExecutionDeadline(process: Pick<GuardedProcess, 'phase'>, timeoutMs: number,
  expired: (error: Error & { code: string }) => void) {
  let phase = process.phase?.() ?? 'executing', started = Date.now();
  const timer = setInterval(() => {
    const current = process.phase?.() ?? 'executing';
    if (current !== phase) { phase = current; started = Date.now(); }
    const limit = phase === 'executing' ? timeoutMs : 120_000;
    if (Date.now() - started < limit) return;
    clearInterval(timer);
    const code = phase === 'executing' ? 'process_timeout' : phase === 'preparing_sandbox' ? 'sandbox_setup_timeout' : 'sandbox_cleanup_timeout';
    expired(Object.assign(Error(`${phase} timed out after ${limit} ms.`), { code }));
  }, Math.min(50, timeoutMs));
  timer.unref();
  return () => clearInterval(timer);
}
