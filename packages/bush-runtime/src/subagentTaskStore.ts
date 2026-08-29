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
  load(parentSessionId: string): SubagentEvent[];
  append(event: SubagentEvent): void;
}

export class SubagentTaskStore {
  readonly #persistence?: SubagentTaskPersistence;
  readonly #createEventId: () => string;
  readonly #now: () => string;
  readonly #events = new Map<string, SubagentEvent[]>();

  constructor(options: {
    persistence?: SubagentTaskPersistence;
    createEventId?: () => string;
    now?: () => string;
  } = {}) {
    this.#persistence = options.persistence;
    this.#createEventId = options.createEventId ?? (() => `subagent_event_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  start(input: {
    taskId: string;
    parentSessionId: string;
    parentTurnId: string;
    childSessionId: string;
    childTurnId: string;
    prompt: string;
    inheritContext: boolean;
    inheritedMessageCount: number;
    origin?: "subagent" | "team";
    teamId?: string;
    teamMemberId?: string;
    agentProfileId?: string;
    phase?: "discussion" | "execution";
  }): SubagentTask {
    const existing = this.get(input.parentSessionId, input.taskId);
    if (existing) throw new Error(`Subagent task ${input.taskId} already exists.`);
    const now = this.#now();
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
    return structuredClone(task);
  }

  finish(input: {
    parentSessionId: string;
    taskId: string;
    status: "completed" | "failed" | "stopped";
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
    return structuredClone(task);
  }

  get(parentSessionId: string, taskId: string): SubagentTask | undefined {
    const task = projectSubagentTasks(parentSessionId, this.#load(parentSessionId)).get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  list(parentSessionId: string, parentTurnId?: string): SubagentTask[] {
    return [...projectSubagentTasks(parentSessionId, this.#load(parentSessionId)).values()]
      .filter((task) => !parentTurnId || task.parentTurnId === parentTurnId)
      .map((task) => structuredClone(task));
  }

  #load(parentSessionId: string): SubagentEvent[] {
    const cached = this.#events.get(parentSessionId);
    if (cached) return cached;
    const loaded = (this.#persistence?.load(parentSessionId) ?? []).map((event) =>
      subagentEventSchema.parse(event),
    );
    projectSubagentTasks(parentSessionId, loaded);
    this.#events.set(parentSessionId, loaded);
    return loaded;
  }

  #append(parentSessionId: string, task: SubagentTask): void {
    const events = this.#load(parentSessionId);
    const event = subagentEventSchema.parse({
      protocol: BUSH_SUBAGENT_EVENT_PROTOCOL,
      eventId: this.#createEventId(),
      sequence: events.length + 1,
      parentSessionId,
      taskId: task.taskId,
      createdAt: this.#now(),
      task,
    });
    this.#persistence?.append(event);
    events.push(event);
  }
}

export function projectSubagentTasks(
  parentSessionId: string,
  candidates: SubagentEvent[],
): Map<string, SubagentTask> {
  const tasks = new Map<string, SubagentTask>();
  const eventIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const event = subagentEventSchema.parse(candidate);
    if (event.parentSessionId !== parentSessionId || event.task.parentSessionId !== parentSessionId) {
      throw new Error("Subagent parent Session identity mismatch.");
    }
    if (event.sequence !== index + 1) throw new Error("Subagent event sequence is not contiguous.");
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate Subagent event ${event.eventId}.`);
    eventIds.add(event.eventId);
    if (event.taskId !== event.task.taskId) throw new Error("Subagent task identity mismatch.");
    const before = tasks.get(event.taskId);
    if (!before) {
      if (event.task.revision !== 1 || event.task.status !== "running") {
        throw new Error("A Subagent task must begin with running revision 1.");
      }
    } else {
      if (event.task.revision !== before.revision + 1) {
        throw new Error("Subagent task revision is not contiguous.");
      }
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
        "phase",
        "createdAt",
      ] as const) {
        if (event.task[key] !== before[key]) {
          throw new Error(`Subagent immutable fact ${key} changed.`);
        }
      }
      if (before.status !== "running") throw new Error("Subagent terminal task was updated.");
    }
    tasks.set(event.taskId, event.task);
  }
  return tasks;
}
