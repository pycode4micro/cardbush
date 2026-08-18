import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  Edit3,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Presentation,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  ThumbsDown,
  ThumbsUp,
  WrapText,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  basename,
  fileUrl,
  isAbsoluteLocalPath,
  isImagePath,
  stripWrappingQuotes,
} from '../../shared/localPaths';
import type {
  AppLanguage,
  ChatAttachment,
  ChatMessage,
  ChatToolExecution,
} from '../../types';
import type { CardlingScene } from '../cardling/scene';
import { openInspector } from '../inspector/inspectorEvents';
import {
  normalizeExecutionNarrationForDisplay,
  normalizeMarkdownContentForDisplay,
} from './markdownFormat';
import {
  linkifyLocalFileReferences,
  localFileReference,
  localFileReferenceFromHref,
} from './fileReferences';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
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
  ToolExecutionBlock,
  toolExecutionFinishedAt,
  type ConversationChangeReport,
} from '../tools';
import { asRecord } from '../tools/toolPayload';
import {
  assistantMessageDisclosureId,
  defaultToolExecutionExpanded,
  readToolExecutionDisclosure,
  writeToolExecutionDisclosure,
} from '../tools/toolExecutionDisclosure';

export type GuidanceMode = 'append_context' | 'interrupt_and_continue';

type GuidanceDeliveryState = 'pending' | 'queued' | 'failed' | 'sent';

type UserMessageDeliveryState = 'pending' | 'failed';

function userMessageDeliveryState(message: ChatMessage): UserMessageDeliveryState | null {
  const metadata = message.metadata ?? {};
  if (metadata.turn_guidance === true) {
    return null;
  }
  const delivery = String(metadata.message_delivery ?? '').trim().toLowerCase();
  return delivery === 'pending' || delivery === 'failed' ? delivery : null;
}

function guidanceDeliveryState(message: ChatMessage): GuidanceDeliveryState | null {
  const metadata = message.metadata ?? {};
  const isGuidance =
    metadata.turn_guidance === true ||
    typeof metadata.guidance_delivery === 'string';
  if (!isGuidance) {
    return null;
  }

  const delivery =
    typeof metadata.guidance_delivery === 'string'
      ? metadata.guidance_delivery.trim().toLowerCase()
      : message.status?.trim().toLowerCase();
  if (delivery === 'pending' || delivery === 'queued' || delivery === 'failed') {
    return delivery;
  }
  return 'sent';
}

function guidanceDeliveryLabel(
  state: GuidanceDeliveryState,
  language: AppLanguage,
): string {
  const labels = {
    pending: language === 'zh' ? '发送中' : 'Sending',
    queued: language === 'zh' ? '已排队' : 'Queued',
    failed: language === 'zh' ? '发送失败' : 'Failed to send',
    sent: language === 'zh' ? '已作为引导发送' : 'Sent as guidance',
  } satisfies Record<GuidanceDeliveryState, string>;
  return labels[state];
}

function userGoalCommandPresentation(text: string, language: AppLanguage) {
  const match = text.match(/^\/goal(?:[ \t]+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return {
    label: language === 'zh' ? '目标' : 'Goal',
    content: (match[1] ?? '').trim(),
  };
}

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

  function MarkdownRenderer({
    content,
    workspaceRoot,
    language,
  }: {
    content: string;
    workspaceRoot: string;
    language: AppLanguage;
  }) {
    return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...props }) => {
          const directReference = href
            ? localFileReference(href, workspaceRoot)
            : null;
          const localPath = href
            ? localFileReferenceFromHref(href) || directReference?.path || ''
            : '';
          if (localPath) {
            return (
              <LocalFileReferenceLink path={localPath}>
                {children}
              </LocalFileReferenceLink>
            );
          }
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                if (!href || href.startsWith('#')) {
                  return;
                }
                event.preventDefault();
                openInspector(href, href);
              }}
            >
              {children}
            </a>
          );
        },
        code: ({ children, className, ...props }) => {
          const text = reactNodeText(children).trim();
          const reference = !className
            ? localFileReference(text, workspaceRoot)
            : null;
          if (reference) {
            return (
              <LocalFileReferenceLink path={reference.path}>
                {reference.label}
              </LocalFileReferenceLink>
            );
          }
          return <code {...props} className={className}>{children}</code>;
        },
        pre: ({ children, ...props }) => (
          <MarkdownCodeBlock {...props} language={language}>{children}</MarkdownCodeBlock>
        ),
      }}
    >
      {linkifyLocalFileReferences(
        normalizeMarkdownContentForDisplay(content),
        workspaceRoot,
      )}
    </ReactMarkdown>
    );
  }

  return { default: MarkdownRenderer };
});

