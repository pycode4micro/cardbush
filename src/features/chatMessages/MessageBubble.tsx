import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  Edit3,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  WrapText,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import type { AppLanguage, ChatMessage, ChatToolExecution } from '../../types';
import type { CardlingScene } from '../cardling/scene';
import { normalizeMarkdownContentForDisplay } from './markdownFormat';
import {
  COPY_FEEDBACK_EVENT,
  copyText,
  readAssistantFeedback,
  recordAssistantFeedback,
  type AssistantFeedbackRating,
} from '../messageFeedback';
import { splitMessageImages } from '../messageImages';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import {
  compareToolExecutionOrder,
  isToolRunning,
  isToolRunningInContext,
  looksLikeFileChangeExecution,
  ToolExecutionBlock,
  toolExecutionFinishedAt,
  type ConversationChangeReport,
} from '../tools';
import { asRecord } from '../tools/toolPayload';

export type GuidanceMode = 'append_context' | 'interrupt_and_continue';

type ImagePreview = {
  src: string;
  name: string;
  path?: string;
};

const LazyMarkdownContent = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);

  function MarkdownRenderer({ content }: { content: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                if (!href || href.startsWith('#')) {
                  return;
                }
                event.preventDefault();
                void (
                  window.cardbushDesktop?.openUiPreview ??
                  window.cardbushDesktop?.openExternal
                )?.(href);
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children, ...props }) => (
            <MarkdownCodeBlock {...props}>{children}</MarkdownCodeBlock>
          ),
        }}
      >
        {normalizeMarkdownContentForDisplay(content)}
      </ReactMarkdown>
    );
  }

  return { default: MarkdownRenderer };
});

