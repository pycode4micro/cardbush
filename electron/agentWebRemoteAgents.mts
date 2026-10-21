/** Private account-bound gateway bridge. No registry or local Agent provisioning
 * exists in the tenant, and remote credentials never enter the runtime worker. */
export async function callWebRemoteAgent(configuration: { gateway: string; credential: string } | undefined,
  operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!configuration) { if (operation === 'agents.list') return []; throw new Error('No remote Agents are configured.'); }
  const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let idle = setTimeout(() => abort.abort(), 45_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(configuration.gateway, { method: 'POST', redirect: 'error', signal: combined,
      headers: { Authorization: `Bearer ${configuration.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, input }) });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? 'Remote Agent request failed.');
    }
    if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) return await response.json();
    reader = response.body!.getReader();
    let pending = ''; const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Remote Agent result stream disconnected.');
      clearTimeout(idle); idle = setTimeout(() => abort.abort(), 45_000);
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 8 * 1024 * 1024) throw new Error('Remote Agent result is too large.');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as { type: string; value?: unknown; error?: string };
        if (frame.type === 'result') return frame.value;
        if (frame.type === 'error') throw new Error(frame.error ?? 'Remote Agent failed.');
        if (frame.type !== 'heartbeat') throw new Error('Invalid remote Agent stream.');
      }
    }
  } finally { clearTimeout(idle); await reader?.cancel().catch(() => {}); abort.abort(); }
}
