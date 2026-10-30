import { TASK_WAIT_MAX_MS, TASK_BATCH_LIMIT, TASK_PAGE_DEFAULT } from './taskLimits.js';
import type { RuntimeTaskProgress } from './runtimeTaskProgress.js';
import { TEAM_WORKFLOW_MAX_NODES } from '@cardbush/bush-protocol';
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
  progress?: RuntimeTaskProgress;
  readProgress?: () => RuntimeTaskProgress | undefined;
  result?: unknown;
  readResult?: (nodeIds?: string[]) => Promise<unknown>;
  readConversation?: (context: ToolHandlerContext<unknown>, cursor?: string, nodeIds?: string[]) => Promise<unknown>;
  wait?: (signal: AbortSignal) => Promise<unknown>;
  stop?: (context: ToolHandlerContext<unknown>) => Promise<unknown>;
  cancelObservation?: () => void;
}
export type TaskSource = (context: ToolHandlerContext<unknown>) => Promise<RuntimeTaskHandle[]> | RuntimeTaskHandle[];
export const taskPending = (task: RuntimeTaskHandle) => ['running', 'pending', 'waiting_user', 'stopping'].includes(task.status);
const schema = z.object({
  action: z.enum(['list', 'inspect', 'conversation', 'wait', 'stop', 'cancel_observation']).default('list'),
  cursor: z.string().regex(/^\d+:\d+$/).optional(),
  node_ids: z.array(z.string().trim().min(1)).min(1).max(TEAM_WORKFLOW_MAX_NODES).refine(ids => new Set(ids).size === ids.length, 'node_ids must be unique').optional().describe('Selected node outputs from one Team run for inspect/wait; omit for final outputs. conversation requires exactly one node ID from that run.'),
  task_ids: z.array(z.string().min(1)).min(1).max(TASK_BATCH_LIMIT).optional().describe('Existing task_id handles from tasks list or launch results (subagent taskId, team task_id/run_id). Employee IDs, workflow definition IDs, node IDs and chat session IDs are not task handles.'),
  mode: z.enum(['any', 'all']).default('any'),
  yield_time_ms: z.number().int().min(0).max(TASK_WAIT_MAX_MS).optional().describe('Omit to wait until completion or new guidance, without periodic model wakeups. 0 reads a snapshot; a positive value explicitly requests a timeout. Cancellation stops observation only.'),
  after: z.record(z.string(), z.string()).refine(value => Object.keys(value).length <= TASK_BATCH_LIMIT).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(TASK_BATCH_LIMIT).default(TASK_PAGE_DEFAULT),
}).strict();

/** A facade over existing executors; never creates a second task lifecycle. */
export class RuntimeTaskTools {
  private readonly sources: TaskSource[] = [];
  constructor(private readonly waitForWork: (context: ToolHandlerContext<unknown>, promises: Promise<unknown>[], mode: 'any' | 'all', signal: AbortSignal, duration?: number) => Promise<string>) {}
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
      definition: { name: 'tasks', description: 'Observe or control existing terminal, subagent, team, MCP, script and question tasks in this conversation. Creates no work: subagent dispatches/follows up on individual children; team starts/resumes saved dependency workflows. list returns task handles; inspect reads results; conversation reads one owned child’s ordered inputs and final answers (one task_ids entry; for Team runs also select exactly one node_ids entry; follow nextCursor). Private reasoning and tool contents are excluded. Local child progress reports phase, last activity and counts. wait defaults to staying asleep until any/all completion or user/peer guidance; omit yield_time_ms while blocked. Use 0 for a snapshot or a positive value only for an explicit timeout. Continue independent work first; do not poll or restart pending tasks. after revisions omit unchanged results. inspect/conversation/stop/cancel_observation require task_ids. stop uses normal permissions; cancel_observation only removes a completion subscription. Wait cancellation never stops tasks. Independent peers use an available collaboration plugin.', inputSchema: z.toJSONSchema(schema) },
      manifest: { effect_kind: 'delegation', operation: 'tasks.manage', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
      delegatesToolExecution: true, nestedCallable: false, executionChannel: 'runtime:tasks',
      projectModelPage: (value, budget) => projectCatalogPage(value, budget, ['tasks'], 'total', page => ({ ...page,
        after: Object.fromEntries((page.tasks as RuntimeTaskHandle[]).map(task => [task.task_id, task.revision])) })),
      decodeInput: value => schema.parse(value), execute: async context => {
        const input = context.input;
        if (['inspect', 'conversation', 'stop', 'cancel_observation'].includes(input.action) && !input.task_ids) throw new Error('Explicit task_ids are required for this action.');
        if (input.action === 'conversation' && input.task_ids?.length !== 1) throw new Error('Read one child conversation at a time.');
        if (input.cursor !== undefined && input.action !== 'conversation') throw new Error('A conversation cursor requires action=conversation.');
        let snapshot = await this.snapshot(context);
        const all = snapshot.handles;
        const select = (items: RuntimeTaskHandle[], ids: string[]) => [...new Set(ids.map(id => {
          const exact = items.find(item => item.task_id === id);
          if (exact) return exact;
          const matches = items.filter(item => item.aliases?.includes(id));
          if (matches.length > 1) throw new Error(`Task alias ${id} is ambiguous. Use an exact task_id from tasks list.`);
          if (!matches.length) throw new Error(`Task ${id} is not available in this conversation. Use tasks list to find an existing task_id; employee IDs, workflow definition IDs, node IDs and chat session IDs are not task handles.`);
          return matches[0]!;
        }))];
        let selected = input.task_ids ? select(all, input.task_ids) : input.action === 'wait' ? all.filter(taskPending).slice(0, TASK_BATCH_LIMIT) : all.slice(input.offset, input.offset + input.limit);
        if (input.node_ids && (!['inspect', 'wait', 'conversation'].includes(input.action) || selected.length !== 1 || selected[0]!.kind !== 'team' || !input.task_ids)) throw new Error('node_ids requires inspect, wait or conversation and one explicit Team task_id.');
        if (input.action === 'conversation') {
          const task = selected[0]!;
          if (task.kind === 'team' && input.node_ids?.length !== 1) throw new Error('Team conversation requires exactly one node_ids entry. Use tasks inspect to find node IDs.');
          if (!task.readConversation) throw new Error('This task has no readable child conversation. Use inspect for its result.');
          return { task_id: task.task_id, kind: task.kind, ...(input.node_ids ? { node_id: input.node_ids[0] } : {}), conversation: await task.readConversation(context, input.cursor, input.node_ids) };
        }
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
          tasks: await Promise.all(selected.map(async ({ task_id, kind, status, revision, summary, progress, readProgress, result, readResult, stop, cancelObservation }) => {
            const unchanged = !input.node_ids && input.after?.[task_id] === revision;
            const value = !unchanged && input.action !== 'list' ? readResult ? await readResult(input.node_ids) : result : undefined;
            progress = readProgress?.() ?? progress;
            return { task_id, kind, status, revision, ...(summary ? { summary: input.action === 'list' ? briefText(summary) : summary } : {}), ...(progress ? { progress } : {}),
              ...(unchanged ? { unchanged: true } : value !== undefined ? { result: value } : {}),
              controls: { stop: !!stop, cancel_observation: !!cancelObservation } };
          })),
          after: Object.fromEntries(selected.map(task => [task.task_id, task.revision])),
          ...(selected.some(taskPending) ? { next_step: 'Continue independent work. Pending tasks have not completed; they may be running or waiting for user input. Waiting does not restart or stop them.' } : {}),
        };
      },
    });
  }
}
