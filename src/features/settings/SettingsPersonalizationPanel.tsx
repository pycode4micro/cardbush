import { uiText } from '../../i18n';
import type { AppLanguage, AppSettingsState } from '../../types';
import { ConversationStyleSettings } from './ConversationStyleSettings';
import { GlobalInstructionsPanel, type InstructionsSource } from './GlobalInstructionsPanel';
import { SettingsCard } from './SettingsControls';

export function SettingsPersonalizationPanel({ language, settings, onSettingsChange, instructionsSource, responseStyleAvailable = true }: {
  instructionsSource?: InstructionsSource; responseStyleAvailable?: boolean;
  language: AppLanguage; settings: AppSettingsState;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {

  return <div className="settings-stack personalization-settings-stack">
    {responseStyleAvailable && <SettingsCard title={uiText(language)('settingsPersonalizationPanel.responsePreferences')}
      subtitle={uiText(language)('settingsPersonalizationPanel.adjustsToneAndPersonaNotTheAmount')}>
      <ConversationStyleSettings language={language} value={settings.conversationStyle}
        onChange={conversationStyle => onSettingsChange(current => ({ ...current, conversationStyle }))} />
    </SettingsCard>}
    <GlobalInstructionsPanel language={language} source={instructionsSource} />
  </div>;
}
