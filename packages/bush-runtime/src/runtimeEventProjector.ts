import { randomUUID } from "node:crypto";

import type { ModelEvent, RuntimeEvent } from "@cardbush/bush-protocol";

import type {
  InMemoryRuntimeEventLog,
  RuntimeEventIdentity,
} from "./runtimeEventLog.js";

export interface RuntimeEventProjectorOptions {
  /** Display intent only; terminal events still own completion and cancellation. */
  finalResponse?: boolean;
  createMessageId?: () => string;
  createSegmentId?: () => string;
  /** Coalesce before assigning event IDs; published events and cursors never change. */
  deltaFlushIntervalMs?: number;
  deltaFlushChars?: number;
}

type SegmentChannel = "reasoning" | "assistant";

interface ActiveSegment {
  channel: SegmentChannel;
  segmentId: string;
  ordinal: number;
  content: string;
}

export class RuntimeEventProjector {
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #identity: RuntimeEventIdentity;
  readonly #messageId: string;
  readonly #createSegmentId: () => string;
  readonly #deltaFlushIntervalMs: number;
  readonly #deltaFlushChars: number;
  #pending: string[] = [];
  #pendingChars = 0;
  #flushTimer?: ReturnType<typeof setTimeout>;
  #flushFailure?: Error;
  #active?: ActiveSegment;
  #nextOrdinal = 0;
  #hasAssistantSegment = false;
  #assistantContent = "";
  #reasoningContent = "";
  #finalResponse: boolean | undefined;
  #lastAssistantSegment?: ActiveSegment;

