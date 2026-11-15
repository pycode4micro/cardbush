import { useEffect, useMemo, useState } from 'react';
import { usableUserMessagePrediction, type UserMessagePrediction } from '@cardbush/bush-protocol';
import type { ChatMessage } from '../../types';
import { conversationViewKey, useConversationViewState } from '../../shared/conversationViewState';
import { latestUserMessagePrediction } from './userMessagePrediction';

export function useUserMessagePrediction(messages: ChatMessage[], sessionId: string, hostId: string | undefined, enabled: boolean, supplied?: UserMessagePrediction) {
  const [clock, tick] = useState(0);
  const prediction = useMemo(() => !enabled ? undefined : supplied ? usableUserMessagePrediction(supplied)
    : latestUserMessagePrediction(messages, sessionId), [messages, sessionId, supplied, enabled, clock]);
  const [dismissed, dismiss] = useConversationViewState(conversationViewKey(hostId, sessionId, 'accepted-prediction'), () => '');
  useEffect(() => {
    if (!prediction || prediction.expiresAt <= Date.now()) return;
    const timer = window.setTimeout(() => tick(value => value + 1), Math.min(prediction.expiresAt - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [prediction, clock]);
  return { prediction: prediction && prediction.expiresAt > Date.now() && prediction.id !== dismissed ? prediction : undefined, dismiss };
}
