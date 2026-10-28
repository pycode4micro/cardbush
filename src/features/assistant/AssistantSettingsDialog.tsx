import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import { Camera, Lightbulb, RotateCcw, X } from 'lucide-react';
import { readAssistantProfile, saveAssistantProfile } from './assistantProfile';
import { prepareAssistantAvatar, readAssistantAvatar, saveAssistantAvatar } from './assistantAvatar';

export function AssistantSettingsDialog({ language, onClose }: { language: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => readAssistantProfile().name), [persona, setPersona] = useState(() => readAssistantProfile().persona);
  const [avatar, setAvatar] = useState(readAssistantAvatar), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current; node?.showModal(); nameInput.current?.focus({ preventScroll: true });
    return () => { request.current++; node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const id = ++request.current; setLoading(true); setError('');
    try { const next = await prepareAssistantAvatar(file, language); if (id === request.current) setAvatar(next); }
    catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === request.current) setLoading(false); }
  };
  const save = () => {
    if (loading) return;
    if (!name.trim()) { setError(uiText(language)('assistantSettingsDialog.enterAName')); nameInput.current?.focus(); return; }
    const previousAvatar = readAssistantAvatar();
    try {
      saveAssistantAvatar(avatar);
      try { saveAssistantProfile({ ...readAssistantProfile(), name: name.trim(), persona }); }
      catch (error) { saveAssistantAvatar(previousAvatar); throw error; }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <dialog ref={dialog} className="assistant-settings-dialog" aria-labelledby="assistant-settings-title" onCancel={dialogEventHandler(event => {
    event.preventDefault();
    onClose();
  })} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <header><div><h2 id="assistant-settings-title">{uiText(language)('assistantSettingsDialog.assistantSettings')}</h2><p>{uiText(language)('assistantSettingsDialog.makeItFeelLikeYourCompanion')}</p></div>
        <button type="button" className="assistant-settings-close" aria-label={uiText(language)('assistantSettingsDialog.closeSettings')} onClick={onClose}><X size={18}/></button></header>
      <div className="assistant-avatar-picker">
        <button type="button" className="assistant-avatar-preview" aria-label={uiText(language)('assistantSettingsDialog.changeAvatar')} disabled={loading} onClick={() => fileInput.current?.click()}>
          {avatar ? <img src={avatar} alt=""/> : <Lightbulb size={34} strokeWidth={1.5}/>}
          <span><Camera size={13}/></span>
        </button>
        <div><button type="button" disabled={loading} onClick={() => fileInput.current?.click()}>{loading ? uiText(language)('assistantSettingsDialog.preparing') : uiText(language)('assistantSettingsDialog.chooseImage')}</button>
          {avatar && <button type="button" className="assistant-avatar-reset" disabled={loading} onClick={() => { setAvatar(''); setError(''); }}><RotateCcw size={13}/>{uiText(language)('assistantSettingsDialog.restoreLightbulb')}</button>}
          <small>{uiText(language)('assistantSettingsDialog.pngJpgWebpUpTo8Mb')}</small></div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file); }}/>
      </div>
      <label>{uiText(language)('agentConnectionForm.name')}<input ref={nameInput} name="assistant-name" value={name} maxLength={60} onChange={event => { setName(event.target.value); setError(''); }}/></label>
      <label>{uiText(language)('assistantSettingsDialog.personaAndConversationStyle')}<textarea name="assistant-persona" value={persona} maxLength={2000} rows={5} onChange={event => setPersona(event.target.value)}/></label>
      <p className="assistant-settings-note">{uiText(language)('assistantSettingsDialog.personaChangesApplyToTheNextCall')}</p>
      {error && <p className="assistant-settings-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit" disabled={loading}>{uiText(language)('appCenter.save')}</button></footer>
    </form>
  </dialog>;
}
