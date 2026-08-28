import { randomUUID } from "node:crypto";

import {
  BUSH_RUNTIME_EVENT_PROTOCOL,
  runtimeEventCursorSchema,
  runtimeEventSchema,
  type RuntimeEvent,
} from "@cardbush/bush-protocol";

export interface RuntimeEventIdentity {
  requestId: string;
  sessionId: string;
  turnId: string;
}

type RuntimeEnvelopeKey =
  | "protocol"
  | "eventId"
  | "sequence"
  | "requestId"
  | "sessionId"
  | "turnId"
  | "createdAt";

export type RuntimeEventDraft = RuntimeEvent extends infer TEvent
  ? TEvent extends RuntimeEvent
    ? Omit<TEvent, RuntimeEnvelopeKey>
    : never
  : never;

export interface RuntimeEventCursor {
  afterSequence?: number;
  lastEventId?: string;
}

export interface RuntimeEventIdContext extends RuntimeEventIdentity {
  sequence: number;
  kind: RuntimeEvent["kind"];
}

export interface RuntimeEventLogOptions {
  createEventId?: (context: RuntimeEventIdContext) => string;
  now?: () => string;
}

interface TurnEventStream {
  identity?: RuntimeEventIdentity;
  events: RuntimeEvent[];
  listeners: Set<(event: RuntimeEvent) => void>;
}

export class RuntimeCursorError extends Error {
  readonly code: "cursor_event_not_found" | "cursor_identity_mismatch";

  constructor(
    code: RuntimeCursorError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RuntimeCursorError";
    this.code = code;
  }
}

export class InMemoryRuntimeEventLog {
  readonly #streams = new Map<string, TurnEventStream>();
  readonly #eventIds = new Set<string>();
  readonly #createEventId: (context: RuntimeEventIdContext) => string;
  readonly #now: () => string;

  constructor(options: RuntimeEventLogOptions = {}) {
    this.#createEventId = options.createEventId ?? (() => `evt_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  append(identity: RuntimeEventIdentity, draft: RuntimeEventDraft): RuntimeEvent {
    const stream = this.#stream(identity.sessionId, identity.turnId);
    if (stream.events.at(-1)?.kind === "turn_terminal") {
      throw new Error(`Turn ${identity.turnId} is already terminal.`);
    }
    if (stream.identity && !sameIdentity(stream.identity, identity)) {
      throw new Error(`Turn ${identity.turnId} received a conflicting event identity.`);
    }
    stream.identity ??= { ...identity };
    const sequence = (stream.events.at(-1)?.sequence ?? 0) + 1;
    const eventId = this.#createEventId({ ...identity, sequence, kind: draft.kind });
    if (this.#eventIds.has(eventId)) {
      throw new Error(`Runtime event ID ${eventId} is not unique.`);
    }
    const event = runtimeEventSchema.parse({
      protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
      eventId,
      sequence,
      ...identity,
      createdAt: this.#now(),
      ...draft,
    });
    this.#eventIds.add(eventId);
    stream.events.push(event);
    for (const listener of stream.listeners) {
      listener(event);
    }
    return event;
  }

  replay(
    sessionId: string,
    turnId: string,
    cursor: RuntimeEventCursor = {},
  ): RuntimeEvent[] {
    const validatedCursor = runtimeEventCursorSchema.parse(cursor);
    const events = this.#stream(sessionId, turnId).events;
    let afterSequence = validatedCursor.afterSequence ?? 0;
    if (validatedCursor.lastEventId) {
      const cursorEvent = events.find(
        (event) => event.eventId === validatedCursor.lastEventId,
      );
      if (!cursorEvent) {
        throw new RuntimeCursorError(
          "cursor_event_not_found",
          `Runtime event ${validatedCursor.lastEventId} does not belong to Turn ${turnId}.`,
        );
      }
      if (
        validatedCursor.afterSequence !== undefined &&
        validatedCursor.afterSequence !== cursorEvent.sequence
      ) {
        throw new RuntimeCursorError(
          "cursor_identity_mismatch",
          `Cursor sequence ${validatedCursor.afterSequence} does not match event ${validatedCursor.lastEventId}.`,
        );
      }
      afterSequence = cursorEvent.sequence;
    }
    return events.filter((event) => event.sequence > afterSequence);
  }

  async *subscribe(
    sessionId: string,
    turnId: string,
    cursor: RuntimeEventCursor = {},
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    if (signal?.aborted) return;
    const stream = this.#stream(sessionId, turnId);
    const pending: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: RuntimeEvent) => {
      pending.push(event);
      wake?.();
      wake = undefined;
    };
    stream.listeners.add(listener);
    let lastSequence = cursor.afterSequence ?? 0;
    try {
      if (cursor.lastEventId) {
        lastSequence =
          stream.events.find((event) => event.eventId === cursor.lastEventId)
            ?.sequence ?? lastSequence;
      }
      for (const event of this.replay(sessionId, turnId, cursor)) {
        if (signal?.aborted) return;
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        yield event;
        if (event.kind === "turn_terminal") return;
      }
      while (!signal?.aborted) {
        const ready = pending
          .filter((event) => event.sequence > lastSequence)
          .sort((left, right) => left.sequence - right.sequence);
        pending.length = 0;
        if (ready.length === 0) {
          if (
            stream.events.at(-1)?.kind === "turn_terminal" &&
            lastSequence >= (stream.events.at(-1)?.sequence ?? 0)
          ) {
            return;
          }
          await waitForEvent(signal, pending, lastSequence, (resolve) => {
            wake = resolve;
          });
          continue;
        }
        for (const event of ready) {
          if (event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          yield event;
          if (event.kind === "turn_terminal") return;
        }
      }
    } finally {
      stream.listeners.delete(listener);
    }
  }

  #stream(sessionId: string, turnId: string): TurnEventStream {
    const key = JSON.stringify([sessionId, turnId]);
    let stream = this.#streams.get(key);
    if (!stream) {
      stream = { events: [], listeners: new Set() };
      this.#streams.set(key, stream);
    }
    return stream;
  }
}

function sameIdentity(left: RuntimeEventIdentity, right: RuntimeEventIdentity): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId
  );
}

function waitForEvent(
  signal: AbortSignal | undefined,
  pending: RuntimeEvent[],
  afterSequence: number,
  register: (resolve: () => void) => void,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      signal?.removeEventListener("abort", complete);
      resolve();
    };
    signal?.addEventListener("abort", complete, { once: true });
    register(complete);
    if (pending.some((event) => event.sequence > afterSequence)) {
      complete();
    }
  });
}