  constructor(
    eventLog: InMemoryRuntimeEventLog,
    identity: RuntimeEventIdentity,
    options: RuntimeEventProjectorOptions = {},
  ) {
    this.#eventLog = eventLog;
    this.#finalResponse = options.finalResponse || undefined;
    this.#identity = identity;
    this.#messageId = (options.createMessageId ?? (() => `msg_${randomUUID()}`))();
    this.#createSegmentId = options.createSegmentId ?? (() => `seg_${randomUUID()}`);
    this.#deltaFlushIntervalMs = options.deltaFlushIntervalMs ?? 40;
    this.#deltaFlushChars = options.deltaFlushChars ?? 2048;
    if (!Number.isFinite(this.#deltaFlushIntervalMs) || this.#deltaFlushIntervalMs < 0 ||
        !Number.isSafeInteger(this.#deltaFlushChars) || this.#deltaFlushChars < 1) {
      throw new Error('Invalid stream delta batching limits.');
    }
  }

  get messageId(): string {
    return this.#messageId;
  }

  get finalMessageId(): string | undefined {
    return this.#hasAssistantSegment ? this.#messageId : undefined;
  }

  get assistantContent(): string {
    return this.#assistantContent;
  }

  get reasoningContent(): string {
    return this.#reasoningContent;
  }

  accept(event: ModelEvent): RuntimeEvent[] {
    if (this.#flushFailure) throw this.#flushFailure;
    switch (event.kind) {
      case "reasoning_delta":
        return this.#appendDelta("reasoning", event.delta);
      case "text_delta":
        return this.#appendDelta("assistant", event.delta);
      case "response_completed":
      case "response_failed":
        return this.completeOpenSegment();
      case "response_started":
      case "usage":
        return this.flush();
      case "tool_call_delta": {
        if (!this.#finalResponse) return this.flush();
        this.#finalResponse = false;
        if (this.#active?.channel === 'assistant') return this.completeOpenSegment();
        const events = this.flush();
        // A model may continue work despite its final intent. Correct any text
        // already displayed, including a block closed by subsequent reasoning.
        const segment = this.#lastAssistantSegment;
        if (segment) events.push(this.#eventLog.append(this.#identity, {
          kind: 'assistant_segment_completed', payload: { messageId: this.#messageId,
            segmentId: segment.segmentId, ordinal: segment.ordinal, content: segment.content, finalResponse: false },
        }));
        return events;
      }
    }
  }

  completeOpenSegment(): RuntimeEvent[] {
    const events = this.flush();
    if (!this.#active) return [];
    const active = this.#active;
    if (active.channel === 'assistant') this.#lastAssistantSegment = active;
    this.#active = undefined;
    return [...events,
      this.#eventLog.append(this.#identity, {
        kind: `${active.channel}_segment_completed`,
        payload: {
          messageId: this.#messageId,
          segmentId: active.segmentId,
          ordinal: active.ordinal,
          content: active.content,
          ...(active.channel === 'assistant' && this.#finalResponse !== undefined ? { finalResponse: this.#finalResponse } : {}),
        },
      } as const),
    ];
  }

  appendAssistantText(content: string): RuntimeEvent[] {
    const events = this.#appendDelta("assistant", content);
    events.push(...this.completeOpenSegment());
    return events;
  }

  /** Seal visible partial output as process text, never as a final answer. */
  interrupt(): RuntimeEvent[] {
    const activeAssistant = this.#active?.channel === 'assistant';
    this.#finalResponse = false;
    const events = this.completeOpenSegment();
    const segment = this.#lastAssistantSegment;
    if (!activeAssistant && segment) events.push(this.#eventLog.append(this.#identity, {
      kind: 'assistant_segment_completed', payload: { messageId: this.#messageId,
        segmentId: segment.segmentId, ordinal: segment.ordinal, content: segment.content, finalResponse: false },
    }));
    return events;
  }

  #appendDelta(channel: SegmentChannel, delta: string): RuntimeEvent[] {
    if (this.#flushFailure) throw this.#flushFailure;
    if (!delta) return [];
    const events: RuntimeEvent[] = [];
    const first = this.#active?.channel !== channel;
    if (channel === "assistant") this.#assistantContent += delta;
    else this.#reasoningContent += delta;
    if (this.#active?.channel !== channel) {
      events.push(...this.completeOpenSegment());
      this.#active = {
        channel,
        segmentId: this.#createSegmentId(),
        ordinal: this.#nextOrdinal++,
        content: "",
      };
      if (channel === "assistant") {
        this.#hasAssistantSegment = true;
      }
      events.push(
        this.#eventLog.append(this.#identity, {
          kind: `${channel}_segment_started`,
          payload: {
            messageId: this.#messageId,
            segmentId: this.#active.segmentId,
            ordinal: this.#active.ordinal,
            ...(channel === 'assistant' && this.#finalResponse !== undefined ? { finalResponse: this.#finalResponse } : {}),
          },
        } as const),
      );
    }
    this.#active.content += delta;
    this.#pending.push(delta);
    this.#pendingChars += delta.length;
    // First text is immediate. Slow streams flush on time even without another chunk.
    if (first || this.#deltaFlushIntervalMs === 0 || this.#pendingChars >= this.#deltaFlushChars) {
      events.push(...this.flush());
    } else if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = undefined;
        try { this.flush(); } catch (error) {
          // Propagate storage failures through the model round, never an uncaught timer.
          this.#flushFailure = error instanceof Error ? error : new Error(String(error));
        }
      }, this.#deltaFlushIntervalMs);
      this.#flushTimer.unref?.();
    }
    return events;
  }

  flush(): RuntimeEvent[] {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    if (this.#flushFailure) throw this.#flushFailure;
    if (!this.#active || !this.#pendingChars) return [];
    const event = this.#eventLog.append(this.#identity, {
      kind: `${this.#active.channel}_segment_delta`,
      payload: {
        messageId: this.#messageId, segmentId: this.#active.segmentId,
        ordinal: this.#active.ordinal, delta: this.#pending.join(''),
        ...(this.#active.channel === 'assistant' && this.#finalResponse !== undefined ? { finalResponse: this.#finalResponse } : {}),
      },
    } as const);
    this.#pending = [];
    this.#pendingChars = 0;
    return [event];
  }
}
