import { randomUUID } from "node:crypto";

import {
  BUSH_COORDINATION_EVENT_PROTOCOL,
  BUSH_GOAL_PROTOCOL,
  BUSH_PLAN_STATE_PROTOCOL,
  coordinationEventSchema,
  createRuntimeGoalRequestSchema,
  goalStateSchema,
  setRuntimePlanRequestSchema,
  updateRuntimeGoalRequestSchema,
  type CoordinationEvent,
  type GoalState,
  type PlanState,
  type TaskPlan,
} from "@cardbush/bush-protocol";

export interface CoordinationPersistence {
  load(sessionId: string): CoordinationEvent[];
  append(event: CoordinationEvent): void;
}

export interface CoordinationStoreOptions {
  persistence?: CoordinationPersistence;
  createEventId?: () => string;
  createNodeId?: () => string;
  now?: () => string;
}

interface CoordinationProjection {
  plan?: PlanState;
  goal?: GoalState;
}

export class CoordinationStore {
  readonly #persistence?: CoordinationPersistence;
  readonly #createEventId: () => string;
  readonly #createNodeId: () => string;
  readonly #now: () => string;
  readonly #events = new Map<string, CoordinationEvent[]>();

  constructor(options: CoordinationStoreOptions = {}) {
    this.#persistence = options.persistence;
    this.#createEventId =
      options.createEventId ?? (() => `coordination_event_${randomUUID()}`);
    this.#createNodeId = options.createNodeId ?? (() => `plan_node_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  getPlan(sessionId: string): PlanState | undefined {
    const plan = projectCoordination(sessionId, this.#load(sessionId)).plan;
    return plan ? structuredClone(plan) : undefined;
  }

  setPlan(input: unknown): PlanState {
    const request = setRuntimePlanRequestSchema.parse(input);
    const before = this.getPlan(request.sessionId);
    const actualRevision = before?.revision ?? 0;
    if (request.expectedRevision !== actualRevision) {
      throw new Error(
        `Plan revision conflict: expected ${request.expectedRevision}, current ${actualRevision}.`,
      );
    }
    if (request.plan.session_id !== request.sessionId) {
      throw new Error("Plan Session identity mismatch.");
    }
    if (before && request.plan.plan_id !== before.plan.plan_id) {
      throw new Error("Plan identity cannot change within a Plan revision chain.");
    }

    const plan = assignMissingNodeIds(request.plan, this.#createNodeId);
    const previousIds = new Set(
      before?.plan.nodes.flatMap((node) => (node.id ? [node.id] : [])) ?? [],
    );
    const nextIds = new Set(plan.nodes.flatMap((node) => (node.id ? [node.id] : [])));
    const removedIds = [...previousIds].filter((id) => !nextIds.has(id));
    if (removedIds.length > 0 && request.scopeChangeReason.trim().length === 0) {
      throw new Error(
        "Removing Plan nodes requires an explicit scopeChangeReason.",
      );
    }

    const state = {
      protocol: BUSH_PLAN_STATE_PROTOCOL,
      sessionId: request.sessionId,
      revision: actualRevision + 1,
      plan,
      updatedAt: this.#now(),
    } satisfies PlanState;
    this.#append(request.sessionId, "plan_set", state);
    return structuredClone(state);
  }

  getGoal(sessionId: string): GoalState | undefined {
    const goal = projectCoordination(sessionId, this.#load(sessionId)).goal;
    return goal ? structuredClone(goal) : undefined;
  }

  createGoal(input: unknown): GoalState {
    const request = createRuntimeGoalRequestSchema.parse(input);
    const existing = this.getGoal(request.sessionId);
    if (existing?.goalId === request.goalId) {
      const equivalent =
        existing.objective === request.objective &&
        existing.tokenBudget === request.tokenBudget &&
        JSON.stringify(existing.linkedA2ATaskIds) ===
          JSON.stringify(request.linkedA2ATaskIds);
      if (equivalent) return existing;
      throw new Error(`Goal ${request.goalId} already exists with different facts.`);
    }
    const now = this.#now();
    const state = goalStateSchema.parse({
      protocol: BUSH_GOAL_PROTOCOL,
      goalId: request.goalId,
      sessionId: request.sessionId,
      objective: request.objective,
      status: "active",
      statusReason: "",
      tokenBudget: request.tokenBudget,
      consumedTokens: 0,
      linkedA2ATaskIds: request.linkedA2ATaskIds,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.#append(request.sessionId, "goal_set", state);
    return structuredClone(state);
  }

  updateGoal(input: unknown): GoalState {
    const request = updateRuntimeGoalRequestSchema.parse(input);
    const before = this.getGoal(request.sessionId);
    if (!before) throw new Error(`Session ${request.sessionId} has no Goal.`);
    if (before.goalId !== request.goalId) throw new Error("Goal identity mismatch.");
    if (before.revision !== request.expectedRevision) {
      throw new Error(
        `Goal revision conflict: expected ${request.expectedRevision}, current ${before.revision}.`,
      );
    }
    const now = this.#now();
    const state = goalStateSchema.parse({
      ...before,
      status: request.status,
      statusReason: request.statusReason,
      consumedTokens: request.consumedTokens,
      linkedA2ATaskIds: request.linkedA2ATaskIds,
      revision: before.revision + 1,
      updatedAt: now,
      ...(request.status === "active"
        ? { completedAt: undefined }
        : { completedAt: now }),
    });
    this.#append(request.sessionId, "goal_set", state);
    return structuredClone(state);
  }

  #load(sessionId: string): CoordinationEvent[] {
    const cached = this.#events.get(sessionId);
    if (cached) return cached;
    const loaded = (this.#persistence?.load(sessionId) ?? []).map((event) =>
      coordinationEventSchema.parse(event),
    );
    projectCoordination(sessionId, loaded);
    this.#events.set(sessionId, loaded);
    return loaded;
  }

  #append(
    sessionId: string,
    kind: CoordinationEvent["kind"],
    payload: PlanState | GoalState,
  ): void {
    const events = this.#load(sessionId);
    const event = coordinationEventSchema.parse({
      protocol: BUSH_COORDINATION_EVENT_PROTOCOL,
      eventId: this.#createEventId(),
      sequence: events.length + 1,
      sessionId,
      createdAt: this.#now(),
      kind,
      payload,
    });
    this.#persistence?.append(event);
    events.push(event);
  }
}

export function projectCoordination(
  sessionId: string,
  candidates: CoordinationEvent[],
): CoordinationProjection {
  let plan: PlanState | undefined;
  let goal: GoalState | undefined;
  const eventIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const event = coordinationEventSchema.parse(candidate);
    if (event.sessionId !== sessionId) throw new Error("Coordination Session identity mismatch.");
    if (event.sequence !== index + 1) {
      throw new Error("Coordination event sequence is not contiguous.");
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(`Duplicate Coordination event ${event.eventId}.`);
    }
    eventIds.add(event.eventId);
    if (event.payload.sessionId !== sessionId) {
      throw new Error("Coordination payload Session identity mismatch.");
    }
    if (event.kind === "plan_set") {
      const expected = (plan?.revision ?? 0) + 1;
      if (event.payload.revision !== expected) {
        throw new Error("Plan revision is not contiguous.");
      }
      if (plan && event.payload.plan.plan_id !== plan.plan.plan_id) {
        throw new Error("Persisted Plan identity changed within its revision chain.");
      }
      plan = event.payload;
    } else {
      if (goal?.goalId === event.payload.goalId) {
        if (event.payload.revision !== goal.revision + 1) {
          throw new Error("Goal revision is not contiguous.");
        }
        if (
          event.payload.objective !== goal.objective ||
          event.payload.createdAt !== goal.createdAt
        ) {
          throw new Error("Persisted Goal immutable facts changed.");
        }
      } else if (event.payload.revision !== 1) {
        throw new Error("A new Goal must begin at revision 1.");
      }
      goal = event.payload;
    }
  }
  return { plan, goal };
}

function assignMissingNodeIds(plan: TaskPlan, createNodeId: () => string): TaskPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) => ({
      ...node,
      id: node.id || createNodeId(),
    })),
  };
}
