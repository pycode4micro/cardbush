import { useMemo } from 'react';

import {
  mergeFinalStreamMessages,
  normalizeActiveTurnTranscriptForDisplay,
  normalizeChatMessagesForDisplay,
} from '../../hooks/useCardbushChat';
import type {
  AppLanguage,
  ChatMessage,
  ChatToolExecution,
} from '../../types';
import {
  MessageBubble,
  MessageFileReferenceScope,
} from '../chatMessages';
import { ConversationWorkSummary } from '../chat/ConversationWorkSummary';

const sessionId = 'pre-test-loop-history';
const turnId = 'pre-test-loop-turn';

export function isLoopHistoryPreTestEnabled() {
  const query = new URLSearchParams(window.location.search).get('pre_test');
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pre_test');
  return query === 'loop-history' ||
    hash === 'loop-history' ||
    window.localStorage.getItem('cardbush_pre_test') === 'loop-history';
}

export function LoopHistoryPreTest({ language }: { language: AppLanguage }) {
  const fixture = useMemo(buildMergedFixture, []);
  const messages = fixture.messages;
  const activeMessages = fixture.activeMessages;
  const assistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const historyCount = assistantMessage?.loopHistory?.length ?? 0;
  const expectedHistoryCount = 4;
  const passed = historyCount === expectedHistoryCount &&
    fixture.streamHistoryCount === expectedHistoryCount &&
    fixture.activeHistoryCount === 2;

  return (
    <div className="chat-panel loop-history-pre-test">
      <header className="loop-history-pre-test-header">
        <span>
          <strong>{language === 'zh' ? 'Loop 历史合并 · Pre Test' : 'Loop history merge · Pre Test'}</strong>
          <small>
            {language === 'zh'
              ? '本地测试数据：后端历史重载 + 流式临时消息 → 最终快照'
              : 'Local fixture: backend history reload + streaming draft → final snapshot'}
          </small>
        </span>
        <output className={passed ? 'passed' : 'failed'} data-testid="loop-history-result">
          {passed ? 'PASS' : 'FAIL'} · active {fixture.activeHistoryCount}/2 · reload{' '}
          {historyCount}/{expectedHistoryCount} · stream {fixture.streamHistoryCount}/{expectedHistoryCount}
        </output>
      </header>
      <main className="loop-history-pre-test-stage">
        <div className="loop-history-pre-test-notice">
          <strong>
            {language === 'zh'
              ? '点击“历史执行 4 条 · 4 个工具”展开验证'
              : 'Expand “Loop history 4 · 4 tools” to verify'}
          </strong>
          <span>
            {language === 'zh'
              ? '完成后的 Plan 应位于历史详情顶部；第 1 段前不应出现多余分隔线。'
              : 'The completed Plan should be archived above the steps without an extra first divider.'}
          </span>
        </div>
        <MessageFileReferenceScope workspaceRoot="C:\\workspace\\cardbush-electron">
          <div className="loop-history-pre-test-layout">
            <div className="message-list loop-history-pre-test-messages">
              {activeMessages.map((message) => (
                <MessageBubble
                  key={`active:${message.id}`}
                  message={message}
                  language={language}
                  sending
                  activeTurnId="pre-test-active-turn"
                  activeAssistantMessageId="pre-test-active-3"
                  selectedModel="glm-5"
                  onRegenerate={async () => undefined}
                  onEditUserMessage={async () => undefined}
                  onGuideMessage={async () => undefined}
                  onRetryGuidance={async () => undefined}
                  onRevertChangeReport={async () => undefined}
                  onOpenScene={() => undefined}
                />
              ))}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  language={language}
                  sending={false}
                  activeTurnId=""
                  activeAssistantMessageId=""
                  onRegenerate={async () => undefined}
                  onEditUserMessage={async () => undefined}
                  onGuideMessage={async () => undefined}
                  onRetryGuidance={async () => undefined}
                  onRevertChangeReport={async () => undefined}
                  onOpenScene={() => undefined}
                />
              ))}
            </div>
            <div className="loop-history-pre-test-summary">
              <ConversationWorkSummary
                language={language}
                sessionId={sessionId}
                messages={messages}
                changeReports={[]}
                onOpenChangeReview={() => undefined}
              />
            </div>
          </div>
        </MessageFileReferenceScope>
      </main>
    </div>
  );
}

