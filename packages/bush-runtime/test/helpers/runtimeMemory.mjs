import { dirname } from 'node:path';
import { InMemoryRuntimeHost } from '../../dist/inMemoryRuntimeHost.js';
import { IndividuationMemory } from '../../dist/individuationMemory.js';

/** Memory tests exercise the production Runtime, never a second model executor. */
export function runtimeMemory(path, provider, options = {}) {
  const runtime = new InMemoryRuntimeHost({ dataRoot: dirname(path), registerDefaultWorkspaceTools: false,
    durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    ...options, provider });
  const memory = new IndividuationMemory(path, runtime.runInternalTask.bind(runtime));
  const close = memory.close.bind(memory);
  memory.close = async () => { await close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); };
  return memory;
}
