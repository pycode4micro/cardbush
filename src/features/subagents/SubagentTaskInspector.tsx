import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchSubagentTask } from '../../backend/api';
import type { AppLanguage, SubagentDispatchEvent, SubagentTaskSnapshot } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { SUBAGENT_DISPATCH_UI_EVENT, type WorkSummaryInspectorDetail } from './subagentObservabilityEvents';
import { SubagentConversation, type SubagentConversationOptions } from './SubagentConversation';

export function SubagentTaskInspector({ detail, language, active, conversationOptions }: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'subagent-task' }>;
  language: AppLanguage;
  active: boolean;
  conversationOptions?: SubagentConversationOptions;
}) {
  const host = useContext(ConversationHostContext);
  const [task, setTask] = useState(detail.task);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const refreshSequence = useRef(0);
  useEffect(() => setTask(current => current.taskId === detail.task.taskId
    ? mergeTask(current, detail.task) : detail.task), [detail.task]);
  const parentSessionId = host?.sessionId ?? detail.sessionId;
  const refresh = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!detail.task.taskId) return;
    const sequence = ++refreshSequence.current;
    if (!silent) setRefreshing(true);
    try {
      const next = await fetchSubagentTask(detail.task.taskId, signal, parentSessionId, host?.runtime);
      if (!signal?.aborted && sequence === refreshSequence.current) {
        setTask(current => mergeTask(current, next)); setError('');
      }
    } catch (caught) {
      if (!signal?.aborted && sequence === refreshSequence.current) setError(String(caught));
    } finally { if (!silent && !signal?.aborted) setRefreshing(false); }
  }, [detail.task.taskId, parentSessionId, host?.runtime]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const update = () => { if (document.visibilityState !== 'hidden') void refresh(controller.signal, true); };
    const dispatch = (raw: Event) => {
      const event = (raw as CustomEvent<SubagentDispatchEvent>).detail;
      if (event?.parentSessionId === parentSessionId && event.taskId === detail.task.taskId) update();
    };
    update();
    const timer = window.setInterval(update, 2500);
    window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch); };
  }, [active, refresh, parentSessionId, detail.task.taskId]);
  return <SubagentConversation {...conversationOptions} task={task} parentSessionId={parentSessionId}
    language={language} active={active} refresh={refresh} refreshing={refreshing} error={error}/>;
}

function mergeTask(current: SubagentTaskSnapshot, next: SubagentTaskSnapshot) {
  if (current.terminal && !next.terminal) return current;
  if (Date.parse(next.updatedAt || '') < Date.parse(current.updatedAt || '')) return current;
  return {
    ...current,
    ...next,
    taskId: next.taskId || current.taskId,
    toolCallId: next.toolCallId || current.toolCallId,
    requestPrompt: next.requestPrompt || current.requestPrompt,
    responsePrompt: next.responsePrompt || current.responsePrompt,
    errorMessage: next.errorMessage,
    raw: { ...current.raw, ...next.raw },
  };
}
