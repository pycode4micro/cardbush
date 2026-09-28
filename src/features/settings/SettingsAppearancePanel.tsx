import { useEffect, useState } from 'react';
import { Monitor, Moon, RotateCcw, Sun, Upload } from 'lucide-react';
import type { AppLanguage, AppLanguageMode, AppSettingsState, ThemePreference, ThemeMode } from '../../types';
import type { WindowMaterialPreference } from '../appearance/windowAppearance';
import { appearanceProfileKey, appearanceVariables, normalizeAppearance, setSeparateAppearanceModes, updateAppearanceProfile,
  type AppearancePreferences, type AppearanceProfile } from '../appearance/appearancePreferences';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import './appearanceSettings.css';

export function SettingsAppearancePanel({ themePreference, windowMaterial, onWindowMaterialChange, language,
  languageMode, systemLanguage, settings, onThemePreferenceChange, onLanguageModeChange, onSettingsChange,
  onImportFont, onResetFont, onImportThemeStyle, onResetImportedThemeStyle,
}: {
  themePreference: ThemePreference; windowMaterial: WindowMaterialPreference;
  onWindowMaterialChange?: (value: WindowMaterialPreference) => void;
  language: AppLanguage; languageMode: AppLanguageMode; systemLanguage: AppLanguage; settings: AppSettingsState;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onImportFont: () => void; onResetFont: () => void; onImportThemeStyle: () => void; onResetImportedThemeStyle: () => void;
}) {
  const zh = language === 'zh';
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const theme: ThemeMode = themePreference === 'dark' || (themePreference === 'system' && systemDark) ? 'dark' : 'bright';
  const appearance = normalizeAppearance(settings.appearance);
  const profile = appearance[appearanceProfileKey(appearance, theme)];
  const imported = settings.importedThemeStyle;
  const importedCompatible = imported?.base === (theme === 'bright' ? 'light' : 'dark');
  const variables = appearanceVariables(appearance, theme, imported, settings.font.family);
  const update = (patch: Partial<AppearancePreferences>) => onSettingsChange(current => ({ ...current, appearance: { ...normalizeAppearance(current.appearance), ...patch } }));
  const updateProfile = (patch: Partial<AppearanceProfile>) => onSettingsChange(current => ({ ...current, appearance: updateAppearanceProfile(normalizeAppearance(current.appearance), theme, patch) }));
  const fontOptions = [
    <option key="system" value="system">{zh ? '系统' : 'System'}</option>,
    <option key="sans" value="sans">{zh ? '无衬线' : 'Sans serif'}</option>,
    <option key="serif" value="serif">{zh ? '衬线' : 'Serif'}</option>,
    <option key="mono" value="mono">{zh ? '等宽' : 'Monospace'}</option>,
    ...(settings.font.family ? [<option key="imported" value="imported">{settings.font.displayName}</option>] : []),
  ];
  const styles = [
    <option key="regular" value="regular">{zh ? '常规' : 'Regular'}</option>,
    <option key="medium" value="medium">{zh ? '中等' : 'Medium'}</option>,
    <option key="italic" value="italic">{zh ? '斜体' : 'Italic'}</option>,
  ];
  return <div className="settings-stack appearance-settings-stack">
    <SettingsCard title={zh ? '视觉风格' : 'Visual style'}>
      <div className="appearance-row">
        <strong>{zh ? '模式' : 'Mode'}</strong>
        <div className="appearance-modes" role="group" aria-label={zh ? '模式' : 'Mode'}>
          {(['system', 'light', 'dark'] as const).map(mode => {
            const Icon = mode === 'system' ? Monitor : mode === 'light' ? Sun : Moon;
            const title = mode === 'system' ? zh ? '跟随系统' : 'System' : mode === 'light' ? zh ? '浅色' : 'Light' : zh ? '深色' : 'Dark';
            return <button key={mode} type="button" name="theme-mode" value={mode} aria-label={title} aria-pressed={themePreference === mode}
              onClick={() => onThemePreferenceChange(mode)}>
              <span className={'appearance-mode-preview preview-' + mode} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
              <span><Icon size={13} />{title}</span>
            </button>;
          })}
        </div>
      </div>
    </SettingsCard>
    <SettingsCard title={zh ? '主题与颜色' : 'Theme and colors'} subtitle={appearance.separateModes ? (zh ? '正在调整' + (theme === 'bright' ? '浅色' : '深色') + '模式' : 'Editing ' + (theme === 'bright' ? 'light' : 'dark') + ' mode') : undefined}>
      <SettingsSelect name="appearance-theme" title={zh ? '主题' : 'Theme'} value={profile.theme}
        onChange={value => updateProfile({ theme: value as AppearanceProfile['theme'] })}>
        <option value="default">CardBush</option>
        {imported && <option value="imported">{imported.name}</option>}
      </SettingsSelect>
      {profile.theme === 'imported' && imported && !importedCompatible && <p className="appearance-hint">{zh ? '导入主题将用于对应的明暗模式；当前模式使用默认配色。' : 'The imported palette applies to its matching light or dark mode. This mode uses the default palette.'}</p>}
      <ColorRow name="accent" title={zh ? '强调色' : 'Accent'} value={profile.accent} fallback={String(variables['--accent'] || (theme === 'bright' ? '#175FB5' : '#83BAFF'))} onChange={accent => updateProfile({ accent })} zh={zh} />
      <ColorRow name="background" title={zh ? '背景' : 'Background'} value={profile.background} fallback={String(variables['--bg'] || (theme === 'bright' ? '#F5F3EF' : '#1A1A1A'))} onChange={background => updateProfile({ background })} zh={zh} />
      <ColorRow name="foreground" title={zh ? '前景' : 'Foreground'} value={profile.foreground} fallback={String(variables['--text'] || (theme === 'bright' ? '#1E1C1A' : '#F0EDE7'))} onChange={foreground => updateProfile({ foreground })} zh={zh} />
      <SettingsSelect name="appearance-font" title={zh ? '字体' : 'Font'} value={profile.font} onChange={font => updateProfile({ font: font as AppearanceProfile['font'] })}>{fontOptions}</SettingsSelect>
      <div className="appearance-imports">
        <button className="secondary-button" type="button" onClick={onImportThemeStyle}><Upload size={14} />{zh ? '导入主题' : 'Import theme'}</button>
        <button className="secondary-button" type="button" onClick={onImportFont}><Upload size={14} />{zh ? '导入字体' : 'Import font'}</button>
        {imported && <button className="secondary-button" type="button" onClick={onResetImportedThemeStyle}>{zh ? '移除导入主题' : 'Remove imported theme'}</button>}
        {settings.font.family && <button className="secondary-button" type="button" onClick={onResetFont}>{zh ? '移除导入字体' : 'Remove imported font'}</button>}
      </div>
    </SettingsCard>
    <details className="settings-disclosure appearance-advanced">
      <summary>{zh ? '高级' : 'Advanced'}</summary>
      <div className="settings-disclosure-body">
        <SettingsCard title={zh ? '字号' : 'Text size'}>
          <NumberRow name="interface-size" title={zh ? '界面字号' : 'Interface font size'} subtitle={zh ? '调整界面和会话的基础字号' : 'Base size for the interface and conversation'} value={appearance.interfaceSize} min={12} max={20} onChange={interfaceSize => update({ interfaceSize })} />
          <NumberRow name="code-size" title={zh ? '代码字体大小' : 'Code font size'} subtitle={zh ? '用于聊天、源文件和差异视图' : 'Used in chat, source files and diffs'} value={appearance.codeSize} min={10} max={20} onChange={codeSize => update({ codeSize })} />
        </SettingsCard>
        <SettingsCard title={zh ? '显示偏好' : 'Display preferences'}>
          <SettingsSelect name="reduced-motion" title={zh ? '减少动态效果' : 'Reduce motion'} value={appearance.reducedMotion} onChange={value => update({ reducedMotion: value as AppearancePreferences['reducedMotion'] })}>
            <option value="system">{zh ? '跟随系统' : 'System'}</option><option value="on">{zh ? '开启' : 'On'}</option><option value="off">{zh ? '关闭' : 'Off'}</option>
          </SettingsSelect>
          <SettingsSwitch title={zh ? '分别设置浅色和深色模式' : 'Separate light and dark appearance'} subtitle={zh ? '分别选择主题、颜色和字体；切换模式即可调整' : 'Choose a theme, colors and fonts for each mode'} checked={appearance.separateModes}
            onChange={enabled => onSettingsChange(current => ({ ...current, appearance: setSeparateAppearanceModes(normalizeAppearance(current.appearance), enabled, theme) }))} />
          <SettingsSelect name="interface-style" title={zh ? '界面字体样式' : 'Interface font style'} value={profile.fontStyle} onChange={value => updateProfile({ fontStyle: value as AppearanceProfile['fontStyle'] })}>{styles}</SettingsSelect>
          <SettingsSelect name="content-font" title={zh ? '内容字体' : 'Content font'} value={profile.contentFont} onChange={value => updateProfile({ contentFont: value as AppearanceProfile['contentFont'] })}><option value="inherit">{zh ? '与界面字体相同' : 'Same as interface'}</option>{fontOptions}</SettingsSelect>
          <SettingsSelect name="content-style" title={zh ? '内容字体样式' : 'Content font style'} value={profile.contentStyle} onChange={value => updateProfile({ contentStyle: value as AppearanceProfile['contentStyle'] })}>{styles}</SettingsSelect>
          <SettingsSelect name="code-font" title={zh ? '代码字体' : 'Code font'} value={profile.codeFont} onChange={value => updateProfile({ codeFont: value as AppearanceProfile['codeFont'] })}>
            <option value="system">{zh ? '系统' : 'System'}</option><option value="consolas">Consolas</option><option value="cascadia">Cascadia Code</option><option value="courier">Courier New</option>
          </SettingsSelect>
          <SettingsSelect name="code-style" title={zh ? '代码字体样式' : 'Code font style'} value={profile.codeStyle} onChange={value => updateProfile({ codeStyle: value as AppearanceProfile['codeStyle'] })}>{styles}</SettingsSelect>
          {onWindowMaterialChange && <SettingsSwitch title={zh ? '窗口玻璃效果' : 'Window glass effect'} subtitle={zh ? '系统支持时透出桌面背景' : 'Show the desktop backdrop when supported'} checked={windowMaterial === 'auto'} onChange={enabled => onWindowMaterialChange(enabled ? 'auto' : 'solid')} />}
          <SettingsSwitch title={zh ? '半透明侧边栏' : 'Translucent sidebar'} checked={appearance.translucentSidebar} onChange={translucentSidebar => update({ translucentSidebar })} />
          <label className="appearance-row"><strong>{zh ? '对比度' : 'Contrast'}</strong><span className="appearance-range"><input name="appearance-contrast" aria-label={zh ? '对比度' : 'Contrast'} type="range" min="0" max="100" value={appearance.contrast} onChange={event => update({ contrast: Number(event.target.value) })} /><output>{appearance.contrast}</output></span></label>
          <SettingsSelect name="diff-indicators" title={zh ? '差异标记' : 'Diff indicators'} value={appearance.diffIndicators} onChange={value => update({ diffIndicators: value as AppearancePreferences['diffIndicators'] })}><option value="color">{zh ? '颜色' : 'Color'}</option><option value="symbols">+/−</option></SettingsSelect>
          <SettingsSwitch title={zh ? '使用指针光标' : 'Use pointer cursor'} subtitle={zh ? '悬停交互元素时切换为指针光标' : 'Use a pointer when hovering over interactive elements'} checked={appearance.pointerCursor} onChange={pointerCursor => update({ pointerCursor })} />
        </SettingsCard>
        <button type="button" className="secondary-button" onClick={() => onSettingsChange(current => ({ ...current, appearance: normalizeAppearance() }))}><RotateCcw size={14} />{zh ? '恢复外观默认设置' : 'Reset appearance defaults'}</button>
      </div>
    </details>
    <SettingsCard title={zh ? '语言' : 'Language'}>
      <SettingsSelect name="language-mode" title={zh ? '界面语言' : 'Interface language'} value={languageMode} onChange={value => onLanguageModeChange(value as AppLanguageMode)}>
        <option value="system">{zh ? '跟随系统' : 'System'} · {systemLanguage === 'zh' ? '中文' : 'English'}</option><option value="zh">中文</option><option value="en">English</option>
      </SettingsSelect>
    </SettingsCard>
  </div>;
}

