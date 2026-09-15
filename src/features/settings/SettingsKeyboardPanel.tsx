import { RotateCcw, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { AppLanguage } from '../../types';
import { bindingError, bindingFromEvent, shortcutBinding, shortcutDefinitions,
  type ShortcutBinding, type ShortcutId } from '../shortcuts/keyboardShortcuts';
import { saveKeyboardShortcuts, useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { SettingsCard } from './SettingsControls';
import './keyboardSettings.css';

export function SettingsKeyboardPanel({ language }: { language: AppLanguage }) {
  const zh = language === 'zh';
  const shortcuts = useKeyboardShortcuts();
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState('');
  const [errorId, setErrorId] = useState<ShortcutId | null>(null);
  const groups = [
    { id: 'conversation', title: zh ? '对话' : 'Conversation' },
    { id: 'inspector', title: zh ? '右侧栏' : 'Right sidebar' },
    { id: 'image', title: zh ? '图片预览' : 'Image preview' },
  ] as const;
  const filtered = shortcutDefinitions.filter(item => {
    const text = [item.title.zh, item.title.en, item.description.zh, item.description.en, shortcuts.label(item.id)].join(' ').toLowerCase();
    return query.trim().toLowerCase().split(/\s+/).every(term => text.includes(term));
  });

  function save(id: ShortcutId, binding: ShortcutBinding | null | undefined) {
    setErrorId(id);
    const candidate = binding === undefined ? shortcutDefinitions.find(item => item.id === id)!.defaultBinding : binding;
    const conflict = shortcuts.conflict(id, candidate);
    if (conflict) {
      setError(zh ? '与“' + conflict.title.zh + '”冲突，请换一个组合。' : 'Already used by “' + conflict.title.en + '”. Choose another combination.');
      return;
    }
    const next = { ...shortcuts.overrides };
    if (binding === undefined) delete next[id]; else next[id] = binding;
    try {
      saveKeyboardShortcuts(next);
      setRecording(null);
      setError('');
    } catch { setError(zh ? '快捷键未能保存，请重试。' : 'Could not save the shortcut. Try again.'); }
  }

  return <div className="settings-stack keyboard-settings" data-keyboard-settings>
    <div className="keyboard-settings-toolbar">
      <label className="keyboard-settings-search"><Search size={16} aria-hidden="true" />
        <input aria-label={zh ? '搜索快捷键' : 'Search shortcuts'} placeholder={zh ? '搜索操作或快捷键…' : 'Search actions or shortcuts…'} value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      <button className="keyboard-reset-all" type="button" disabled={!Object.keys(shortcuts.overrides).length}
        onClick={() => { setErrorId(null); try { saveKeyboardShortcuts({}); setRecording(null); setError(''); } catch { setError(zh ? '恢复失败，请重试。' : 'Could not reset shortcuts. Try again.'); } }}>
        <RotateCcw size={14} aria-hidden="true" />{zh ? '恢复默认' : 'Reset all'}
      </button>
    </div>
    <p className="keyboard-settings-help">{zh ? '点击按键后输入新组合，自动保存。按 Esc 取消修改。' : 'Click a shortcut and press a new combination. Changes save automatically. Esc cancels.'}</p>
    {error && !errorId && <p className="keyboard-settings-error" role="alert">{error}</p>}
    {groups.map(group => {
      const items = filtered.filter(item => item.group === group.id);
      if (!items.length) return null;
      return <SettingsCard key={group.id} title={group.title}>
        {items.map(item => <div className="keyboard-settings-row" key={item.id} data-shortcut-row={item.id}>
          <span className="keyboard-settings-description"><strong>{item.title[language]}</strong><small>{item.description[language]}</small>
            {error && errorId === item.id && <small className="keyboard-binding-error" role="alert">{error}</small>}
          </span>
          <div className="keyboard-settings-actions">
            <button className={'keyboard-binding' + (recording === item.id ? ' recording' : '')} type="button"
              data-shortcut-recorder={item.id} aria-pressed={recording === item.id}
              aria-label={(zh ? '修改快捷键：' : 'Change shortcut: ') + item.title[language]}
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
              {recording === item.id ? (zh ? '请按下快捷键…' : 'Press shortcut…') : <kbd>{shortcuts.label(item.id) || (zh ? '未设置' : 'Not set')}</kbd>}
            </button>
            <button className="keyboard-binding-action" type="button" disabled={!shortcutBinding(item.id, shortcuts.overrides)}
              aria-label={(zh ? '停用快捷键：' : 'Disable shortcut: ') + item.title[language]}
              title={zh ? '停用' : 'Disable'} onClick={() => save(item.id, null)}><X size={14} /></button>
            <button className="keyboard-binding-action" type="button" disabled={!Object.hasOwn(shortcuts.overrides, item.id)}
              aria-label={(zh ? '恢复默认：' : 'Reset shortcut: ') + item.title[language]}
              title={zh ? '恢复默认' : 'Reset'} onClick={() => save(item.id, undefined)}><RotateCcw size={14} /></button>
          </div>
        </div>)}
      </SettingsCard>;
    })}
    {!filtered.length && <p className="keyboard-settings-help">{zh ? '没有匹配的快捷键。' : 'No matching shortcuts.'}</p>}
    {!query.trim() && <SettingsCard title={zh ? '常用键盘操作' : 'Standard keyboard controls'} subtitle={zh ? '以下操作跟随当前焦点，保持系统默认。' : 'These controls follow keyboard focus and keep their standard behavior.'}>
      {[
        [zh ? '输入框换行' : 'New line in composer', 'Shift + Enter'],
        [zh ? '会话区滚动 / 翻页' : 'Scroll / page through conversation', '↑ ↓ / PageUp PageDown'],
        [zh ? '会话区顶部 / 底部' : 'Conversation top / bottom', 'Home / End'],
        [zh ? '会话区上翻 / 下翻一页' : 'Page up / down in conversation', 'Shift + Space / Space'],
        [zh ? '候选菜单切换 / 确认' : 'Navigate / confirm suggestions', '↑ ↓ / Enter Tab'],
        [zh ? '队列手柄调整顺序' : 'Reorder using queue handle', '↑ ↓'],
        [zh ? '关闭弹层或取消编辑' : 'Dismiss popup or cancel edit', 'Esc'],
      ].map(([label, keys]) => <div className="keyboard-reference-row" key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}
    </SettingsCard>}
  </div>;
}
