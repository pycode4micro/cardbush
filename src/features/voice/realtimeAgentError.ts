/** Keep execution facts distinct from the speech model's interpretation. */
export function realtimeAgentError(error: unknown) {
  const value = error && typeof error === 'object' ? error as { code?: unknown; fact?: { code?: unknown } } : {};
  const rawCode = value.fact?.code ?? value.code;
  const code = typeof rawCode === 'string' && /^[a-z0-9_]{1,100}$/.test(rawCode) ? rawCode : 'realtime_agent_failed';
  // Provider errors can contain auth headers or signed URLs. Keep a short,
  // redacted explanation; never forward stacks or structured request data.
  const message = (error instanceof Error ? error.message : '本地 Agent 调用失败。')
    .replace(/Bearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, '[service URL]')
    .slice(0, 500);
  return { status: 'error' as const, code, message,
    instruction: 'Report this specific error, not an inferred need for permission. A spoken confirmation does not fix configuration or connection errors. Do not claim acceptance or success. Check await_subagents before retrying a dispatch with an unknown outcome.' };
}
