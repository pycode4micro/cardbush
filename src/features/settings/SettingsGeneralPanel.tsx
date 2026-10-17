import type { AppLanguage, AppLanguageMode, AppSettingsState } from '../../types';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';

export function SettingsGeneralPanel({ language, languageMode, systemLanguage, settings, reasoningStreamAvailable, onLanguageModeChange, onSettingsChange }: {
  language: AppLanguage; languageMode: AppLanguageMode; systemLanguage: AppLanguage;
  settings: AppSettingsState; reasoningStreamAvailable: boolean;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  const zh = language === 'zh';
  return <div className="settings-stack">
    <SettingsCard title={zh ? '语言' : 'Language'}>
      <SettingsSelect name="language-mode" title={zh ? '界面语言' : 'Interface language'} value={languageMode} onChange={value => onLanguageModeChange(value as AppLanguageMode)}>
        <option value="system">{zh ? '跟随系统' : 'System'} · {systemLanguage === 'zh' ? '中文' : 'English'}</option><option value="zh">中文</option><option value="en">English</option>
      </SettingsSelect>
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
  </div>;
}
