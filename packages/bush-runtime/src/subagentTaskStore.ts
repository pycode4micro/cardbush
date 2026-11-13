import { memoryCacheEntry, type CacheEntry } from './cacheMaintenance.js';
import { randomUUID } from "node:crypto";

import {
  BUSH_SUBAGENT_EVENT_PROTOCOL,
  BUSH_SUBAGENT_TASK_PROTOCOL,
  subagentEventSchema,
  subagentTaskSchema,
  type SubagentEvent,
  type SubagentTask,
} from "@cardbush/bush-protocol";

export interface SubagentTaskPersistence {
  cacheEntries?(): Promise<CacheEntry[]>;
  load(parentSessionId: string): SubagentEvent[];
  append(event: SubagentEvent): void;
}

type ParentTasks = {
  latest: Map<string, SubagentTask>;
  eventIds: Set<string>;
  cacheRows?: SubagentEvent[];
};

export class SubagentTaskStore {
  readonly #persistence?: SubagentTaskPersistence;
  readonly #createEventId: () => string;
  readonly #now: () => string;
  readonly #parents = new Map<string, ParentTasks>();
  readonly #listeners = new Set<() => void>();
  // Only this host's in-flight dispatches own execution. Journal replay restores history.
  readonly #liveByParent = new Map<string, Map<string, { sessionId: string; turnId: string } | undefined>>();

  startedHere(parentSessionId: string, taskId: string): boolean {
    return this.#liveByParent.get(parentSessionId)?.has(taskId) ?? false;
  }

  waitForCompletion(parentSessionId: string, taskId: string, signal: AbortSignal): Promise<void> {
    return this.#wait(parentSessionId, taskId, task => task?.status !== 'running', signal);
  }

  waitForChange(parentSessionId: string, taskId: string, revision: number, signal: AbortSignal): Promise<void> {
    return this.#wait(parentSessionId, taskId, task => task?.revision !== revision, signal);
  }

