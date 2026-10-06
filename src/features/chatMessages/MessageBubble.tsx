import { useConversationFileSource } from '../conversationFileSource';
import { AutomationReminderCard } from '../automations/AutomationReminderCard';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { WorkspaceRevertAvailability } from '../tools/workspaceRevertAvailability';
import {
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  Clipboard,
  Clock3,
  Edit3,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  LoaderCircle,
  Presentation,
  RefreshCw,
  ShieldCheck,
  Target,
  ThumbsDown,
  ThumbsUp,
  UsersRound,
  WrapText,
  X,
} from 'lucide-react';
import {
  type HTMLAttributes,
  type ReactNode,
  createContext,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Components, Options as MarkdownOptions } from 'react-markdown';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';

import {
  basename,
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isLocalFileResource,
  isVideoPath,
  mediaResourceUrl,
  resourceTargetKind,
  stripWrappingQuotes,
  splitExplicitAttachmentMentions,
} from '../../shared/localPaths';
import type {
  AppLanguage,
  ChatAttachment,
  ChatMessage,
  ChatToolArtifact,
  ChatToolExecution,
} from '../../types';
import type { CardlingScene } from '../cardling/scene';
import { openInspector } from '../inspector/inspectorEvents';
import { WorkspaceChangeStateContext, workspaceChangeReverted } from '../tools/WorkspaceChangeStateContext';
import { AssistantThinkingProcessLine, AssistantThinkingScope } from './AssistantThinkingProcessLine';
import {
  normalizeExecutionNarrationForDisplay,
  normalizeMarkdownContentForDisplay,
  remarkAutolinkBoundaries,
} from './markdownFormat';
import { ImagePreviewDialog, type ImagePreviewSource as ImagePreview } from './ImagePreviewDialog';
import { modelFailurePresentation } from './modelFailurePresentation';
import { MessageToolArtifact, MessageToolOutputs } from '../tools/MessageToolOutputs';
import { McpAppReferencesContext } from '../tools/McpAppReferenceLink';
import { LoopExecutionPreviews, isLoopPreviewExecution } from '../tools/LoopExecutionPreviews';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import {
  localFileReference,
  localFileReferenceHref,
  markdownLocalFileReference,
  remarkLocalFileReferences,
} from './fileReferences';
import { showUiError } from '../../shared/showUiError';
import {
  remapProjectPath,
  type ProjectPathAlias,
} from '../conversationScope';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { InlineHtmlPreview, isHtmlPreviewPath } from './InlineHtmlPreview';
import { InlineAudio, InlineVideo } from './InlineMedia';
import { PluginReferenceLink } from '../plugins/PluginReferenceLink';
import { PromptReferenceFallback } from '../composer/PromptReferenceLink';
import { pluginReferenceFromLink } from '../plugins/pluginPrompts';
import { MarkdownReference, parseMarkdownReference, UnavailableMarkdownReference } from './MarkdownReference';
import { ConversationFileReference } from './ConversationFileReference';
import { FileMemoScope } from './FileMemoScope';
import { useSourceMemoReferences } from './useSourceMemoReferences';
import { remarkSourceMemoShorthand } from './sourceMemoShorthand';
import { createToolOutputProjector, mediaPresentationKey, PresentedMediaContext, PresentedMediaReference, ToolMediaContext } from './mediaPresentation';
import {
  copyText,
  readAssistantFeedback,
  recordAssistantFeedback,
  type AssistantFeedbackRating,
} from '../messageFeedback';
import { codeLanguageForFence, codeLanguageLabel } from '../../shared/codeLanguages';
import { shouldVirtualizeSource } from '../tools/sourcePreviewBlocks';
import { splitMessageMedia, splitMessageMediaBlocks } from '../messageImages';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import {
  compareToolExecutionOrder,
  isToolRunningInContext,
  ToolExecutionBlock,
  toolExecutionFinishedAt,
  type ConversationChangeReport,
} from '../tools';
import {
  toolChangeReportFromExecutions,
  type ToolChangeReport,
} from '../tools/toolChangeReports';
import { asRecord } from '../tools/toolPayload';
import {
  assistantMessageDisclosureId,
  defaultToolExecutionExpanded,
  readToolExecutionDisclosure,
  writeToolExecutionDisclosure,
} from '../tools/toolExecutionDisclosure';
import { formatCompactDuration } from './assistantTurnTiming';
import { turnActivityExecutions } from './assistantRunActivity';
import { mcpActivations } from './mcpActivation';
import { McpActivationStatus } from './McpActivationStatus';
import { TurnArtifactsMenu, type TurnArtifactEntry } from './TurnArtifactsMenu';
import { coalesceAssistantTranscript } from './assistantTranscriptPresentation';

type UserMessageDeliveryState = 'pending' | 'failed';

function userMessageDeliveryState(message: ChatMessage): UserMessageDeliveryState | null {
  const metadata = message.metadata ?? {};
  if (metadata.turn_guidance === true || metadata.name === 'turn_guidance') {
    return null;
  }
  const delivery = String(metadata.message_delivery ?? '').trim().toLowerCase();
  return delivery === 'pending' || delivery === 'failed' ? delivery : null;
}

function userGoalCommandPresentation(
  message: ChatMessage,
  text: string,
  language: AppLanguage,
  currentGoalObjective = '',
) {
  const match = text.match(/^\/goal(?:[ \t]+([\s\S]*))?$/i);
  if (match) {
    return {
      label: language === 'zh' ? '目标' : 'Goal',
      content: (match[1] ?? '').trim(),
      commandToken: '/goal',
    };
  }
  const matchesCurrentGoal = Boolean(
    currentGoalObjective.trim() &&
    normalizeGoalObjective(text) === normalizeGoalObjective(currentGoalObjective),
  );
  if (!messageHasGoalContext(message) && !matchesCurrentGoal) {
    return null;
  }
  return {
    label: language === 'zh' ? '目标' : 'Goal',
    content: text,
    commandToken: '',
  };
}

