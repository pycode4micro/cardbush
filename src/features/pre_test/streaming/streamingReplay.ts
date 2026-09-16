import type { ChatMessage, ChatToolExecution, StreamExecutionUpdate, TurnTerminalSnapshot } from '../../../types';
import { createSegmentedAssistantStreamBuffers, type AssistantStreamRoute } from '../../chatMessages/transcript/assistantStreamBuffer';
import { appendAssistantDelta, appendToolExecution, applyAssistantSegmentBoundary, applyTurnTerminalSnapshot, replaceAssistantStreamContent } from '../../chatMessages/transcript/liveMessageUpdates';
import { mergeFinalStreamMessages, normalizeChatMessagesForDisplay } from '../../chatMessages/transcript/messageProjection';
import { createFrameStreamBuffers, type FrameStreamScheduler } from './frameStreamBuffer';

export type ReplayMode = 'baseline' | 'frame';
export type ReplayEvent =
  | { kind: 'delta'; content: string; route: AssistantStreamRoute }
  | { kind: 'segment'; content: string; route: AssistantStreamRoute }
  | { kind: 'tool'; execution: ChatToolExecution }
  | { kind: 'guidance'; message: ChatMessage; update: StreamExecutionUpdate }
  | { kind: 'snapshot'; messages: ChatMessage[] }
  | { kind: 'terminal'; terminal: TurnTerminalSnapshot };
export const replaySession = 'streaming-lab';
export const replayTurn = 'streaming-lab-turn';
export const replayAssistant = 'lab-first';
export interface ReplayIdentity { sessionId: string; turnId: string; assistantId: string }
export interface ReplayFixture {
  initial: ChatMessage[];
  events: Array<{ at: number; event: ReplayEvent }>;
  duration: number;
  identity?: ReplayIdentity;
}

export function createStreamingReplay(mode: ReplayMode, initial: ChatMessage[], options: {
  scheduler?: FrameStreamScheduler;
  now?: () => number;
  identity?: ReplayIdentity;
} = {}) {
  const { sessionId, turnId, assistantId } = options.identity ?? {
    sessionId: replaySession, turnId: replayTurn, assistantId: replayAssistant,
  };
  const listeners = new Set<() => void>();
  let state: Record<string, ChatMessage[]> = { [sessionId]: initial };
  let active = true;
  let disposed = false;
  let commits = 0;
  let firstDeltaAt: number | null = null;
  let firstReleaseMs: number | null = null;
  const now = options.now ?? (() => performance.now());
  const pending = new Set<Promise<void>>();
  const snapshot = () => ({ messages: state[sessionId], active, commits, firstReleaseMs });
  let current = snapshot();
  const notify = () => {
    if (disposed) return;
    current = snapshot();
    listeners.forEach(listener => listener());
  };
  const track = (promise: Promise<void>) => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise));
  };
  const append: Parameters<typeof createSegmentedAssistantStreamBuffers>[0] = (delta, route, release) => {
    if (disposed) return;
    if (delta && firstReleaseMs == null && firstDeltaAt != null) firstReleaseMs = now() - firstDeltaAt;
    state = appendAssistantDelta(state, sessionId, assistantId, delta, route, release);
    commits++;
    notify();
  };
  const buffer = mode === 'baseline' ? createSegmentedAssistantStreamBuffers(append) : createFrameStreamBuffers(append, {
    scheduler: options.scheduler,
    replace(content, route) {
      state = replaceAssistantStreamContent(state, sessionId, assistantId, content, route);
      commits++;
      notify();
    },
  });

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => current,
    async idle() { await Promise.all([...pending]); },
    accept(event: ReplayEvent) {
      if (disposed) return;
      switch (event.kind) {
        case 'delta':
          firstDeltaAt ??= now();
          buffer.push(event.content, event.route);
          break;
        case 'segment':
          track(buffer.completeSegment(event.content, event.route));
          break;
        case 'tool': {
          const apply = () => {
            if (disposed) return;
            state = appendToolExecution(state, sessionId, assistantId, event.execution);
            notify();
          };
          if (mode === 'frame') { buffer.flushToolBoundary(); apply(); }
          else track(buffer.releaseToolBoundary().then(apply));
          break;
        }
        case 'guidance':
          if (mode === 'frame') buffer.flushToolBoundary();
          state = { ...state, [sessionId]: [...state[sessionId], event.message] };
          state = applyAssistantSegmentBoundary(state, sessionId, assistantId, event.update);
          notify();
          break;
        case 'snapshot':
          track(buffer.releaseTerminal().then(() => {
            if (disposed) return;
            state = mergeFinalStreamMessages(state, sessionId, event.messages, {
              turnId, temporaryMessageIds: [], toolSourceMessageId: assistantId,
            });
            notify();
          }));
          break;
        case 'terminal':
          track((event.terminal.status === 'completed' ? buffer.releaseTerminal() : buffer.flushAllStreaming()).then(() => {
            if (disposed) return;
            active = false;
            notify();
          }));
          state = applyTurnTerminalSnapshot(state, sessionId, assistantId, event.terminal);
          notify();
          break;
      }
    },
    dispose() { disposed = true; buffer.dispose(); listeners.clear(); },
  };
}

/** Compare user-visible facts, not timestamps or intentional animation markers. */
export function replaySemanticSnapshot(messages: ChatMessage[]): unknown {
  return normalizeChatMessagesForDisplay(messages).map(message => ({
    id: message.messageId ?? message.id, role: message.role, content: message.content,
    status: message.status, boundary: message.metadata?.segment_boundary,
    tools: message.toolExecutions?.map(tool => ({ id: tool.id, name: tool.name, state: tool.state,
      output: tool.output, contentOffset: tool.contentOffset })),
    history: message.loopHistory ? replaySemanticSnapshot(message.loopHistory) : undefined,
  }));
}

export function replayDifferencePaths(left: unknown, right: unknown, path = ''): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return [path];
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .flatMap(key => replayDifferencePaths(a[key], b[key], `${path}/${key}`));
}