  #wait(parentSessionId: string, taskId: string, done: (task: SubagentTask | undefined) => boolean, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.#listeners.delete(check); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Wait stopped', 'AbortError')); };
      const check = () => { if (done(this.get(parentSessionId, taskId))) { cleanup(); resolve(); } };
      if (signal.aborted) { abort(); return; }
      this.#listeners.add(check); signal.addEventListener('abort', abort, { once: true }); check();
    });
  }

  constructor(options: {
    persistence?: SubagentTaskPersistence;
    createEventId?: () => string;
    now?: () => string;
  } = {}) {
    this.#persistence = options.persistence;
    this.#createEventId = options.createEventId ?? (() => `subagent_event_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async cacheEntries(): Promise<CacheEntry[]> {
    return [...await this.#persistence?.cacheEntries?.() ?? [], ...[...this.#parents].map(([id, state]) =>
      memoryCacheEntry('subagents', id, state.cacheRows ?? [], () => this.#parents.delete(id)))];
  }

  start(input: {
    taskId: string;
    parentSessionId: string;
    parentTurnId: string;
    originMessageIds?: string[];
    childSessionId: string;
    childTurnId: string;
    prompt: string;
    inheritContext: boolean;
    background?: boolean;
    inheritedMessageCount: number;
    origin?: "subagent" | "team";
    teamId?: string;
    teamMemberId?: string;
    agentProfileId?: string;
    agentName?: string;
    resumedFromTaskId?: string;
    queuedAfterTaskId?: string;
    remote?: SubagentTask['remote'];
    phase?: "discussion" | "execution";
  }): SubagentTask {
    const existing = this.get(input.parentSessionId, input.taskId);
    if (existing) throw new Error(`Subagent task ${input.taskId} already exists.`);
    const now = this.#now();
    if (input.queuedAfterTaskId) {
      const predecessor = this.get(input.parentSessionId, input.queuedAfterTaskId);
      if (!predecessor || predecessor.childSessionId !== input.childSessionId || predecessor.remote || input.remote)
        throw new Error('A local queued turn must follow an owned task in the same child conversation.');
    }
    const task = subagentTaskSchema.parse({
      protocol: BUSH_SUBAGENT_TASK_PROTOCOL,
      ...input,
      origin: input.origin ?? "subagent",
      phase: input.phase ?? "execution",
      status: "running",
      finalResponse: "",
      errorMessage: "",
      usage: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.#append(input.parentSessionId, task);
    let live = this.#liveByParent.get(input.parentSessionId);
    if (!live) this.#liveByParent.set(input.parentSessionId, live = new Map());
    live.set(input.taskId, task.remote ? undefined : { sessionId: task.childSessionId, turnId: task.childTurnId });
    return structuredClone(task);
  }

  acceptRemote(parentSessionId: string, taskId: string): void {
    const task = this.get(parentSessionId, taskId);
    if (!task?.remote || task.status !== 'running' || task.remoteAcceptedAt) return;
    const now = this.#now();
    this.#append(parentSessionId, subagentTaskSchema.parse({ ...task, remoteAcceptedAt: now, updatedAt: now, revision: task.revision + 1 }));
  }

  beginExecution(parentSessionId: string, taskId: string): void {
    const task = this.get(parentSessionId, taskId);
    if (!task || task.status !== 'running') throw new Error('stale_target');
    if (!task.queuedAfterTaskId || task.executionStartedAt) return;
    if (this.get(parentSessionId, task.queuedAfterTaskId)?.status === 'running') throw new Error('The preceding child turn is still running.');
    const now = this.#now();
    this.#append(parentSessionId, subagentTaskSchema.parse({ ...task, executionStartedAt: now, updatedAt: now, revision: task.revision + 1 }));
  }

  finish(input: {
    parentSessionId: string;
    taskId: string;
    status: "completed" | "failed" | "stopped" | "unavailable";
    finalResponse: string;
    errorMessage: string;
    usage: SubagentTask["usage"];
  }): SubagentTask {
    const before = this.get(input.parentSessionId, input.taskId);
    if (!before) throw new Error(`Subagent task ${input.taskId} does not exist.`);
    if (before.status !== "running") {
      const expected = { ...before };
      if (
        before.status === input.status &&
        before.finalResponse === input.finalResponse &&
        before.errorMessage === input.errorMessage &&
        JSON.stringify(before.usage) === JSON.stringify(input.usage)
      ) {
        return expected;
      }
      throw new Error(`Subagent task ${input.taskId} is already terminal.`);
    }
    const now = this.#now();
    const task = subagentTaskSchema.parse({
      ...before,
      status: input.status,
      finalResponse: input.finalResponse,
      errorMessage: input.errorMessage,
      usage: input.usage,
      revision: before.revision + 1,
      updatedAt: now,
      completedAt: now,
    });
    this.#append(input.parentSessionId, task);
    const live = this.#liveByParent.get(input.parentSessionId);
    live?.delete(input.taskId);
    if (!live?.size) this.#liveByParent.delete(input.parentSessionId);
    return structuredClone(task);
  }

  observe(parentSessionId: string, taskId: string, observation: SubagentTask['observation'], error?: string): void {
    const before = this.get(parentSessionId, taskId);
    if (!before || before.status !== 'running') return;
    if (observation && (observation.contextId !== before.childSessionId || observation.taskId !== taskId)) throw new Error('Child observation identity mismatch.');
    if (observation && before.observation && observation.cursor < before.observation.cursor) throw new Error('Child observation cursor moved backwards.');
    if (JSON.stringify(before.observation) === JSON.stringify(observation) && before.observationError === error) return;
    this.#append(parentSessionId, subagentTaskSchema.parse({ ...before, observation, observationError: error,
      updatedAt: this.#now(), revision: before.revision + 1 }));
  }

  get(parentSessionId: string, taskId: string): SubagentTask | undefined {
    const task = this.#load(parentSessionId).latest.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  list(parentSessionId: string, parentTurnId?: string): SubagentTask[] {
    return [...this.#load(parentSessionId).latest.values()]
      .filter((task) => !parentTurnId || task.parentTurnId === parentTurnId)
      .map((task) => structuredClone(task));
  }

  runningCount(parentSessionId: string): number {
    return this.#liveByParent.get(parentSessionId)?.size ?? 0;
  }
  *liveLocalTurns(parentSessionId: string) {
    const live = this.#liveByParent.get(parentSessionId);
    if (live) for (const child of live.values()) if (child) yield child;
  }

  restoredLocalRuns(parentSessionId: string, taskId?: string): SubagentTask[] {
    const latest = this.#load(parentSessionId).latest;
    const candidates = taskId ? [latest.get(taskId)] : latest.values();
    const restored: SubagentTask[] = [];
    for (const task of candidates) {
      if (task?.status === 'running' && !task.remote && task.origin !== 'team' &&
          !this.startedHere(parentSessionId, task.taskId)) restored.push(structuredClone(task));
    }
    return restored;
  }

  #load(parentSessionId: string): ParentTasks {
    const cached = this.#parents.get(parentSessionId);
    if (cached) return cached;
    const loaded = replay(parentSessionId, this.#persistence?.load(parentSessionId) ?? [], !this.#persistence?.cacheEntries);
    this.#parents.set(parentSessionId, loaded);
    return loaded;
  }

  #append(parentSessionId: string, task: SubagentTask): void {
    const state = this.#load(parentSessionId);
    const event = subagentEventSchema.parse({
      protocol: BUSH_SUBAGENT_EVENT_PROTOCOL,
      eventId: this.#createEventId(),
      sequence: state.eventIds.size + 1,
      parentSessionId,
      taskId: task.taskId,
      createdAt: this.#now(),
      task,
    });
    validateTransition(parentSessionId, state, event);
    this.#persistence?.append(event);
    apply(state, event);
    for (const listener of this.#listeners) listener();
  }
}

export function projectSubagentTasks(
  parentSessionId: string,
  candidates: SubagentEvent[],
): Map<string, SubagentTask> {
  return replay(parentSessionId, candidates, false).latest;
}

function replay(parentSessionId: string, events: SubagentEvent[], keepCacheRows: boolean): ParentTasks {
  const state: ParentTasks = { latest: new Map(), eventIds: new Set(), cacheRows: keepCacheRows ? [] : undefined };
  for (const candidate of events) {
    const event = subagentEventSchema.parse(candidate);
    validateTransition(parentSessionId, state, event);
    apply(state, event);
  }
  return state;
}

function apply(state: ParentTasks, event: SubagentEvent) {
  state.latest.set(event.taskId, event.task);
  state.eventIds.add(event.eventId);
  state.cacheRows?.push(event);
}

function validateTransition(parentSessionId: string, state: ParentTasks, event: SubagentEvent) {
  if (event.parentSessionId !== parentSessionId || event.task.parentSessionId !== parentSessionId) {
    throw new Error("Subagent parent Session identity mismatch.");
  }
  if (event.sequence !== state.eventIds.size + 1) throw new Error("Subagent event sequence is not contiguous.");
  if (state.eventIds.has(event.eventId)) throw new Error(`Duplicate Subagent event ${event.eventId}.`);
  if (event.taskId !== event.task.taskId) throw new Error("Subagent task identity mismatch.");
  const before = state.latest.get(event.taskId);
  if (!before) {
    if (event.task.revision !== 1 || event.task.status !== "running") {
      throw new Error("A Subagent task must begin with running revision 1.");
    }
  } else {
    if (event.task.revision !== before.revision + 1) {
      throw new Error("Subagent task revision is not contiguous.");
    }
    if (JSON.stringify(event.task.remote) !== JSON.stringify(before.remote)) throw new Error('Subagent remote binding changed.');
    for (const key of [
      "parentTurnId",
      "childSessionId",
      "childTurnId",
      "prompt",
      "inheritContext",
      "inheritedMessageCount",
      "origin",
      "teamId",
      "teamMemberId",
      "agentProfileId",
      "agentName",
      "resumedFromTaskId",
      "queuedAfterTaskId",
      "phase",
      "createdAt",
    ] as const) {
      if (event.task[key] !== before[key]) {
        throw new Error(`Subagent immutable fact ${key} changed.`);
      }
    }
    if (before.status !== "running") throw new Error("Subagent terminal task was updated.");
    if (before.executionStartedAt && event.task.executionStartedAt !== before.executionStartedAt) throw new Error('Child execution admission changed.');
  }
}