const FileReferenceWorkspaceContext = createContext('');

export function MessageFileReferenceScope({
  workspaceRoot,
  children,
}: {
  workspaceRoot?: string;
  children: ReactNode;
}) {
  return (
    <FileReferenceWorkspaceContext.Provider value={workspaceRoot?.trim() ?? ''}>
      {children}
    </FileReferenceWorkspaceContext.Provider>
  );
}

function MarkdownCodeBlock({
  children,
  language,
  ...props
}: HTMLAttributes<HTMLPreElement> & { language: AppLanguage }) {
  const [wrapped, setWrapped] = useState(false);
  const text = reactNodeText(children);
  return (
    <div className={`markdown-code-block ${wrapped ? 'wrapped' : ''}`}>
      <div className="markdown-code-actions">
        <button
          type="button"
          aria-pressed={wrapped}
          title={
            wrapped
              ? language === 'zh' ? '取消换行' : 'Disable wrapping'
              : language === 'zh' ? '换行显示' : 'Wrap lines'
          }
          onClick={() => setWrapped((value) => !value)}
        >
          <WrapText size={12} />
          <span>
            {wrapped
              ? language === 'zh' ? '不换行' : 'No wrap'
              : language === 'zh' ? '换行' : 'Wrap'}
          </span>
        </button>
        <button
          type="button"
          title={language === 'zh' ? '复制' : 'Copy'}
          onClick={() => void copyText(text).catch(() => undefined)}
        >
          <Clipboard size={12} />
          <span>{language === 'zh' ? '复制' : 'Copy'}</span>
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

function MessageBubbleView({
  message,
  language,
  sending,
  activeTurnId,
  activeAssistantMessageId,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRetryMessage = async () => undefined,
  onRetryGuidance,
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
  onRetryMessage?: (message: ChatMessage) => Promise<void>;
  onRetryGuidance: (message: ChatMessage) => Promise<void>;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const contentParts = splitMessageImages(message.content);
  const userContentParts =
    message.role === 'user'
      ? splitUserFileAttachments(contentParts.text)
      : { text: contentParts.text, paths: [] };
  const attachedImagePaths = (message.attachments ?? [])
    .filter((attachment) => attachment.type === 'image')
    .map((attachment) => attachment.path?.trim() ?? '')
    .filter(Boolean);
  const parsedImagePaths = userContentParts.paths.filter(isImagePath);
  const imagePaths = uniqueAttachmentPaths([
    ...contentParts.imagePaths,
    ...attachedImagePaths,
    ...parsedImagePaths,
  ]);
  const text = userContentParts.text;
  const goalCommand =
    message.role === 'user' ? userGoalCommandPresentation(text, language) : null;
  const fileAttachments = userMessageFileAttachments(
    message.attachments ?? [],
    userContentParts.paths.filter((pathValue) => !isImagePath(pathValue)),
  );
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
  const canGuide =
    isActiveAssistantTurn;
  const guidanceDelivery =
    message.role === 'user' ? guidanceDeliveryState(message) : null;
  const messageDelivery =
    message.role === 'user' ? userMessageDeliveryState(message) : null;

  useEffect(() => {
    setEditing(false);
    setSubmittingEdit(false);
    setGuidanceOpen(false);
    setAssistantFeedback(readAssistantFeedback(message.id));
    setFeedbackPulse(null);
    setEditText(splitMessageImages(message.content).text);
  }, [message.id]);

  useEffect(() => {
    if (!editing) {
      setEditText(splitMessageImages(message.content).text);
    }
  }, [editing, message.content]);

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
      ...uniqueAttachmentPaths([
        ...imagePaths,
        ...fileAttachments.map((attachment) => attachment.path ?? ''),
      ]).map((pathValue) => `@${pathValue}`),
      editText.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (!nextContent.trim()) {
      return;
    }
    setSubmittingEdit(true);
    setEditing(false);
    try {
      await onEditUserMessage(message, nextContent);
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
            <MessageImageStrip paths={imagePaths} language={language} />
            <MessageFileAttachmentStrip
              attachments={fileAttachments}
              language={language}
            />
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
                disabled={
                  submittingEdit ||
                  (!editText.trim() &&
                    imagePaths.length === 0 &&
                    fileAttachments.length === 0)
                }
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
          <MessageImageStrip paths={imagePaths} language={language} />
          <MessageFileAttachmentStrip
            attachments={fileAttachments}
            language={language}
          />
          {goalCommand && (
            <div className={`user-command-heading goal${goalCommand.content ? ' has-content' : ''}`}>
              <Target size={14} />
              <strong>{goalCommand.label}</strong>
              <span className="user-command-token">/goal</span>
            </div>
          )}
          {(goalCommand?.content ?? text) && (
            <MarkdownContent content={goalCommand?.content ?? text} language={language} />
          )}
          {guidanceDelivery && (
            <div
              className={`guidance-delivery-status ${guidanceDelivery}`}
              role="status"
              aria-live="polite"
            >
              {guidanceDelivery === 'pending' && <LoaderCircle size={12} />}
              {guidanceDelivery === 'queued' && <Clock3 size={12} />}
              {guidanceDelivery === 'failed' && <X size={12} />}
              {guidanceDelivery === 'sent' && <Check size={12} />}
              <span>{guidanceDeliveryLabel(guidanceDelivery, language)}</span>
              {guidanceDelivery === 'failed' && (
                <button
                  type="button"
                  className="guidance-retry-button"
                  onClick={() => void onRetryGuidance(message)}
                >
                  <RefreshCw size={11} />
                  {language === 'zh' ? '重试' : 'Retry'}
                </button>
              )}
            </div>
          )}
          {messageDelivery && (
            <div
              className={`message-delivery-status ${messageDelivery}`}
              role="status"
              aria-live="polite"
            >
              {messageDelivery === 'pending' ? (
                <LoaderCircle size={12} />
              ) : (
                <X size={12} />
              )}
              <span>
                {messageDelivery === 'pending'
                  ? language === 'zh' ? '发送中' : 'Sending'
                  : language === 'zh' ? '发送失败' : 'Failed to send'}
              </span>
              {messageDelivery === 'failed' && (
                <button
                  type="button"
                  className="message-retry-button"
                  onClick={() => void onRetryMessage(message)}
                >
                  <RefreshCw size={11} />
                  {language === 'zh' ? '重试' : 'Retry'}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="message-actions">
          <button
            type="button"
            title={language === 'zh' ? '复制' : 'Copy'}
            onClick={() => void copyText(text).catch(() => undefined)}
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
  const toolExecutions =
    message.role === 'assistant'
      ? visibleTopLevelToolExecutions(allToolExecutions, isActiveAssistantTurn)
      : allToolExecutions;
  const assistantProgressExecutions = toolExecutions;
  const showAssistantProgress =
    message.role === 'assistant' &&
    (isActiveAssistantTurn ||
      toolExecutions.length > 0 ||
      hasAssistantProgressSource(message, assistantProgressExecutions));
  const assistantCompletedAt =
    message.role === 'assistant' && !isActiveAssistantTurn
      ? assistantTurnCompletedAt(message, assistantProgressExecutions)
      : undefined;
  const taskPlan = message.role === 'assistant' ? message.taskPlan : undefined;
  const archiveTaskPlanInHistory = Boolean(
    taskPlan && !taskPlan.active && visibleLoopHistory.length > 0,
  );
  const finalAssistantRound =
    !isActiveAssistantTurn && isFinalAssistantDisplayMessage(message);
  const hookSummary = agentHookSummaryFromMessage(message);
  const hasAssistantBody = Boolean(
    text.trim() ||
      imagePaths.length > 0 ||
      toolExecutions.length > 0 ||
      (!isActiveAssistantTurn && taskPlan) ||
      renderActiveTranscript ||
      visibleLoopHistory.length > 0 ||
      hookSummary,
  );
  if (!showAssistantProgress && !hasAssistantBody) {
    return null;
  }
  const assistantBody = (
    <>
      <AgentHookSummaryBadge message={message} language={language} />
      {!renderActiveTranscript && (
        <MessageImageStrip paths={imagePaths} language={language} />
      )}
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
          <MarkdownContent content={text} language={language} />
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
          archivedPlan={archiveTaskPlanInHistory ? taskPlan : undefined}
          language={language}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      )}
      {taskPlan && !isActiveAssistantTurn && !archiveTaskPlanInHistory && (
        <TaskPlanBlock plan={taskPlan} language={language} />
      )}
    </>
  );
  const finalAnswerBody = (
    <div className="assistant-final-answer">
      <MessageImageStrip paths={imagePaths} language={language} />
      {text && (
        <MarkdownContent
          content={assistantTextWithoutToolNarration(text, toolExecutions)}
          language={language}
        />
      )}
    </div>
  );
  return (
    <>
      <div className="message-row assistant">
        <div className="assistant-bubble">
          {showAssistantProgress && isActiveAssistantTurn && (
            <AssistantRunHeader
              executions={assistantProgressExecutions}
              isActive={isActiveAssistantTurn}
              message={message}
              language={language}
            />
          )}
          {isActiveAssistantTurn ? (
            assistantBody
          ) : finalAssistantRound ? (
            <>
              {showAssistantProgress && (
                <AssistantRunHeader
                  executions={assistantProgressExecutions}
                  isActive={false}
                  message={message}
                  language={language}
                />
              )}
              {finalAnswerBody}
            </>
          ) : (
            <AssistantCompletedDisclosure
              executions={assistantProgressExecutions}
              message={message}
              language={language}
            >
              {assistantBody}
            </AssistantCompletedDisclosure>
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
          {assistantCompletedAt != null && (
            <time
              className="assistant-completed-at"
              dateTime={new Date(assistantCompletedAt).toISOString()}
              title={formatAssistantCompletedAtTitle(assistantCompletedAt, language)}
            >
              {formatAssistantCompletedAt(assistantCompletedAt, language)}
            </time>
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

function TaskPlanBlock({
  plan,
  language,
}: {
  plan: NonNullable<ChatMessage['taskPlan']>;
  language: AppLanguage;
}) {
  const completed = plan.nodes.filter((item) => item.status === 'completed').length;
  return (
    <section className={`task-plan-block ${plan.active ? 'active' : 'completed'}`}>
      <div className="task-plan-header">
        <strong>{language === 'zh' ? '任务计划' : 'Task plan'}</strong>
        <span>{completed}/{plan.nodes.length}</span>
      </div>
      {plan.explanation && <p>{plan.explanation}</p>}
      <ol>
        {plan.nodes.map((item, index) => (
          <li className={item.status} key={`${index}-${item.step}`}>
            {item.status === 'completed' ? (
              <CheckCircle2 size={14} />
            ) : item.status === 'in_progress' ? (
              <LoaderCircle size={14} />
            ) : (
              <Clock3 size={14} />
            )}
            <span>{item.step}</span>
          </li>
        ))}
      </ol>
    </section>
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
            key={segment.id}
            className="assistant-active-transcript-segment"
          >
            <MessageImageStrip paths={imagePaths} language={language} />
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
                <MarkdownContent content={text} language={language} />
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
  const displayContent = sortedExecutions.some(hasExplicitToolContentOffset)
    ? content
    : normalizeExecutionNarrationForDisplay(content, sortedExecutions.length);
  const groups = groupExecutionsByContentOffset(displayContent, sortedExecutions);
  const blocks: ReactNode[] = [];
  let cursor = 0;

  groups.forEach((group, index) => {
    const groupKey = group.executions[0]?.id || String(index);
    const segment = displayContent.slice(cursor, group.offset);
    if (segment.trim()) {
      blocks.push(
        <MarkdownContent
          key={`text-before-${groupKey || index}`}
          content={segment.trim()}
          language={language}
        />,
      );
    }
    blocks.push(
      <ToolExecutionBlock
        key={`tools-${groupKey || index}`}
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

  const tail = displayContent.slice(cursor);
  if (tail.trim()) {
    blocks.push(
      <MarkdownContent key="text-tail" content={tail.trim()} language={language} />,
    );
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

function assistantTextWithoutToolNarration(
  content: string,
  executions: ChatToolExecution[],
) {
  return executions.some(hasExplicitToolContentOffset)
    ? content
    : normalizeExecutionNarrationForDisplay(content, executions.length);
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
  active: boolean,
) {
  return active ? executions : [];
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

const AssistantRunHeader = memo(function AssistantRunHeader({
  executions,
  isActive,
  message,
  language,
}: {
  executions: ChatToolExecution[];
  isActive: boolean;
  message: ChatMessage;
  language: AppLanguage;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const label = assistantProgressLabel({
    executions,
    isActive,
    message,
    now,
    language,
  });
  return (
    <div className={`assistant-run-header ${isActive ? 'running' : ''}`}>
      <span className="assistant-run-label">{label}</span>
      <div className="assistant-run-divider" />
    </div>
  );
});

function AssistantCompletedDisclosure({
  executions,
  message,
  language,
  children,
}: {
  executions: ChatToolExecution[];
  message: ChatMessage;
  language: AppLanguage;
  children: ReactNode;
}) {
  const disclosureId = assistantMessageDisclosureId(message);
  const [expanded, setExpanded] = useState(() =>
    defaultToolExecutionExpanded(
      false,
      readToolExecutionDisclosure(browserStorage(), disclosureId),
    ),
  );
  const blockRef = useRef<HTMLDivElement>(null);
  const label = assistantProgressLabel({
    executions,
    isActive: false,
    message,
    now: Date.now(),
    language,
  });

  useEffect(() => {
    setExpanded(
      defaultToolExecutionExpanded(
        false,
        readToolExecutionDisclosure(browserStorage(), disclosureId),
      ),
    );
  }, [disclosureId]);

  const toggleExpanded = useCallback(() => {
    const opening = !expanded;
    preserveScrollPositionForToggle(blockRef.current, () => {
      writeToolExecutionDisclosure(browserStorage(), disclosureId, opening);
      setExpanded(opening);
    });
  }, [disclosureId, expanded]);

  return (
    <div
      ref={blockRef}
      className={`assistant-completed-disclosure ${expanded ? 'expanded' : ''}`}
    >
      <button
        type="button"
        className="assistant-completed-summary"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span>{label}</span>
        <i className="assistant-run-divider" />
        <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && <div className="assistant-completed-content">{children}</div>}
    </div>
  );
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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
    if (isActive) {
      return duration ? `处理中 ${duration}` : '处理中';
    }
    return duration ? `已处理 ${duration}` : '已处理';
  }
  if (isActive) {
    return duration ? `Working ${duration}` : 'Working';
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

function assistantTurnCompletedAt(
  message: ChatMessage,
  executions: ChatToolExecution[],
) {
  const metadata = message.metadata ?? {};
  return latestTimestamp([
    metadata.cardbush_turn_completed_at,
    metadata.cardbushTurnCompletedAt,
    metadata.turn_completed_at,
    metadata.turnCompletedAt,
    metadata.completed_at,
    metadata.completedAt,
    metadata.done_at,
    metadata.doneAt,
    metadata.finished_at,
    metadata.finishedAt,
    ...executions.map((execution) => toolExecutionFinishedAt(execution)),
    message.createdAt,
  ]);
}

function formatAssistantCompletedAt(timestamp: number, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function formatAssistantCompletedAtTitle(timestamp: number, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
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

export function AssistantLoopHistoryBlock({
  history,
  archivedPlan,
  language,
  onRevertChangeReport = async () => undefined,
  onOpenScene = () => undefined,
}: {
  history: ChatMessage[];
  archivedPlan?: NonNullable<ChatMessage['taskPlan']>;
  language: AppLanguage;
  onRevertChangeReport?: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene?: (scene: CardlingScene) => void;
}) {
  const visibleHistory = history.filter(hasVisibleLoopHistoryMessage);
  const toolCount = visibleHistory.reduce(
    (total, item) => total + (item.toolExecutions?.length ?? 0),
    0,
  );
  const summary =
    language === 'zh'
      ? `历史执行 ${visibleHistory.length} 条${toolCount > 0 ? ` · ${toolCount} 个工具` : ''}`
      : `Loop history ${visibleHistory.length}${toolCount > 0 ? ` · ${toolCount} tools` : ''}`;

  if (visibleHistory.length === 0) {
    return null;
  }

  return (
    <div className="assistant-loop-history">
      <div className="assistant-loop-history-summary">
        <Clock3 size={15} />
        <span>{summary}</span>
      </div>
      <div className="assistant-loop-history-details">
        {archivedPlan && (
          <div className="assistant-loop-history-plan">
            <TaskPlanBlock plan={archivedPlan} language={language} />
          </div>
        )}
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
    <section
      className="assistant-loop-history-item"
      data-testid="assistant-loop-history-item"
    >
      <header>
        <strong>{title}</strong>
        {timestamp && <span>{timestamp}</span>}
      </header>
      <MessageImageStrip paths={imagePaths} language={language} />
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
        <MarkdownContent content={text} language={language} />
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
      title: language === 'zh' ? '补充给当前任务' : 'Add to current task',
      description:
        language === 'zh'
          ? '当前模型轮次输出完成后，把这段补充作为上下文继续处理。'
          : 'After the current model round finishes, continue with this as additional context.',
    },
    {
      value: 'interrupt_and_continue',
      title: language === 'zh' ? '本轮结束后调整方向' : 'Redirect after this round',
      description:
        language === 'zh'
          ? '不会截断正在生成的内容；等待本轮完成后，按这段新引导继续下一轮。'
          : 'Do not cut off the current output; wait for this round to finish, then continue the next round with this guidance.',
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

function splitUserFileAttachments(content: string) {
  const paths: string[] = [];
  const lines = content.split(/\r?\n/);
  const keptLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const directPath = trimmed.startsWith('@')
      ? stripWrappingQuotes(trimmed.slice(1).trim())
      : '';
    if (directPath && isAbsoluteLocalPath(directPath)) {
      paths.push(directPath);
      continue;
    }
    keptLines.push(line);
  }

  let attachmentHeaderIndex = -1;
  for (let index = keptLines.length - 1; index >= 0; index -= 1) {
    if (keptLines[index].trim().toLowerCase() === 'attached files (absolute paths):') {
      attachmentHeaderIndex = index;
      break;
    }
  }
  if (attachmentHeaderIndex >= 0) {
    const suffixPaths: string[] = [];
    let validSuffix = true;
    for (const line of keptLines.slice(attachmentHeaderIndex + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const candidate = stripWrappingQuotes(trimmed.replace(/^[-*]\s+/, ''));
      if (!isAbsoluteLocalPath(candidate)) {
        validSuffix = false;
        break;
      }
      suffixPaths.push(candidate);
    }
    if (validSuffix && suffixPaths.length > 0) {
      paths.push(...suffixPaths);
      keptLines.splice(attachmentHeaderIndex);
    }
  }

  return {
    text: keptLines.join('\n').trim(),
    paths: uniqueAttachmentPaths(paths),
  };
}

function uniqueAttachmentPaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter((pathValue) => {
    const normalized = pathValue.trim();
    if (!normalized) return false;
    const key = normalized.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function userMessageFileAttachments(
  attachments: ChatAttachment[],
  parsedPaths: string[],
) {
  const byPath = new Map<string, ChatAttachment>();
  for (const attachment of attachments) {
    const pathValue = attachment.path?.trim() ?? '';
    if (!pathValue || attachment.type === 'image' || isImagePath(pathValue)) {
      continue;
    }
    byPath.set(pathValue.replace(/\\/g, '/').toLowerCase(), attachment);
  }
  for (const pathValue of parsedPaths) {
    const key = pathValue.replace(/\\/g, '/').toLowerCase();
    if (!byPath.has(key)) {
      byPath.set(key, {
        id: `file-${key}`,
        name: basename(pathValue),
        path: pathValue,
        type: 'document',
      });
    }
  }
  return Array.from(byPath.values());
}

function messageFileExtension(value: string) {
  return (basename(value).match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '').slice(0, 5);
}

function messageFileIconKind(extension: string) {
  if (/^(?:xls|xlsx|xlsm|csv|tsv|ods)$/.test(extension)) return 'sheet';
  if (/^(?:ppt|pptx|pps|ppsx|odp|key)$/.test(extension)) return 'slides';
  if (/^(?:zip|rar|7z|tar|gz|bz2|xz)$/.test(extension)) return 'archive';
  if (/^(?:js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|html|css|scss|json|xml|yaml|yml|toml|sql|sh|ps1)$/.test(extension)) return 'code';
  if (/^(?:doc|docx|odt|rtf|txt|md|pdf)$/.test(extension)) return 'document';
  return 'file';
}

function MessageFileIcon({ name }: { name: string }) {
  const extension = messageFileExtension(name);
  const kind = messageFileIconKind(extension);
  const icon = kind === 'sheet'
    ? <FileSpreadsheet size={22} />
    : kind === 'slides'
      ? <Presentation size={22} />
      : kind === 'archive'
        ? <FileArchive size={22} />
        : kind === 'code'
          ? <FileCode2 size={22} />
          : kind === 'document'
            ? <FileText size={22} />
            : <FileIcon size={22} />;
  return (
    <span className={`message-file-icon ${kind}`} aria-hidden="true">
      {icon}
      <em>{extension ? extension.toUpperCase() : 'FILE'}</em>
    </span>
  );
}

function formatMessageFileSize(size?: number) {
  if (!Number.isFinite(size) || size == null || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function MessageFileAttachmentStrip({
  attachments,
  language,
}: {
  attachments: ChatAttachment[];
  language: AppLanguage;
}) {
  const [metadata, setMetadata] = useState<Record<string, { name: string; size: number }>>({});
  const attachmentKey = attachments
    .map((attachment) => `${attachment.path ?? ''}:${attachment.size ?? ''}`)
    .join('|');

  useEffect(() => {
    const missingPaths = attachments
      .filter((attachment) => attachment.path && !Number.isFinite(attachment.size))
      .map((attachment) => attachment.path as string)
      .filter((pathValue) => metadata[pathValue] == null);
    if (missingPaths.length === 0 || !window.cardbushDesktop?.inspectAttachments) {
      return;
    }
    let cancelled = false;
    void window.cardbushDesktop.inspectAttachments(missingPaths).then((items) => {
      if (cancelled) return;
      setMetadata((current) => {
        const next = { ...current };
        for (const item of items) {
          next[item.path] = { name: item.name, size: item.size };
        }
        return next;
      });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attachmentKey]);

  if (attachments.length === 0) return null;
  return (
    <div className="message-file-strip">
      {attachments.map((attachment) => {
        const pathValue = attachment.path?.trim() ?? '';
        const inspected = metadata[pathValue];
        const name = inspected?.name || attachment.name || basename(pathValue);
        const size = inspected?.size ?? attachment.size;
        return (
          <button
            className="message-file-attachment"
            type="button"
            key={attachment.id || pathValue}
            title={pathValue}
            disabled={!pathValue}
            onClick={() => openInspector(pathValue, name)}
          >
            <MessageFileIcon name={name} />
            <span className="message-file-meta">
              <strong>{name}</strong>
              <small>
                {formatMessageFileSize(size)} · {language === 'zh' ? '只读' : 'Read only'}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MessageImageStrip({
  paths,
  language,
}: {
  paths: string[];
  language: AppLanguage;
}) {
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
          language={language}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function ImagePreviewDialog({
  image,
  language,
  onClose,
}: {
  image: ImagePreview;
  language: AppLanguage;
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
          <button
            type="button"
            onClick={onClose}
            aria-label={language === 'zh' ? '关闭预览' : 'Close preview'}
          >
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

const MarkdownContent = memo(function MarkdownContent({
  content,
  language,
}: {
  content: string;
  language: AppLanguage;
}) {
  const workspaceRoot = useContext(FileReferenceWorkspaceContext);
  return (
    <Suspense fallback={<p className="markdown-fallback">{content}</p>}>
      <LazyMarkdownContent
        content={content}
        workspaceRoot={workspaceRoot}
        language={language}
      />
    </Suspense>
  );
});

export const MessageBubble = memo(MessageBubbleView);


