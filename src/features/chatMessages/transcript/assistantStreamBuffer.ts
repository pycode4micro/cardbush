// Segment-local text buffering and release timing. No React state or Runtime subscriptions.
import type {
  AssistantStreamChunk,
} from '../../../types';

// Assistant deltas stay outside React while their Runtime segment is open. A
// canonical segment-completed fact releases loop text; the terminal fact
// releases any final-only fallback. A release is deliberately projected in a
// small, bounded number of accelerated chunks. This gives the reader a visible
// hand-off without returning to unbounded token-by-token Markdown reparsing.

const assistantRevealMinimumChunkCharacters = 10;

const assistantRevealMaximumCommits = 72;

const assistantRevealIntervalMs = 32;

export type AssistantStreamBufferRelease = {
  reason: 'segment_completed' | 'terminal' | 'boundary';
  eventId?: string;
  segmentId?: string;
  segmentOrdinal?: number;
};

type AssistantStreamDeltaBufferOptions = {
  revealIntervalMs?: number;
  shouldAnimate?: () => boolean;
};

type AssistantRevealBatch = {
  characters: string[];
  index: number;
  chunkSize: number;
  release: AssistantStreamBufferRelease;
};

export function createAssistantStreamDeltaBuffer(
  append: (delta: string, release?: AssistantStreamBufferRelease) => void,
  options: AssistantStreamDeltaBufferOptions = {},
) {
  let pending = '';
  let emitted = '';
  let terminalRequested = false;
  let revealTimer: number | undefined;
  let lateTerminalTimer: number | undefined;
  let activeBatch: AssistantRevealBatch | undefined;
  const queuedBatches: AssistantRevealBatch[] = [];
  const drainWaiters: Array<() => void> = [];
  const completedSegmentKeys = new Set<string>();
  const revealInterval = Math.max(
    0,
    Math.round(options.revealIntervalMs ?? assistantRevealIntervalMs),
  );

  const emit = (delta: string, release?: AssistantStreamBufferRelease) => {
    if (!delta) {
      return;
    }
    append(delta, release);
    emitted += delta;
  };

  const unrevealedText = () => [
    activeBatch?.characters.slice(activeBatch.index).join('') ?? '',
    ...queuedBatches.map((batch) => batch.characters.slice(batch.index).join('')),
    pending,
  ].join('');

  const bufferedText = () => emitted + unrevealedText();

  const shouldAnimateReveal = () => {
    if (options.shouldAnimate && !options.shouldAnimate()) {
      return false;
    }
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return false;
    }
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  };

  const isDrained = () =>
    !pending &&
    !activeBatch &&
    queuedBatches.length === 0 &&
    revealTimer === undefined &&
    lateTerminalTimer === undefined;

  const resolveDrainWaiters = () => {
    if (!isDrained() || drainWaiters.length === 0) return;
    const waiters = drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  const waitForDrain = () => new Promise<void>((resolve) => {
    if (isDrained()) {
      resolve();
      return;
    }
    drainWaiters.push(resolve);
  });

  const cancelRevealTimer = () => {
    if (revealTimer !== undefined) {
      window.clearTimeout(revealTimer);
      revealTimer = undefined;
    }
    if (lateTerminalTimer !== undefined) {
      window.clearTimeout(lateTerminalTimer);
      lateTerminalTimer = undefined;
    }
  };

  const preferredRevealEnd = (batch: AssistantRevealBatch) => {
    const minimumEnd = Math.min(
      batch.characters.length,
      batch.index + batch.chunkSize,
    );
    if (minimumEnd >= batch.characters.length) return minimumEnd;
    const maximumEnd = Math.min(batch.characters.length, minimumEnd + 6);
    for (let index = minimumEnd; index < maximumEnd; index += 1) {
      if (/\s|[，。！？；：、,.!?;:)}\]]/.test(batch.characters[index])) {
        return index + 1;
      }
    }
    return minimumEnd;
  };

  const queuePending = (release: AssistantStreamBufferRelease) => {
    if (!pending) return;
    const characters = Array.from(pending);
    pending = '';
    queuedBatches.push({
      characters,
      index: 0,
      chunkSize: Math.max(
        assistantRevealMinimumChunkCharacters,
        Math.ceil(characters.length / assistantRevealMaximumCommits),
      ),
      release,
    });
  };

  const startNextReveal = () => {
    if (activeBatch || revealTimer !== undefined) return;
    activeBatch = queuedBatches.shift();
    if (!activeBatch) {
      if (terminalRequested && pending) {
        queuePending({ reason: 'terminal' });
        activeBatch = queuedBatches.shift();
      }
      if (!activeBatch) {
        resolveDrainWaiters();
        return;
      }
    }

    const revealNextChunk = () => {
      revealTimer = undefined;
      const batch = activeBatch;
      if (!batch) {
        startNextReveal();
        return;
      }
      if (!shouldAnimateReveal()) {
        emit(
          batch.characters.slice(batch.index).join(''),
          batch.release,
        );
        activeBatch = undefined;
        startNextReveal();
        return;
      }
      const nextIndex = preferredRevealEnd(batch);
      const finished = nextIndex >= batch.characters.length;
      emit(
        batch.characters.slice(batch.index, nextIndex).join(''),
        finished ? batch.release : undefined,
      );
      batch.index = nextIndex;
      if (finished) {
        activeBatch = undefined;
        startNextReveal();
        return;
      }
      revealTimer = window.setTimeout(revealNextChunk, revealInterval);
    };

    revealNextChunk();
  };

  const flushAllImmediately = (release?: AssistantStreamBufferRelease) => {
    cancelRevealTimer();
    const queuedRelease =
      queuedBatches.at(-1)?.release ?? activeBatch?.release;
    const remainder = unrevealedText();
    activeBatch = undefined;
    queuedBatches.length = 0;
    pending = '';
    emit(remainder, release ?? queuedRelease);
    resolveDrainWaiters();
    return Promise.resolve();
  };

  const flushAllStreaming = (release?: AssistantStreamBufferRelease) => {
    if (terminalRequested && shouldAnimateReveal() && !isDrained()) {
      startNextReveal();
      return waitForDrain();
    }
    return flushAllImmediately(release);
  };

  const reconcileSnapshot = (finalText: string) => {
    const snapshot = finalText ?? '';
    const buffered = bufferedText();
    if (snapshot.startsWith(buffered)) {
      pending += snapshot.slice(buffered.length);
    } else if (snapshot.startsWith(emitted)) {
      cancelRevealTimer();
      activeBatch = undefined;
      queuedBatches.length = 0;
      pending = snapshot.slice(emitted.length);
    } else {
      cancelRevealTimer();
      activeBatch = undefined;
      queuedBatches.length = 0;
      emitted = '';
      pending = snapshot;
    }
  };

  const reconcileSegmentSnapshot = (segmentText: string) => {
    const snapshot = segmentText ?? '';
    const buffered = bufferedText();
    if (snapshot.startsWith(buffered)) {
      pending += snapshot.slice(buffered.length);
    } else if (buffered.startsWith(snapshot)) {
      return;
    } else if (snapshot.startsWith(pending)) {
      pending += snapshot.slice(pending.length);
    } else {
      // Segment-completed content is scoped to the open protocol segment, not
      // necessarily to the whole assistant message. Preserve prior committed
      // segments while replacing only this segment's uncommitted delta buffer.
      pending = snapshot;
    }
  };

  const completeFinalSnapshot = (finalText: string) => {
    reconcileSnapshot(finalText);
    if (terminalRequested) {
      if (lateTerminalTimer !== undefined) {
        window.clearTimeout(lateTerminalTimer);
        lateTerminalTimer = undefined;
      }
      queuePending({ reason: 'terminal' });
      startNextReveal();
    }
    return waitForDrain();
  };

  const completeSegmentSnapshot = (
    content: string,
    release: AssistantStreamBufferRelease,
  ) => {
    const completionKey = release.segmentId || release.eventId || (
      release.segmentOrdinal != null ? `ordinal:${release.segmentOrdinal}` : ''
    );
    if (completionKey && completedSegmentKeys.has(completionKey)) {
      return Promise.resolve();
    }
    reconcileSegmentSnapshot(content);
    queuePending(release);
    if (completionKey) completedSegmentKeys.add(completionKey);
    startNextReveal();
    return waitForDrain();
  };

  const releaseToolBoundary = () => {
    queuePending({ reason: 'boundary' });
    startNextReveal();
    return waitForDrain();
  };

  const flushToolBoundary = () => {
    void flushAllStreaming({ reason: 'boundary' });
  };

  return {
    push(delta: string) {
      if (!delta) {
        return;
      }
      pending += delta;
      if (
        terminalRequested &&
        !activeBatch &&
        queuedBatches.length === 0 &&
        lateTerminalTimer === undefined
      ) {
        // A terminal event may race slightly ahead of its final delta/snapshot.
        // Coalesce that burst once instead of turning every late token into a
        // separate React commit.
        lateTerminalTimer = window.setTimeout(() => {
          lateTerminalTimer = undefined;
          queuePending({ reason: 'terminal' });
          startNextReveal();
        }, revealInterval);
      }
    },
    flushAllStreaming() {
      return flushAllStreaming();
    },
    completeFinalSnapshot(finalText: string) {
      return completeFinalSnapshot(finalText);
    },
    completeSegmentSnapshot(
      content: string,
      release: AssistantStreamBufferRelease,
    ) {
      return completeSegmentSnapshot(content, release);
    },
    releaseToolBoundary() {
      return releaseToolBoundary();
    },
    releaseTerminal() {
      terminalRequested = true;
      if (lateTerminalTimer !== undefined) {
        window.clearTimeout(lateTerminalTimer);
        lateTerminalTimer = undefined;
      }
      queuePending({ reason: 'terminal' });
      startNextReveal();
      return waitForDrain();
    },
    flushToolBoundary() {
      flushToolBoundary();
    },
    reset(nextEmitted = '') {
      cancelRevealTimer();
      terminalRequested = false;
      activeBatch = undefined;
      queuedBatches.length = 0;
      pending = '';
      emitted = nextEmitted;
      completedSegmentKeys.clear();
      resolveDrainWaiters();
    },
    dispose() {
      cancelRevealTimer();
      terminalRequested = false;
      activeBatch = undefined;
      queuedBatches.length = 0;
      pending = '';
      emitted = '';
      completedSegmentKeys.clear();
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    },
  };
}