function MarkdownCodeBlock({
  children,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  const [wrapped, setWrapped] = useState(false);
  const text = reactNodeText(children);
  return (
    <div className={`markdown-code-block ${wrapped ? 'wrapped' : ''}`}>
      <div className="markdown-code-actions">
        <button
          type="button"
          aria-pressed={wrapped}
          title={wrapped ? '取消换行' : '换行显示'}
          onClick={() => setWrapped((value) => !value)}
        >
          <WrapText size={12} />
          <span>{wrapped ? '不换行' : '换行'}</span>
        </button>
        <button
          type="button"
          title="复制"
          onClick={() => void copyText(text).catch(() => undefined)}
        >
          <Clipboard size={12} />
          <span>复制</span>
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

function reactNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(reactNodeText).join('');
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const props = node.props as { children?: ReactNode };
    return reactNodeText(props.children);
  }
  return '';
}

export function MessageBubble({
  message,
  language,
  sending,
  activeTurnId,
  activeAssistantMessageId,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRevertChangeReport,
  onOpenScene,
}: {
  message: ChatMessage;
  language: AppLanguage;
  sending: boolean;
  activeTurnId: string;
  activeAssistantMessageId: string;
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onGuideMessage: (
    message: ChatMessage,
    guidance: string,
    mode: GuidanceMode,
  ) => Promise<void>;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const { imagePaths, text } = splitMessageImages(message.content);
  const allToolExecutions = message.toolExecutions ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [assistantFeedback, setAssistantFeedback] =
    useState<AssistantFeedbackRating | null>(() => readAssistantFeedback(message.id));
  const [feedbackPulse, setFeedbackPulse] =
    useState<AssistantFeedbackRating | null>(null);
  const feedbackPulseFrameRef = useRef<number | null>(null);
  const feedbackPulseTimerRef = useRef<number | null>(null);
  const activeMessageTurn = message.turnId?.trim() ?? '';
  const activeTurn = activeTurnId.trim();
  const activeAssistantId = activeAssistantMessageId.trim();
  const isActiveAssistantTurn =
    message.role === 'assistant' &&
    sending &&
    activeAssistantId === message.id &&
    (!activeTurn || !activeMessageTurn || activeTurn === activeMessageTurn);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const canGuide =
    isActiveAssistantTurn;

  useEffect(() => {
    if (!isActiveAssistantTurn) {
      return undefined;
    }
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActiveAssistantTurn]);

  useEffect(() => {
    setEditing(false);
    setSubmittingEdit(false);
    setGuidanceOpen(false);
    setAssistantFeedback(readAssistantFeedback(message.id));
    setFeedbackPulse(null);
    setEditText(splitMessageImages(message.content).text);
  }, [message.id, message.content]);

  useEffect(() => {
    return () => {
      if (feedbackPulseFrameRef.current != null) {
        window.cancelAnimationFrame(feedbackPulseFrameRef.current);
      }
      if (feedbackPulseTimerRef.current != null) {
        window.clearTimeout(feedbackPulseTimerRef.current);
      }
    };
  }, []);

  if (message.role === 'system' || message.role === 'guidance' || message.role === 'tool') {
    return null;
  }

  async function submitEdit() {
    if (submittingEdit) {
      return;
    }
    const nextContent = [
      ...imagePaths.map((pathValue) => `@${pathValue}`),
      editText.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (!nextContent.trim()) {
      return;
    }
    if (nextContent.trim() === message.content.trim()) {
      setEditing(false);
      return;
    }
    setSubmittingEdit(true);
    try {
      await onEditUserMessage(message, nextContent);
      setEditing(false);
    } finally {
      setSubmittingEdit(false);
    }
  }

  function toggleAssistantFeedback(rating: AssistantFeedbackRating) {
    const nextRating = assistantFeedback === rating ? null : rating;
    playAssistantFeedbackPulse(rating);
    setAssistantFeedback(nextRating);
    recordAssistantFeedback(message, nextRating);
  }

  function playAssistantFeedbackPulse(rating: AssistantFeedbackRating) {
    if (feedbackPulseFrameRef.current != null) {
      window.cancelAnimationFrame(feedbackPulseFrameRef.current);
    }
    if (feedbackPulseTimerRef.current != null) {
      window.clearTimeout(feedbackPulseTimerRef.current);
    }
    setFeedbackPulse(null);
    feedbackPulseFrameRef.current = window.requestAnimationFrame(() => {
      setFeedbackPulse(rating);
      feedbackPulseTimerRef.current = window.setTimeout(() => {
        setFeedbackPulse(null);
        feedbackPulseTimerRef.current = null;
      }, 520);
      feedbackPulseFrameRef.current = null;
    });
  }

  if (message.role === 'user') {
    if (editing) {
      return (
        <div className="message-row user">
          <div className="user-edit-card">
            <MessageImageStrip paths={imagePaths} />
            <textarea
              value={editText}
              autoFocus
              onChange={(event) => setEditText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitEdit();
                }
                if (event.key === 'Escape') {
                  setEditing(false);
                }
              }}
              placeholder={language === 'zh' ? '修改这条提问' : 'Edit this message'}
              rows={Math.min(5, Math.max(2, editText.split(/\r?\n/).length))}
            />
            <div className="message-edit-actions">
              <button
                type="button"
                disabled={submittingEdit}
                onClick={() => setEditing(false)}
              >
                {language === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={submittingEdit || (!editText.trim() && imagePaths.length === 0)}
                onClick={() => void submitEdit()}
              >
                {submittingEdit ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                {language === 'zh' ? '更新并重跑' : 'Update and rerun'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="message-row user">
        <div className="user-bubble">
          <MessageImageStrip paths={imagePaths} />
          {text && <MarkdownContent content={text} />}
        </div>
        <div className="message-actions">
          <button
            type="button"
            title={language === 'zh' ? '复制' : 'Copy'}
            onClick={() => void copyText(message.content).catch(() => undefined)}
          >
            <Clipboard size={14} />
          </button>
          <button
            type="button"
            title={language === 'zh' ? '编辑并重跑' : 'Edit and rerun'}
            disabled={sending}
            onClick={() => setEditing(true)}
          >
            <Edit3 size={14} />
          </button>
        </div>
      </div>
    );
  }

  const loopHistory =
    message.role === 'assistant'
      ? (message.loopHistory ?? []).filter(hasVisibleLoopHistoryMessage)
      : [];
  const visibleLoopHistory = isActiveAssistantTurn ? [] : loopHistory;
  const activeTranscriptMessages = isActiveAssistantTurn
    ? activeAssistantTranscriptMessages(loopHistory, message)
    : [];
  const renderActiveTranscript = activeTranscriptMessages.length > 1;
  const suppressFinalTopLevelTools =
    message.role === 'assistant' &&
    !isActiveAssistantTurn &&
    isFinalAssistantDisplayMessage(message);
  const toolExecutions =
    message.role === 'assistant'
      ? suppressFinalTopLevelTools
        ? []
        : visibleTopLevelToolExecutions(
            allToolExecutions,
            loopHistory,
            isActiveAssistantTurn,
          )
      : allToolExecutions;
  const assistantProgressExecutions = suppressFinalTopLevelTools
    ? allToolExecutions
    : toolExecutions;
  const showAssistantProgress =
    message.role === 'assistant' &&
    (isActiveAssistantTurn ||
      toolExecutions.length > 0 ||
      hasAssistantProgressSource(message, assistantProgressExecutions));
  const assistantProgressText = showAssistantProgress
    ? assistantProgressLabel({
        executions: assistantProgressExecutions,
        isActive: isActiveAssistantTurn,
        message,
        now: progressNow,
        language,
      })
    : '';
  const hasAssistantBody = Boolean(
    text.trim() ||
      imagePaths.length > 0 ||
      toolExecutions.length > 0 ||
      renderActiveTranscript ||
      visibleLoopHistory.length > 0 ||
      agentHookSummaryFromMessage(message),
  );
  if (!showAssistantProgress && !hasAssistantBody) {
    return null;
  }
  return (
    <>
      <div className="message-row assistant">
        <div className="assistant-bubble">
          {showAssistantProgress && (
            <div
              className={`assistant-run-header ${isActiveAssistantTurn ? 'running' : ''}`}
            >
              <span className="assistant-run-label">{assistantProgressText}</span>
              <div />
            </div>
          )}
          <AgentHookSummaryBadge message={message} language={language} />
          {!renderActiveTranscript && <MessageImageStrip paths={imagePaths} />}
          {renderActiveTranscript ? (
            <AssistantActiveTranscript
              messages={activeTranscriptMessages}
              language={language}
              active={isActiveAssistantTurn}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ) : toolExecutions.length > 0 ? (
            <AssistantMessageContent
              content={text}
              executions={toolExecutions}
              language={language}
              message={message}
              active={isActiveAssistantTurn}
              showThinkingPlaceholder={isActiveAssistantTurn}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ) : text ? (
            <>
              <MarkdownContent content={text} />
              {isActiveAssistantTurn && (
                <AssistantThinkingProcessLine language={language} />
              )}
            </>
          ) : isActiveAssistantTurn ? (
            <AssistantThinkingProcessLine language={language} />
          ) : null}
          {visibleLoopHistory.length > 0 && (
            <AssistantLoopHistoryBlock
              history={visibleLoopHistory}
              language={language}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          )}
        </div>
        <div className="message-actions">
          <button
            type="button"
            title={language === 'zh' ? '复制' : 'Copy'}
            onClick={() => void copyText(message.content).catch(() => undefined)}
          >
            <Clipboard size={14} />
          </button>
          <button
            className={`feedback-up ${assistantFeedback === 'up' ? 'active' : ''} ${
              feedbackPulse === 'up' ? 'feedback-pop' : ''
            }`}
            type="button"
            aria-pressed={assistantFeedback === 'up'}
            title={language === 'zh' ? '有帮助，记录给 LEM' : 'Helpful, record for LEM'}
            onClick={() => toggleAssistantFeedback('up')}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            className={`feedback-down ${assistantFeedback === 'down' ? 'active' : ''} ${
              feedbackPulse === 'down' ? 'feedback-pop' : ''
            }`}
            type="button"
            aria-pressed={assistantFeedback === 'down'}
            title={language === 'zh' ? '不理想，记录给 LEM' : 'Needs improvement, record for LEM'}
            onClick={() => toggleAssistantFeedback('down')}
          >
            <ThumbsDown size={14} />
          </button>
          {activeMessageTurn && (
            <button
              type="button"
              title={language === 'zh' ? '重新生成' : 'Retry'}
              disabled={sending}
              onClick={() => void onRegenerate(message)}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {canGuide && (
            <button
              type="button"
              title={language === 'zh' ? '插入引导' : 'Guide this turn'}
              onClick={() => setGuidanceOpen(true)}
            >
              <Sparkles size={14} />
            </button>
          )}
        </div>
      </div>
      {guidanceOpen && (
        <GuidanceDialog
          language={language}
          onCancel={() => setGuidanceOpen(false)}
          onSubmit={async (guidance, mode) => {
            await onGuideMessage(message, guidance, mode);
            setGuidanceOpen(false);
          }}
        />
      )}
    </>
  );
}

function AssistantActiveTranscript({
  messages,
  language,
  active,
  onRevertChangeReport,
  onOpenScene,
}: {
  messages: ChatMessage[];
  language: AppLanguage;
  active: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const visibleMessages = messages.filter(hasVisibleLoopHistoryMessage);
  if (visibleMessages.length === 0) {
    return null;
  }
  const hasRunningTool = visibleMessages.some((message) =>
    (message.toolExecutions ?? []).some((execution) => isToolRunningInContext(execution, active)),
  );
  const showThinkingPlaceholder = active && !hasRunningTool;
  return (
    <div className="assistant-active-transcript">
      {visibleMessages.map((segment, index) => {
        const { imagePaths, text } = splitMessageImages(segment.content);
        const executions = segment.toolExecutions ?? [];
        const isLastSegment = index === visibleMessages.length - 1;
        return (
          <section
            // eslint-disable-next-line react/no-array-index-key
            key={`${segment.id}-${index}`}
            className="assistant-active-transcript-segment"
          >
            <MessageImageStrip paths={imagePaths} />
            {executions.length > 0 ? (
              <AssistantMessageContent
                content={text}
                executions={executions}
                language={language}
                message={segment}
                active
                showThinkingPlaceholder={showThinkingPlaceholder && isLastSegment}
                onRevertChangeReport={onRevertChangeReport}
                onOpenScene={onOpenScene}
              />
            ) : text ? (
              <>
                <MarkdownContent content={text} />
                {showThinkingPlaceholder && isLastSegment && (
                  <AssistantThinkingProcessLine language={language} />
                )}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function activeAssistantTranscriptMessages(
  loopHistory: ChatMessage[],
  currentMessage: ChatMessage,
) {
  return [...loopHistory, currentMessage].filter(hasVisibleLoopHistoryMessage);
}

function AssistantMessageContent({
  content,
  executions,
  language,
  message,
  active,
  showThinkingPlaceholder = false,
  onRevertChangeReport,
  onOpenScene,
}: {
  content: string;
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  active: boolean;
  showThinkingPlaceholder?: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const sortedExecutions = [...executions].sort(compareToolExecutionOrder);
  const groups = groupExecutionsByContentOffset(content, sortedExecutions);
  const blocks: ReactNode[] = [];
  let cursor = 0;

  groups.forEach((group, index) => {
    const segment = content.slice(cursor, group.offset);
    if (segment.trim()) {
      blocks.push(
        // eslint-disable-next-line react/no-array-index-key
        <MarkdownContent key={`text-${index}`} content={segment.trim()} />,
      );
    }
    blocks.push(
      <ToolExecutionBlock
        // eslint-disable-next-line react/no-array-index-key
        key={`tools-${group.offset}-${index}`}
        executions={group.executions}
        language={language}
        message={message}
        active={active}
        onRevertChangeReport={onRevertChangeReport}
        onOpenScene={onOpenScene}
      />,
    );
    cursor = group.offset;
  });

  const tail = content.slice(cursor);
  if (tail.trim()) {
    blocks.push(<MarkdownContent key="text-tail" content={tail.trim()} />);
  }
  if (
    showThinkingPlaceholder &&
    !sortedExecutions.some((execution) => isToolRunningInContext(execution, active))
  ) {
    blocks.push(
      <AssistantThinkingProcessLine
        key="thinking-placeholder"
        language={language}
      />,
    );
  }

  return (
    <div className="assistant-message-content">
      {blocks}
    </div>
  );
}

function AssistantThinkingProcessLine({ language }: { language: AppLanguage }) {
  return (
    <div className="assistant-thinking-process">
      <LoaderCircle size={14} />
      <span>{language === 'zh' ? '正在思考' : 'Thinking'}</span>
    </div>
  );
}

function AgentHookSummaryBadge({
  message,
  language,
}: {
  message: ChatMessage;
  language: AppLanguage;
}) {
  const summary = agentHookSummaryFromMessage(message);
  if (!summary) {
    return null;
  }
  const tone =
    summary.verificationStatus === 'attempted_failed' ||
    summary.verificationStatus === 'failed'
      ? 'danger'
      : summary.verificationRequired && summary.verificationStatus !== 'satisfied'
        ? 'warning'
        : 'ok';
  const statusLabel = hookVerificationStatusLabel(
    summary.verificationStatus,
    summary.verificationRequired,
    language,
  );
  return (
    <div className={`agent-hook-summary ${tone}`}>
      {tone === 'ok' ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}
      <span>
        <strong>{language === 'zh' ? 'Profile Hook' : 'Profile hook'}</strong>
        <em>{statusLabel}</em>
        {summary.changedFiles.length > 0 && (
          <small>
            {language === 'zh'
              ? `${summary.changedFiles.length} 个文件需要/已完成验证`
              : `${summary.changedFiles.length} changed file${summary.changedFiles.length > 1 ? 's' : ''}`}
          </small>
        )}
      </span>
    </div>
  );
}

function groupExecutionsByContentOffset(
  content: string,
  executions: ChatToolExecution[],
) {
  const groups: Array<{ offset: number; executions: ChatToolExecution[] }> = [];
  const annotated = executions
    .map((execution, index) => {
      const rawOffset =
        hasExplicitToolContentOffset(execution)
          ? execution.contentOffset
          : inferToolContentOffset(content, execution);
      return {
        execution,
        index,
        offset: safeAssistantToolSplitOffset(content, rawOffset),
      };
    })
    .sort(
      (left, right) =>
        left.offset - right.offset ||
        compareToolExecutionOrder(left.execution, right.execution) ||
        left.index - right.index,
    );
  for (const item of annotated) {
    const { execution, offset } = item;
    const previous = groups.at(-1);
    if (previous && previous.offset === offset) {
      previous.executions.push(execution);
      continue;
    }
    groups.push({
      offset,
      executions: [execution],
    });
  }
  return groups;
}

function visibleTopLevelToolExecutions(
  executions: ChatToolExecution[],
  loopHistory: ChatMessage[],
  active: boolean,
) {
  if (active || loopHistory.length === 0) {
    return executions;
  }
  const loopToolIds = new Set(
    loopHistory.flatMap((message) =>
      (message.toolExecutions ?? []).map((execution) => execution.id),
    ),
  );
  return executions.filter((execution) => {
    if (looksLikeFileChangeExecution(execution)) {
      return true;
    }
    if (loopToolIds.has(execution.id)) {
      return false;
    }
    return !isToolRunning(execution);
  });
}

function isFinalAssistantDisplayMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = String(
    message.metadata?.transcript_kind ?? message.metadata?.transcriptKind ?? '',
  )
    .trim()
    .toLowerCase();
  if (status === 'superseded' || transcriptKind === 'assistant_loop') {
    return false;
  }
  return status === 'complete' || transcriptKind === 'assistant_final' || (!status && !transcriptKind);
}

function hasAssistantProgressSource(
  message: ChatMessage,
  executions: ChatToolExecution[],
) {
  if (executions.length > 0) {
    return true;
  }
  const metadata = message.metadata ?? {};
  return [
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
  ].some((value) => typeof value === 'string' && value.trim());
}

function assistantProgressLabel({
  executions,
  isActive,
  message,
  now,
  language,
}: {
  executions: ChatToolExecution[];
  isActive: boolean;
  message: ChatMessage;
  now: number;
  language: AppLanguage;
}) {
  const elapsedMs = assistantTurnElapsedMs(message, executions, isActive, now);
  const duration = formatCompactDuration(elapsedMs);
  if (language === 'zh') {
    return duration ? `已处理 ${duration}` : '已处理';
  }
  return duration ? `Processed ${duration}` : 'Processed';
}

function assistantTurnElapsedMs(
  message: ChatMessage,
  executions: ChatToolExecution[],
  isActive: boolean,
  now: number,
) {
  const metadata = message.metadata ?? {};
  const startedAt = earliestTimestamp([
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    message.createdAt,
    ...executions.map((execution) => execution.createdAt),
  ]);
  if (isActive) {
    return startedAt == null ? 0 : Math.max(0, now - startedAt);
  }
  const completedAt = latestTimestamp([
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
    message.createdAt,
    ...executions.map((execution) => toolExecutionFinishedAt(execution)),
  ]);
  if (startedAt != null && completedAt != null && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  return executions.reduce((total, execution) => total + Math.max(0, execution.durationMs), 0);
}

function earliestTimestamp(values: unknown[]) {
  const timestamps = values
    .map(parseTimestamp)
    .filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values
    .map(parseTimestamp)
    .filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatCompactDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '';
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function inferToolContentOffset(content: string, execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const candidates = [
    metadata.content_offset,
    metadata.contentOffset,
    metadata.assistant_content_offset,
    metadata.assistantContentOffset,
    metadata.text_offset,
    metadata.textOffset,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return content.length;
}

function hasExplicitToolContentOffset(execution: ChatToolExecution) {
  if (execution.contentOffsetExplicit) {
    return true;
  }
  const metadata = execution.metadata;
  return [
    metadata.content_offset,
    metadata.contentOffset,
    metadata.assistant_content_offset,
    metadata.assistantContentOffset,
    metadata.text_offset,
    metadata.textOffset,
  ].some((value) => value != null && value !== '' && Number.isFinite(Number(value)));
}

function safeAssistantToolSplitOffset(content: string, rawOffset: number) {
  const offset = Math.max(0, Math.min(content.length, rawOffset));
  if (offset <= 0 || offset >= content.length) {
    return offset;
  }
  const fencedRange = fencedMarkdownRangeAt(content, offset);
  if (fencedRange) {
    return nearestOffset(offset, fencedRange.start, fencedRange.end);
  }
  const tableRange = markdownTableRangeAt(content, offset);
  if (tableRange) {
    return nearestOffset(offset, tableRange.start, tableRange.end);
  }
  if (isMarkdownBoundary(content, offset)) {
    return offset;
  }
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const nextLineBreak = content.indexOf('\n', offset);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak : content.length;
  if (offset <= lineStart || offset >= lineEnd) {
    return offset;
  }
  const line = content.slice(lineStart, lineEnd);
  if (markdownBlockLine(line)) {
    return lineEnd;
  }
  return nearestOffset(offset, lineStart, lineEnd);
}

function isMarkdownBoundary(content: string, offset: number) {
  return (
    offset <= 0 ||
    offset >= content.length ||
    content[offset - 1] === '\n' ||
    content[offset] === '\n'
  );
}

function markdownBlockLine(line: string) {
  return /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|~~~)/.test(line);
}

function fencedMarkdownRangeAt(content: string, offset: number) {
  const fencePattern = /(^|\n)(```|~~~)[^\n]*(?:\n|$)/g;
  let open: { start: number; marker: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) != null) {
    const start = match.index + (match[1] ? match[1].length : 0);
    const marker = match[2];
    if (!open) {
      open = { start, marker };
      continue;
    }
    if (open.marker !== marker) {
      continue;
    }
    const end = fencePattern.lastIndex;
    if (offset > open.start && offset < end) {
      return { start: open.start, end };
    }
    open = null;
  }
  if (open && offset > open.start) {
    return { start: open.start, end: content.length };
  }
  return null;
}

function markdownTableRangeAt(content: string, offset: number) {
  const lines = markdownLinesWithRanges(content);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (!markdownTableRowLine(header.text) || !markdownTableSeparatorLine(separator.text)) {
      continue;
    }
    let endIndex = index + 2;
    while (endIndex < lines.length && markdownTableRowLine(lines[endIndex].text)) {
      endIndex += 1;
    }
    const start = header.start;
    const end = lines[endIndex - 1].end;
    if (offset > start && offset < end) {
      return { start, end };
    }
  }
  return null;
}

function markdownLinesWithRanges(content: string) {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /.*(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) != null) {
    const raw = match[0];
    if (!raw && pattern.lastIndex >= content.length) {
      break;
    }
    const start = match.index;
    const end = start + raw.length;
    lines.push({
      text: raw.replace(/\r?\n$/, ''),
      start,
      end,
    });
    if (pattern.lastIndex >= content.length) {
      break;
    }
  }
  return lines;
}

function markdownTableRowLine(line: string) {
  const trimmed = line.trim();
  return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed);
}

function markdownTableSeparatorLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }
  const normalized = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const columns = normalized.split('|').map((column) => column.trim());
  return columns.length >= 2 && columns.every((column) => /^:?-{3,}:?$/.test(column));
}

function nearestOffset(offset: number, before: number, after: number) {
  return offset - before <= after - offset ? before : after;
}

function AssistantLoopHistoryBlock({
  history,
  language,
  onRevertChangeReport,
  onOpenScene,
}: {
  history: ChatMessage[];
  language: AppLanguage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const visibleHistory = history.filter(hasVisibleLoopHistoryMessage);
  const toolCount = visibleHistory.reduce(
    (total, item) => total + (item.toolExecutions?.length ?? 0),
    0,
  );
  const summary =
    language === 'zh'
      ? `历史执行 ${visibleHistory.length} 条${toolCount > 0 ? ` · ${toolCount} 个工具` : ''}`
      : `Loop history ${visibleHistory.length}${toolCount > 0 ? ` · ${toolCount} tools` : ''}`;
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => !value);
    });
  }, []);

  if (visibleHistory.length === 0) {
    return null;
  }

  return (
    <div
      ref={blockRef}
      className={`assistant-loop-history ${expanded ? 'expanded' : ''}`}
    >
      <button
        className="assistant-loop-history-summary"
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <Clock3 size={15} />
        <span>{summary}</span>
        <em>{expanded ? (language === 'zh' ? '收起' : 'Hide') : language === 'zh' ? '展开' : 'Show'}</em>
        <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && (
        <div className="assistant-loop-history-details">
          {visibleHistory.map((historyMessage, index) => (
            <AssistantLoopHistoryItem
              // eslint-disable-next-line react/no-array-index-key
              key={`${historyMessage.id}-${index}`}
              index={index}
              message={historyMessage}
              language={language}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantLoopHistoryItem({
  index,
  message,
  language,
  onRevertChangeReport,
  onOpenScene,
}: {
  index: number;
  message: ChatMessage;
  language: AppLanguage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const { imagePaths, text } = splitMessageImages(message.content);
  const executions = message.toolExecutions ?? [];
  const title =
    language === 'zh'
      ? `第 ${index + 1} 段执行`
      : `Step ${index + 1}`;
  const timestamp = formatLoopHistoryTimestamp(message, language);

  return (
    <section className="assistant-loop-history-item">
      <header>
        <strong>{title}</strong>
        {timestamp && <span>{timestamp}</span>}
      </header>
      <MessageImageStrip paths={imagePaths} />
      {executions.length > 0 ? (
        <AssistantMessageContent
          content={text}
          executions={executions}
          language={language}
          message={message}
          active={false}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      ) : text ? (
        <MarkdownContent content={text} />
      ) : null}
    </section>
  );
}

function hasVisibleLoopHistoryMessage(message: ChatMessage) {
  return Boolean(
    message.content.trim() ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.toolExecutions?.length ?? 0) > 0,
  );
}

function formatLoopHistoryTimestamp(message: ChatMessage, language: AppLanguage) {
  const value = loopHistoryTimestamp(message);
  if (value == null) {
    return '';
  }
  const date = new Date(value);
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function loopHistoryTimestamp(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  const executionTimestamps = (message.toolExecutions ?? []).flatMap((execution) => [
    execution.createdAt,
    toolExecutionFinishedAt(execution),
  ]);
  return latestTimestamp([
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
    ...executionTimestamps,
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    message.createdAt,
  ]);
}

function agentHookSummaryFromMessage(message: ChatMessage) {
  const metadata = asRecord(message.metadata);
  const summary = asRecord(
    metadata.agent_hook_summary ??
      metadata.agentHookSummary ??
      metadata.hook_summary ??
      metadata.hookSummary,
  );
  if (Object.keys(summary).length === 0) {
    return null;
  }
  const changedFilesRaw = summary.changed_files ?? summary.changedFiles;
  const changedFiles = Array.isArray(changedFilesRaw)
    ? changedFilesRaw.map(String).filter(Boolean)
    : [];
  return {
    changedFiles,
    verificationRequired: Boolean(
      summary.verification_required ?? summary.verificationRequired,
    ),
    verificationStatus: String(
      summary.verification_status ?? summary.verificationStatus ?? '',
    ).trim(),
    verificationEvidence: summary.verification_evidence ?? summary.verificationEvidence,
  };
}

function hookVerificationStatusLabel(
  status: string,
  required: boolean,
  language: AppLanguage,
) {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'satisfied' || normalized === 'verified') {
    return language === 'zh' ? '验证已满足' : 'verified';
  }
  if (normalized === 'attempted_failed' || normalized === 'failed') {
    return language === 'zh' ? '验证失败' : 'verification failed';
  }
  if (normalized === 'attempted' || normalized === 'attempted_unknown') {
    return language === 'zh' ? '已尝试验证' : 'verification attempted';
  }
  if (required) {
    return language === 'zh' ? '需要验证' : 'verification required';
  }
  return language === 'zh' ? '无强制验证' : 'no verification required';
}

function GuidanceDialog({
  language,
  onCancel,
  onSubmit,
}: {
  language: AppLanguage;
  onCancel: () => void;
  onSubmit: (guidance: string, mode: GuidanceMode) => Promise<void>;
}) {
  const [guidance, setGuidance] = useState('');
  const [mode, setMode] = useState<GuidanceMode>('append_context');
  const [submitting, setSubmitting] = useState(false);
  const modeOptions: Array<{
    value: GuidanceMode;
    title: string;
    description: string;
  }> = [
    {
      value: 'append_context',
      title: language === 'zh' ? '补充给当前回合' : 'Add to current turn',
      description:
        language === 'zh'
          ? '不打断正在运行的任务，把这段话作为即时引导注入。'
          : 'Keep the task running and inject this as immediate guidance.',
    },
    {
      value: 'interrupt_and_continue',
      title: language === 'zh' ? '中断后继续' : 'Interrupt and continue',
      description:
        language === 'zh'
          ? '让当前回合停在这里，再按你的新引导继续处理。'
          : 'Pause the current turn here, then continue with this guidance.',
    },
  ];

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = guidance.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(text, mode);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop guidance-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <form className="guidance-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <Sparkles size={18} />
          <strong>{language === 'zh' ? '插入引导' : 'Guide this turn'}</strong>
          <button type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <textarea
          value={guidance}
          autoFocus
          onChange={(event) => setGuidance(event.currentTarget.value)}
          placeholder={
            language === 'zh'
              ? '例如：先别写代码，先解释风险点'
              : 'For example: pause coding and explain the risks first'
          }
          rows={4}
        />
        <div className="guidance-mode-field">
          <span>{language === 'zh' ? '处理方式' : 'Mode'}</span>
          <div
            className="guidance-mode-options"
            role="radiogroup"
            aria-label={language === 'zh' ? '处理方式' : 'Guidance mode'}
          >
            {modeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={mode === option.value ? 'active' : ''}
                aria-pressed={mode === option.value}
                disabled={submitting}
                onClick={() => setMode(option.value)}
              >
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                {mode === option.value && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={onCancel} disabled={submitting}>
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={submitting || !guidance.trim()}
          >
            {submitting ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
            {language === 'zh' ? '发送' : 'Send'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function MessageImageStrip({ paths }: { paths: string[] }) {
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  if (paths.length === 0) {
    return null;
  }
  return (
    <>
      <div className="message-image-strip">
        {paths.map((pathValue, index) => {
          const src = fileUrl(pathValue);
          const name = basename(pathValue);
          return (
            <button
              className="message-image-preview"
              type="button"
              key={`${pathValue}-${index}`}
              title={name}
              onClick={() => setPreview({ src, name, path: pathValue })}
            >
              <img src={src} alt={name} />
            </button>
          );
        })}
      </div>
      {preview && (
        <ImagePreviewDialog
          image={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function ImagePreviewDialog({
  image,
  onClose,
}: {
  image: ImagePreview;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop image-preview-backdrop"
      onMouseDown={onClose}
    >
      <section
        className="image-preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong title={image.path ?? image.name}>{image.name}</strong>
          <button type="button" onClick={onClose} aria-label="close preview">
            <X size={16} />
          </button>
        </header>
        <div className="image-preview-stage">
          <img src={image.src} alt={image.name} />
        </div>
      </section>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Suspense fallback={<p className="markdown-fallback">{content}</p>}>
      <LazyMarkdownContent content={content} />
    </Suspense>
  );
}


