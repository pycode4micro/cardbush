import { randomUUID } from "node:crypto";

import type { ModelEvent, RuntimeEvent } from "@cardbush/bush-protocol";

import type {
  InMemoryRuntimeEventLog,
  RuntimeEventIdentity,
} from "./runtimeEventLog.js";

export interface RuntimeEventProjectorOptions {
  createMessageId?: () => string;
  createSegmentId?: () => string;
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
  #active?: ActiveSegment;
  #nextOrdinal = 0;
  #hasAssistantSegment = false;

  constructor(
    eventLog: InMemoryRuntimeEventLog,
    identity: RuntimeEventIdentity,
    options: RuntimeEventProjectorOptions = {},
  ) {
    this.#eventLog = eventLog;
    this.#identity = identity;
    this.#messageId = (options.createMessageId ?? (() => `msg_${randomUUID()}`))();
    this.#createSegmentId = options.createSegmentId ?? (() => `seg_${randomUUID()}`);
  }

  get messageId(): string {
    return this.#messageId;
  }

  get finalMessageId(): string | undefined {
    return this.#hasAssistantSegment ? this.#messageId : undefined;
  }

  accept(event: ModelEvent): RuntimeEvent[] {
    switch (event.kind) {
      case "reasoning_delta":
        return this.#appendDelta("reasoning", event.delta);
      case "text_delta":
        return this.#appendDelta("assistant", event.delta);
      case "response_completed":
      case "response_failed":
        return this.completeOpenSegment();
      case "response_started":
      case "tool_call_delta":
      case "usage":
        return [];
    }
  }

  completeOpenSegment(): RuntimeEvent[] {
    if (!this.#active) return [];
    const active = this.#active;
    this.#active = undefined;
    return [
      this.#eventLog.append(this.#identity, {
        kind: `${active.channel}_segment_completed`,
        payload: {
          messageId: this.#messageId,
          segmentId: active.segmentId,
          ordinal: active.ordinal,
          content: active.content,
        },
      } as const),
    ];
  }

  appendAssistantText(content: string): RuntimeEvent[] {
    const events = this.#appendDelta("assistant", content);
    events.push(...this.completeOpenSegment());
    return events;
  }

  #appendDelta(channel: SegmentChannel, delta: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
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
          },
        } as const),
      );
    }
    this.#active.content += delta;
    events.push(
      this.#eventLog.append(this.#identity, {
        kind: `${channel}_segment_delta`,
        payload: {
          messageId: this.#messageId,
          segmentId: this.#active.segmentId,
          ordinal: this.#active.ordinal,
          delta,
        },
      } as const),
    );
    return events;
  }
}
