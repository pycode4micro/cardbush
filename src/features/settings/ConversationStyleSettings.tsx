import {
  normalizeConversationStyle,
  type ConversationStyleMode,
  type ConversationStyleSettings as StyleSettings,
} from '@cardbush/bush-product-agent';
import type { AppLanguage } from '../../types';
import { SettingsDropdown } from './SettingsDropdown';

const choices: Array<{
  mode: ConversationStyleMode;
  label: Record<AppLanguage, string>;
  description: Record<AppLanguage, string>;
}> = [
  { mode: 'natural', label: { zh: '自然', en: 'Natural' }, description: {
    zh: '像日常聊天一样自然，表达简单易懂。',
    en: 'An everyday conversational tone with clear, familiar language.',
  } },
  { mode: 'professional', label: { zh: '专业', en: 'Professional' }, description: {
    zh: '专业分析，系统、全面地说明关键方面。',
    en: 'A professional, analytical tone with thorough coverage of the relevant points.',
  } },
  { mode: 'concise', label: { zh: '简短', en: 'Concise' }, description: {
    zh: '尽可能简短，只说必要的重点。',
    en: 'As brief as possible, covering only the essential points.',
  } },
  { mode: 'custom', label: { zh: '自定义', en: 'Custom' }, description: {
    zh: '按照你填写的偏好调整对话语气。',
    en: 'Describe the tone you would like CardBush to use.',
  } },
];

export function ConversationStyleSettings({ language, value, onChange }: {
  language: AppLanguage;
  value: StyleSettings;
  onChange: (value: StyleSettings) => void;
}) {
  const style = normalizeConversationStyle(value);
  return <div className="conversation-style-settings">
    <div className="settings-select-row">
      <span><strong>{language === 'zh' ? '对话风格' : 'Conversation style'}</strong>
        <small id="conversation-style-description">{choices.find(choice => choice.mode === style.mode)?.description[language]}</small>
      </span>
      <SettingsDropdown id="conversation-style-mode" value={style.mode} describedBy="conversation-style-description"
        label={language === 'zh' ? '对话风格' : 'Conversation style'}
        options={choices.map(choice => ({ value: choice.mode, label: choice.label[language] }))}
        onChange={mode => onChange(normalizeConversationStyle({ ...style, mode }))} />
    </div>
    {style.mode === 'custom' && <label className="settings-field" htmlFor="conversation-style-custom">
      {language === 'zh' ? '对话语气' : 'Conversation tone'}
      <textarea id="conversation-style-custom" rows={4} value={style.customTone}
        placeholder={language === 'zh'
          ? '例如：像朋友一样交流，直接说重点，少用术语；需要解释时举一个简单的例子。'
          : 'For example: speak like a friend, get to the point, avoid jargon, and use a simple example when explaining.'}
        onChange={event => onChange({ ...style, customTone: event.target.value })} />
    </label>}
  </div>;
}
