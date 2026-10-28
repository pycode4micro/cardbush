import { uiText, uiLanguages } from '../../i18n';
import { RotateCcw, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { AppLanguage } from '../../types';
import { bindingError, bindingFromEvent, shortcutBinding, shortcutDefinitions,
  type ShortcutBinding, type ShortcutId } from '../shortcuts/keyboardShortcuts';
import { saveKeyboardShortcuts, useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { SettingsCard } from './SettingsControls';
import './keyboardSettings.css';

export function SettingsKeyboardPanel({ language }: { language: AppLanguage }) {

  const shortcuts = useKeyboardShortcuts();
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState('');
  const [errorId, setErrorId] = useState<ShortcutId | null>(null);
  const groups = [
    { id: 'application', title: uiText(language)('settingsKeyboardPanel.application') },
    { id: 'conversation', title: uiText(language)('settingsKeyboardPanel.conversation') },
    { id: 'inspector', title: uiText(language)('settingsKeyboardPanel.rightSidebar') },
    { id: 'image', title: uiText(language)('settingsKeyboardPanel.imagePreview') },
  ] as const;
  const filtered = shortcutDefinitions.filter(item => {
    const text = [...uiLanguages.flatMap(locale => [uiText(locale.locale)(item.title), uiText(locale.locale)(item.description)]), shortcuts.label(item.id)].join(' ').toLowerCase();
    return query.trim().toLowerCase().split(/\s+/).every(term => text.includes(term));
  });

  function save(id: ShortcutId, binding: ShortcutBinding | null | undefined) {
    setErrorId(id);
    const candidate = binding === undefined ? shortcutDefinitions.find(item => item.id === id)!.defaultBinding : binding;
    const conflict = shortcuts.conflict(id, candidate);
    if (conflict) {
      setError(uiText(language)('keyboard.conflict', { name: uiText(language)(conflict.title) }));
      return;
    }
    const next = { ...shortcuts.overrides };
    if (binding === undefined) delete next[id]; else next[id] = binding;
    try {
      saveKeyboardShortcuts(next);
      setRecording(null);
      setError('');
    } catch { setError(uiText(language)('settingsKeyboardPanel.couldNotSaveTheShortcutTryAgain')); }
  }

  return <div className="settings-stack keyboard-settings" data-keyboard-settings>
    <div className="keyboard-settings-toolbar">
      <label className="keyboard-settings-search"><Search size={16} aria-hidden="true" />
        <input aria-label={uiText(language)('settingsKeyboardPanel.searchShortcuts')} placeholder={uiText(language)('settingsKeyboardPanel.searchActionsOrShortcuts')} value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      <button className="keyboard-reset-all" type="button" disabled={!Object.keys(shortcuts.overrides).length}
        onClick={() => { setErrorId(null); try { saveKeyboardShortcuts({}); setRecording(null); setError(''); } catch { setError(uiText(language)('settingsKeyboardPanel.couldNotResetShortcutsTryAgain')); } }}>
        <RotateCcw size={14} aria-hidden="true" />{uiText(language)('settingsKeyboardPanel.resetAll')}
      </button>
    </div>
    <p className="keyboard-settings-help">{uiText(language)('settingsKeyboardPanel.clickAShortcutAndPressANew')}</p>
    {error && !errorId && <p className="keyboard-settings-error" role="alert">{error}</p>}
    {groups.map(group => {
      const items = filtered.filter(item => item.group === group.id);
      if (!items.length) return null;
      return <SettingsCard key={group.id} title={group.title}>
        {items.map(item => <div className="keyboard-settings-row" key={item.id} data-shortcut-row={item.id}>
          <span className="keyboard-settings-description"><strong>{uiText(language)(item.title)}</strong><small>{uiText(language)(item.description)}</small>
            {error && errorId === item.id && <small className="keyboard-binding-error" role="alert">{error}</small>}
          </span>
          <div className="keyboard-settings-actions">
            <button className={'keyboard-binding' + (recording === item.id ? ' recording' : '')} type="button"
              data-shortcut-recorder={item.id} aria-pressed={recording === item.id}
              aria-label={(uiText(language)('settingsKeyboardPanel.changeShortcut')) + uiText(language)(item.title)}
              onClick={() => { setRecording(item.id); setError(''); }} onBlur={() => setRecording(null)}
              onKeyDown={event => {
                if (recording !== item.id || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) { setRecording(null); return; }
                event.preventDefault(); event.stopPropagation();
                if (event.key === 'Escape') { setRecording(null); setError(''); return; }
                if (event.repeat) return;
                const binding = bindingFromEvent(event);
                if (!binding) return;
                const invalid = bindingError(item.id, binding, language);
                if (invalid) { setErrorId(item.id); setError(invalid); return; }
                save(item.id, binding);
              }}>
              {recording === item.id ? (uiText(language)('settingsKeyboardPanel.pressShortcut')) : <kbd>{shortcuts.label(item.id) || (uiText(language)('settingsKeyboardPanel.notSet'))}</kbd>}
            </button>
            <button className="keyboard-binding-action" type="button" disabled={!shortcutBinding(item.id, shortcuts.overrides)}
              aria-label={(uiText(language)('settingsKeyboardPanel.disableShortcut')) + uiText(language)(item.title)}
              title={uiText(language)('pluginMcpSettings.disable')} onClick={() => save(item.id, null)}><X size={14} /></button>
            <button className="keyboard-binding-action" type="button" disabled={!Object.hasOwn(shortcuts.overrides, item.id)}
              aria-label={(uiText(language)('settingsKeyboardPanel.resetShortcut')) + uiText(language)(item.title)}
              title={uiText(language)('settingsKeyboardPanel.reset')} onClick={() => save(item.id, undefined)}><RotateCcw size={14} /></button>
          </div>
        </div>)}
      </SettingsCard>;
    })}
    {!filtered.length && <p className="keyboard-settings-help">{uiText(language)('settingsKeyboardPanel.noMatchingShortcuts')}</p>}
    {!query.trim() && <SettingsCard title={uiText(language)('settingsKeyboardPanel.standardKeyboardControls')} subtitle={uiText(language)('settingsKeyboardPanel.theseControlsFollowKeyboardFocusAndKeep')}>
      {[
        [uiText(language)('settingsKeyboardPanel.newLineInComposer'), 'Shift + Enter'],
        [uiText(language)('settingsKeyboardPanel.scrollPageThroughConversation'), '↑ ↓ / PageUp PageDown'],
        [uiText(language)('settingsKeyboardPanel.conversationTopBottom'), 'Home / End'],
        [uiText(language)('settingsKeyboardPanel.pageUpDownInConversation'), 'Shift + Space / Space'],
        [uiText(language)('settingsKeyboardPanel.navigateConfirmSuggestions'), '↑ ↓ / Enter Tab'],
        [uiText(language)('settingsKeyboardPanel.reorderUsingQueueHandle'), '↑ ↓'],
        [uiText(language)('settingsKeyboardPanel.dismissPopupOrCancelEdit'), 'Esc'],
      ].map(([label, keys]) => <div className="keyboard-reference-row" key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}
    </SettingsCard>}
  </div>;
}
