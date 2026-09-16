import type {
  AssistantStreamBufferRelease,
  AssistantStreamRoute,
} from './assistantStreamBuffer';

export interface FrameStreamScheduler {
  schedule: (callback: () => void) => () => void;
  visible: () => boolean;
  watchVisibility?: (callback: () => void) => () => void;
}

export const browserFrameScheduler: FrameStreamScheduler = {
  schedule(callback) {
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    }
    const id = window.setTimeout(callback, 16);
    return () => window.clearTimeout(id);
  },
  visible: () => (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
    !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  watchVisibility(callback) {
    if (typeof document === 'undefined' || !document.addEventListener) return () => {};
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
};

type Segment = {
  route: AssistantStreamRoute;
  text: string;
  emitted: number;
  release?: AssistantStreamBufferRelease;
  completed: boolean;
};
type Message = { route: AssistantStreamRoute; seed: string; segments: Map<string, Segment> };
export interface FrameStreamCheckpoint {
  messages: Array<{ route: AssistantStreamRoute; seed: string; segments: Array<[string, Segment]> }>;
  eventIds: string[];
}

/** Text paints in bounded frames. Tool/guidance/terminal facts flush synchronously
 * so their order never depends on a decorative animation or Promise callback. */
export function createFrameStreamBuffers(
  append: (delta: string, route: AssistantStreamRoute, release?: AssistantStreamBufferRelease) => void,
  options: {
    replace: (content: string, route: AssistantStreamRoute) => void;
    scheduler?: FrameStreamScheduler;
    shouldAnimate?: () => boolean;
    checkpoint?: FrameStreamCheckpoint;
  },
) {
  const scheduler = options.scheduler ?? browserFrameScheduler;
  const messages = new Map<string, Message>();
  const seenEvents = new Set<string>();
  const waiters: Array<() => void> = [];
  let cancelFrame: (() => void) | undefined;
  let drainFrames = 0;
  let disposed = false;
  const messageKey = (route: AssistantStreamRoute) =>
    `${route.turnId}:${route.messageId || route.assistantSegmentIndex || 1}`;
  const segmentKey = (route: AssistantStreamRoute) =>
    route.segmentId || String(route.segmentOrdinal ?? 'message');
  const messageFor = (route: AssistantStreamRoute) => {
    const key = messageKey(route);
    let message = messages.get(key);
    if (!message) messages.set(key, message = { route, seed: '', segments: new Map() });
    return message;
  };
  const segmentFor = (route: AssistantStreamRoute) => {
    const message = messageFor(route);
    const key = segmentKey(route);
    let segment = message.segments.get(key);
    if (!segment) message.segments.set(key, segment = { route, text: '', emitted: 0, completed: false });
    return segment;
  };
  const pending = () => [...messages.values()].some(message =>
    [...message.segments.values()].some(segment => segment.emitted < segment.text.length || segment.release));
  const settle = () => {
    if (pending()) return;
    drainFrames = 0;
    waiters.splice(0).forEach(resolve => resolve());
  };
  const joined = (message: Message) => message.seed + [...message.segments.values()].map(segment => segment.text).join('');
  for (const saved of options.checkpoint?.messages ?? []) {
    messages.set(messageKey(saved.route), { ...saved,
      segments: new Map(saved.segments.map(([key, segment]) => [key, { ...segment }])),
    });
  }
  for (const eventId of options.checkpoint?.eventIds ?? []) seenEvents.add(eventId);

  const flush = (all = false, exceptKey = '', onlyKey = '') => {
    cancelFrame?.();
    cancelFrame = undefined;
    if (disposed) return;
    for (const [key, message] of messages) {
      if (key === exceptKey || (onlyKey && key !== onlyKey)) continue;
      const remaining = [...message.segments.values()].reduce((sum, segment) =>
        sum + Array.from(segment.text.slice(segment.emitted)).length, 0);
      let budget = all ? Infinity : Math.max(24, drainFrames ? Math.ceil(remaining / drainFrames) : 24);
      for (const segment of message.segments.values()) {
        const delta = Array.from(segment.text.slice(segment.emitted)).slice(0, budget).join('');
        segment.emitted += delta.length;
        budget -= Array.from(delta).length;
        const release = segment.emitted === segment.text.length ? segment.release : undefined;
        // A completion with no remaining text must still carry segment metadata.
        if (delta || release) append(delta, segment.route, release);
        if (release) segment.release = undefined;
        if (budget <= 0) break;
      }
    }
    if (drainFrames) drainFrames--;
    if (pending()) schedule();
    else settle();
  };
  const schedule = () => {
    if (disposed || cancelFrame || !pending()) return;
    cancelFrame = scheduler.schedule(() => flush(!scheduler.visible() || options.shouldAnimate?.() === false));
  };
  const stopWatching = scheduler.watchVisibility?.(() => {
    if (!scheduler.visible()) flush(true);
  });
  const drain = () => {
    if (!pending()) return Promise.resolve();
    drainFrames ||= 8;
    schedule();
    return new Promise<void>(resolve => waiters.push(resolve));
  };
  const replaceMessage = (message: Message) => {
    options.replace(joined(message), message.route);
    for (const segment of message.segments.values()) segment.emitted = segment.text.length;
  };

  return {
    push(delta: string, route: AssistantStreamRoute) {
      if (disposed || !delta) return;
      const eventKey = route.eventId ? `${route.turnId}:${route.eventId}` : '';
      if (eventKey && seenEvents.has(eventKey)) return;
      if (eventKey) seenEvents.add(eventKey);
      const segment = segmentFor(route);
      if (segment.completed) return;
      segment.text += delta;
      schedule();
    },
    completeSegment(content: string, route: AssistantStreamRoute) {
      if (disposed) return Promise.resolve();
      const segment = segmentFor(route);
      if (segment.completed) return Promise.resolve();
      const message = messageFor(route);
      // A revision can seed a message before protocol segment IDs are known.
      // Do not append that prefix twice when the first segment snapshot arrives.
      if (message.segments.values().next().value === segment && message.seed && content.startsWith(message.seed)) {
        content = content.slice(message.seed.length);
      }
      const emitted = segment.text.slice(0, segment.emitted);
      segment.text = content;
      segment.completed = true;
      segment.release = {
        reason: 'segment_completed', eventId: route.eventId,
        segmentId: route.segmentId, segmentOrdinal: route.segmentOrdinal,
      };
      if (!content.startsWith(emitted)) replaceMessage(messageFor(route));
      return drain();
    },
    completeRoute(content: string, route: AssistantStreamRoute) {
      if (disposed) return Promise.resolve();
      const message = messageFor(route);
      const received = joined(message);
      if (content.startsWith(received)) {
        const last = [...message.segments.values()].at(-1) ?? segmentFor(route);
        last.text += content.slice(received.length);
      } else {
        message.segments.clear();
        message.seed = '';
        const segment = segmentFor(route);
        segment.text = content;
        replaceMessage(message);
      }
      return drain();
    },
    releaseToolBoundary() {
      // Flush before appending the tool so its contentOffset matches received text.
      // This is synchronous; no waiting for a decorative animation.
      flush(true);
      return Promise.resolve();
    },
    releaseTerminal() {
      flush(true);
      return Promise.resolve();
    },
    flushToolBoundary(exceptRoute?: AssistantStreamRoute) {
      flush(true, exceptRoute ? messageKey(exceptRoute) : '');
    },
    flushRoute(route: AssistantStreamRoute) {
      flush(true, '', messageKey(route));
      return Promise.resolve();
    },
    flushAllStreaming() {
      flush(true);
      return Promise.resolve();
    },
    reset(route: AssistantStreamRoute, emitted = '') {
      messages.delete(messageKey(route));
      if (emitted) {
        messageFor(route).seed = emitted;
      }
      settle();
      if (!pending()) { cancelFrame?.(); cancelFrame = undefined; }
    },
    checkpoint(): FrameStreamCheckpoint {
      // A detached subscription must retain both received text and protocol
      // segment identity; reconstructing a cursor resume from prose is lossy.
      flush(true);
      return { messages: [...messages.values()].map(message => ({ route: message.route, seed: message.seed,
        segments: [...message.segments].map(([key, segment]) => [key, { ...segment }]),
      })), eventIds: [...seenEvents] };
    },
    dispose() {
      disposed = true;
      cancelFrame?.();
      cancelFrame = undefined;
      stopWatching?.();
      messages.clear();
      seenEvents.clear();
      waiters.splice(0).forEach(resolve => resolve());
    },
  };
}
