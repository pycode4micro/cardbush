import { useEffect, useRef, useState } from 'react';

import { recordUiPerformanceMetric } from '../../shared/uiPerformanceTrace';
import {
  createThinkingNoticeProjection,
  type ThinkingNotice,
  type ThinkingNoticeEvent,
} from './thinkingNoticeProjection';

export const thinkingEventName = 'cardbush:thinking';

export function useLiveThinkingNotice({
  activeConversationId,
  enabled,
  running,
}: {
  activeConversationId: string;
  enabled: boolean;
  running: boolean;
}) {
  const [notice, setNotice] = useState<ThinkingNotice | null>(null);
  const contextRef = useRef({ activeConversationId, enabled, running });
  const projectionRef = useRef<ReturnType<typeof createThinkingNoticeProjection> | null>(null);

  useEffect(() => {
    contextRef.current = { activeConversationId, enabled, running };
    if (!enabled || !running) {
      projectionRef.current?.clear();
    }
  }, [activeConversationId, enabled, running]);

  useEffect(() => {
    const projection = createThinkingNoticeProjection(setNotice, {
      onCommit: (next) => {
        recordUiPerformanceMetric('reasoning_projection_commit', {
          sessionId: contextRef.current.activeConversationId,
          value: next?.content.length ?? 0,
        });
      },
    });
    projectionRef.current = projection;
    const receive = (event: Event) => {
      const context = contextRef.current;
      if (!context.enabled || !context.running) return;
      const detail = thinkingEventDetail(event);
      if (!detail) return;
      const sourceSessionId = detail.sessionId;
      if (
        sourceSessionId &&
        context.activeConversationId &&
        sourceSessionId !== context.activeConversationId
      ) {
        return;
      }
      recordUiPerformanceMetric(`reasoning_${detail.event.phase}_received`, {
        sessionId: context.activeConversationId,
        value: detail.event.delta.length,
      });
      projection.accept(detail.event);
    };
    window.addEventListener(thinkingEventName, receive);
    return () => {
      window.removeEventListener(thinkingEventName, receive);
      projection.dispose();
      projectionRef.current = null;
    };
  }, []);

  return notice;
}

function thinkingEventDetail(event: Event): {
  sessionId: string;
  event: ThinkingNoticeEvent;
} | null {
  if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') {
    return null;
  }
  const detail = event.detail as Record<string, unknown>;
  const channel = String(detail.channel ?? 'reasoning').trim().toLowerCase();
  if (channel !== 'reasoning') return null;
  const turnId = String(detail.turnId ?? detail.turn_id ?? detail.id ?? '').trim();
  const id = String(
    detail.generationId ?? detail.generation_id ?? detail.id ?? turnId,
  ).trim();
  const rawPhase = String(detail.phase ?? 'delta').trim().toLowerCase();
  const phase = rawPhase === 'start' || rawPhase === 'end' ? rawPhase : 'delta';
  if (!turnId || !id) return null;
  return {
    sessionId: String(detail.sessionId ?? detail.session_id ?? '').trim(),
    event: {
      id,
      turnId,
      phase,
      delta: phase === 'delta' ? String(detail.delta ?? '') : '',
      createdAt: String(detail.createdAt ?? new Date().toISOString()),
    },
  };
}
