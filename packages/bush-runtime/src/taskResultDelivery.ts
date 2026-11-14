import type { SubagentTask } from '@cardbush/bush-protocol';
import { z } from 'zod';

export const taskResultReferenceSchema = z.object({ sessionId: z.string(), taskId: z.string(), attempt: z.string() });
export type TaskResultReference = z.infer<typeof taskResultReferenceSchema>;

export interface ResultDelivery {
  references(presented: string): TaskResultReference[];
  commit(presented: string): void;
  release(): void;
}

// Internal ownership travels alongside a native result, never in model arguments.
const deliveries = new WeakMap<object, ResultDelivery>();
export function bindResultDelivery<T extends object>(result: T, delivery: ResultDelivery): T {
  deliveries.set(result, delivery);
  return result;
}
export function resultDelivery(result: unknown): ResultDelivery | undefined {
  return result && typeof result === 'object' ? deliveries.get(result) : undefined;
}
export function transferResultDelivery(source: unknown, target: unknown) {
  const delivery = resultDelivery(source);
  if (delivery && target && typeof target === 'object') deliveries.set(target, delivery);
}

export interface TaskResultLease {
  task: SubagentTask;
  reference: TaskResultReference;
  active(): boolean;
  commit(): void;
  release(): void;
}
type State = {
  task: SubagentTask;
  attempt: string;
  phase: 'running' | 'ready' | 'delivering' | 'delivered';
  watched: boolean;
  owner?: symbol;
};

/** Execution and delivery are separate lifecycles. Only a committed parent
 * context owns a delivered result; failed reads return ownership to the queue. */
export class TaskResultDelivery {
  private sessions = new Map<string, Map<string, State>>();
  private committed = new Map<string, string>();
  restore(sessionId: string, references: TaskResultReference[]) {
    for (const reference of references) {
      if (reference.sessionId !== sessionId) continue;
      this.committed.set(JSON.stringify([reference.sessionId, reference.taskId]), reference.attempt);
      const state = this.sessions.get(reference.sessionId)?.get(reference.taskId);
      if (state?.attempt === reference.attempt) { state.phase = 'delivered'; state.watched = false; state.owner = undefined; }
    }
  }
  private state(sessionId: string, task: SubagentTask): State {
    let session = this.sessions.get(sessionId);
    if (!session) this.sessions.set(sessionId, session = new Map());
    const attempt = JSON.stringify([task.childSessionId, task.childTurnId, task.createdAt]);
    let state = session.get(task.taskId);
    if (!state || state.attempt !== attempt) {
      state = { task: structuredClone(task), attempt, phase: task.status === 'running' ? 'running' : 'ready', watched: false };
      if (this.committed.get(JSON.stringify([sessionId, task.taskId])) === attempt) state.phase = 'delivered';
      session.set(task.taskId, state);
    } else if (!(state.task.status !== 'running' && task.status === 'running') &&
      !(typeof state.task.revision === 'number' && typeof task.revision === 'number' && task.revision <= state.task.revision)) {
      // Execution revisions are monotonic within an attempt. A late observation
      // cannot reopen a terminal execution or replace its result snapshot.
      if (state.phase === 'running' && task.status !== 'running') state.phase = 'ready';
      state.task = structuredClone(task);
    }
    return state;
  }
  observe(sessionId: string, task: SubagentTask) { this.state(sessionId, task); }
  watch(sessionId: string, task: SubagentTask) {
    const state = this.state(sessionId, task);
    if (state.phase !== 'delivered') state.watched = true;
  }
  ready(sessionId: string): SubagentTask[] {
    return [...this.sessions.get(sessionId)?.values() ?? []]
      .filter(state => state.watched && state.phase === 'ready').map(state => structuredClone(state.task));
  }
  watching(sessionId: string) {
    return [...this.sessions.get(sessionId)?.values() ?? []].some(state => state.watched && state.phase !== 'delivered');
  }
  phase(sessionId: string, task: SubagentTask) { return this.state(sessionId, task).phase; }
  reserve(sessionId: string, task: SubagentTask): TaskResultLease | undefined {
    const state = this.state(sessionId, task);
    if (state.phase !== 'ready') return;
    const owner = Symbol('task result delivery');
    const taskId = state.task.taskId;
    state.phase = 'delivering'; state.owner = owner;
    const active = () => state.owner === owner && this.sessions.get(sessionId)?.get(taskId) === state;
    const settle = (phase: 'ready' | 'delivered') => {
      if (!active()) return;
      state.phase = phase; state.owner = undefined;
      if (phase === 'delivered') {
        state.watched = false;
        this.committed.set(JSON.stringify([sessionId, taskId]), state.attempt);
      }
    };
    return { task: structuredClone(state.task), reference: { sessionId, taskId, attempt: state.attempt }, active, commit: () => settle('delivered'), release: () => settle('ready') };
  }
  forget(sessionId: string) {
    this.sessions.delete(sessionId);
    for (const key of this.committed.keys()) if (JSON.parse(key)[0] === sessionId) this.committed.delete(key);
  }
}

/** Commit only rows that survived model projection in full. A list, archive
 * preview, unchanged revision or failed read cannot acknowledge a result. */
export function taskReceiptDelivery<T extends object>(result: T, rows: Array<{ lease: TaskResultLease; value: unknown; taskId?: string }>, signal?: AbortSignal): T {
  if (!rows.length) return result;
  const presentedRows = (presented: string) => {
    let output: Record<string, unknown> | undefined;
    try { const value: unknown = JSON.parse(presented); if (value && typeof value === 'object' && !Array.isArray(value)) output = value as Record<string, unknown>; }
    catch { /* An archive preview has no result ownership. */ }
    return rows.filter(row => {
      if (!row.lease.active()) return false;
      const delivered = row.taskId && Array.isArray(output?.tasks)
        ? output.tasks.find((task: unknown) => task && typeof task === 'object' && 'task_id' in task && task.task_id === row.taskId)
        : row.taskId ? undefined : output;
      return delivered && JSON.stringify(delivered) === JSON.stringify(row.value);
    });
  };
  const release = () => { signal?.removeEventListener('abort', release); rows.forEach(row => row.lease.release()); };
  if (signal?.aborted) release();
  else signal?.addEventListener('abort', release, { once: true });
  return bindResultDelivery(result, {
    references: presented => presentedRows(presented).map(row => row.lease.reference),
    commit(presented) {
      signal?.removeEventListener('abort', release);
      const accepted = new Set(presentedRows(presented));
      for (const row of rows) {
        if (accepted.has(row)) row.lease.commit();
        else row.lease.release();
      }
    },
    release,
  });
}