function ColorRow({ name, title, value, fallback, onChange, zh }: { name: string; title: string; value: string; fallback: string; onChange: (value: string) => void; zh: boolean }) {
  const [draft, setDraft] = useState(value || fallback);
  useEffect(() => setDraft(value || fallback), [value, fallback]);
  const commit = () => {
    const hex = draft.trim().replace(/^#?([\da-f]{3})$/i, (_, digits: string) => '#' + [...digits].map(char => char + char).join(''));
    if (/^#[\da-f]{6}$/i.test(hex)) onChange(hex.toUpperCase());
    else setDraft(value || fallback);
  };
  return <div className="appearance-row"><strong>{title}</strong><div className="appearance-color-control">
    <label className="appearance-color-field"><span style={{ background: value || fallback }} aria-hidden="true" /><input type="color" aria-label={title} value={/^#[\da-f]{6}$/i.test(value || fallback) ? value || fallback : '#808080'} onChange={event => onChange(event.target.value)} />
      <input name={'appearance-' + name} aria-label={title + ' HEX'} value={draft} maxLength={96} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    </label><button type="button" title={zh ? '恢复默认' : 'Reset'} aria-label={title + (zh ? '恢复默认' : ' reset')} disabled={!value} onClick={() => onChange('')}><RotateCcw size={13} /></button>
  </div></div>;
}

function NumberRow({ name, title, subtitle, value, min, max, onChange }: { name: string; title: string; subtitle: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="appearance-row"><span><strong>{title}</strong><small>{subtitle}</small></span><span className="appearance-number">
    <input name={name} aria-label={title} type="number" min={min} max={max} value={draft} onChange={event => { const next = event.target.value; setDraft(next); if (next && +next >= min && +next <= max) onChange(Math.round(+next)); }} onBlur={() => { const next = draft && Number.isFinite(+draft) ? Math.min(max, Math.max(min, Math.round(+draft))) : value; setDraft(String(next)); onChange(next); }} />px
  </span></label>;
}
