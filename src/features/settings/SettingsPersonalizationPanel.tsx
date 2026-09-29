import type { AppLanguage, AppSettingsState } from '../../types';
import { ConversationStyleSettings } from './ConversationStyleSettings';
import { GlobalInstructionsPanel, type InstructionsSource } from './GlobalInstructionsPanel';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import { NotificationSoundSettings } from './NotificationSoundSettings';
import { normalizeIndividuation } from './individuation';

export function SettingsPersonalizationPanel({ language, settings, reasoningStreamAvailable, onSettingsChange, instructionsSource, responseStyleAvailable = true }: {
  instructionsSource?: InstructionsSource; responseStyleAvailable?: boolean;
  language: AppLanguage; settings: AppSettingsState; reasoningStreamAvailable: boolean;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  const zh = language === 'zh';
  const individuation = normalizeIndividuation(settings.individuation);
  return <div className="settings-stack personalization-settings-stack">
    {responseStyleAvailable && <SettingsCard title={zh ? '回复偏好' : 'Response preferences'}
      subtitle={zh ? '只调整角色语气，不影响内容详略。最终回复默认简洁，需要展开时可在对话中说明。'
        : 'Adjusts tone and persona, not the amount of detail. Final replies stay concise; ask in chat when you need more detail.'}>
      <ConversationStyleSettings language={language} value={settings.conversationStyle}
        onChange={conversationStyle => onSettingsChange(current => ({ ...current, conversationStyle }))} />
    </SettingsCard>}
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
    <SettingsCard title={zh ? '个性化记忆' : 'Personalization memory'}
      subtitle={zh ? '默认关闭。开启后由 Agent 按需检索，在同一运行环境的不同对话间使用。设置从下一轮对话生效。'
        : 'Off by default. When enabled, the agent can search across conversations on the same runtime host. Changes apply from the next turn.'}>
      <SettingsSwitch title={zh ? '记住并参考用户习惯' : 'Remember and use habits'}
        subtitle={zh ? '保存有依据的长期偏好，帮助后续对话。关闭后暂停读取和写入。' : 'Save supported long-term preferences for later conversations. Turning off pauses reads and writes.'}
        checked={individuation.habits} onChange={habits => onSettingsChange(current => ({ ...current,
          individuation: { ...normalizeIndividuation(current.individuation), habits } }))} />
      <SettingsSwitch title={zh ? '预测下一步行为' : 'Predict next actions'}
        subtitle={zh ? '保存可能的后续需求，在新的对话输入匹配时由 Agent 判断是否执行；继续遵守操作权限。'
          : 'Save possible follow-ups for the agent to evaluate against later input. Actions still follow existing permissions.'}
        checked={individuation.predictions} onChange={predictions => onSettingsChange(current => ({ ...current,
          individuation: { ...normalizeIndividuation(current.individuation), predictions } }))} />
    </SettingsCard>
    <NotificationSoundSettings language={language}/>
    <GlobalInstructionsPanel language={language} source={instructionsSource} />
  </div>;
}
