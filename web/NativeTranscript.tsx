import { useMemo, type ReactNode } from 'react';
import { ConversationHostContext, type ConversationHost } from '../src/features/conversationHost';
import { MessageBubble, MessageFileReferenceScope } from '../src/features/chatMessages/MessageBubble';
import type { ChatMessage } from '../src/types';
import { acquireCachedImage, peekCachedImage, useAccountCache } from './BrowserCacheProvider';
import { personalFilePath } from './personalFiles';
import { pendingTranscript, persistedTranscript, webAttachments, webToolExecution, type LiveTranscript } from './transcript';
import { api, type Job, type State } from './api';
import type { ToolExecutionRecord } from '@cardbush/bush-protocol';

const noAction = async () => {};
const noScene = () => {};

export function NativeTranscript({ state, live, selected, modelName, children, submitting, onError, onRetry }: {
  state: State | null; live: LiveTranscript; selected: string | null; modelName: string; children?: ReactNode;
  onError: (message: string) => void; onRetry: (text: string) => void;
  submitting?: { sessionId: string; id: string; text: string; attachments: unknown[] } | null;
}) {
  const cache = useAccountCache();
  const history = useMemo(() => persistedTranscript(state), [state]);
  const pending = useMemo(() => {
    const committed = new Set(state?.snapshot?.turns.map(turn => turn.turnId));
    return (state?.jobs ?? []).filter(job => !committed.has(job.turnId));
  }, [state]);
  const host = useMemo<ConversationHost>(() => {
    const readFile = async (source: string) => {
      const path = personalFilePath(source);
      if (!path || !cache.valid()) throw new Error('只能读取当前账号的个人文件。');
      const controller = new AbortController();
      const off = cache.onClose(() => controller.abort());
      try {
        const response = await fetch(`/api/web/v1/files/view?path=${encodeURIComponent(path)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'X-CardBush-User': cache.owner },
        });
        if (!response.ok) throw new Error('文件暂时无法读取。');
        if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error('文件过大。');
        const blob = await response.blob();
        if (!cache.valid() || blob.size > 16 * 1024 * 1024) throw new Error('文件暂时无法读取。');
        return { name: path.split('/').at(-1) || '附件', blob };
      } finally { off?.(); }
    };
    return {
      id: `web:${cache.owner}:${selected ?? ''}`, sessionId: selected ?? undefined, plugins: [], pluginCommands: [], messageFeedbackAvailable: false,
      uploadFiles: async () => { throw new Error('请使用消息输入框上传附件。'); },
      readFile,
      fileReferencePath: source => personalFilePath(source) ?? undefined,
      openExternal: url => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
      resolveFileSource: path => acquireCachedImage(cache, path),
      peekFileSource: path => peekCachedImage(cache, path),
      previewFile: path => acquireCachedImage(cache, path),
      openFile: path => { void readFile(path).then(({ name, blob }) => {
        if (!cache.valid()) return;
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }).catch(error => onError(error instanceof Error ? error.message : '文件暂时无法读取。')); },
      toolDetails: async (sessionId, turnId) => {
        if (sessionId !== selected || !cache.valid()) throw new Error('会话已切换。');
        const records = await api<ToolExecutionRecord[]>(`/sessions/${sessionId}/tools?turnId=${encodeURIComponent(turnId)}`);
        if (!cache.valid()) throw new Error('账号已切换。');
        return records.map(webToolExecution);
      },
    };
  }, [cache, selected, onError]);
  const latestAssistant = [...history].reverse().find(message => message.role === 'assistant')?.id;
  const renderMessage = (message: ChatMessage, activeId = '', job?: Job) => <div key={message.renderKey ?? message.id}
    className={`message-list-item${activeId ? ' live-turn' : ''}`} data-message-id={message.id} data-message-role={message.role}>
    <MessageBubble message={message} language="zh" sending={Boolean(activeId)} activeTurnId={activeId ? job?.turnId ?? '' : ''}
      activeAssistantMessageId={activeId} activeConversationId={selected ?? ''} selectedModel={modelName}
      keepActionsVisible={message.id === latestAssistant || Boolean(job && !activeId)} readOnlyActions canRevertWorkspace={false}
      onRegenerate={noAction} onEditUserMessage={noAction} onRetryGuidance={noAction} onRevertChangeReport={noAction} onOpenScene={noScene}/>
  </div>;
  return <ConversationHostContext.Provider value={host}><MessageFileReferenceScope workspaceRoot="/data/workspaces">
    <div className="native-transcript">
      {history.map(message => renderMessage(message))}
      {pending.map(job => {
        const messages = pendingTranscript(selected ?? '', job, live[job.turnId]);
        const activeId = job.status === 'running' ? [...messages].reverse().find(message => message.role === 'assistant')?.id ?? '' : '';
        return <div key={job.id} className="native-turn" data-turn-id={job.turnId}>
          {messages.map(message => renderMessage(message, activeId, job))}
          {job.status === 'queued' && <div className="thinking"><span className="loading-dot"/>等待回复…</div>}
          {['failed','interrupted'].includes(job.status) && <div className="job-error">{job.status === 'interrupted' ? '这次回复因服务重启而中断。' : '这次回复未能完成。'}<button onClick={() => onRetry(job.text)}>重新编辑</button></div>}
          {job.status === 'stopped' && <div className="status-line">已停止回复</div>}
        </div>;
      })}
      {submitting?.sessionId === selected && !state?.jobs.some(job => job.id === submitting.id) && <>
        {renderMessage({ id: submitting.id, role: 'user', content: submitting.text, createdAt: new Date().toISOString(), attachments: webAttachments(submitting.attachments) } as ChatMessage)}
        <div className="thinking"><span className="loading-dot"/>正在发送…</div>
      </>}
      {children}
    </div>
  </MessageFileReferenceScope></ConversationHostContext.Provider>;
}
