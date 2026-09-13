import type { AppLanguage, AppSettingsState } from '../../types';
import { ConversationStyleSettings } from './ConversationStyleSettings';
import { GlobalInstructionsPanel } from './GlobalInstructionsPanel';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';

export function SettingsPersonalizationPanel({ language, settings, reasoningStreamAvailable, onSettingsChange }: {
  language: AppLanguage; settings: AppSettingsState; reasoningStreamAvailable: boolean;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  const zh = language === 'zh';
  return <div className="settings-stack personalization-settings-stack">
    <SettingsCard title={zh ? '回复偏好' : 'Response preferences'}>
      <ConversationStyleSettings language={language} value={settings.conversationStyle}
        onChange={conversationStyle => onSettingsChange(current => ({ ...current, conversationStyle }))} />
    </SettingsCard>
    <SettingsCard title={zh ? '对话交互' : 'Conversation interaction'}>
      <SettingsSelect name="guidance-delivery-mode" title={zh ? '任务运行时的新消息' : 'Messages sent during a task'}
        subtitle={settings.guidance.deliveryMode === 'immediate'
          ? zh ? '尽快交给当前任务，在下一次可接收输入时生效。' : 'Apply to the current task as soon as it can receive input.'
          : zh ? '等待当前回复完成，再自动发送下一条消息。' : 'Wait for the current response, then send the next message automatically.'}
        value={settings.guidance.deliveryMode ?? 'queue'} onChange={value => onSettingsChange(current => ({
          ...current, guidance: { deliveryMode: value as AppSettingsState['guidance']['deliveryMode'] },
        }))}>
        <option value="queue">{zh ? '加入队列' : 'Add to queue'}</option>
        <option value="immediate">{zh ? '马上发送' : 'Send immediately'}</option>
      </SettingsSelect>
      {reasoningStreamAvailable && <SettingsSwitch title={zh ? '显示思考过程' : 'Show thinking'}
        subtitle={zh ? '任务运行时，在输入框上方显示。' : 'Show above the composer while a task is running.'}
        checked={settings.thinking.visible} onChange={visible => onSettingsChange(current => ({
          ...current, thinking: { ...current.thinking, visible },
        }))} />}
    </SettingsCard>
    <GlobalInstructionsPanel language={language} />
  </div>;
}
