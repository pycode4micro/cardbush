import { z } from 'zod';
import type { ToolHandlerContext, ToolRegistry } from './toolRegistry.js';
import { briefText, projectCatalogPage } from './catalogPage.js';

export interface RuntimeTaskHandle {
  task_id: string;
  aliases?: string[];
  kind: 'terminal' | 'subagent' | 'team' | 'mcp' | 'question' | 'script';
  status: string;
  revision: string;
  summary?: string;
  result?: unknown;
  readResult?: () => Promise<unknown>;
  wait?: (signal: AbortSignal) => Promise<unknown>;
  stop?: (context: ToolHandlerContext<unknown>) => Promise<unknown>;
  cancelObservation?: () => void;
}
export type TaskSource = (context: ToolHandlerContext<unknown>) => Promise<RuntimeTaskHandle[]> | RuntimeTaskHandle[];
export const taskPending = (task: RuntimeTaskHandle) => ['running', 'pending', 'waiting_user', 'stopping'].includes(task.status);
const schema = z.object({
  action: z.enum(['list', 'inspect', 'wait', 'stop', 'cancel_observation']).default('list'),
  task_ids: z.array(z.string().min(1)).min(1).max(32).optional(),
  mode: z.enum(['any', 'all']).default('any'),
  yield_time_ms: z.number().int().min(0).max(30_000).default(1000),
  after: z.record(z.string(), z.string()).refine(value => Object.keys(value).length <= 32).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32).default(20),
}).strict();

