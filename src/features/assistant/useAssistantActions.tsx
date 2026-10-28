import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import { Edit3, Mic, MicOff, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { confirmAction } from '../../components/confirmAction';
import { showUiError } from '../../shared/showUiError';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { assistantBackend } from './assistantBackend';
import { readAssistantProfile, saveAssistantProfile, useAssistantProfile } from './assistantProfile';
import './assistant.css';

export function useAssistantActions(language: string) {
  const profile = useAssistantProfile();
  const [renaming, setRenaming] = useState(false), [resetting, setResetting] = useState(false);
  const reset = async () => {
    if (resetting || !await confirmAction({
      title: uiText(language)('useAssistantActions.resetAssistantContext'),
      message: uiText(language)('useAssistantActions.clearThisConversationCallMemoryAndSummaries'),
      confirmLabel: uiText(language)('useAssistantActions.resetContext'), cancelLabel: uiText(language)('agentConnectionForm.cancel'),
    })) return;
    setResetting(true);
    try {
      const voice = applicationVoiceSession();
      if (voice.snapshot().assistant) voice.end();
      await assistantBackend.reset();
    } catch (error) { await showUiError(uiText(language)('useAssistantActions.resetFailed'), error instanceof Error ? error.message : String(error)); }
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
    } catch (error) { void showUiError(uiText(language)('useAssistantActions.muteSettingNotSaved'), String(error)); }
  };
  return { profile, resetting, items: [
    { key: 'assistant-reset', icon: <RotateCcw size={15}/>, label: uiText(language)('useAssistantActions.resetContext'), danger: true, disabled: resetting, onClick: () => void reset() },
    { key: 'assistant-rename', icon: <Edit3 size={15}/>, label: uiText(language)('useAssistantActions.rename'), onClick: () => setRenaming(true) },
    { key: 'assistant-microphone', icon: profile.microphoneMuted ? <MicOff size={15}/> : <Mic size={15}/>, separatorBefore: true,
      label: profile.microphoneMuted ? uiText(language)('useAssistantActions.unmuteMicrophone') : uiText(language)('useAssistantActions.muteMicrophone'), onClick: () => toggleMute('microphoneMuted') },
    { key: 'assistant-output', icon: profile.outputMuted ? <VolumeX size={15}/> : <Volume2 size={15}/>,
      label: profile.outputMuted ? uiText(language)('useAssistantActions.unmuteSpeech') : uiText(language)('useAssistantActions.muteSpeech'), onClick: () => toggleMute('outputMuted') },
  ], dialog: renaming ? <AssistantRenameDialog language={language} onClose={() => setRenaming(false)}/> : null };
}

function AssistantRenameDialog({ language, onClose }: { language: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => readAssistantProfile().name), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); input.current?.focus(); input.current?.select();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="assistant-rename-dialog" aria-labelledby="assistant-rename-title" onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) { setError(uiText(language)('assistantSettingsDialog.enterAName')); input.current?.focus(); return; }
      try { saveAssistantProfile({ ...readAssistantProfile(), name: name.trim() }); onClose(); }
      catch (error) { setError(String(error)); }
    }}>
      <h3 id="assistant-rename-title">{uiText(language)('useAssistantActions.renameAssistant')}</h3>
      <label>{uiText(language)('agentConnectionForm.name')}<input ref={input} value={name} maxLength={60} aria-invalid={Boolean(error)} onChange={event => { setName(event.target.value); setError(''); }}/></label>
      {error && <p role="alert">{error}</p>}
      <div><button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit">{uiText(language)('appCenter.save')}</button></div>
    </form>
  </dialog>;
}
