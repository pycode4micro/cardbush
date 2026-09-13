import { Monitor, Moon, Palette, RotateCcw, Scroll, Sun, Upload, Zap } from 'lucide-react';
import type { AppLanguage, AppLanguageMode, AppSettingsState, ThemePreference } from '../../types';
import type { WindowMaterialPreference } from '../appearance/windowAppearance';
import { basename } from '../../shared/localPaths';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';

export function SettingsAppearancePanel({ themePreference, windowMaterial, onWindowMaterialChange, language,
  languageMode, systemLanguage, settings, onThemePreferenceChange, onLanguageModeChange,
  onImportFont, onResetFont, onImportThemeStyle, onResetImportedThemeStyle,
}: {
  themePreference: ThemePreference; windowMaterial: WindowMaterialPreference;
  onWindowMaterialChange?: (value: WindowMaterialPreference) => void;
  language: AppLanguage; languageMode: AppLanguageMode; systemLanguage: AppLanguage; settings: AppSettingsState;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onImportFont: () => void; onResetFont: () => void; onImportThemeStyle: () => void; onResetImportedThemeStyle: () => void;
}) {
  const zh = language === 'zh', fontIsCustom = Boolean(settings.font.family && settings.font.filePath);
  const importedThemeStyle = settings.importedThemeStyle;
  return <div className="settings-stack appearance-settings-stack">
    <SettingsCard title={zh ? '界面' : 'Interface'}>
      <SettingsSelect name="theme-mode" title={zh ? '主题' : 'Theme'} value={themePreference}
        icons={{ system: <Monitor size={15} />, light: <Sun size={15} />, dark: <Moon size={15} />,
          parchment: <Scroll size={15} />, cyberpunk: <Zap size={15} />, custom: <Palette size={15} /> }}
        onChange={value => onThemePreferenceChange(value as ThemePreference)}>
        <option value="system">{zh ? '跟随系统' : 'Follow system'}</option>
        <option value="light">{zh ? '浅色' : 'Light'}</option>
        <option value="dark">{zh ? '深色' : 'Dark'}</option>
        <option value="parchment">{zh ? '羊皮纸' : 'Parchment'}</option>
        <option value="cyberpunk">{zh ? '赛博朋克' : 'Cyberpunk'}</option>
        {importedThemeStyle && <option value="custom">{importedThemeStyle.name}</option>}
      </SettingsSelect>
      {onWindowMaterialChange && <SettingsSwitch title={zh ? '窗口玻璃效果' : 'Window glass effect'}
        subtitle={zh ? '让顶栏和侧栏透出桌面背景，系统不支持时使用纯色。' : 'Blend the title bar and sidebar with your desktop when supported.'}
        checked={windowMaterial === 'auto'} onChange={enabled => onWindowMaterialChange(enabled ? 'auto' : 'solid')} />}
      <SettingsSelect name="language-mode" title={zh ? '界面语言' : 'Interface language'} value={languageMode}
        onChange={value => onLanguageModeChange(value as AppLanguageMode)}>
        <option value="system">{zh ? '跟随系统' : 'Follow system'} · {systemLanguage === 'zh' ? '中文' : 'English'}</option>
        <option value="zh">中文</option><option value="en">English</option>
      </SettingsSelect>
    </SettingsCard>
    <SettingsCard title={zh ? '字体' : 'Font'}>
      <div className="settings-value-row">
        <span><strong>{fontIsCustom ? settings.font.displayName : zh ? '系统默认字体' : 'System default font'}</strong></span>
        <div className="settings-actions">
          <button className="secondary-button" type="button" onClick={onImportFont}><Upload size={14} />{zh ? '导入字体' : 'Import font'}</button>
          {fontIsCustom && <button className="secondary-button" type="button" onClick={onResetFont}><RotateCcw size={14} />{zh ? '恢复默认' : 'Reset'}</button>}
        </div>
      </div>
      <p className="settings-font-sample">{zh ? '你好，cardbush。让想法自然发生。' : 'Hello, cardbush. Make room for your next idea.'} <span>Aa 123</span></p>
    </SettingsCard>
    <details className="settings-disclosure">
      <summary>{zh ? '自定义主题' : 'Custom theme'}</summary>
      <div className="settings-disclosure-body">
        <p>{importedThemeStyle ? basename(importedThemeStyle.sourcePath) || importedThemeStyle.name
          : zh ? '导入主题颜色配置，保留当前界面的布局。' : 'Import a color configuration for the current interface.'}</p>
        <div className="settings-actions">
          <button className="secondary-button" type="button" onClick={onImportThemeStyle}><Upload size={14} />{zh ? '导入主题配置' : 'Import theme config'}</button>
          {importedThemeStyle && <button className="secondary-button" type="button" onClick={onResetImportedThemeStyle}><RotateCcw size={14} />{zh ? '移除导入主题' : 'Remove imported theme'}</button>}
        </div>
      </div>
    </details>
  </div>;
}