function buildMergedFixture() {
  const activeMessages = normalizeActiveTurnTranscriptForDisplay([
    {
      ...historyMessage(
        1,
        '我先读取入口文件，确认事件绑定。',
        toolExecution(1, 'read_file', '入口文件读取完成'),
        'assistant_segment',
      ),
      id: 'pre-test-active-1',
      turnId: 'pre-test-active-turn',
    },
    {
      ...historyMessage(
        2,
        '入口已经确认，接着检查样式与历史合并。',
        toolExecution(2, 'search_file_content', '合并路径定位完成'),
        'assistant_segment',
      ),
      id: 'pre-test-active-2',
      turnId: 'pre-test-active-turn',
    },
    {
      id: 'pre-test-active-3',
      role: 'assistant',
      turnId: 'pre-test-active-turn',
      content: '两次工具结果都已返回，现在运行最终验证。',
      status: 'streaming',
      metadata: {
        transcript_kind: 'assistant_segment',
        assistant_segment_index: 3,
      },
    },
  ], 'pre-test-active-turn');
  const changedFileExecution = toolExecution(
    3,
    'write_file',
    '已更新 loop 历史合并逻辑',
  );
  changedFileExecution.metadata = {
    ...changedFileExecution.metadata,
    kind: 'file_change',
    files: [
      {
        path: 'src/hooks/useCardbushChat.ts',
        additions: 18,
        deletions: 4,
        diff: '+merge\n-old',
      },
      {
        path: 'src/features/chatMessages/MessageBubble.tsx',
        additions: 12,
        deletions: 2,
        diff: '+render\n-old',
      },
      {
        path: 'src/styles/app.css',
        additions: 24,
        deletions: 3,
        diff: '+style\n-old',
      },
      {
        path: 'scripts/test-history-tool-contract.mjs',
        additions: 9,
        deletions: 0,
        diff: '+test',
      },
      { path: 'README.md', additions: 3, deletions: 1, diff: '+docs\n-old' },
    ],
  };
  const archivedSteps = [
    historyMessage(
      1,
      '先读取会话与流式合并代码，确认临时 assistant 的生命周期。',
      toolExecution(1, 'read_file', '已读取 useCardbushChat.ts'),
      'assistant_segment',
    ),
    historyMessage(
      2,
      '定位最终快照替换路径，检查 loopHistory 是否在替换过程中被保留。',
      toolExecution(2, 'search_file_content', '已定位 mergeFinalStreamMessages'),
      'assistant_segment',
    ),
    historyMessage(
      3,
      '修正嵌套历史的归一化逻辑，并保留稳定的执行顺序。',
      changedFileExecution,
      'assistant_loop',
    ),
  ];
  const streamingMessage: ChatMessage = {
    ...historyMessage(
      4,
      '运行类型检查并核对历史面板的最终展示。',
      toolExecution(4, 'shell_command', 'npm run typecheck 已通过'),
      'assistant_loop',
    ),
    id: 'temporary-assistant-loop-4',
    loopHistory: archivedSteps,
  };
  const finalMessage: ChatMessage = {
    id: 'persisted-final-assistant',
    messageId: 'persisted-final-assistant',
    role: 'assistant',
    turnId,
    content: '问题已修复：最终快照替换后，四段 loop 消息都会完整归档，Plan 也只显示在历史详情内。',
    status: 'completed',
    createdAt: '2026-08-14T12:00:05.000Z',
    metadata: {
      transcript_kind: 'assistant_final',
      assistant_segment_index: 5,
      turn_id: turnId,
    },
    taskPlan: {
      protocol: 'bush.task_plan.v1',
      planId: 'pre-test-loop-plan',
      sessionId,
      explanation: '验证 loop 历史在最终快照合并后保持完整。',
      active: false,
      nodes: [
        { id: 'plan-1', step: '读取流式合并路径', status: 'completed' },
        { id: 'plan-2', step: '复现嵌套 loopHistory 丢失', status: 'completed' },
        { id: 'plan-3', step: '修复覆盖判断与递归归一化', status: 'completed' },
        { id: 'plan-4', step: '在 pre_test 验证最终历史', status: 'completed' },
      ],
    },
  };
  const current = {
    [sessionId]: [
      {
        id: 'pre-test-user',
        role: 'user' as const,
        turnId,
        content: '检查 loop 消息在最终快照到达后是否会丢失。',
        createdAt: '2026-08-14T12:00:00.000Z',
      },
      streamingMessage,
    ],
  };
  const streamMessages = mergeFinalStreamMessages(current, sessionId, [finalMessage], {
    turnId,
    temporaryMessageIds: [streamingMessage.id],
  })[sessionId];
  const streamAssistant = [...streamMessages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const reloadedMessages = normalizeChatMessagesForDisplay([
    current[sessionId][0],
    ...archivedSteps,
    historyMessage(
      4,
      '运行类型检查并核对历史面板的最终展示。',
      toolExecution(4, 'shell_command', 'npm run typecheck 已通过'),
      'assistant_segment',
    ),
    finalMessage,
  ]);
  return {
    activeMessages,
    activeHistoryCount: activeMessages.find((message) => message.role === 'assistant')
      ?.loopHistory?.length ?? 0,
    messages: reloadedMessages,
    streamHistoryCount: streamAssistant?.loopHistory?.length ?? 0,
  };
}

function historyMessage(
  index: number,
  content: string,
  execution: ChatToolExecution,
  transcriptKind: 'assistant_loop' | 'assistant_segment',
): ChatMessage {
  const archivedSegment = transcriptKind === 'assistant_segment';
  return {
    id: `persisted-loop-${index}`,
    messageId: `persisted-loop-${index}`,
    role: 'assistant',
    turnId,
    content,
    status: archivedSegment ? 'completed' : 'superseded',
    loopIndex: index,
    sequence: index,
    createdAt: `2026-08-14T12:00:0${index}.000Z`,
    toolExecutions: [execution],
    metadata: {
      transcript_kind: transcriptKind,
      ...(archivedSegment ? { history_visibility: 'ephemeral' } : {}),
      assistant_segment_index: index,
      turn_id: turnId,
    },
  };
}

function toolExecution(
  index: number,
  name: string,
  summary: string,
): ChatToolExecution {
  return {
    id: `pre-test-tool-${index}`,
    name,
    state: 'completed',
    summary,
    output: summary,
    success: true,
    durationMs: 180 + index * 40,
    createdAt: `2026-08-14T12:00:0${index}.000Z`,
    contentOffset: 0,
    sequence: index,
    loopIndex: index,
    turnId,
    assistantMessageId: `persisted-loop-${index}`,
    assistantSegmentIndex: index,
    metadata: { state: 'completed' },
  };
}
