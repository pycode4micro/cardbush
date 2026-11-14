import { emptyEventPreferences } from './events/eventPreferences';
import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { readAssistantProfile, saveAssistantProfile } from './assistantProfile';
import { AssistantSettingsDialogView } from './AssistantSettingsDialogView';

export function AssistantSettingsDialog({ language, onClose }: { language: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => readAssistantProfile().name), [persona, setPersona] = useState(() => readAssistantProfile().persona);
  const [error, setError] = useState('');
  const [proactive, setProactive] = useState(() => readAssistantProfile().proactive ?? emptyEventPreferences());
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current; node?.showModal(); nameInput.current?.focus({ preventScroll: true });
    return () => { node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const save = () => {
    if (!name.trim()) { setError(uiText(language)('assistantSettingsDialog.enterAName')); nameInput.current?.focus(); return; }
    try {
      saveAssistantProfile({ ...readAssistantProfile(), name: name.trim(), persona, proactive });
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <AssistantSettingsDialogView language={language} dialogRef={dialog} nameInputRef={nameInput}
    name={name} persona={persona} proactive={proactive} error={error}
    onName={value => { setName(value); setError(''); }} onPersona={setPersona} onProactive={setProactive}
    onClose={onClose} onSave={save}/>;
}