export type AssistantStreamRoute = Pick<
  AssistantStreamChunk,
  | 'messageId'
  | 'assistantSegmentIndex'
  | 'segmentId'
  | 'segmentOrdinal'
  | 'turnId'
  | 'createdAt'
  | 'eventId'
>;

export function createSegmentedAssistantStreamBuffers(
  append: (
    delta: string,
    route: AssistantStreamRoute,
    release?: AssistantStreamBufferRelease,
  ) => void,
  options: AssistantStreamDeltaBufferOptions = {},
) {
  const buffers = new Map<string, ReturnType<typeof createAssistantStreamDeltaBuffer>>();

  const routeKey = (route: AssistantStreamRoute) =>
    route.messageId.trim() ||
    `${route.turnId.trim()}:segment:${route.assistantSegmentIndex ?? 1}`;

  const bufferFor = (route: AssistantStreamRoute) => {
    const key = routeKey(route);
    const existing = buffers.get(key);
    if (existing) return existing;
    const created = createAssistantStreamDeltaBuffer(
      (delta, release) => append(delta, route, release),
      options,
    );
    buffers.set(key, created);
    return created;
  };

  return {
    push(delta: string, route: AssistantStreamRoute) {
      bufferFor(route).push(delta);
    },
    reset(route: AssistantStreamRoute, nextEmitted = '') {
      bufferFor(route).reset(nextEmitted);
    },
    flushRoute(route: AssistantStreamRoute) {
      return bufferFor(route).flushAllStreaming();
    },
    completeRoute(finalText: string, route: AssistantStreamRoute) {
      return bufferFor(route).completeFinalSnapshot(finalText);
    },
    completeSegment(content: string, route: AssistantStreamRoute) {
      return bufferFor(route).completeSegmentSnapshot(content, {
        reason: 'segment_completed',
        eventId: route.eventId,
        segmentId: route.segmentId,
        segmentOrdinal: route.segmentOrdinal,
      });
    },
    releaseToolBoundary() {
      return Promise.all(
        [...buffers.values()].map((buffer) => buffer.releaseToolBoundary()),
      ).then(() => undefined);
    },
    releaseTerminal() {
      return Promise.all(
        [...buffers.values()].map((buffer) => buffer.releaseTerminal()),
      ).then(() => undefined);
    },
    flushAllStreaming() {
      return Promise.all(
        [...buffers.values()].map((buffer) => buffer.flushAllStreaming()),
      ).then(() => undefined);
    },
    flushToolBoundary(exceptRoute?: AssistantStreamRoute) {
      const exceptKey = exceptRoute ? routeKey(exceptRoute) : '';
      for (const [key, buffer] of buffers) {
        if (exceptKey && key === exceptKey) continue;
        buffer.flushToolBoundary();
      }
    },
    dispose() {
      for (const buffer of buffers.values()) buffer.dispose();
      buffers.clear();
    },
  };
}
