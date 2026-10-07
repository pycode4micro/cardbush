import { Suspense } from 'react';
import type { AppLanguage, ChatMessage } from '../../types';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import type { SubagentConversationOptions } from '../subagents/SubagentConversation';

// Reading a turn's history must not initialize a child conversation or its
// local/remote execution adapters. Each panel owns its own deferred boundary.
const TurnHistoryInspector = recoverableLazy('turn-history',
  async () => ({ default: (await import('./TurnHistoryInspector')).TurnHistoryInspector }),
  (props, retry) => <DeferredModuleNotice language={props.language} retry={retry}/>);
const SubagentTaskInspector = recoverableLazy('subagent-task',
  async () => ({ default: (await import('../subagents/SubagentTaskInspector')).SubagentTaskInspector }),
  (props, retry) => <DeferredModuleNotice language={props.language} retry={retry}/>);

export function WorkSummaryInspector({ detail, messages, language, active = true, conversationOptions }: {
  detail: WorkSummaryInspectorDetail;
  messages: ChatMessage[];
  language: AppLanguage;
  active?: boolean;
  conversationOptions?: SubagentConversationOptions;
}) {
  return <Suspense fallback={<div className="deferred-module-notice" role="status">{language === 'zh' ? '正在加载执行详情…' : 'Loading execution details…'}</div>}>
    {detail.kind === 'turn-history'
      ? <TurnHistoryInspector detail={detail} messages={messages} language={language} active={active}/>
      : <SubagentTaskInspector detail={detail} language={language} active={active} conversationOptions={conversationOptions}/>}
  </Suspense>;
}
