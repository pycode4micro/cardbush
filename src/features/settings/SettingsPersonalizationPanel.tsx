import type { AppLanguage, AppSettingsState } from '../../types';
import { ConversationStyleSettings } from './ConversationStyleSettings';
import { GlobalInstructionsPanel, type InstructionsSource } from './GlobalInstructionsPanel';
import { SettingsCard } from './SettingsControls';

export function SettingsPersonalizationPanel({ language, settings, onSettingsChange, instructionsSource, responseStyleAvailable = true }: {
  instructionsSource?: InstructionsSource; responseStyleAvailable?: boolean;
  language: AppLanguage; settings: AppSettingsState;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  const zh = language === 'zh';
  return <div className="settings-stack personalization-settings-stack">
    {responseStyleAvailable && <SettingsCard title={zh ? '回复偏好' : 'Response preferences'}
      subtitle={zh ? '只调整角色语气，不影响内容详略。最终回复默认简洁，需要展开时可在对话中说明。'
        : 'Adjusts tone and persona, not the amount of detail. Final replies stay concise; ask in chat when you need more detail.'}>
      <ConversationStyleSettings language={language} value={settings.conversationStyle}
        onChange={conversationStyle => onSettingsChange(current => ({ ...current, conversationStyle }))} />
    </SettingsCard>}
    <GlobalInstructionsPanel language={language} source={instructionsSource} />
  </div>;
}
