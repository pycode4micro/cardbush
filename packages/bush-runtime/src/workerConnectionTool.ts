import { z } from 'zod';
import type { ToolRegistry } from './toolRegistry.js';
import type { RemoteSubagentBridge } from './subagentTool.js';

export function registerWorkerConnectionTool(registry: ToolRegistry, bridge?: RemoteSubagentBridge) {
  if (!bridge?.connection) return;
  const schema = z.object({ action: z.enum(['verify', 'reconnect']), connection_id: z.string().trim().min(1).max(200) }).strict();
  registry.register({
    definition: { name: 'worker_connection', description: 'Verify or reconnect a saved remote worker by connection_id from list_subagent_options. verify performs a fresh authenticated identity check. reconnect renews the host connection without restarting the remote service or its tasks. Credentials and managed tunnels stay with the host. Unverified is an on-demand state, not evidence of failure. Returns current state, check timestamps and a sanitized failure reason. Do not read credential files or guess authentication headers.', inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'delegation', operation: 'workers.connection', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    executionChannel: 'runtime:worker-connection',
    decodeInput: input => schema.parse(input),
    execute: async context => {
      context.signal?.throwIfAborted();
      return bridge.connection!({ action: context.input.action, connectionId: context.input.connection_id }, context.signal);
    },
  });
}
