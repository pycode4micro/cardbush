import { uiText, uiLanguages } from '../../i18n';
import { useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { SettingsDropdown } from './SettingsDropdown';
import { conversationStyleName, conversationStylePresets, normalizeConversationStylePreferences,
  type ConversationStylePreferences, type NamedConversationStyle } from './conversationStyle';
import './conversationStyle.css';

export function ConversationStyleSettings({ language, value, onChange }: {
  language: AppLanguage;
  value: ConversationStylePreferences;
  onChange: (value: ConversationStylePreferences) => void;
}) {
  const preferences = normalizeConversationStylePreferences(value);
  const [editing, setEditing] = useState<NamedConversationStyle | null>(null);

  const name = editing?.name.trim() ?? '';
  const duplicate = preferences.styles.some(style => style.id !== editing?.id && conversationStyleName(style.id, preferences, language).toLocaleLowerCase() === name.toLocaleLowerCase())
    || conversationStylePresets.some(style => uiLanguages.map(locale => uiText(locale.locale)(style.labelKey)).some(label => label.toLocaleLowerCase() === name.toLocaleLowerCase()));
  const update = (next: ConversationStylePreferences) => onChange(normalizeConversationStylePreferences(next));
  const options = [...conversationStylePresets, ...preferences.styles].map(style => ({ value: style.id, label: conversationStyleName(style.id, preferences, language) }));
  const save = () => {
    if (!editing || !name || !editing.instructions.trim() || duplicate) return;
    const style = { ...editing, name };
    update({ ...preferences, styles: preferences.styles.some(item => item.id === style.id)
      ? preferences.styles.map(item => item.id === style.id ? style : item) : [...preferences.styles, style] });
    setEditing(null);
  };
  const copy = (style: NamedConversationStyle) => {
    const base = conversationStyleName(style.id, preferences, language) + (uiText(language)('conversationStyleSettings.copy'));
    let nextName = base;
    let index = 2;
    while (preferences.styles.some(item => item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) nextName = base + ' ' + index++;
    update({ ...preferences, styles: [...preferences.styles, { ...style, id: 'custom-' + crypto.randomUUID(), name: nextName }] });
  };
  return <div className="conversation-style-settings">
    <div className="settings-select-row">
      <span><strong>{uiText(language)('conversationStyleSettings.defaultConversationStyle')}</strong>
        <small id="conversation-style-description">{uiText(language)('conversationStyleSettings.useStyleInTheComposerToChoose')}</small></span>
      <SettingsDropdown id="conversation-style-mode" value={preferences.defaultId} describedBy="conversation-style-description"
        label={uiText(language)('conversationStyleSettings.defaultConversationStyle')} options={options}
        onChange={defaultId => update({ ...preferences, defaultId })} />
    </div>
    <div className="conversation-style-library">
      <div className="conversation-style-library-heading"><strong>{uiText(language)('conversationStyleSettings.myStyles')}</strong>
        <button type="button" className="secondary-button" onClick={() => setEditing({ id: 'custom-' + crypto.randomUUID(), name: '', instructions: '' })}>
          <Plus size={14}/>{uiText(language)('conversationStyleSettings.addStyle')}</button></div>
      {preferences.styles.map(style => <div className="conversation-style-library-row" key={style.id} data-style-id={style.id}>
        <span><strong>{conversationStyleName(style.id, preferences, language)}</strong><small>{style.instructions}</small></span>
        <div className="conversation-style-library-actions">
          <button type="button" title={uiText(language)('common.edit')} aria-label={(uiText(language)('conversationStyleSettings.edit')) + conversationStyleName(style.id, preferences, language)} onClick={() => setEditing({ ...style, name: conversationStyleName(style.id, preferences, language) })}><Pencil size={15}/></button>
          <button type="button" title={uiText(language)('conversationStyleSettings.duplicate')} aria-label={(uiText(language)('conversationStyleSettings.duplicate_b749a17')) + conversationStyleName(style.id, preferences, language)} onClick={() => copy(style)}><Copy size={15}/></button>
          <button type="button" title={uiText(language)('appCenter.delete')} aria-label={(uiText(language)('conversationStyleSettings.delete')) + conversationStyleName(style.id, preferences, language)} onClick={() => {
            update({ ...preferences, styles: preferences.styles.filter(item => item.id !== style.id) });
            if (editing?.id === style.id) setEditing(null);
          }}><Trash2 size={15}/></button>
        </div>
      </div>)}
      {!preferences.styles.length && !editing && <p className="conversation-style-hint">{uiText(language)('conversationStyleSettings.saveNamesAndInstructionsForYourPreferred')}</p>}
    </div>
    {editing && <div className="conversation-style-editor">
      <label className="settings-field" htmlFor="conversation-style-name">{uiText(language)('conversationStyleSettings.styleName')}
        <input id="conversation-style-name" autoFocus maxLength={80} value={editing.name} placeholder={uiText(language)('conversationStyleSettings.forExamplePatientColleague')} onChange={event => setEditing({ ...editing, name: event.target.value })}/>
      </label>
      <label className="settings-field" htmlFor="conversation-style-custom">{uiText(language)('conversationStyleSettings.styleInstructions')}
        <textarea id="conversation-style-custom" rows={4} value={editing.instructions}
          placeholder={uiText(language)('conversationStyleSettings.forExampleUseAWarmPatientVoice')}
          onChange={event => setEditing({ ...editing, instructions: event.target.value })}/>
      </label>
      <small className="conversation-style-hint">{uiText(language)('conversationStyleSettings.changesPersonaAndToneAllStylesKeep')}</small>
      {duplicate && <small role="alert">{uiText(language)('conversationStyleSettings.thisNameIsAlreadyInUseChoose')}</small>}
      <div className="conversation-style-editor-actions">
        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{uiText(language)('agentConnectionForm.cancel')}</button>
        <button type="button" className="secondary-button" disabled={!name || !editing.instructions.trim() || duplicate} onClick={save}>{uiText(language)('conversationStyleSettings.saveStyle')}</button>
      </div>
    </div>}
  </div>;
}
