import { useCapsuleControls, type CapsuleInput } from './useCapsuleControls';
import { ArrowUp, AudioLines, Bell, Circle, House, Plus, SquarePen, X } from 'lucide-react';
import { uiText } from '../../i18n';
import { basename } from '../../shared/localPaths';
import type { ConversationEntry } from '@cardbush/bush-protocol';
import { assistantTimeLabel } from './assistantTimeline';
import { useVoiceComposer, VoiceComposerPanel } from '../voice/VoiceComposer';
import './floatingAssistantCapsule.css';

type Props = CapsuleInput & {
  language: string; unread: number; calling: boolean; voiceBlocked: boolean;
  replies: ConversationEntry[]; error: string;
  compose(): void; open(): void; openVoice(): void; returnToWorkspace(): void;
};
export function FloatingAssistantCapsule(p: Props) {
  const t = uiText(p.language);
  const voice = useVoiceComposer(true);
  const {input, toolbar, sheet, limit, setLimit, failed, setFailed, suppressClick, beginDrag, moveDrag, endDrag, submit, attach} = useCapsuleControls(p);
  const bell = t('capsule.replies', { count: p.unread });
  return <div className="floating-assistant-surface" data-replies={p.repliesOpen || undefined}
    onKeyDown={event => { if ((p.repliesOpen || p.voiceOpen) && event.key === 'Escape') { event.preventDefault(); p.collapse(); } }}>
    <div ref={toolbar} className="floating-capsule" role={p.composing || p.voiceOpen ? 'group' : 'toolbar'} onPointerDown={beginDrag} onPointerMove={moveDrag}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onClickCapture={event => { if (suppressClick.current && event.detail) { event.preventDefault(); event.stopPropagation(); suppressClick.current=false; } }} data-surface={p.composing ? 'compose' : p.voiceOpen ? 'voice' : 'capsule'} aria-label={t('capsule.label')}>
    {p.voiceOpen && voice.session ? <VoiceComposerPanel session={voice.session} language={p.language} showVoicePicker={false}/> : p.composing ? <div className="capsule-form">
      <button className="capsule-attach" type="button" title={t('capsule.attach')} aria-label={t('capsule.attach')} disabled={p.sending} onClick={() => void attach()}><Plus/></button>
      {p.files.length > 0 && <button type="button" className="capsule-files" disabled={p.sending} title={p.files.map(basename).join(' · ')}
        aria-label={t('capsule.removeFiles',{count:p.files.length})} onClick={() => p.changeFiles([])}>{p.files.length}<X/></button>}
      <input ref={input} aria-label={t('capsule.write')} placeholder={t('capsule.placeholder')} value={p.draft} readOnly={p.sending}
        onChange={e => { setFailed(false); p.changeDraft(e.target.value); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); p.collapse(); }
        }}/>
      {failed && <button type="button" className="capsule-error" title={t('capsule.inspectError')} aria-label={t('capsule.inspectError')} onClick={p.open}>!</button>}
      <button className="capsule-send" type="button" onClick={() => void submit()} disabled={!p.ready || p.sending || (!p.draft.trim() && !p.files.length)} title={t('common.send')} aria-label={t('common.send')}><ArrowUp/></button>
    </div> : <>
      <button type="button" data-action="compose" onClick={p.compose} title={t('capsule.write')} aria-label={t('capsule.write')}><SquarePen/></button>
      <span className="capsule-divider" aria-hidden="true"/>
      <button type="button" data-action="voice" disabled={p.voiceBlocked || (!p.ready && !p.calling)} aria-pressed={p.calling} onClick={p.openVoice}
        title={t(p.calling ? 'capsule.callControls' : 'capsule.call')} aria-label={t(p.calling ? 'capsule.callControls' : 'capsule.call')}>
        {p.calling ? <Circle className="capsule-live"/> : <AudioLines/>}</button>
      <span className="capsule-divider" aria-hidden="true"/>
      <button type="button" data-action="replies" aria-expanded={p.repliesOpen} onClick={p.repliesOpen ? p.collapse : p.open} aria-label={bell} title={bell}><Bell/>{p.unread > 0 && <span className="capsule-badge" aria-hidden="true">{p.unread > 99 ? '99+' : p.unread}</span>}</button>
      {!p.repliesOpen && <>
        <span className="capsule-divider" aria-hidden="true"/>
        <button type="button" data-action="workspace" aria-label={t('resident.openHome')} title={t('resident.openHome')}
          onClick={p.returnToWorkspace}><House/></button>
      </>}
    </>}
    </div>
    {p.repliesOpen && <section ref={sheet} className="capsule-replies" aria-label={t('capsule.replyList')}>
      <header><strong>{t('capsule.replyList')}</strong><button type="button" aria-label={t('resident.closeAssistant')}
        title={t('resident.closeAssistant')} onClick={() => void window.cardbushDesktop?.closeToTray()}><X/></button></header>
      <div className="capsule-reply-scroll" tabIndex={0}>
        {(p.error || failed) && <p role="alert">{p.error || t('capsule.inspectError')}</p>}
        {!p.replies.length && !p.error && !failed && <p>{t('capsule.empty')}</p>}
        {p.replies.slice(-limit).reverse().map(reply => <article key={reply.id}><time dateTime={reply.createdAt}>{assistantTimeLabel(reply.createdAt,p.language)}</time>
          <p>{reply.content}</p></article>)}
        {p.replies.length > limit && <button type="button" onClick={() => setLimit(value => value + 30)}>{t('capsule.earlier')}</button>}
      </div>
    </section>}
  </div>;
}
