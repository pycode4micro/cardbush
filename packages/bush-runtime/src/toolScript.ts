import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';
import { returnedToolError } from '@cardbush/bush-protocol';
import { z } from 'zod';
import type { ToolRegistry, ToolHandlerContext } from './toolRegistry.js';
import type { RuntimeAsyncJobs } from './runtimeAsyncJobs.js';
import { ToolResourceScheduler } from './toolResourceScheduler.js';
import { resolveToolReferenceName, unknownToolReferenceError } from './toolReferenceNames.js';

const schema = z.object({ code: z.string().min(1).max(64000) }).strict();
export function registerToolScript(registry: ToolRegistry, jobs: RuntimeAsyncJobs) {
  registry.register({
    definition: { name: 'run_tools', description: 'Run a small JavaScript async function body to compose registered tools and filter/transform their results. Returns a task_id immediately; continue independent work and receive the result automatically, or use tasks when it is needed. Call await tools.NAME({...}) or await tools.call("NAME", {...}); return only useful JSON data. Example: const r = await tools.read_file({path:"data.json"}); return JSON.parse(r.content).slice(0,10). Promise.all supports independent calls (max 8 in flight, 32 total); dependent writes must be awaited. Tools keep their ordinary permissions, scope, hooks, resource locks and journal. MCP schemas must already be loaded. No Node, filesystem, network, timers or imports in JavaScript; use registered tools. No nested run_tools/tasks/questions/parallel_tools. CPU/memory/time limits apply. A failed or cancelled script may have completed tool actions: inspect records before rerunning.', inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'delegation', operation: 'tools.script', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    delegatesToolExecution: true, nestedCallable: false,
    decodeInput: value => schema.parse(value),
    execute: context => jobs.start(context, 'script', (signal, onHooks) => executeToolScript(context.input.code, context, registry, signal, onHooks)),
  });
}

/** QuickJS/WASM owns the guest heap. Never evaluate tool scripts in Node's realm. */
export async function executeToolScript(code: string, context: ToolHandlerContext<unknown>, registry: ToolRegistry, signal: AbortSignal, onHooks?: (messages: string[], stop?: string) => void) {
  const engine = await getQuickJS(); signal.throwIfAborted();
  const runtime = engine.newRuntime(); runtime.setMemoryLimit(32 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext(), scheduler = new ToolResourceScheduler();
  const pending = new Set<Promise<void>>(), deferred = new Set<QuickJSDeferredPromise>();
  const deadline = Date.now() + 300_000;
  let alive = true, calls = 0, failures = 0, cpu = 0, sliceDeadline = 0;
  const controller = new AbortController(), scopedSignal = AbortSignal.any([signal, controller.signal]);
  runtime.setInterruptHandler(() => scopedSignal.aborted || performance.now() >= sliceDeadline || cpu > 1000 || Date.now() > deadline);
  const runGuest = <T>(action: () => T): T => {
    const start = performance.now(); sliceDeadline = start + Math.min(250, Math.max(0, 1000 - cpu));
    try { return action(); } finally { cpu += performance.now() - start; }
  };
  const bridge = vm.newFunction('__toolCall', (nameHandle, argumentsHandle) => {
    const name = resolveToolReferenceName(vm.getString(nameHandle), context.turn), text = vm.getString(argumentsHandle);
    if (++calls > 32 || pending.size >= 8) throw new Error('Tool script limit: 32 calls total, 8 in flight.');
    if (text.length > 2 * 1024 * 1024) throw new Error('Tool arguments exceed 2 MiB.');
    const registration = registry.resolve(name);
    if (!registration) throw unknownToolReferenceError(name, 'native');
    if (registration.nestedCallable === false) throw new Error('Tool is unavailable for nested execution. Call it directly.');
    const input = JSON.parse(text), promise = vm.newPromise(); deferred.add(promise);
    const operation = (async () => {
      let envelope: unknown;
      try {
        const release = await scheduler.acquire([{ key: registration.executionChannel ?? 'runtime:default', mode: registration.parallelSafe ? 'read' : 'write' }], scopedSignal);
        try {
          const result = await context.invokeTool(name, input, { signal: scopedSignal, record: true, onHooks });
          const error = returnedToolError(name, result);
          if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details });
          envelope = { value: result };
        } finally { release(); }
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
      if (Date.now() > deadline) throw new Error('Tool script time budget exceeded. Inspect completed actions before retrying.');
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
        const timer = setTimeout(finish, Math.min(1000, deadline - Date.now()));
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
