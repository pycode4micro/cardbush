import { uiLanguages, uiText } from '../../i18n';
import type { AppLanguage, AppLanguageMode, AppSettingsState } from '../../types';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';

export function SettingsGeneralPanel({ language, languageMode, systemLanguage, settings, reasoningStreamAvailable, onLanguageModeChange, onSettingsChange }: {
  language: AppLanguage; languageMode: AppLanguageMode; systemLanguage: AppLanguage;
  settings: AppSettingsState; reasoningStreamAvailable: boolean;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  return <div className="settings-stack">
    <SettingsCard title={uiText(language)('settingsGeneralPanel.language')}>
      <SettingsSelect name="language-mode" title={uiText(language)('settingsGeneralPanel.interfaceLanguage')} value={languageMode} onChange={value => onLanguageModeChange(value as AppLanguageMode)}>
        <option value="system">{uiText(language)('settingsAppearancePanel.system_9916b02')} · {uiLanguages.find(pack => pack.locale === systemLanguage)?.name}</option>
        {uiLanguages.map(pack => <option key={pack.locale} value={pack.locale}>{pack.name}</option>)}
      </SettingsSelect>
    </SettingsCard>
    <SettingsCard title={uiText(language)('settingsGeneralPanel.conversationInteraction')}>
      <SettingsSelect name="guidance-delivery-mode" title={uiText(language)('settingsGeneralPanel.messagesSentDuringATask')}
        subtitle={settings.guidance.deliveryMode === 'immediate'
          ? uiText(language)('settingsGeneralPanel.applyToTheCurrentTaskAsSoon')
          : uiText(language)('settingsGeneralPanel.waitForTheCurrentResponseThenSend')}
        value={settings.guidance.deliveryMode ?? 'queue'} onChange={value => onSettingsChange(current => ({
          ...current, guidance: { deliveryMode: value as AppSettingsState['guidance']['deliveryMode'] },
        }))}>
        <option value="queue">{uiText(language)('settingsGeneralPanel.addToQueue')}</option>
        <option value="immediate">{uiText(language)('settingsGeneralPanel.sendImmediately')}</option>
      </SettingsSelect>
      {reasoningStreamAvailable && <SettingsSwitch title={uiText(language)('settingsGeneralPanel.showThinking')}
        subtitle={uiText(language)('settingsGeneralPanel.showAboveTheComposerWhileATask')}
        checked={settings.thinking.visible} onChange={visible => onSettingsChange(current => ({
          ...current, thinking: { ...current.thinking, visible },
        }))} />}
    </SettingsCard>
  </div>;
}
