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
  const zh = language === 'zh';
  const name = editing?.name.trim() ?? '';
  const duplicate = preferences.styles.some(style => style.id !== editing?.id && conversationStyleName(style.id, preferences, language).toLocaleLowerCase() === name.toLocaleLowerCase())
    || conversationStylePresets.some(style => [style.zh, style.en].some(label => label.toLocaleLowerCase() === name.toLocaleLowerCase()));
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
    const base = conversationStyleName(style.id, preferences, language) + (zh ? ' 副本' : ' copy');
    let nextName = base;
    let index = 2;
    while (preferences.styles.some(item => item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) nextName = base + ' ' + index++;
    update({ ...preferences, styles: [...preferences.styles, { ...style, id: 'custom-' + crypto.randomUUID(), name: nextName }] });
  };
  return <div className="conversation-style-settings">
    <div className="settings-select-row">
      <span><strong>{zh ? '默认对话风格' : 'Default conversation style'}</strong>
        <small id="conversation-style-description">{zh ? '在输入框使用 /style 可为当前会话单独选择。' : 'Use /style in the composer to choose a style for this chat.'}</small></span>
      <SettingsDropdown id="conversation-style-mode" value={preferences.defaultId} describedBy="conversation-style-description"
        label={zh ? '默认对话风格' : 'Default conversation style'} options={options}
        onChange={defaultId => update({ ...preferences, defaultId })} />
    </div>
    <div className="conversation-style-library">
      <div className="conversation-style-library-heading"><strong>{zh ? '我的风格' : 'My styles'}</strong>
        <button type="button" className="secondary-button" onClick={() => setEditing({ id: 'custom-' + crypto.randomUUID(), name: '', instructions: '' })}>
          <Plus size={14}/>{zh ? '添加风格' : 'Add style'}</button></div>
      {preferences.styles.map(style => <div className="conversation-style-library-row" key={style.id} data-style-id={style.id}>
        <span><strong>{conversationStyleName(style.id, preferences, language)}</strong><small>{style.instructions}</small></span>
        <div className="conversation-style-library-actions">
          <button type="button" title={zh ? '编辑' : 'Edit'} aria-label={(zh ? '编辑 ' : 'Edit ') + conversationStyleName(style.id, preferences, language)} onClick={() => setEditing({ ...style, name: conversationStyleName(style.id, preferences, language) })}><Pencil size={15}/></button>
          <button type="button" title={zh ? '复制' : 'Duplicate'} aria-label={(zh ? '复制 ' : 'Duplicate ') + conversationStyleName(style.id, preferences, language)} onClick={() => copy(style)}><Copy size={15}/></button>
          <button type="button" title={zh ? '删除' : 'Delete'} aria-label={(zh ? '删除 ' : 'Delete ') + conversationStyleName(style.id, preferences, language)} onClick={() => {
            update({ ...preferences, styles: preferences.styles.filter(item => item.id !== style.id) });
            if (editing?.id === style.id) setEditing(null);
          }}><Trash2 size={15}/></button>
        </div>
      </div>)}
      {!preferences.styles.length && !editing && <p className="conversation-style-hint">{zh ? '为常用的角色和语气保存名称与要求。' : 'Save names and instructions for your preferred personas and tones.'}</p>}
    </div>
    {editing && <div className="conversation-style-editor">
      <label className="settings-field" htmlFor="conversation-style-name">{zh ? '风格名称' : 'Style name'}
        <input id="conversation-style-name" autoFocus maxLength={80} value={editing.name} placeholder={zh ? '例如：耐心的同事' : 'For example: Patient colleague'} onChange={event => setEditing({ ...editing, name: event.target.value })}/>
      </label>
      <label className="settings-field" htmlFor="conversation-style-custom">{zh ? '风格要求' : 'Style instructions'}
        <textarea id="conversation-style-custom" rows={4} value={editing.instructions}
          placeholder={zh ? '例如：语气温和、有耐心，坦诚表达判断。' : 'For example: Use a warm, patient voice and express judgments candidly.'}
          onChange={event => setEditing({ ...editing, instructions: event.target.value })}/>
      </label>
      <small className="conversation-style-hint">{zh ? '仅调整角色与语气；各风格都保持简洁的最终回复，并遵循你的明确要求。' : 'Changes persona and tone. All styles keep final replies concise and follow your explicit requests.'}</small>
      {duplicate && <small role="alert">{zh ? '这个名称已存在，请换一个。' : 'This name is already in use. Choose another.'}</small>}
      <div className="conversation-style-editor-actions">
        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" className="secondary-button" disabled={!name || !editing.instructions.trim() || duplicate} onClick={save}>{zh ? '保存风格' : 'Save style'}</button>
      </div>
    </div>}
  </div>;
}
