import type { RefObject } from 'react';
import type { AssistantEventPreferences } from '@cardbush/bush-protocol';
import { X } from 'lucide-react';
import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { AssistantPortrait } from './AssistantCharacter';
import { EventPreferenceFields } from './events/EventPreferenceFields';

export function AssistantSettingsDialogView({ language, dialogRef, nameInputRef, name, persona, proactive, error, onName, onPersona, onProactive, onClose, onSave }: {
  language: string; dialogRef: RefObject<HTMLDialogElement | null>; nameInputRef: RefObject<HTMLInputElement | null>;
  name: string; persona: string; proactive: AssistantEventPreferences; error: string;
  onName(value: string): void; onPersona(value: string): void; onProactive(value: AssistantEventPreferences): void;
  onClose(): void; onSave(): void;
}) {
  const t = uiText(language);
  return <dialog ref={dialogRef} className="assistant-settings-dialog" aria-labelledby="assistant-settings-title" onCancel={dialogEventHandler(event => {
    event.preventDefault();
    onClose();
  })} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <form onSubmit={event => { event.preventDefault(); onSave(); }}>
      <header><div className="assistant-settings-heading"><AssistantPortrait state="idle"/>
        <div><h2 id="assistant-settings-title">{t('assistantSettingsDialog.assistantSettings')}</h2><p>{t('assistantSettingsDialog.makeItFeelLikeYourCompanion')}</p></div></div>
        <button type="button" className="assistant-settings-close" aria-label={t('assistantSettingsDialog.closeSettings')} onClick={onClose}><X/></button></header>
      <label>{t('agentConnectionForm.name')}<input ref={nameInputRef} name="assistant-name" value={name} maxLength={60} onChange={event => onName(event.target.value)}/></label>
      <label>{t('assistantSettingsDialog.personaAndConversationStyle')}<textarea name="assistant-persona" value={persona} placeholder={t('assistantSettingsDialog.defaultPersona')} maxLength={2000} rows={5} onChange={event => onPersona(event.target.value)}/></label>
      <p className="assistant-settings-note">{t('assistantSettingsDialog.personaChangesApplyToTheNextCall')}</p>
      <EventPreferenceFields language={language} value={proactive} change={onProactive}/>
      {error && <p className="assistant-settings-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{t('agentConnectionForm.cancel')}</button><button type="submit">{t('appCenter.save')}</button></footer>
    </form>
  </dialog>;
}