/** A facade over existing executors; never creates a second task lifecycle. */
export class RuntimeTaskTools {
  private readonly sources: TaskSource[] = [];
  constructor(private readonly waitForWork: (context: ToolHandlerContext<unknown>, promises: Promise<unknown>[], mode: 'any' | 'all', signal: AbortSignal, duration: number) => Promise<string>) {}
  addSource(source: TaskSource) { this.sources.push(source); }
  async snapshot(context: ToolHandlerContext<unknown>) {
    const results = await Promise.allSettled(this.sources.map(async source => {
      const observer = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, observer.signal]) : observer.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => source({ ...context, signal })),
          new Promise<RuntimeTaskHandle[]>((_, reject) => { timer = setTimeout(() => {
            observer.abort(); reject(new Error('Task status source timed out; underlying tasks may still be running.'));
          }, 1000); }),
        ]);
      } finally { clearTimeout(timer); }
    }));
    context.signal?.throwIfAborted();
    const handles = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    return { handles: [...new Map(handles.map(task => [task.task_id, task])).values()].sort((a, b) => Number(taskPending(b)) - Number(taskPending(a))),
      unavailable_sources: results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []) };
  }
  register(registry: ToolRegistry) {
    registry.register({
      definition: { name: 'tasks', description: 'Manage terminal, subagent, Team, MCP, question and script tasks. list returns handles; inspect reads results. wait wakes on any/all completion, user guidance or yield_time_ms (default 1000; 0=snapshot). Continue independent work first; do not poll or restart pending tasks. Pass after revisions to omit unchanged results. inspect/stop/cancel_observation require task_ids. stop uses the normal executor/permissions; cancel_observation only removes a completion subscription. Wait timeout/cancellation never stops tasks.', inputSchema: z.toJSONSchema(schema) },
      manifest: { effect_kind: 'delegation', operation: 'tasks.manage', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
      delegatesToolExecution: true, nestedCallable: false, executionChannel: 'runtime:tasks',
      projectModelPage: (value, budget) => projectCatalogPage(value, budget, ['tasks'], 'total', page => ({ ...page,
        after: Object.fromEntries((page.tasks as RuntimeTaskHandle[]).map(task => [task.task_id, task.revision])) })),
      decodeInput: value => schema.parse(value), execute: async context => {
        const input = context.input;
        if (['inspect', 'stop', 'cancel_observation'].includes(input.action) && !input.task_ids) throw new Error('Explicit task_ids are required for this action.');
        let snapshot = await this.snapshot(context);
        const all = snapshot.handles;
        const select = (items: RuntimeTaskHandle[], ids: string[]) => [...new Set(ids.map(id => {
          const task = items.find(item => item.task_id === id || item.aliases?.includes(id));
          if (!task) throw new Error(`Task ${id} is not available in this conversation. Use tasks list to inspect existing handles.`);
          return task;
        }))];
        let selected = input.task_ids ? select(all, input.task_ids) : input.action === 'wait' ? all.filter(taskPending).slice(0, 32) : all.slice(input.offset, input.offset + input.limit);
        // Validate the entire selection before dispatching any controls.
        if (input.action === 'stop' && selected.some(task => !task.stop)) throw new Error('One or more selected tasks do not support stopping. No stop was dispatched.');
        if (input.action === 'cancel_observation' && selected.some(task => !task.cancelObservation)) throw new Error('One or more tasks have no cancellable subscription. No subscription was cancelled.');
        const controls: unknown[] = [];
        if (input.action === 'stop') for (const task of selected) controls.push({ task_id: task.task_id, result: await task.stop!(context) });
        if (input.action === 'cancel_observation') selected.forEach(task => task.cancelObservation!());
        let wake: string | undefined;
        if (input.action === 'wait') {
          const pending = selected.filter(taskPending), observedCompletion = selected.some(task => !taskPending(task) && input.after?.[task.task_id] !== task.revision);
          if (!pending.length || input.mode === 'any' && observedCompletion) wake = selected.length ? 'task_completed' : 'no_pending_tasks';
          else if (input.yield_time_ms === 0) wake = 'snapshot';
          else {
            const waiting = new AbortController();
            const signal = context.signal ? AbortSignal.any([context.signal, waiting.signal]) : waiting.signal;
            const promises = pending.map(task => task.wait ? task.wait(signal) : new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
            // Guidance can return before the waiter subscribes. Cleanup rejections
            // must still be observed without changing the original promises.
            for (const promise of promises) void promise.catch(() => {});
            try { wake = await this.waitForWork(context, promises, input.mode, signal, input.yield_time_ms); }
            finally { waiting.abort(); }
          }
        }
        if (input.action !== 'list') { snapshot = await this.snapshot(context); selected = select(snapshot.handles, selected.map(task => task.task_id)); }
        return { ...(wake ? { wake_reason: wake } : {}), ...(controls.length ? { controls } : {}),
          ...(snapshot.unavailable_sources.length ? { complete: false, unavailable_sources: snapshot.unavailable_sources, note: 'Unavailable sources do not prove tasks ended or never started. Inspect the original handles before retrying.' } : {}),
          ...(input.action === 'wait' && !input.task_ids && all.filter(taskPending).length > selected.length ? { selection_limited: true, pending_count: snapshot.handles.filter(taskPending).length } : {}),
          ...(input.action === 'list' && !input.task_ids ? { total: all.length, offset: input.offset, next_offset: input.offset + selected.length < all.length ? input.offset + selected.length : null } : {}),
          tasks: await Promise.all(selected.map(async ({ task_id, kind, status, revision, summary, result, readResult, stop, cancelObservation }) => {
            const unchanged = input.after?.[task_id] === revision;
            const value = !unchanged && input.action !== 'list' ? readResult ? await readResult() : result : undefined;
            return { task_id, kind, status, revision, ...(summary ? { summary: input.action === 'list' ? briefText(summary) : summary } : {}),
              ...(unchanged ? { unchanged: true } : value !== undefined ? { result: value } : {}),
              controls: { stop: !!stop, cancel_observation: !!cancelObservation } };
          })),
          after: Object.fromEntries(selected.map(task => [task.task_id, task.revision])),
          ...(selected.some(taskPending) ? { next_step: 'Continue independent work. Pending tasks are still running; waiting does not restart or stop them.' } : {}),
        };
      },
    });
  }
}
