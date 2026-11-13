import { useCapsuleControls, type CapsuleInput } from './useCapsuleControls';
import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, AudioLines, Bell, Circle, File, Film, Plus, SquarePen, X } from 'lucide-react';
import { uiText } from '../../i18n';
import { basename, fileUrl, isAudioPath, isImagePath, isVideoPath } from '../../shared/localPaths';
import type { ConversationEntry } from '@cardbush/bush-protocol';
import { assistantTimeLabel } from './assistantTimeline';
import { MarkdownContent } from '../chatMessages/MessageBubble';
import { useVoiceComposer, VoiceComposerPanel } from '../voice/VoiceComposer';
import './floatingAssistantCapsule.css';

type Props = CapsuleInput & {
  language: string; unread: number; calling: boolean; voiceBlocked: boolean;
  replies: ConversationEntry[]; replyWidth?: number; targetId?: string; error: string;
  compose(): void; open(): void; openVoice(): void;
};
export function FloatingAssistantCapsule(p: Props) {
  const t = uiText(p.language);
  const voice = useVoiceComposer();
  const {input, toolbar, sheet, renderReplies, revealReplies, limit, setLimit, failed, setFailed, attachmentError, suppressClick, beginDrag, moveDrag, endDrag, submit, attach, importing} = useCapsuleControls(p);
  const bell = t('capsule.replies', { count: p.unread });
  const replyScroll = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const latestId = p.replies.at(-1)?.id;
  const located = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!p.repliesOpen) followingLatest.current = true;
    else if (followingLatest.current && replyScroll.current) replyScroll.current.scrollTop = 0;
  }, [p.repliesOpen, latestId]);
  useLayoutEffect(() => {
    if (!p.repliesOpen || !p.targetId) { located.current = undefined; return; }
    if (located.current === p.targetId) return;
    const index = p.replies.findIndex(reply => reply.id === p.targetId);
    if (index < 0) return;
    const count = p.replies.length - index;
    if (count > limit) { setLimit(count); return; }
    const row = replyScroll.current?.querySelector<HTMLElement>(`[data-reply-id="${CSS.escape(p.targetId)}"]`);
    if (row) {
      row.scrollIntoView({block:'nearest'});
      followingLatest.current = count === 1;
      located.current = p.targetId;
    }
  }, [p.targetId, p.repliesOpen, p.replies, limit, setLimit]);
  return <div className="floating-assistant-surface" data-replies={p.repliesOpen || undefined}
    onKeyDown={event => { if ((p.repliesOpen || p.voiceOpen) && event.key === 'Escape') { event.preventDefault(); p.collapse(); } }}>
    <div ref={toolbar} className="floating-capsule" role={p.composing || p.voiceOpen ? 'group' : 'toolbar'} onPointerDown={beginDrag} onPointerMove={moveDrag}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onClickCapture={event => { if (suppressClick.current && event.detail) { event.preventDefault(); event.stopPropagation(); suppressClick.current=false; } }} data-surface={p.composing ? 'compose' : p.voiceOpen ? 'voice' : 'capsule'} aria-label={t('capsule.label')}>
    {p.voiceOpen && voice.session ? <VoiceComposerPanel session={voice.session} language={p.language} showVoicePicker={false}/> : p.composing ? <div className="capsule-form" aria-busy={importing}
      onPaste={event => {
        const files = [...event.clipboardData.files];
        if (files.length) { event.preventDefault(); void attach(files); }
      }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => {
        const files = [...event.dataTransfer.files];
        if (files.length) { event.preventDefault(); void attach(files); }
      }}>
      <button className="capsule-attach" type="button" title={t('capsule.attach')} aria-label={t('capsule.attach')} disabled={p.sending} onClick={() => void attach()}><Plus/></button>
      {p.files.length > 0 && <div className="capsule-files">{p.files.map(path => {
        const name = basename(path);
        const Icon = isAudioPath(path) ? AudioLines : isVideoPath(path) ? Film : File;
        const label = t('capsule.removeAttachment', { name });
        return <button key={path} type="button" className="capsule-file" disabled={p.sending} title={label} aria-label={label}
          onClick={() => p.changeFiles(current => current.filter(item => item !== path))}>
          {isImagePath(path) ? <img src={fileUrl(path)} alt=""/> : <Icon/>}<span>{name}</span><X/>
        </button>;
      })}</div>}
      <input ref={input} aria-label={t('capsule.write')} placeholder={t('capsule.placeholder')} value={p.draft} readOnly={p.sending}
        onChange={e => { setFailed(false); p.changeDraft(e.target.value); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); p.collapse(); }
        }}/>
      {failed && <button type="button" className="capsule-error" title={t('capsule.inspectError')} aria-label={t('capsule.inspectError')} onClick={p.open}>!</button>}
      {attachmentError && <span className="capsule-error" role="alert" tabIndex={0} title={attachmentError} aria-label={t('composer.unableToAddAttachments')}>!</span>}
      <button className="capsule-send" type="button" onClick={() => void submit()} disabled={!p.ready || p.sending || importing || (!p.draft.trim() && !p.files.length)} title={t('common.send')} aria-label={t('common.send')}><ArrowUp/></button>
    </div> : <>
      <button type="button" data-action="compose" onClick={p.compose} title={t('capsule.write')} aria-label={t('capsule.write')}><SquarePen/></button>
      <span className="capsule-divider" aria-hidden="true"/>
      <button type="button" data-action="voice" disabled={p.voiceBlocked || (!p.ready && !p.calling)} aria-pressed={p.calling} onClick={p.openVoice}
        title={t(p.calling ? 'capsule.callControls' : 'capsule.call')} aria-label={t(p.calling ? 'capsule.callControls' : 'capsule.call')}>
        {p.calling ? <Circle className="capsule-live"/> : <AudioLines/>}</button>
      <span className="capsule-divider" aria-hidden="true"/>
      <button type="button" data-action="replies" aria-expanded={p.repliesOpen} onClick={p.repliesOpen ? p.collapse : p.open} aria-label={bell} title={bell}><Bell/>{p.unread > 0 && <span className="capsule-badge" aria-hidden="true">{p.unread > 99 ? '99+' : p.unread}</span>}</button>
    </>}
    </div>
    {renderReplies && <section ref={sheet} className="capsule-replies" data-visible={revealReplies}
      inert={!p.repliesOpen} aria-hidden={!p.repliesOpen} style={{width:p.replyWidth}} aria-label={t('capsule.replyList')}>
      <header><strong>{t('capsule.replyList')}</strong><button type="button" aria-label={t('capsule.collapseReplies')}
        title={t('capsule.collapseReplies')} onClick={p.collapse}><X/></button></header>
      <div ref={replyScroll} className="capsule-reply-scroll" tabIndex={0}
        onScroll={event => { followingLatest.current = event.currentTarget.scrollTop <= 1; }}>
        {(p.error || failed) && <p role="alert">{p.error || t('capsule.inspectError')}</p>}
        {!p.replies.length && !p.error && !failed && <p>{t('capsule.empty')}</p>}
        {p.replies.slice(-limit).reverse().map(reply => <article key={reply.id} data-reply-id={reply.id} className="assistant-bubble">
          <time dateTime={reply.createdAt}>{assistantTimeLabel(reply.createdAt,p.language)}</time>
          <MarkdownContent content={reply.content} language={p.language}/>
        </article>)}
        {p.replies.length > limit && <button type="button" onClick={() => setLimit(value => value + 30)}>{t('capsule.earlier')}</button>}
      </div>
    </section>}
  </div>;
}
