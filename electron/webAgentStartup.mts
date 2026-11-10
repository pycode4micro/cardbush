import { setTimeout as pause } from 'node:timers/promises';

export const WEB_AGENT_STARTUP_MS = 60_000;
export const WEB_AGENT_PROBE_MS = 2500;
export class WebAgentStartupError extends Error {
  constructor(readonly code: string) { super(code); }
}
export async function waitForWebAgent(
  client: { info(signal?: AbortSignal): Promise<{ capabilities: Record<string, unknown> }> },
  deadline: AbortSignal,
  status?: (signal: AbortSignal) => Promise<{ state?: string; code?: string }>,
  probeMs = WEB_AGENT_PROBE_MS,
) {
  while (!deadline.aborted) {
    try {
      const info = await client.info(AbortSignal.any([deadline, AbortSignal.timeout(probeMs)]));
      if (info.capabilities.webRestricted !== true || info.capabilities.webRemoteAgents !== true) {
        throw new WebAgentStartupError('SESSION_AGENT_POLICY_NOT_READY');
      }
      return info;
    } catch (error) {
      if (error instanceof WebAgentStartupError) throw error;
      if (deadline.aborted) break;
      const state = await status?.(AbortSignal.any([deadline, AbortSignal.timeout(probeMs)])).catch(() => undefined);
      if (state?.state === 'failed') throw new WebAgentStartupError(state.code || 'SESSION_AGENT_START_FAILED');
      try { await pause(500, undefined, { signal: deadline }); } catch { break; }
    }
  }
  throw new WebAgentStartupError('SESSION_AGENT_START_TIMEOUT');
}
