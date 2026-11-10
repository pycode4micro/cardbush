import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConversationHostContext, type ConversationHost } from '../src/features/conversationHost';
import { MessageBubble, MessageFileReferenceScope } from '../src/features/chatMessages/MessageBubble';
import type { ChatMessage, ChatToolArtifact } from '../src/types';
import { acquireCachedImage, peekCachedImage, useAccountCache } from './BrowserCacheProvider';
import { personalFilePath } from './personalFiles';
import { pendingTranscript, persistedTranscript, webAttachments, webToolExecution, type LiveTranscript } from './transcript';
import { api, type Job, type State } from './api';
import type { ToolExecutionRecord } from '@cardbush/bush-protocol';
import { generatedImagePath, hasDeferredImageArtifacts, webTurnArtifacts } from './artifacts';
import { downloadArtifactArchive } from './artifactDownload';

const noAction = async () => {};

function HistoryMessage({ eager, role, children }: { eager: boolean; role: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(eager);
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: element.current.closest('.transcript'), rootMargin: '600px 0px' });
    observer.observe(element.current); return () => observer.disconnect();
  }, [visible]);
  return <div ref={element} className="history-message" data-visible={visible} data-role={role}>{visible ? children : null}</div>;
}

export function NativeTranscript({ state, live, selected, modelName, children, submitting, connectionUnavailable, onError, onRetry }: {
  state: State | null; live: LiveTranscript; selected: string | null; modelName: string; children?: ReactNode;
  onError: (message: string) => void; onRetry: (text: string) => void;
  submitting?: { sessionId: string; id: string; text: string; attachments: unknown[] } | null;
  connectionUnavailable?: boolean;
}) {
  const language = useUiLanguage();

  const cache = useAccountCache();
  const history = useMemo(() => persistedTranscript(state), [state, language]);
  const pending = useMemo(() => {
    const committed = new Set(state?.snapshot?.turns.map(turn => turn.turnId));
    return (state?.jobs ?? []).filter(job => !committed.has(job.turnId));
  }, [state]);
  const host = useMemo<ConversationHost>(() => {
    const detailRequests = new Map<string, Promise<ReturnType<typeof webToolExecution>[]>>();
    const toolDetails = async (sessionId: string, turnId: string) => {
      if (sessionId !== selected || !cache.valid()) throw new Error(uiText(language)("web.theConversationChanged"));
      let request = detailRequests.get(turnId);
      if (!request) {
        request = api<ToolExecutionRecord[]>(`/sessions/${sessionId}/tools?turnId=${encodeURIComponent(turnId)}`).then(records => records.map(webToolExecution));
        detailRequests.set(turnId, request);
      }
      try {
        const records = await request;
        if (!cache.valid()) throw new Error(uiText(language)("web.theAccountChanged"));
        return records;
      } finally { if (detailRequests.get(turnId) === request) detailRequests.delete(turnId); }
    };
    const readFile = async (source: string) => {
      const path = personalFilePath(source);
      if (!path || !cache.valid()) throw new Error(uiText(language)("web.onlyThisAccountSPersonalFilesCanBeRead"));
      const controller = new AbortController();
      const off = cache.onClose(() => controller.abort());
      try {
        const response = await fetch(`/api/web/v1/files/view?path=${encodeURIComponent(path)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'X-CardBush-User': cache.owner },
        });
        if (!response.ok) throw new Error(uiText(language)("web.theFileCannotBeReadRightNow"));
        if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error(uiText(language)("web.theFileIsTooLarge"));
        const blob = await response.blob();
        if (!cache.valid() || blob.size > 16 * 1024 * 1024) throw new Error(uiText(language)("web.theFileCannotBeReadRightNow"));
        return { name: path.split('/').at(-1) || uiText(language)("image.scope.attachments"), blob };
      } finally { off?.(); }
    };
    return {
      id: `web:${cache.owner}:${selected ?? ''}`, sessionId: selected ?? undefined, plugins: [], pluginCommands: [], messageFeedbackAvailable: false,
      uploadFiles: async () => { throw new Error(uiText(language)("web.uploadAttachmentsUsingTheMessageComposer")); },
      readFile,
      fileReferencePath: source => personalFilePath(source) ?? undefined,
      openExternal: url => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
      resolveFileSource: path => acquireCachedImage(cache, path),
      peekFileSource: path => peekCachedImage(cache, path),
      previewFile: path => acquireCachedImage(cache, path),
      downloadFile: async source => {
        const path = generatedImagePath(source);
        if (!path || !cache.valid()) throw new Error(uiText(language)("web.onlyImagesGeneratedByThisAccountCanBeDownloaded"));
        const image = await acquireCachedImage(cache, path);
        try {
          if (!cache.valid()) throw new Error(uiText(language)("web.theAccountChanged"));
          const anchor = document.createElement('a');
          anchor.href = image.source; anchor.download = path.split('/').at(-1)!;
          document.body.append(anchor);
          try { anchor.click(); } finally { anchor.remove(); }
        } finally { setTimeout(image.dispose, 30_000); }
      },
      downloadFiles: async (paths, progress) => {
        if (!selected) throw new Error(uiText(language)("web.openAConversationFirst"));
        const controller = new AbortController(), off = cache.onClose(() => controller.abort());
        try { await downloadArtifactArchive(paths, selected, () => cache.valid(), controller.signal, progress); }
        finally { off?.(); }
      },
      turnArtifacts: message => {
        const candidates = webTurnArtifacts(message);
        if (!message.turnId || !message.conversationId || (!candidates.length && !hasDeferredImageArtifacts(message))) return { items: [] };
        return { items: [], load: async () => {
          if (message.conversationId !== selected || !cache.valid()) throw new Error(uiText(language)("web.theConversationChanged"));
          const items = await api<ChatToolArtifact[]>(`/sessions/${message.conversationId}/artifacts?turnId=${encodeURIComponent(message.turnId!)}`);
          if (!cache.valid()) throw new Error(uiText(language)("web.theAccountChanged"));
          return items;
        } };
      },
      openFile: path => { void readFile(path).then(({ name, blob }) => {
        if (!cache.valid()) return;
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }).catch(error => onError(error instanceof Error ? error.message : uiText(language)("web.theFileCannotBeReadRightNow"))); },
      toolDetails,
    };
  }, [cache, selected, onError, language]);
  const latestAssistant = [...history].reverse().find(message => message.role === 'assistant')?.id;
  const renderMessage = (message: ChatMessage, activeId = '', job?: Job) => <div key={message.renderKey ?? message.id}
    className={`message-list-item${activeId ? ' live-turn' : ''}`} data-message-id={message.id} data-message-role={message.role}>
    <MessageBubble message={message} language={language} sending={Boolean(activeId)} activeTurnId={activeId ? job?.turnId ?? '' : ''}
      activeAssistantMessageId={activeId} activeConversationId={selected ?? ''} selectedModel={modelName}
      keepActionsVisible={message.id === latestAssistant || Boolean(job && !activeId)} readOnlyActions canRevertWorkspace={false}
      onRegenerate={noAction} onEditUserMessage={noAction} onRetryGuidance={noAction} onRevertChangeReport={noAction}/>
  </div>;
  return <ConversationHostContext.Provider value={host}><MessageFileReferenceScope workspaceRoot="/data/workspaces">
    <div className="native-transcript">
      {history.map((message, index) => <HistoryMessage key={`${selected}:${message.renderKey ?? message.id}`} eager={index >= history.length - 4} role={message.role}>{renderMessage(message)}</HistoryMessage>)}
      {pending.map(job => {
        const messages = pendingTranscript(selected ?? '', job, live[job.turnId]);
        const activeId = !connectionUnavailable && job.status === 'running' ? [...messages].reverse().find(message => message.role === 'assistant')?.id ?? '' : '';
        return <div key={job.id} className="native-turn" data-turn-id={job.turnId}>
          {messages.map(message => renderMessage(message, activeId, job))}
          {job.status === 'queued' && <div className="thinking"><span className="loading-dot"/>{uiText(language)("web.waitingForAReply")}</div>}
          {['failed','interrupted'].includes(job.status) && <div className="job-error">{job.status === 'interrupted' ? uiText(language)("web.thisReplyWasInterruptedByAServiceRestart") : uiText(language)("web.thisReplyCouldNotBeCompleted")}<button onClick={() => onRetry(job.text)}>{uiText(language)("web.editAgain")}</button></div>}
          {job.status === 'stopped' && <div className="status-line">{uiText(language)("web.replyStopped")}</div>}
        </div>;
      })}
      {submitting?.sessionId === selected && !state?.jobs.some(job => job.id === submitting.id) && <>
        {renderMessage({ id: submitting.id, role: 'user', content: submitting.text, createdAt: new Date().toISOString(), attachments: webAttachments(submitting.attachments) } as ChatMessage)}
        <div className="status-line" role="status">{uiText(language)("web.sessionPreparing")}</div>
      </>}
      {children}
    </div>
  </MessageFileReferenceScope></ConversationHostContext.Provider>;
}
