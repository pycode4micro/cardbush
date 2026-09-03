export type ThinkingNotice = {
  id: string;
  turnId: string;
  preview: string;
  content: string;
  createdAt: string;
};

export type ThinkingNoticeEvent = {
  id: string;
  turnId: string;
  phase: 'start' | 'delta' | 'end';
  delta: string;
  createdAt: string;
};

type ThinkingNoticeScheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timer: number) => void;
};

const defaultProjectionIntervalMs = 120;
const previewCharacterLimit = 320;

export function createThinkingNoticeProjection(
  commit: (notice: ThinkingNotice | null) => void,
  options: {
    intervalMs?: number;
    scheduler?: ThinkingNoticeScheduler;
    onCommit?: (notice: ThinkingNotice | null) => void;
  } = {},
) {
  const intervalMs = Math.max(16, options.intervalMs ?? defaultProjectionIntervalMs);
  const scheduler = options.scheduler ?? browserScheduler();
  let draft: ThinkingNotice | null = null;
  let committed: ThinkingNotice | null = null;
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer === undefined) return;
    scheduler.clearTimer(timer);
    timer = undefined;
  };

  const publish = () => {
    if (disposed) return;
    cancelTimer();
    if (sameNotice(committed, draft)) return;
    committed = draft ? { ...draft } : null;
    lastCommitAt = scheduler.now();
    commit(committed);
    options.onCommit?.(committed);
  };

  const schedule = () => {
    if (timer !== undefined || disposed) return;
    const remaining = Math.max(0, intervalMs - (scheduler.now() - lastCommitAt));
    timer = scheduler.setTimer(publish, remaining);
  };

  return {
    accept(event: ThinkingNoticeEvent) {
      if (disposed) return;
      if (event.phase === 'start') {
        // Keep the previous preview in place until the next segment has text.
        // This avoids a clear/recreate render pair between adjacent reasoning
        // segments while preserving the segment identity in the next delta.
        draft = null;
        cancelTimer();
        return;
      }
      if (event.phase === 'end') {
        if (!draft || draft.id === event.id || committed?.id === event.id) {
          draft = null;
          publish();
        }
        return;
      }
      if (!event.delta || !event.id || !event.turnId) return;
      const currentDraft = draft;
      const sameGeneration = currentDraft?.id === event.id;
      const content = sameGeneration
        ? `${currentDraft.content}${event.delta}`
        : event.delta;
      draft = {
        id: event.id,
        turnId: event.turnId,
        preview: appendPreview(sameGeneration ? currentDraft.preview : '', event.delta),
        content,
        createdAt: sameGeneration ? currentDraft.createdAt : event.createdAt,
      };
      if (!committed || committed.id !== event.id) {
        publish();
      } else if (scheduler.now() - lastCommitAt >= intervalMs) {
        publish();
      } else {
        schedule();
      }
    },
    clear() {
      draft = null;
      cancelTimer();
      publish();
    },
    dispose() {
      disposed = true;
      cancelTimer();
      draft = null;
      committed = null;
    },
    snapshot() {
      return draft ? { ...draft } : null;
    },
  };
}

function appendPreview(current: string, delta: string) {
  const normalized = delta.replace(/\s+/g, ' ');
  const joined = `${current}${normalized}`.trimStart();
  return joined.length <= previewCharacterLimit
    ? joined
    : joined.slice(-previewCharacterLimit);
}

function sameNotice(left: ThinkingNotice | null, right: ThinkingNotice | null) {
  return left === right || Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.content === right.content,
  );
}

function browserScheduler(): ThinkingNoticeScheduler {
  return {
    now: () => performance.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (timer) => window.clearTimeout(timer),
  };
}
