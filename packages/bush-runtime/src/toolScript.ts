import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';
import { returnedToolError } from '@cardbush/bush-protocol';
import { z } from 'zod';
import type { ToolRegistry, ToolHandlerContext, ToolPermissionWaitObserver } from './toolRegistry.js';
import type { RuntimeAsyncJobs } from './runtimeAsyncJobs.js';
import { ToolResourceScheduler } from './toolResourceScheduler.js';
import { resolveToolReferenceName, unknownToolReferenceError } from './toolReferenceNames.js';
import { toolScriptInputSchema as schema } from './toolScriptSchema.js';
import { scheduledToolName, TOOL_CONCURRENCY_LIMIT, TOOL_SCRIPT_CALL_LIMIT } from './toolScheduling.js';

export function registerToolScript(registry: ToolRegistry, jobs: RuntimeAsyncJobs) {
  registry.register({
    definition: { name: 'run_tools', description: 'Compose registered tools with a small JavaScript async body in code. Returns a task_id immediately; continue independent work and receive results automatically, or use tasks. In code, await tools.NAME({...}) or tools.call("NAME", {...}); return useful JSON. Use Promise.allSettled for independent calls when partial success is useful; inspect each rejected result. Max 32 calls total, 8 admitted at once; the rest queue within the same time budget. Await dependencies. Tools keep ordinary permissions, scope, hooks, shared MCP limits, locks and journal. MCP schemas must be loaded. No Node, filesystem, network, timers or imports; use registered tools. No nested dispatchers/questions. CPU/memory/time limits apply. Failed/cancelled scripts may have completed actions; inspect records before rerunning.', inputSchema: z.toJSONSchema(schema, { io: 'input' }) },
    manifest: { effect_kind: 'delegation', operation: 'tools.script', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    delegatesToolExecution: true, nestedCallable: false,
    decodeInput: value => schema.parse(value),
    execute: async context => {
      return jobs.start(context, 'script', (signal, onHooks, onPermissionWait) => executeToolScript(context.input.code, context, registry, signal, onHooks, onPermissionWait));
    },
  });
}

/** QuickJS/WASM owns the guest heap. Never evaluate tool scripts in Node's realm. */
export async function executeToolScript(code: string, context: ToolHandlerContext<unknown>, registry: ToolRegistry, signal: AbortSignal, onHooks?: (messages: string[], stop?: string) => void, onPermissionWait?: ToolPermissionWaitObserver) {
  const engine = await getQuickJS(); signal.throwIfAborted();
  const runtime = engine.newRuntime(); runtime.setMemoryLimit(32 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext(), scheduler = new ToolResourceScheduler();
  const pending = new Set<Promise<void>>(), deferred = new Set<QuickJSDeferredPromise>();
  // Human approval is not execution time. Track the union of permission waits,
  // including delegated/parallel calls, without relaxing CPU or tool deadlines.
  let deadline = Date.now() + 300_000, approvalStarted: number | undefined;
  const approvalWaits = new Set<string>();
  const permissionWait: ToolPermissionWaitObserver = (callId, waiting) => {
    if (waiting) {
      if (!approvalWaits.size) approvalStarted = Date.now();
      approvalWaits.add(callId);
    } else if (approvalWaits.delete(callId) && !approvalWaits.size) {
      deadline += Math.max(0, Date.now() - approvalStarted!); approvalStarted = undefined;
    }
    onPermissionWait?.(callId, waiting);
  };
  const remaining = () => deadline - (approvalStarted ?? Date.now());
  let alive = true, calls = 0, failures = 0, cpu = 0, sliceDeadline = 0;
  const controller = new AbortController(), scopedSignal = AbortSignal.any([signal, controller.signal]);
  runtime.setInterruptHandler(() => scopedSignal.aborted || performance.now() >= sliceDeadline || cpu > 1000 || remaining() <= 0);
  const runGuest = <T>(action: () => T): T => {
    const start = performance.now(); sliceDeadline = start + Math.min(250, Math.max(0, 1000 - cpu));
    try { return action(); } finally { cpu += performance.now() - start; }
  };
  const bridge = vm.newFunction('__toolCall', (nameHandle, argumentsHandle) => {
    const name = resolveToolReferenceName(vm.getString(nameHandle), context.turn), text = vm.getString(argumentsHandle);
    if (++calls > TOOL_SCRIPT_CALL_LIMIT) throw new Error(`Tool script limit: ${TOOL_SCRIPT_CALL_LIMIT} calls total.`);
    if (text.length > 2 * 1024 * 1024) throw new Error('Tool arguments exceed 2 MiB.');
    const registration = registry.resolve(name);
    if (!registration) throw unknownToolReferenceError(name, 'native');
    if (registration.nestedCallable === false) throw new Error('Tool is unavailable for nested execution. Call it directly.');
    const input = JSON.parse(text), promise = vm.newPromise(); deferred.add(promise);
    const target = scheduledToolName(name, input, context.turn);
    const resources = [
      { key: 'script:slots', mode: 'read' as const, capacity: TOOL_CONCURRENCY_LIMIT },
      { key: `channel:${registry.executionChannel(target)}`, mode: registry.isParallelSafe(target) ? 'read' as const : 'write' as const },
    ];
    const operation = (async () => {
      let envelope: unknown;
      try {
        const result = await context.invokeTool(name, input, { signal: scopedSignal, record: true, onHooks, onPermissionWait: permissionWait,
          scheduling: { scheduler, resources } });
        const error = returnedToolError(name, result);
        if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details });
        envelope = { value: result };
        if (JSON.stringify(envelope).length > 8 * 1024 * 1024) throw new Error('Tool result exceeds script memory budget. Read a bounded result or its journal archive.');
      } catch (error) { failures++; envelope = { error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code, details: (error as { details?: unknown })?.details } }; }
      if (alive) {
        const handle = vm.newString(JSON.stringify(envelope));
        try { promise.resolve(handle); } finally { handle.dispose(); }
      }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
    return promise.handle;
  });
  vm.setProp(vm.global, '__toolCall', bridge); bridge.dispose();
  let script: QuickJSHandle | undefined;
  try {
    script = runGuest(() => vm.unwrapResult(vm.evalCode(`(async () => {
      const invoke = __toolCall; delete globalThis.__toolCall;
      const call = async (name, args = {}) => { const receipt = JSON.parse(await invoke(name, JSON.stringify(args))); if (receipt.error) { const error = new Error(receipt.error.message); Object.assign(error, receipt.error); throw error; } return receipt.value; };
      const tools = new Proxy(Object.freeze({call}), {get: (target, name) => name === 'call' ? call : (args) => call(String(name), args)});
      const value = await (async () => { ${code}\n })();
      return JSON.stringify(value === undefined ? null : value);
    })()`)));
    for (;;) {
      scopedSignal.throwIfAborted();
      if (remaining() <= 0) throw new Error('Tool script time budget exceeded. Inspect completed actions before retrying.');
      const jobs = runGuest(() => runtime.executePendingJobs(64));
      if (jobs.error) { const error = jobs.error.context.dump(jobs.error); jobs.error.dispose(); throw new Error(JSON.stringify(error)); }
      const state = runGuest(() => vm.getPromiseState(script!));
      if (state.type === 'rejected') { const error = vm.dump(state.error); state.error.dispose(); throw Object.assign(new Error(error.message ?? JSON.stringify(error)), { code: error.code, details: error.details }); }
      if (state.type === 'fulfilled') {
        const value = vm.getString(state.value); state.value.dispose();
        if (value.length > 2 * 1024 * 1024) throw new Error('Script output exceeds 2 MiB; return a smaller projection.');
        if (!pending.size) return { result: JSON.parse(value), calls, failed_calls: failures };
      }
      if (runtime.hasPendingJob()) { await new Promise<void>(resolve => setImmediate(resolve)); continue; }
      if (!pending.size) throw new Error('Script is awaiting a promise with no pending tool calls.');
      // Host waits happen in a background task, never on the model's dispatch path.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(scopedSignal.reason); };
        const finish = () => { clearTimeout(timer); scopedSignal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, approvalWaits.size ? 1000 : Math.min(1000, remaining()));
        scopedSignal.addEventListener('abort', abort, { once: true });
        void Promise.race(pending).then(finish, finish);
        if (scopedSignal.aborted) abort();
      });
    }
  } finally {
    alive = false; controller.abort(); script?.dispose();
    for (const promise of deferred) promise.dispose();
    vm.dispose(); runtime.dispose();
  }
}
