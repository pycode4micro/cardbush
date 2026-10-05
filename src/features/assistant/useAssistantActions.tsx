import { useEffect, useRef, useState } from 'react';
import { Edit3, Mic, MicOff, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { confirmAction } from '../../components/confirmAction';
import { showUiError } from '../../shared/showUiError';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { assistantBackend } from './assistantBackend';
import { readAssistantProfile, saveAssistantProfile, useAssistantProfile } from './assistantProfile';
import './assistant.css';

export function useAssistantActions(language: 'zh' | 'en') {
  const zh = language === 'zh', profile = useAssistantProfile();
  const [renaming, setRenaming] = useState(false), [resetting, setResetting] = useState(false);
  const reset = async () => {
    if (resetting || !await confirmAction({
      title: zh ? '重置 assistant 上下文？' : 'Reset assistant context?',
      message: zh ? '将清空当前对话、通话记忆和摘要，并结束当前通话。名称、角色、执行主机和静音设置保留。已派发的任务继续在各自子会话中运行。此操作无法撤销。'
        : 'Clear this conversation, call memory and summaries, and end the current call. Keep the name, persona, execution host and mute settings. Dispatched tasks continue in their child chats. This cannot be undone.',
      confirmLabel: zh ? '重置上下文' : 'Reset context', cancelLabel: zh ? '取消' : 'Cancel',
    })) return;
    setResetting(true);
    try {
      const voice = applicationVoiceSession();
      if (voice.snapshot().assistant) voice.end();
      await assistantBackend.reset();
    } catch (error) { await showUiError(zh ? '重置失败' : 'Reset failed', error instanceof Error ? error.message : String(error)); }
    finally { setResetting(false); }
  };
  const toggleMute = (kind: 'microphoneMuted' | 'outputMuted') => {
    try {
      const current = readAssistantProfile(), value = !current[kind];
      saveAssistantProfile({ ...current, [kind]: value });
      const voice = applicationVoiceSession();
      if (voice.snapshot().assistant && voice.snapshot().mode !== 'idle') {
        if (kind === 'microphoneMuted') voice.setMuted(value, false);
        else voice.setOutputMuted(value);
      }
    } catch (error) { void showUiError(zh ? '静音设置未保存' : 'Mute setting not saved', String(error)); }
  };
  return { profile, resetting, items: [
    { key: 'assistant-reset', icon: <RotateCcw size={15}/>, label: zh ? '重置上下文' : 'Reset context', danger: true, disabled: resetting, onClick: () => void reset() },
    { key: 'assistant-rename', icon: <Edit3 size={15}/>, label: zh ? '重命名' : 'Rename', onClick: () => setRenaming(true) },
    { key: 'assistant-microphone', icon: profile.microphoneMuted ? <MicOff size={15}/> : <Mic size={15}/>, separatorBefore: true,
      label: profile.microphoneMuted ? zh ? '取消麦克风静音' : 'Unmute microphone' : zh ? '麦克风静音' : 'Mute microphone', onClick: () => toggleMute('microphoneMuted') },
    { key: 'assistant-output', icon: profile.outputMuted ? <VolumeX size={15}/> : <Volume2 size={15}/>,
      label: profile.outputMuted ? zh ? '恢复播报' : 'Unmute speech' : zh ? '播报静音' : 'Mute speech', onClick: () => toggleMute('outputMuted') },
  ], dialog: renaming ? <AssistantRenameDialog language={language} onClose={() => setRenaming(false)}/> : null };
}

function AssistantRenameDialog({ language, onClose }: { language: 'zh' | 'en'; onClose(): void }) {
  const zh = language === 'zh', dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => readAssistantProfile().name), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); input.current?.focus(); input.current?.select();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="assistant-rename-dialog" aria-labelledby="assistant-rename-title" onCancel={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) { setError(zh ? '请输入名称。' : 'Enter a name.'); input.current?.focus(); return; }
      try { saveAssistantProfile({ ...readAssistantProfile(), name: name.trim() }); onClose(); }
      catch (error) { setError(String(error)); }
    }}>
      <h3 id="assistant-rename-title">{zh ? '重命名 assistant' : 'Rename assistant'}</h3>
      <label>{zh ? '名称' : 'Name'}<input ref={input} value={name} maxLength={60} aria-invalid={Boolean(error)} onChange={event => { setName(event.target.value); setError(''); }}/></label>
      {error && <p role="alert">{error}</p>}
      <div><button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="submit">{zh ? '保存' : 'Save'}</button></div>
    </form>
  </dialog>;
}