function normalizeGoalObjective(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function messageHasGoalContext(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  const goal = metadata.experimental_goal ?? metadata.experimentalGoal;
  return (
    Boolean(goal && typeof goal === 'object' && !Array.isArray(goal)) ||
    metadata.goal_auto_continuation === true ||
    metadata.goalAutoContinuation === true
  );
}

function assistantTimeoutPresentation(
  message: ChatMessage,
  language: AppLanguage,
) {
  if (message.role !== 'assistant') {
    return null;
  }
  const metadata = message.metadata ?? {};
  const stopDetails = recordFromUnknown(
    metadata.stop_details ?? metadata.stopDetails,
  );
  const reason = String(
    metadata.limit_reason ??
      metadata.limitReason ??
      metadata.stop_reason ??
      metadata.stopReason ??
      stopDetails.limit_reason ??
      stopDetails.limitReason ??
      '',
  )
    .trim()
    .toLowerCase();
  if (reason === 'llm-first-activity-timeout') {
    return {
      reason,
      title: language === 'zh' ? '模型服务没有开始响应' : 'Model provider did not start responding',
      detail:
        language === 'zh'
          ? '在首包等待上限内没有检测到流式活动。请检查服务商连接后重试。'
          : 'No stream activity arrived before the first-response deadline. Check the provider connection and retry.',
    };
  }
  if (reason === 'llm-stream-idle-timeout') {
    return {
      reason,
      title: language === 'zh' ? '模型流长时间没有活动' : 'Model stream became idle',
      detail:
        language === 'zh'
          ? '本轮已停止，此前收到的思考、正文和工具进度均已保留。'
          : 'The turn stopped; previously received reasoning, text, and tool progress were preserved.',
    };
  }
  if (
    reason === 'llm-call-timeout' ||
    reason === 'llm-generation-timeout' ||
    reason === 'turn-runtime-timeout'
  ) {
    return {
      reason,
      title: language === 'zh' ? '模型调用达到总时长上限' : 'Model call reached its duration limit',
      detail:
        language === 'zh'
          ? '本轮已停止，已收到的进度会保留在当前会话中。'
          : 'The turn stopped, and received progress remains available in this conversation.',
    };
  }
  return null;
}

function assistantFailurePresentation(
  message: ChatMessage,
  language: AppLanguage,
): { reason: string; title: string; detail: string; technicalDetails?: string; tone?: 'neutral' | 'error' } | null {
  if (message.role !== 'assistant') return null;
  const metadata = message.metadata ?? {};
  const status = String(message.status ?? metadata.status ?? '').trim().toLowerCase();
  if (status !== 'failed') return null;
  const stopDetails = recordFromUnknown(
    metadata.stop_details ?? metadata.stopDetails,
  );
  const reason = String(metadata.stop_reason ?? metadata.stopReason ?? 'runtime_failed').trim();
  const providerMessage = String(
    stopDetails.message ?? stopDetails.error ?? '',
  ).trim();
  if (reason === 'current_turn_context_limit_exceeded') {
    const inputTokens = Number(stopDetails.estimatedPromptTokens);
    const usableTokens = Number(stopDetails.usableInputTokens);
    const measured = Number.isFinite(inputTokens) && Number.isFinite(usableTokens)
      ? (language === 'zh' ? `输入估算 ${inputTokens.toLocaleString()} token，可用输入额度 ${usableTokens.toLocaleString()} token。` :
        `Estimated input: ${inputTokens.toLocaleString()} tokens; input allowance: ${usableTokens.toLocaleString()} tokens. `) : '';
    return { reason, title: language === 'zh' ? '当前输入超出上下文额度' : 'Current input exceeds the context allowance',
      detail: measured + (language === 'zh' ? '输入额度是总上下文减去预留输出额度；增大最大输出会减少可用输入。已有进度已保留。' :
        'Input allowance is the total context minus reserved output. Increasing maximum output reduces room for input. Existing progress is preserved.') };
  }
  if (reason === 'file_reference_invalid') {
    return { reason, title: language === 'zh' ? '文件链接需要修正' : 'File links need correction',
      detail: language === 'zh' ? '已尝试纠正交付链接，但仍无法确认对应文件。已有文件和完成的操作已保留，可以继续让助手重新提供链接。'
        : 'The delivery links still could not be verified after a correction attempt. Existing files and completed work are preserved. Ask the assistant to provide the links again.' };
  }
  if (reason === 'reasoning-budget-exhausted-before-action' || reason === 'model_output_limit_exceeded') {
    const attempts = Number(stopDetails.continuationAttempts) || 0;
    const maxOutput = Number(stopDetails.maxOutputTokens);
    const limit = Number.isFinite(maxOutput) && maxOutput > 0
      ? (language === 'zh' ? `当前最大输出为 ${maxOutput.toLocaleString()} token。` : `The current output limit is ${maxOutput.toLocaleString()} tokens. `)
      : '';
    return { reason, title: language === 'zh' ? '模型输出达到单次上限' : 'Model output reached its per-response limit',
      detail: language === 'zh'
        ? `${limit}${attempts ? `已自动续接 ${attempts} 次，仍未完成。` : '本次回复未能在输出上限内完成。'}已有正文和工具操作进度已保留，请提高最大输出后继续任务。`
        : `${limit}${attempts ? `Automatic continuation was attempted ${attempts} times without completion. ` : 'This response could not finish within the output limit. '}Existing text and tool progress are preserved. Increase the maximum output before continuing.` };
  }
  return {
    reason,
    ...modelFailurePresentation(reason, providerMessage, language, stopDetails.status),
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const FinalAnswerMediaContext = createContext(false);
// Assistant narration stays textual until its final response is committed.
// User references and Markdown previews outside that narration remain interactive.
const RichFileReferencesContext = createContext(true);
const noPresentedMedia: ReadonlyMap<string, ChatToolArtifact> = new Map();
const noFilePathAliases: ProjectPathAlias[] = [];

function remoteMarkdownPath(value: string | undefined, workspaceRoot: string) {
  if (!value || value.startsWith('//') || value.startsWith('#')) return '';
  const path = markdownLocalFileReference(value, workspaceRoot)?.path;
  if (path) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  try { return decodeURIComponent(value); } catch { return ''; }
}

const LazyMarkdownContent = recoverableLazy('markdown', async () => {
  const [{ default: ReactMarkdown, defaultUrlTransform }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);

  type MarkdownRenderSettings = {
    workspaceRoot: string;
    pathAliases: ProjectPathAlias[];
    language: AppLanguage;
    referenceMode: 'local' | 'remote';
  };
  const MarkdownRenderContext = createContext<MarkdownRenderSettings>({
    workspaceRoot: '', pathAliases: noFilePathAliases, language: 'zh', referenceMode: 'local',
  });
  // Focus refreshes can replace alias arrays and media maps without changing
  // the message. Component types must stay stable so resolved files, media and
  // code controls retain their state; current settings arrive through context.
  const components: Components = {
    a: ({ href, children, ...props }) => {
      const host = useContext(ConversationHostContext);
      const { workspaceRoot, pathAliases, language, referenceMode } = useContext(MarkdownRenderContext);
      const richFileReferences = useContext(RichFileReferencesContext);
      const reference = parseMarkdownReference(href);
      if (reference) return <MarkdownReference reference={reference} language={language} rich={richFileReferences}>{children}</MarkdownReference>;
      if (referenceMode === 'remote' && href && !/^(https?:\/\/|#)/i.test(href)) {
        const path = remoteMarkdownPath(href, workspaceRoot);
        return host && path ? <ConversationFileReference path={path} language={language}>{children}</ConversationFileReference> : <span>{children}</span>;
      }
      const localPath = markdownLocalFileReference(href, workspaceRoot)?.path;
      if (localPath) {
        if (!richFileReferences) return <span title={localPath}>{children}</span>;
        const pluginReference = pluginReferenceFromLink(reactNodeText(children), localPath);
        if (pluginReference) return <PluginReferenceLink reference={pluginReference} />;
        return (
          <LocalFileReferenceLink
            path={remapProjectPath(localPath, pathAliases)}
            unavailableLabel={children}
          >
            {children}
          </LocalFileReferenceLink>
        );
      }
      if (!href) {
        return <button
          type="button"
          className="markdown-link-error"
          onClick={() => void showUiError(
            language === 'zh' ? '无法打开链接' : 'Unable to open link',
            language === 'zh' ? '链接地址为空或使用了不支持的协议。' : 'The link is empty or uses an unsupported protocol.',
          )}
        >{children}</button>;
      }
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            if (href.startsWith('#')) {
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
    img: ({ src, alt, ...props }) => {
      const host = useContext(ConversationHostContext);
      const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
      const { workspaceRoot, pathAliases, language, referenceMode } = useContext(MarkdownRenderContext);
      const presentedMedia = useContext(PresentedMediaContext);
      const finalAnswerMedia = useContext(FinalAnswerMediaContext);
      const richFileReferences = useContext(RichFileReferencesContext);
      const internalReference = parseMarkdownReference(src);
      if (internalReference) return <MarkdownReference reference={internalReference} language={language} rich={richFileReferences} inline>{alt}</MarkdownReference>;
      const targetKind = resourceTargetKind(src || '');
      if (referenceMode === 'remote' && targetKind !== 'url' && targetKind !== 'inline') {
        const path = remoteMarkdownPath(src, workspaceRoot);
        return host && path && richFileReferences ? <ConversationFileReference path={path} inline language={language}>{alt}</ConversationFileReference> : <span>{alt}</span>;
      }
      if (referenceMode === 'remote' && !richFileReferences) return <span>{alt}</span>;
      const reference = markdownLocalFileReference(src, workspaceRoot);
      const resolvedPath = reference
        ? remapProjectPath(reference.path, pathAliases)
        : '';
      const resolvedSource = mediaResourceUrl(resolvedPath || src || '');
      if (!resolvedSource) {
        return <UnavailableMarkdownReference language={language}>{alt}</UnavailableMarkdownReference>;
      }
      if (resolvedPath && isHtmlPreviewPath(resolvedPath)) return richFileReferences
        ? <InlineHtmlPreview key={resolvedPath} path={resolvedPath} title={alt} language={language} />
        : <span>{alt || basename(resolvedPath)}</span>;
      const presented = presentedMedia.get(mediaPresentationKey(resolvedPath || src || ''));
      if (presented) return <PresentedMediaReference artifact={presented}>{alt}</PresentedMediaReference>;
      if (finalAnswerMedia && (isVideoPath(resolvedPath || src || '') || /^data:video\//i.test(resolvedSource))) {
        return <InlineVideo src={resolvedSource} language={language} aria-label={alt || undefined}
          onContextMenu={event => openFileContextMenu(event, resolvedPath, { language })} />;
      }
      if (finalAnswerMedia && (isAudioPath(resolvedPath || src || '') || /^data:audio\//i.test(resolvedSource))) {
        return <InlineAudio src={resolvedSource} language={language} aria-label={alt || undefined}
          onContextMenu={event => openFileContextMenu(event, resolvedPath, { language })} />;
      }
      return (
        <>
        <img
          {...props}
          src={resolvedSource}
          alt={alt ?? ''}
          onContextMenu={event => openFileContextMenu(event, resolvedPath, { image: true, language })}
          role="button"
          tabIndex={0}
          onClick={event => setImagePreview({ src: event.currentTarget.src, path: resolvedPath || src,
            name: alt || basename(resolvedPath || src || ''), naturalWidth: event.currentTarget.naturalWidth, naturalHeight: event.currentTarget.naturalHeight })}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }}
        />
        {imagePreview && <ImagePreviewDialog image={imagePreview} language={language} onClose={() => setImagePreview(null)} />}
        </>
      );
    },
    code: ({ children, className, ...props }) => {
      const { workspaceRoot, pathAliases, referenceMode, language } = useContext(MarkdownRenderContext);
      const richFileReferences = useContext(RichFileReferencesContext);
      const text = reactNodeText(children).trim();
      const reference = richFileReferences && !className
        ? localFileReference(text, workspaceRoot)
        : null;
      if (reference) {
        if (referenceMode === 'remote') return <ConversationFileReference path={reference.path} language={language}>{reference.label}</ConversationFileReference>;
        return (
          <LocalFileReferenceLink
            path={remapProjectPath(reference.path, pathAliases)}
            unavailableLabel={text}
          >
            {reference.label}
          </LocalFileReferenceLink>
        );
      }
      return <code {...props} className={className}>{children}</code>;
    },
    pre: ({ children, ...props }) => {
      const { language } = useContext(MarkdownRenderContext);
      return <MarkdownCodeBlock {...props} language={language}>{children}</MarkdownCodeBlock>;
    },
    h1: ({ children, className, ...props }) => {
      const conclusionHeading = /^(?:结论|conclusion)\s*[:：]/i.test(
        reactNodeText(children).trim(),
      );
      return (
        <h1
          {...props}
          className={[
            className,
            conclusionHeading ? 'markdown-conclusion-heading' : '',
          ].filter(Boolean).join(' ') || undefined}
        >
          {children}
        </h1>
      );
    },
    table: ({ children, ...props }) => (
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    ),
  };

  function MarkdownRenderer({
    content,
    workspaceRoot,
    pathAliases,
    language,
    referenceMode,
  }: MarkdownRenderSettings & { content: string }) {
    const richFileReferences = useContext(RichFileReferencesContext);
    const sourceReferences = useSourceMemoReferences(content, richFileReferences);
    const settings = useMemo(() => ({ workspaceRoot, pathAliases, language, referenceMode }), [workspaceRoot, pathAliases, language, referenceMode]);
    const remarkPlugins = useMemo(() => {
      const plugins: NonNullable<MarkdownOptions['remarkPlugins']> = [remarkGfm, remarkAutolinkBoundaries];
      if (sourceReferences.size) plugins.push([remarkSourceMemoShorthand, { references: sourceReferences }]);
      if (richFileReferences) plugins.push([remarkLocalFileReferences, { workspaceRoot }]);
      return plugins;
    }, [workspaceRoot, richFileReferences, referenceMode, sourceReferences]);
    const urlTransform = useCallback((url: string, key: string) => {
      if (parseMarkdownReference(url)) return url;
      if (key === 'src' && /^(?:data:(?:image|audio|video)\/|blob:|cardbush-file:\/\/)/i.test(url)) return mediaResourceUrl(url);
      if (referenceMode === 'remote') return /^(https?:\/\/|#)/i.test(url) ? defaultUrlTransform(url) : remoteMarkdownPath(url, workspaceRoot) ? url : '';
      const reference = markdownLocalFileReference(url, workspaceRoot);
      return reference ? localFileReferenceHref(reference.path) : defaultUrlTransform(url) || undefined;
    }, [workspaceRoot, referenceMode]);
    return (
      <MarkdownRenderContext.Provider value={settings}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          urlTransform={urlTransform}
          components={components}
        >
          {normalizeMarkdownContentForDisplay(content)}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
    );
  }

  return { default: MarkdownRenderer };
}, (props) => <>
  <p className="markdown-fallback"><PromptReferenceFallback content={props.content} /></p>
  <DeferredModuleNotice language={props.language} basicPreview />
</>);

const FileReferenceWorkspaceContext = createContext('');
const FileReferencePathAliasesContext = createContext<ProjectPathAlias[]>(noFilePathAliases);

export function MessageFileReferenceScope({
  workspaceRoot,
  pathAliases = noFilePathAliases,
  children,
}: {
  workspaceRoot?: string;
  pathAliases?: ProjectPathAlias[];
  children: ReactNode;
}) {
  return (
    <FileReferenceWorkspaceContext.Provider value={workspaceRoot?.trim() ?? ''}>
      <FileReferencePathAliasesContext.Provider value={pathAliases}>
        {children}
      </FileReferencePathAliasesContext.Provider>
    </FileReferenceWorkspaceContext.Provider>
  );
}

const MarkdownSyntaxCode = recoverableLazy(
  'markdown-syntax',
  () => import('./MarkdownSyntaxCode'),
  ({ content, grammar }) => <code className={`language-${grammar}`}>{content}</code>,
);

function MarkdownCodeBlock({
  children,
  language,
  ...props
}: HTMLAttributes<HTMLPreElement> & { language: AppLanguage }) {
  const [wrapped, setWrapped] = useState(false);
  const text = reactNodeText(children);
  const languageToken = markdownCodeLanguage(children);
  const codeLanguage = codeLanguageLabel(languageToken, language);
  const grammar = codeLanguageForFence(languageToken)?.grammar;
  const highlight = grammar && grammar !== 'plain' && !shouldVirtualizeSource(text);
  // Fenced code must never run through the inline file-reference renderer.
  const plainCode = <code className={languageToken ? `language-${languageToken}` : undefined}>{text}</code>;
  if (!text.trim()) {
    return null;
  }
  return (
    <div className={`markdown-code-block ${wrapped ? 'wrapped' : ''}`}>
      <div className="markdown-code-actions">
        <span className="markdown-code-language">{codeLanguage}</span>
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
      <pre {...props}>{highlight
        ? <Suspense fallback={plainCode}><MarkdownSyntaxCode content={text} grammar={grammar} /></Suspense>
        : plainCode}</pre>
    </div>
  );
}

function markdownCodeLanguage(node: ReactNode): string {
  const nodes = Array.isArray(node) ? node : [node];
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== 'object' || !('props' in candidate)) continue;
    const props = candidate.props as { className?: string };
    const token = props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.trim();
    if (!token) continue;
    return token;
  }
  return '';
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
  changeSummaryMessages,
  language,
  sending,
  activeTurnId,
  activeAssistantMessageId,
  keepActionsVisible = false,
  selectedModel = '',
  readOnlyActions = false,
  canRevertWorkspace = true,
  goalObjective = '',
  onRegenerate,
  onEditUserMessage,
  onRetryMessage = async () => undefined,
  onRevertChangeReport,
  onOpenScene,
}: {
  message: ChatMessage;
  changeSummaryMessages?: ChatMessage[];
  language: AppLanguage;
  sending: boolean;
  activeTurnId: string;
  activeAssistantMessageId: string;
  activeConversationId?: string;
  thinkingVisible?: boolean;
  keepActionsVisible?: boolean;
  selectedModel?: string;
  readOnlyActions?: boolean;
  guidanceAvailable?: boolean;
  canRevertWorkspace?: boolean;
  goalObjective?: string;
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onRetryMessage?: (message: ChatMessage) => Promise<void>;
  onRetryGuidance: (message: ChatMessage) => Promise<void>;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenChangeReview?: (filePath?: string) => void;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const host = useContext(ConversationHostContext);
  const feedbackId = host ? `${host.id}:${message.id}` : message.id;
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const keyboardShortcuts = useKeyboardShortcuts();
  const [presentToolOutputs] = useState(createToolOutputProjector);
  const contentParts = splitMessageMedia(message.content);
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
  const videoPaths = uniqueAttachmentPaths([
    ...contentParts.videoPaths,
    ...(message.attachments ?? [])
      .filter((attachment) =>
        attachment.type === 'video' || isVideoPath(attachment.path ?? ''),
      )
      .map((attachment) => attachment.path?.trim() ?? '')
      .filter(Boolean),
  ]);
  const audioPaths = uniqueAttachmentPaths([
    ...contentParts.audioPaths,
    ...(message.attachments ?? [])
      .filter((attachment) =>
        attachment.type === 'audio' || isAudioPath(attachment.path ?? ''),
      )
      .map((attachment) => attachment.path?.trim() ?? '')
      .filter(Boolean),
  ]);
  const legacyGoalCommandText =
    message.role === 'user'
      ? legacyUserGoalCommandText(message.attachments ?? [], userContentParts.text)
      : null;
  const text = legacyGoalCommandText ?? userContentParts.text;
  const assistantContent = message.role === 'assistant' ? message.content : text;
  const detachedImagePaths = pathsNotEmbeddedInContent(
    imagePaths,
    contentParts.imagePaths,
  );
  const detachedVideoPaths = pathsNotEmbeddedInContent(
    videoPaths,
    contentParts.videoPaths,
  );
  const detachedAudioPaths = pathsNotEmbeddedInContent(
    audioPaths,
    contentParts.audioPaths,
  );
  const goalCommand =
    message.role === 'user'
      ? userGoalCommandPresentation(message, text, language, goalObjective)
      : null;
  const visibleAttachments = legacyGoalCommandText
    ? (message.attachments ?? []).filter(
        (attachment) => !isGoalCommandAttachmentPath(attachment.path ?? ''),
      )
    : message.attachments ?? [];
  const fileAttachments = userMessageFileAttachments(
    visibleAttachments,
    userContentParts.paths.filter(
      (pathValue) =>
        !isImagePath(pathValue) &&
        !(legacyGoalCommandText && isGoalCommandAttachmentPath(pathValue)),
    ),
  );
  const allToolExecutions = message.toolExecutions ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [assistantFeedback, setAssistantFeedback] =
    useState<AssistantFeedbackRating | null>(() => readAssistantFeedback(feedbackId));
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
  const messageDelivery =
    message.role === 'user' ? userMessageDeliveryState(message) : null;
  const messageTeamId = String(message.metadata?.team_id ?? message.metadata?.teamId ?? '').trim();
  const messageTeamName = String(message.metadata?.team_name ?? message.metadata?.teamName ?? messageTeamId).trim();

  useEffect(() => {
    setEditing(false);
    setSubmittingEdit(false);
    setAssistantFeedback(readAssistantFeedback(feedbackId));
    setFeedbackPulse(null);
    setEditText(splitMessageMedia(message.content).text);
  }, [message.id, feedbackId]);

  useEffect(() => {
    if (!editing) {
      setEditText(splitMessageMedia(message.content).text);
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
        ...videoPaths,
        ...audioPaths,
        ...fileAttachments.map((attachment) => attachment.path ?? ''),
      ]).map((pathValue) => `@${remapProjectPath(pathValue, pathAliases)}`),
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
    recordAssistantFeedback(host ? { ...message, id: feedbackId, conversationId: host.id } : message, nextRating);
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
            <MessageMediaStrip
              videoPaths={videoPaths}
              audioPaths={audioPaths}
              language={language}
            />
            <MessageFileAttachmentStrip
              attachments={fileAttachments}
              language={language}
            />
            <textarea
              value={editText}
              autoFocus
              onChange={(event) => setEditText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (keyboardShortcuts.matches('submitEdit', event) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
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
                    videoPaths.length === 0 &&
                    audioPaths.length === 0 &&
                    fileAttachments.length === 0)
                }
                onClick={() => void submitEdit()}
                title={keyboardShortcuts.label('submitEdit')}
                aria-keyshortcuts={keyboardShortcuts.aria('submitEdit')}
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
          {Boolean(message.metadata?.subagent_author) && <div className="subagent-message-author">
            {message.metadata?.subagent_author === 'parent' ? (language === 'zh' ? '主 Agent' : 'Parent Agent') : (language === 'zh' ? '你' : 'You')}
          </div>}
          <MessageImageStrip paths={imagePaths} language={language} />
          <MessageMediaStrip
            videoPaths={videoPaths}
            audioPaths={audioPaths}
            language={language}
          />
          <MessageFileAttachmentStrip
            attachments={fileAttachments}
            language={language}
          />
          {messageTeamId && (
            <div className="user-team-context" title={`Team: ${messageTeamId}`}>
              <UsersRound size={12} />
              <span>{messageTeamName || messageTeamId}</span>
            </div>
          )}
          {goalCommand && (
            <div className={`user-command-heading goal${goalCommand.content ? ' has-content' : ''}`}>
              <Target size={14} />
              <strong>{goalCommand.label}</strong>
              {goalCommand.commandToken && (
                <span className="user-command-token">{goalCommand.commandToken}</span>
              )}
            </div>
          )}
          {(goalCommand?.content ?? text) && (
            <MarkdownContent content={goalCommand?.content ?? text} language={language} />
          )}
          <AutomationReminderCard value={message.metadata?.automationReminder} language={language}/>
          {messageDelivery === 'failed' && (
            <div
              className="message-delivery-status failed"
              role="status"
              aria-live="polite"
            >
              <X size={12} />
              <span>{language === 'zh' ? '发送失败' : 'Failed to send'}</span>
              <button
                type="button"
                className="message-retry-button"
                hidden={readOnlyActions}
                onClick={() => void onRetryMessage(message)}
              >
                <RefreshCw size={11} />
                {language === 'zh' ? '重试' : 'Retry'}
              </button>
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
            hidden={readOnlyActions}
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
  const stoppedAssistantRound = isStoppedAssistantMessage(message);
  const failedAssistantRound = isFailedAssistantMessage(message);
  // Final-display intent is independent of turn completion. Keep stop/actions
  // and task state live, but archive the process as soon as final text streams.
  const streamingFinalResponse = isActiveAssistantTurn &&
    String(message.metadata?.transcript_kind ?? message.metadata?.transcriptKind ?? '') === 'assistant_final';
  const showActiveProcess = isActiveAssistantTurn && !streamingFinalResponse;
  const guidanceBoundaryRound =
    !isActiveAssistantTurn && isGuidanceBoundaryAssistantMessage(message);
  const freezeTerminalTranscript =
    (stoppedAssistantRound || failedAssistantRound || guidanceBoundaryRound) && loopHistory.length > 0;
  const visibleLoopHistory =
    showActiveProcess || freezeTerminalTranscript ? [] : loopHistory;
  const activeTranscriptMessages = showActiveProcess || freezeTerminalTranscript
    ? activeAssistantTranscriptMessages(
        loopHistory,
        message,
      )
    : [];
  const renderActiveTranscript =
    showActiveProcess ||
    activeTranscriptMessages.length > 1 ||
    (freezeTerminalTranscript && activeTranscriptMessages.length > 0);
  const preserveTerminalExecutionRecord =
    (stoppedAssistantRound || failedAssistantRound) &&
    !visibleLoopHistory.some(
      (historyMessage) => (historyMessage.toolExecutions?.length ?? 0) > 0,
    );
  const toolExecutions =
    message.role === 'assistant'
      ? visibleTopLevelToolExecutions(
          allToolExecutions,
          isActiveAssistantTurn ||
            guidanceBoundaryRound ||
            preserveTerminalExecutionRecord,
        )
      : allToolExecutions;
  const assistantProgressExecutions = turnActivityExecutions(message);
  const outputPresentation = presentToolOutputs(assistantProgressExecutions, pathAliases);
  const activations = mcpActivations(assistantProgressExecutions);
  const showAssistantProgress =
    message.role === 'assistant' &&
    !stoppedAssistantRound &&
    (isActiveAssistantTurn ||
      toolExecutions.length > 0 ||
      assistantProgressExecutions.some(execution => execution.artifacts?.length || execution.name === 'mcp_call' || execution.name.startsWith('mcp__')) ||
      hasAssistantProgressSource(message, assistantProgressExecutions));
  const assistantCompletedAt =
    message.role === 'assistant' && !isActiveAssistantTurn
      ? assistantTurnCompletedAt(message, assistantProgressExecutions)
      : undefined;
  const taskPlan = message.role === 'assistant'
    ? message.taskPlan ?? [...loopHistory].reverse().find(item => item.taskPlan)?.taskPlan
    : undefined;
  const archiveTaskPlanInHistory = Boolean(
    taskPlan && !taskPlan.active && visibleLoopHistory.length > 0,
  );
  const finalAssistantRound =
    (!isActiveAssistantTurn || streamingFinalResponse) && isFinalAssistantDisplayMessage(message);
  const showFinalAnswer = finalAssistantRound &&
    !guidanceBoundaryRound && !stoppedAssistantRound && !failedAssistantRound;
  const showAssistantActions = !isActiveAssistantTurn && !guidanceBoundaryRound &&
    !(sending && activeMessageTurn && activeMessageTurn === activeTurn) &&
    (finalAssistantRound || stoppedAssistantRound || failedAssistantRound);
  const historyToolIds = new Set(visibleLoopHistory.flatMap(item => (item.toolExecutions ?? []).map(tool => tool.id)));
  const trailingHistoryTools = allToolExecutions.filter(tool => !historyToolIds.has(tool.id));
  const completedHistory = trailingHistoryTools.length > 0
    ? [...visibleLoopHistory, { ...message, content: '', loopHistory: undefined, toolExecutions: trailingHistoryTools }]
    : visibleLoopHistory;
  // Guidance completes a segment, not the Turn. Publish artifacts once the
  // Turn completes or is explicitly stopped, next to its completion time.
  const completedChangeReport = !isActiveAssistantTurn && !guidanceBoundaryRound &&
    (stoppedAssistantRound || (finalAssistantRound && !failedAssistantRound))
    ? completedAssistantChangeReport(message, changeSummaryMessages)
    : null;
  const completedArtifacts = !isActiveAssistantTurn && !guidanceBoundaryRound &&
    (stoppedAssistantRound || (finalAssistantRound && !failedAssistantRound))
    ? completedTurnExecutions(message, changeSummaryMessages).flatMap(execution => execution.artifacts ?? [])
    : [];
  const timeoutPresentation = assistantTimeoutPresentation(message, language);
  const failurePresentation = assistantFailurePresentation(message, language);
  const hookSummary = agentHookSummaryFromMessage(message);
  const hasAssistantBody = Boolean(
    text.trim() ||
      imagePaths.length > 0 ||
      videoPaths.length > 0 ||
      audioPaths.length > 0 ||
      toolExecutions.length > 0 ||
      (!isActiveAssistantTurn && taskPlan) ||
      renderActiveTranscript ||
      visibleLoopHistory.length > 0 ||
      timeoutPresentation ||
      failurePresentation ||
      completedChangeReport ||
      hookSummary,
  );
  if (!showAssistantProgress && !hasAssistantBody) {
    return null;
  }
  const assistantBodyContent = (
    <>
      <AgentHookSummaryBadge message={message} language={language} />
      {!renderActiveTranscript && (
        <>
          <MessageImageStrip paths={detachedImagePaths} language={language} />
          <MessageMediaStrip
            videoPaths={detachedVideoPaths}
            audioPaths={detachedAudioPaths}
            language={language}
          />
        </>
      )}
      {renderActiveTranscript ? (
        <AssistantActiveTranscript
          messages={activeTranscriptMessages}
          language={language}
          active={isActiveAssistantTurn}
          selectedModel={selectedModel}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      ) : toolExecutions.length > 0 ? (
        <AssistantMessageContent
          content={assistantContent}
          executions={toolExecutions}
          language={language}
          message={message}
          active={isActiveAssistantTurn}
          historyLabel={
            !isActiveAssistantTurn &&
            !stoppedAssistantRound &&
            !failedAssistantRound &&
            !guidanceBoundaryRound
          }
          selectedModel={selectedModel}
          showThinkingPlaceholder={isActiveAssistantTurn}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      ) : assistantContent ? (
        <>
          <MessageInlineMediaContent content={assistantContent} language={language} />
          {isActiveAssistantTurn && (
            <AssistantThinkingProcessLine
              language={language}
              model={selectedModel}
            />
          )}
        </>
      ) : isActiveAssistantTurn ? (
        <AssistantThinkingProcessLine language={language} model={selectedModel} />
      ) : null}
      {visibleLoopHistory.length > 0 && (
        <AssistantLoopHistoryBlock
          history={visibleLoopHistory}
          archivedPlan={archiveTaskPlanInHistory ? taskPlan : undefined}
          language={language}
          active={isActiveAssistantTurn}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      )}
      {taskPlan && !isActiveAssistantTurn && !archiveTaskPlanInHistory && (
        <TaskPlanBlock plan={taskPlan} language={language} />
      )}
    </>
  );
  const assistantBody = (
    <RichFileReferencesContext.Provider value={false}>
      {assistantBodyContent}
    </RichFileReferencesContext.Provider>
  );
  const finalAnswerBody = (
    <FinalAnswerMediaContext.Provider value={true}>
      <PresentedMediaContext.Provider value={noPresentedMedia}>
        <div className="assistant-final-answer">
          {assistantContent && (
            <MessageInlineMediaContent
              content={assistantTextWithoutToolNarration(assistantContent, toolExecutions)}
              language={language}
            />
          )}
        </div>
      </PresentedMediaContext.Provider>
    </FinalAnswerMediaContext.Provider>
  );
  return (
    <PresentedMediaContext.Provider value={outputPresentation.inlineMedia}>
    <ToolMediaContext.Provider value={outputPresentation.mediaByExecution}>
    <McpAppReferencesContext.Provider value={{ sessionId: host?.sessionId ?? message.conversationId ?? '', enabled: !sending && finalAssistantRound }}>
      <div className={`message-row assistant${isActiveAssistantTurn ? ' streaming' : ''}`}>
        <div className="assistant-bubble">
          {activations.map(target => <McpActivationStatus key={target.serverId}
            target={target} isActive={isActiveAssistantTurn} language={language} />)}
          {showAssistantProgress && showActiveProcess && (
            <AssistantRunHeader
              executions={assistantProgressExecutions}
              isActive={isActiveAssistantTurn}
              message={message}
              language={language}
            />
          )}
          {showActiveProcess ? (
            assistantBody
          ) : guidanceBoundaryRound ? (
            assistantBody
          ) : stoppedAssistantRound ? (
            assistantBody
          ) : failedAssistantRound ? (
            <>
              {showAssistantProgress && (
                <AssistantRunHeader
                  executions={assistantProgressExecutions}
                  isActive={false}
                  message={message}
                  language={language}
                />
              )}
              {assistantBody}
            </>
          ) : showFinalAnswer ? (
            <>
              {completedHistory.length > 0 || taskPlan ? (
                <AssistantCompletedDisclosure
                  message={message}
                  executions={assistantProgressExecutions}
                  language={language}
                  active={isActiveAssistantTurn}
                >
                  {completedHistory.length > 0 ? <AssistantLoopHistoryBlock
                    history={completedHistory}
                    archivedPlan={taskPlan}
                    language={language}
                    onRevertChangeReport={onRevertChangeReport}
                    onOpenScene={onOpenScene}
                  /> : taskPlan && <TaskPlanBlock plan={taskPlan} language={language} />}
                </AssistantCompletedDisclosure>
              ) : showAssistantProgress && (
                <AssistantRunHeader
                  executions={assistantProgressExecutions}
                  isActive={isActiveAssistantTurn}
                  message={message}
                  language={language}
                />
              )}
            </>
          ) : (
            <AssistantCompletedDisclosure
              message={message}
              executions={assistantProgressExecutions}
              language={language}
            >
              {assistantBody}
            </AssistantCompletedDisclosure>
          )}
          {completedArtifacts.length === 0 && <MessageToolOutputs key="tool-outputs"
            artifacts={outputPresentation.artifacts.filter(artifact => !['image', 'video', 'audio'].includes(artifact.type))} language={language} />}
          {showFinalAnswer && finalAnswerBody}
          {timeoutPresentation && (
            <div
              className="assistant-timeout-notice"
              data-timeout-reason={timeoutPresentation.reason}
              role="status"
            >
              <Clock3 size={15} />
              <span>
                <strong>{timeoutPresentation.title}</strong>
                <small>{timeoutPresentation.detail}</small>
              </span>
            </div>
          )}
          {failurePresentation && (
            <div
              className={`assistant-timeout-notice ${failurePresentation.tone === 'neutral' ? 'assistant-plan-notice' : 'assistant-failure-notice'}`}
              data-failure-reason={failurePresentation.tone === 'neutral' ? undefined : failurePresentation.reason}
              data-plan-reason={failurePresentation.tone === 'neutral' ? failurePresentation.reason : undefined}
              role={failurePresentation.tone === 'neutral' ? 'status' : 'alert'}
            >
              {failurePresentation.tone === 'neutral' ? <Clock3 size={15} /> : <CircleAlert size={15} />}
              <div className="assistant-failure-content">
                <strong>{failurePresentation.title}</strong>
                <small>{failurePresentation.detail}</small>
                {failurePresentation.technicalDetails && <details className="assistant-failure-details">
                  <summary>{language === 'zh' ? '错误详情' : 'Error details'}</summary>
                  <pre>{failurePresentation.technicalDetails}</pre>
                </details>}
              </div>
            </div>
          )}
        </div>
        {showAssistantActions && <div className={`message-actions${keepActionsVisible ? ' latest' : ''}`}>
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
              title={language === 'zh' ? '有帮助' : 'Helpful'}
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
              title={language === 'zh' ? '不理想' : 'Needs improvement'}
              onClick={() => toggleAssistantFeedback('down')}
            >
              <ThumbsDown size={14} />
            </button>
            {activeMessageTurn && (
              <button
                type="button"
                title={language === 'zh' ? '重新生成' : 'Retry'}
                hidden={readOnlyActions}
                disabled={sending}
                onClick={() => void onRegenerate(message)}
              >
                <RefreshCw size={14} />
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
          {(completedChangeReport || completedArtifacts.length > 0) && <AssistantTurnArtifacts
            key={`${message.conversationId ?? ''}:${message.turnId ?? message.id}`}
            message={message} report={completedChangeReport} artifacts={completedArtifacts} language={language}
            onRevert={readOnlyActions || !canRevertWorkspace || !completedChangeReport || completedChangeReport.revertSupported === false ? undefined : () => onRevertChangeReport({
              ...completedChangeReport, id: `${message.id}:turn-artifacts`, messageId: message.id,
              turnId: message.turnId, createdAt: message.createdAt,
            }, message)} />}
        </div>}
      </div>
    </McpAppReferencesContext.Provider>
    </ToolMediaContext.Provider>
    </PresentedMediaContext.Provider>
  );
}

const completedAssistantChangeReportCache = new WeakMap<
  ChatMessage | ChatMessage[],
  Map<string, ReturnType<typeof toolChangeReportFromExecutions>>
>();

function completedAssistantChangeReport(message: ChatMessage, turnMessages?: ChatMessage[]) {
  const source = turnMessages ?? message;
  const identity = JSON.stringify([message.conversationId, message.turnId ?? message.id]);
  const cached = completedAssistantChangeReportCache.get(source);
  if (cached?.has(identity)) return cached.get(identity) ?? null;
  const report = toolChangeReportFromExecutions(completedTurnExecutions(message, turnMessages));
  const visibleReport = report?.files.length ? report : null;
  const reports = cached ?? new Map();
  reports.set(identity, visibleReport);
  completedAssistantChangeReportCache.set(source, reports);
  return visibleReport;
}

function completedTurnExecutions(message: ChatMessage, turnMessages?: ChatMessage[]) {
  const executions = new Map<string, ChatToolExecution>();
  const collect = (candidate: ChatMessage) => {
    if (message.turnId && candidate.turnId && candidate.turnId !== message.turnId) return;
    if (message.conversationId && candidate.conversationId && candidate.conversationId !== message.conversationId) return;
    for (const nested of candidate.loopHistory ?? []) collect(nested);
    for (const execution of candidate.toolExecutions ?? []) {
      if (message.turnId && execution.turnId && execution.turnId !== message.turnId) continue;
      executions.set(execution.id, execution);
    }
  };
  for (const candidate of turnMessages ?? [message]) collect(candidate);
  return Array.from(executions.values());
}

function AssistantTurnArtifacts({ message, report, artifacts, language, onRevert }: {
  message: ChatMessage;
  report: ToolChangeReport | null;
  artifacts: ChatToolArtifact[];
  language: AppLanguage;
  onRevert?: () => Promise<void>;
}) {
  const host = useContext(ConversationHostContext);
  const workspaceRoot = useContext(FileReferenceWorkspaceContext);
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const changeState = useContext(WorkspaceChangeStateContext);
  const reverted = workspaceChangeReverted(changeState.states, message.conversationId ?? '', {
    messageId: message.id, turnId: message.turnId, reverted: report?.reverted,
  });
  const entries = new Map<string, TurnArtifactEntry>();
  const resolve = (value: string) => remapProjectPath(resolveChangedFilePath(value, workspaceRoot), pathAliases);
  const key = (value: string) => /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
    ? value.replaceAll('\\', '/').toLowerCase() : value;
  for (const file of report?.files ?? []) {
    const path = resolve(file.path);
    entries.set(key(path), { path, name: basename(file.path), additions: file.additions, deletions: file.deletions });
  }
  for (const artifact of artifacts) {
    if (!artifact.path || /^data:/i.test(artifact.path)) continue;
    const path = resolve(artifact.path);
    if (entries.has(key(path))) continue;
    entries.set(key(path), { path, name: artifact.name || basename(path),
      mediaType: artifact.type === 'image' || artifact.type === 'video' || artifact.type === 'audio' ? artifact.type : undefined });
  }
  if (!entries.size) return null;
  return <TurnArtifactsMenu items={[...entries.values()]} language={language} reverted={reverted}
    busy={changeState.busy} onRevert={onRevert}
    onContextMenu={host ? undefined : (event, item) => openFileContextMenu(event, item.path, { language })}
    onOpen={item => {
      if (/^https?:\/\//i.test(item.path)) window.open(item.path, '_blank', 'noopener,noreferrer');
      else if (host) host.openFile(item.path);
      else openInspector(item.path, item.name);
    }} />;
}

function resolveChangedFilePath(pathValue: string, workspaceRoot: string) {
  const path = stripWrappingQuotes(pathValue.trim());
  const root = stripWrappingQuotes(workspaceRoot.trim());
  if (!path || !root || isAbsoluteLocalPath(path) || /^(?:https?|file|ssh):/i.test(path)) {
    return path;
  }
  const separator = root.includes('\\') ? '\\' : '/';
  const normalizedRelative = path
    .replace(/^[.][\\/]/, '')
    .replace(/[\\/]+/g, separator);
  return `${root.replace(/[\\/]+$/, '')}${separator}${normalizedRelative}`;
}

function TaskPlanBlock({
  plan,
  language,
}: {
  plan: NonNullable<ChatMessage['taskPlan']>;
  language: AppLanguage;
}) {
  const completed = plan.nodes.filter((item) => item.status === 'completed').length;
  const waiting = plan.nodes.some(item => item.status === 'waiting');
  return (
    <section className={`task-plan-block ${waiting ? 'waiting' : plan.active ? 'active' : 'completed'}`}>
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
            <span>{item.step}{item.status === 'waiting' && <small> — {language === 'zh' ? '等待：' : 'Waiting: '}{item.waitingFor}</small>}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AssistantSegmentAttachments({
  message,
  language,
}: {
  message: ChatMessage;
  language: AppLanguage;
}) {
  const embedded = splitMessageMedia(message.content);
  const attachments = message.attachments ?? [];
  const paths = (type: 'image' | 'video' | 'audio') => uniqueAttachmentPaths(
    attachments
      .filter((attachment) => attachment.type === type ||
        (type === 'video' && isVideoPath(attachment.path ?? '')) ||
        (type === 'audio' && isAudioPath(attachment.path ?? '')))
      .map((attachment) => attachment.path?.trim() ?? '')
      .filter(Boolean),
  );
  return <>
    <MessageImageStrip
      paths={pathsNotEmbeddedInContent(paths('image'), embedded.imagePaths)}
      language={language}
    />
    <MessageMediaStrip
      videoPaths={pathsNotEmbeddedInContent(paths('video'), embedded.videoPaths)}
      audioPaths={pathsNotEmbeddedInContent(paths('audio'), embedded.audioPaths)}
      language={language}
    />
  </>;
}

function AssistantActiveTranscript({
  messages,
  language,
  active,
  selectedModel,
  onRevertChangeReport,
  onOpenScene,
}: {
  messages: ChatMessage[];
  language: AppLanguage;
  active: boolean;
  selectedModel: string;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const visibleMessages = messages.filter(hasVisibleLoopHistoryMessage);
  const runningExecution = visibleMessages.flatMap(message => message.toolExecutions ?? [])
    .find(execution => isToolRunningInContext(execution, active));
  return (
    <div className="assistant-active-transcript">
      {visibleMessages.map((segment) => {
        const executions = segment.toolExecutions ?? [];
        return (
          <section
            key={segment.id}
            className="assistant-active-transcript-segment"
            data-segment-id={segment.id}
          >
            <AssistantSegmentAttachments message={segment} language={language} />
            <AssistantMessageContent
              content={segment.content}
              executions={executions}
              language={language}
              message={segment}
              active={active}
              historyLabel={false}
              selectedModel={selectedModel}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          </section>
        );
      })}
      {/* One stable tail slot: queued/running/thinking changes its text, never
          removes a row of height or reparents the preceding media. */}
      {active && <AssistantThinkingProcessLine key="activity" language={language}
        model={selectedModel} execution={runningExecution} />}
    </div>
  );
}

function activeAssistantTranscriptMessages(
  loopHistory: ChatMessage[],
  currentMessage: ChatMessage,
) {
  const transcript = [...loopHistory, currentMessage]
    .filter(hasVisibleLoopHistoryMessage);
  return coalesceAssistantTranscript(transcript);
}

function AssistantMessageContent({
  content,
  executions,
  language,
  message,
  active,
  historyLabel = !active,
  selectedModel = '',
  showThinkingPlaceholder = false,
  onRevertChangeReport,
  onOpenScene,
}: {
  content: string;
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  active: boolean;
  historyLabel?: boolean;
  selectedModel?: string;
  showThinkingPlaceholder?: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const mediaByExecution = useContext(ToolMediaContext);
  const sortedExecutions = [...executions].sort(compareToolExecutionOrder);
  const displayContent = sortedExecutions.some(hasExplicitToolContentOffset)
    ? content
    : normalizeExecutionNarrationForDisplay(content, sortedExecutions.length);
  const groups = groupExecutionsByContentOffset(displayContent, sortedExecutions);
  const blocks: ReactNode[] = [];
  let cursor = 0;

  groups.forEach((group, index) => {
    const groupKey = group.executions[0]?.id || String(index);
    const listedExecutions = group.executions.filter(execution => !isLoopPreviewExecution(execution));
    const segment = displayContent.slice(cursor, group.offset);
    if (segment.trim()) {
      blocks.push(
        <MessageInlineMediaContent
          key={`text-${cursor}`}
          content={segment.trim()}
          language={language}
        />,
      );
    }
    if (listedExecutions.length) blocks.push(
      <ToolExecutionBlock
        key={`tools-${groupKey || index}`}
        executions={listedExecutions}
        showImagePreviews={false}
        language={language}
        message={message}
        active={active}
        historyLabel={historyLabel}
        onRevertChangeReport={onRevertChangeReport}
        onOpenScene={onOpenScene}
      />,
    );
    blocks.push(<LoopExecutionPreviews key={`previews-${groupKey}`} executions={group.executions}
      message={message} language={language} active={active} />);
    // Images open on demand from the separate execution preview row.
    const media = group.executions.flatMap(execution => mediaByExecution.get(execution.id) ?? [])
      .filter(artifact => artifact.type !== 'image');
    if (media.length) {
      blocks.push(
        <div key={`media-${groupKey}`} className="message-tool-outputs message-tool-media-outputs">
          {media.map(artifact => <MessageToolArtifact key={mediaPresentationKey(artifact.path)} artifact={artifact} language={language} />)}
        </div>,
      );
    }
    cursor = group.offset;
  });

  const tail = displayContent.slice(cursor);
  if (tail.trim()) {
    blocks.push(
      <MessageInlineMediaContent key={`text-${cursor}`} content={tail.trim()} language={language} />,
    );
  }
  if (showThinkingPlaceholder) {
    blocks.push(
      <AssistantThinkingProcessLine
        key="thinking-placeholder"
        language={language}
        model={selectedModel}
        execution={sortedExecutions.find(execution => isToolRunningInContext(execution, active))}
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
    if (
      previous &&
      previous.offset === offset
    ) {
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
  visible: boolean,
) {
  return visible ? executions : [];
}

function isStoppedAssistantMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  return (
    message.status === 'stopped' ||
    message.metadata?.stopped === true ||
    message.metadata?.cardbush_terminal_stopped === true
  );
}

function isFailedAssistantMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  return String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase() === 'failed';
}

function isGuidanceBoundaryAssistantMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  const metadata = message.metadata ?? {};
  return (
    metadata.segment_boundary === 'turn_guidance' ||
    metadata.segmentBoundary === 'turn_guidance' ||
    String(
      metadata.sealed_by_client_message_id ??
        metadata.sealedByClientMessageId ??
        '',
    ).trim().length > 0
  );
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
  if (status === 'failed') {
    return false;
  }
  return (
    status === 'completed' ||
    transcriptKind === 'assistant_final' ||
    (!status && !transcriptKind)
  );
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
    metadata.cardbush_turn_duration_ms,
    metadata.turn_duration_ms,
    metadata.duration_ms,
    metadata.elapsed_ms,
  ].some(
    (value) =>
      (typeof value === 'string' && Boolean(value.trim())) ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0),
  );
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
  message,
  executions,
  language,
  active = false,
  children,
}: {
  message: ChatMessage;
  executions: ChatToolExecution[];
  language: AppLanguage;
  active?: boolean;
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
    message,
    executions,
    isActive: active,
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
  const persistedDurationMs = assistantDurationFromMetadata(metadata);
  const startedAt = earliestTimestamp([
    metadata.cardbush_turn_started_at,
    metadata.cardbushTurnStartedAt,
    metadata.turn_started_at,
    metadata.turnStartedAt,
    metadata.started_at,
    metadata.startedAt,
    message.createdAt,
    ...executions.map((execution) => execution.createdAt),
  ]);
  if (isActive) {
    return startedAt == null ? null : Math.max(0, now - startedAt);
  }
  if (persistedDurationMs != null) {
    return persistedDurationMs;
  }
  const completedAt = latestTimestamp([
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
    message.createdAt,
    ...executions.map((execution) => toolExecutionFinishedAt(execution)),
  ]);
  if (startedAt != null && completedAt != null && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  const toolDurationMs = executions.reduce(
    (total, execution) => total + Math.max(0, execution.durationMs),
    0,
  );
  return toolDurationMs > 0 ? toolDurationMs : null;
}

function assistantDurationFromMetadata(metadata: Record<string, unknown>) {
  for (const value of [
    metadata.cardbush_turn_duration_ms,
    metadata.cardbushTurnDurationMs,
    metadata.turn_duration_ms,
    metadata.turnDurationMs,
    metadata.duration_ms,
    metadata.durationMs,
    metadata.elapsed_ms,
    metadata.elapsedMs,
  ]) {
    const duration = Number(value);
    if (Number.isFinite(duration) && duration >= 0) return duration;
  }
  return undefined;
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
  active = false,
  onRevertChangeReport = async () => undefined,
  onOpenScene = () => undefined,
}: {
  history: ChatMessage[];
  archivedPlan?: NonNullable<ChatMessage['taskPlan']>;
  language: AppLanguage;
  active?: boolean;
  onRevertChangeReport?: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene?: (scene: CardlingScene) => void;
}) {
  const visibleHistory = coalesceAssistantTranscript(history).filter(hasVisibleLoopHistoryMessage);
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const [presentToolOutputs] = useState(createToolOutputProjector);
  const outputPresentation = presentToolOutputs(turnActivityExecutions({ loopHistory: history }), pathAliases);
  const summary =
    language === 'zh'
      ? '历史执行记录'
      : 'Execution history';

  if (visibleHistory.length === 0) {
    return null;
  }

  return (
    <PresentedMediaContext.Provider value={outputPresentation.inlineMedia}>
    <ToolMediaContext.Provider value={outputPresentation.mediaByExecution}>
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
            message={historyMessage}
            language={language}
            active={active}
            onRevertChangeReport={onRevertChangeReport}
            onOpenScene={onOpenScene}
          />
        ))}
      </div>
    </div>
    </ToolMediaContext.Provider>
    </PresentedMediaContext.Provider>
  );
}

function AssistantLoopHistoryItem({
  message,
  language,
  active,
  onRevertChangeReport,
  onOpenScene,
}: {
  message: ChatMessage;
  language: AppLanguage;
  active: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const executions = message.toolExecutions ?? [];

  return (
    <section
      className="assistant-loop-history-item"
      data-testid="assistant-loop-history-item"
    >
      {executions.length > 0 ? (
        <AssistantMessageContent
          content={message.content}
          executions={executions}
          language={language}
          message={message}
          active={active}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      ) : message.content ? (
        <MessageInlineMediaContent content={message.content} language={language} />
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

function splitUserFileAttachments(content: string) {
  const { text, paths } = splitExplicitAttachmentMentions(content);
  const keptLines = text.split(/\r?\n/);

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

function legacyUserGoalCommandText(
  attachments: ChatAttachment[],
  content: string,
) {
  const normalizedContent = content.trim();
  if (
    normalizedContent &&
    normalizedContent !== 'Please review the attached file(s).'
  ) {
    return null;
  }
  const candidates = attachments
    .map((attachment) => attachment.path?.trim() ?? '')
    .filter(isGoalCommandAttachmentPath);
  return candidates.length === 1 ? candidates[0] : null;
}

function isGoalCommandAttachmentPath(value: string) {
  return /^\/goal(?:\s|$)/i.test(value.trim());
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

function pathsNotEmbeddedInContent(paths: string[], embeddedPaths: string[]) {
  const embedded = new Set(
    embeddedPaths.map((pathValue) => pathValue.trim().replace(/\\/g, '/').toLowerCase()),
  );
  return paths.filter(
    (pathValue) => !embedded.has(pathValue.trim().replace(/\\/g, '/').toLowerCase()),
  );
}

function userMessageFileAttachments(
  attachments: ChatAttachment[],
  parsedPaths: string[],
) {
  const byPath = new Map<string, ChatAttachment>();
  for (const attachment of attachments) {
    const pathValue = attachment.path?.trim() ?? '';
    if (
      !pathValue ||
      attachment.type === 'image' ||
      attachment.type === 'video' ||
      attachment.type === 'audio' ||
      isImagePath(pathValue) ||
      isVideoPath(pathValue) ||
      isAudioPath(pathValue)
    ) {
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

function MessageMediaStrip({ videoPaths, audioPaths, language }: { videoPaths: string[]; audioPaths: string[]; language: AppLanguage }) {
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const presentedMedia = useContext(PresentedMediaContext);
  if (!videoPaths.length && !audioPaths.length) return null;
  return <div className="message-media-strip">{[...videoPaths.map(path => ({ path, kind: 'video' as const })), ...audioPaths.map(path => ({ path, kind: 'audio' as const }))].map(item => {
    const path = remapProjectPath(item.path, pathAliases), presented = presentedMedia.get(mediaPresentationKey(path));
    return presented ? <PresentedMediaReference key={path} artifact={presented}/> : <MessagePlayableMedia key={path} path={path} kind={item.kind} language={language}/>;
  })}</div>;
}

function MessagePlayableMedia({ path, kind, language }: { path: string; kind: 'video' | 'audio'; language: AppLanguage }) {
  const host = useContext(ConversationHostContext);
  const file = useConversationFileSource(path);
  const name = basename(path);
  const Player = kind === 'video' ? InlineVideo : InlineAudio;
  const caption = <figcaption title={path}>{name}</figcaption>;
  return <figure className={`message-${kind}-player`} onContextMenu={host ? undefined : event => openFileContextMenu(event, path, { language })}>
    {kind === 'audio' && caption}
    {file.error ? <span role="alert">{file.error}</span> : file.source ? <Player controls preload="metadata" src={file.source} language={language} aria-label={language === 'zh' ? `播放${kind === 'video' ? '视频' : '音频'} ${name}` : `Play ${kind} ${name}`}/> : <span role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</span>}
    {kind === 'video' && caption}
  </figure>;
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

function MessageFileIcon({
  name,
  kind,
}: {
  name: string;
  kind: 'file' | 'folder';
}) {
  const extension = messageFileExtension(name);
  const iconKind = kind === 'folder' ? 'folder' : messageFileIconKind(extension);
  const icon = iconKind === 'folder'
    ? <FolderOpen size={23} />
    : iconKind === 'sheet'
    ? <FileSpreadsheet size={22} />
    : iconKind === 'slides'
      ? <Presentation size={22} />
      : iconKind === 'archive'
        ? <FileArchive size={22} />
        : iconKind === 'code'
          ? <FileCode2 size={22} />
          : iconKind === 'document'
            ? <FileText size={22} />
            : <FileIcon size={22} />;
  return (
    <span className={`message-file-icon ${iconKind}`} aria-hidden="true">
      {icon}
      <em>{kind === 'folder' ? 'FOLDER' : extension ? extension.toUpperCase() : 'FILE'}</em>
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

export function MessageFileAttachmentStrip({
  attachments,
  language,
}: {
  attachments: ChatAttachment[];
  language: AppLanguage;
}) {
  const host = useContext(ConversationHostContext);
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const resolvedAttachments = attachments.map((attachment) => ({
    ...attachment,
    path: attachment.path
      ? remapProjectPath(attachment.path, pathAliases)
      : attachment.path,
  }));
  const [metadata, setMetadata] = useState<Record<string, {
    name: string;
    kind: 'file' | 'folder';
    size?: number;
  }>>({});
  const attachmentKey = resolvedAttachments
    .map((attachment) => `${attachment.path ?? ''}:${attachment.size ?? ''}`)
    .join('|');

  useEffect(() => {
    const missingPaths = resolvedAttachments
      .filter((attachment) => attachment.path && !Number.isFinite(attachment.size))
      .map((attachment) => attachment.path as string)
      .filter((pathValue) => metadata[pathValue] == null);
    if (host || missingPaths.length === 0 || !window.cardbushDesktop?.inspectAttachments) {
      return;
    }
    let cancelled = false;
    void window.cardbushDesktop.inspectAttachments(missingPaths).then((items) => {
      if (cancelled) return;
      setMetadata((current) => {
        const next = { ...current };
        for (const item of items) {
          next[item.path] = { name: item.name, kind: item.kind, size: item.size };
        }
        return next;
      });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attachmentKey, host]);

  if (resolvedAttachments.length === 0) return null;
  return (
    <div className="message-file-strip">
      {resolvedAttachments.map((attachment) => {
        const pathValue = attachment.path?.trim() ?? '';
        const inspected = metadata[pathValue];
        const name = inspected?.name || attachment.name || basename(pathValue);
        const size = inspected?.size ?? attachment.size;
        const kind = inspected?.kind ?? (attachment.type === 'folder' ? 'folder' : 'file');
        return (
          <button
            className="message-file-attachment"
            type="button"
            key={attachment.id || pathValue}
            title={pathValue}
            disabled={!pathValue}
            onContextMenu={host ? undefined : event => openFileContextMenu(event, pathValue, { language })}
            onClick={() => host ? host.openFile(pathValue) : kind === 'folder'
              ? void window.cardbushDesktop?.openPath?.(pathValue)
              : openInspector(pathValue, name)}
          >
            <MessageFileIcon name={name} kind={kind} />
            <span className="message-file-meta">
              <strong>{name}</strong>
              <small>
                {kind === 'folder'
                  ? language === 'zh' ? '文件夹 · 点击打开' : 'Folder · Open'
                  : `${formatMessageFileSize(size)} · ${language === 'zh' ? '只读' : 'Read only'}`}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MessageImageStrip({
  paths,
  language,
}: {
  paths: string[];
  language: AppLanguage;
}) {
  const pathAliases = useContext(FileReferencePathAliasesContext);
  const presentedMedia = useContext(PresentedMediaContext);
  const resolvedPaths = paths.map((pathValue) => remapProjectPath(pathValue, pathAliases));
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  if (resolvedPaths.length === 0) {
    return null;
  }
  return (
    <>
      <div className="message-image-strip">
        {resolvedPaths.map((pathValue, index) => {
          const presented = presentedMedia.get(mediaPresentationKey(pathValue));
          if (presented) return <PresentedMediaReference key={`${pathValue}-${index}`} artifact={presented} />;
          return (
            <figure className="message-image-item" key={`${pathValue}-${index}`}>
              <MessageImagePreviewButton
                pathValue={pathValue}
                language={language}
                onPreview={setPreview}
              />
            </figure>
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

const MessageInlineMediaContent = memo(function MessageInlineMediaContent({
  content,
  language,
}: {
  content: string;
  language: AppLanguage;
}) {
  const blocks = splitMessageMediaBlocks(content);
  return (
    <div className="message-inline-media-content">
      {blocks.map((block, index) => {
        if (block.kind === 'text') {
          return (
            <MarkdownContent
              // The source range, rather than its words, establishes block identity.
              // eslint-disable-next-line react/no-array-index-key
              key={`text-${index}`}
              content={block.content}
              language={language}
            />
          );
        }
        return <div className="message-inline-media-block" key={`media-${index}`}>
          {block.items.map((item, itemIndex) => item.type === 'image'
            ? <MessageImageStrip key={itemIndex} paths={[item.path]} language={language} />
            : <MessageMediaStrip key={itemIndex} videoPaths={item.type === 'video' ? [item.path] : []}
              audioPaths={item.type === 'audio' ? [item.path] : []} language={language} />)}
        </div>;
      })}
    </div>
  );
});

function MessageImagePreviewButton({
  pathValue,
  language,
  onPreview,
}: {
  pathValue: string;
  language: AppLanguage;
  onPreview: (image: ImagePreview) => void;
}) {
  const host = useContext(ConversationHostContext);
  const source = useConversationFileSource(pathValue);
  const name = basename(pathValue);
  const [src, setSrc] = useState(source.source);
  const [failed, setFailed] = useState(false);
  const fallbackAttemptedRef = useRef(false);

  useEffect(() => {
    fallbackAttemptedRef.current = false;
    setSrc(source.source);
    setFailed(Boolean(source.error));
  }, [pathValue, source.source, source.error]);

  const recoverLocalImage = useCallback(async () => {
    if (
      host || fallbackAttemptedRef.current ||
      !isLocalFileResource(pathValue) ||
      !window.cardbushDesktop?.readImageDataUrl
    ) {
      setFailed(true);
      return;
    }
    fallbackAttemptedRef.current = true;
    try {
      const dataUrl = await window.cardbushDesktop.readImageDataUrl(pathValue);
      if (!dataUrl.startsWith('data:image/')) {
        setFailed(true);
        return;
      }
      setSrc(dataUrl);
    } catch (error) {
      console.warn('Unable to load local image preview', pathValue, error);
      setFailed(true);
    }
  }, [pathValue]);

  return (
    <button
      className={`message-image-preview${failed ? ' is-failed' : ''}`}
      type="button"
      aria-label={name}
      onContextMenu={host ? undefined : event => openFileContextMenu(event, pathValue, { image: true, language })}
      onClick={event => {
        const thumbnail = event.currentTarget.querySelector('img');
        if (!failed) onPreview({ src, name, path: pathValue,
          naturalWidth: thumbnail?.naturalWidth, naturalHeight: thumbnail?.naturalHeight });
      }}
    >
      {failed ? (
        <span className="message-image-preview-fallback">
          <FileIcon size={20} />
          <span>{language === 'zh' ? '图片无法预览' : 'Preview unavailable'}</span>
        </span>
      ) : !src ? <span role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</span> : (
        <img
          src={src}
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => void recoverLocalImage()}
        />
      )}
    </button>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  language,
  referenceMode,
}: {
  content: string;
  language: AppLanguage;
  referenceMode?: 'local' | 'remote';
}) {
  const host = useContext(ConversationHostContext);
  const workspaceRoot = useContext(FileReferenceWorkspaceContext);
  const pathAliases = useContext(FileReferencePathAliasesContext);
  return (
    <div className="markdown-content">
      <Suspense fallback={<p className="markdown-fallback"><PromptReferenceFallback content={content} /></p>}>
        <LazyMarkdownContent
          content={content}
          workspaceRoot={workspaceRoot}
          pathAliases={pathAliases}
          language={language}
          referenceMode={referenceMode ?? (host ? 'remote' : 'local')}
        />
      </Suspense>
    </div>
  );
});

type MessageBubbleViewProps = Parameters<typeof MessageBubbleView>[0];

function sameMessageBubbleProps(
  previous: MessageBubbleViewProps,
  next: MessageBubbleViewProps,
) {
  if (
    previous.message !== next.message ||
    previous.language !== next.language ||
    previous.sending !== next.sending ||
    previous.activeConversationId !== next.activeConversationId ||
    previous.thinkingVisible !== next.thinkingVisible ||
    previous.keepActionsVisible !== next.keepActionsVisible ||
    previous.selectedModel !== next.selectedModel ||
    previous.readOnlyActions !== next.readOnlyActions ||
    previous.guidanceAvailable !== next.guidanceAvailable ||
    previous.canRevertWorkspace !== next.canRevertWorkspace ||
    previous.goalObjective !== next.goalObjective ||
    previous.onRegenerate !== next.onRegenerate ||
    previous.onEditUserMessage !== next.onEditUserMessage ||
    previous.onRetryMessage !== next.onRetryMessage ||
    previous.onRetryGuidance !== next.onRetryGuidance ||
    previous.onRevertChangeReport !== next.onRevertChangeReport ||
    previous.onOpenChangeReview !== next.onOpenChangeReview ||
    previous.onOpenScene !== next.onOpenScene
  ) {
    return false;
  }
  if (
    previous.activeTurnId === next.activeTurnId &&
    previous.activeAssistantMessageId === next.activeAssistantMessageId
  ) {
    return true;
  }
  return !isActiveMessageBubble(previous) && !isActiveMessageBubble(next);
}

function isActiveMessageBubble(props: MessageBubbleViewProps) {
  if (props.message.role !== 'assistant' || !props.sending) return false;
  const assistantId = props.activeAssistantMessageId.trim();
  if (!assistantId || assistantId !== props.message.id) return false;
  const activeTurnId = props.activeTurnId.trim();
  const messageTurnId = props.message.turnId?.trim() ?? '';
  return !activeTurnId || !messageTurnId || activeTurnId === messageTurnId;
}

export const MessageBubble = memo(function MessageBubble(props: MessageBubbleViewProps) {
  const activeConversationId = props.activeConversationId ?? props.message.conversationId ?? '';
  const activeTurnId = props.activeTurnId || props.message.turnId || '';
  const enabled = props.thinkingVisible === true;
  const running = isActiveMessageBubble(props);
  const thinkingScope = useMemo(() => ({ activeConversationId, activeTurnId, enabled, running }),
    [activeConversationId, activeTurnId, enabled, running]);
  return <FileMemoScope sessionId={props.message.conversationId} turnId={props.message.turnId} sourceReferences={props.message.role === 'assistant'}>
    <WorkspaceRevertAvailability.Provider value={props.canRevertWorkspace !== false}>
      <AssistantThinkingScope.Provider value={thinkingScope}>
        <MessageBubbleView {...props} />
      </AssistantThinkingScope.Provider>
    </WorkspaceRevertAvailability.Provider>
  </FileMemoScope>;
}, sameMessageBubbleProps);
import { ConversationHostContext } from '../conversationHost';
