import { useUiLanguage } from '../../i18n/react';
import { THEME_ACCENTS, THEME_BACKGROUNDS, THEME_FOREGROUNDS, COLOR_INPUT_FALLBACK } from '../appearance/themeRuntime';
import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { Monitor, Moon, RotateCcw, Sun, Upload } from 'lucide-react';
import type { AppLanguage, AppSettingsState, ThemePreference, ThemeMode } from '../../types';
import type { WindowMaterialPreference } from '../appearance/windowAppearance';
import { appearanceProfileKey, appearanceVariables, normalizeAppearance, setSeparateAppearanceModes, updateAppearanceProfile,
  type AppearancePreferences, type AppearanceProfile } from '../appearance/appearancePreferences';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import './appearanceSettings.css';

export function SettingsAppearancePanel({ themePreference, windowMaterial, onWindowMaterialChange, language,
  settings, onThemePreferenceChange, onSettingsChange,
  onImportFont, onResetFont, onImportThemeStyle, onResetImportedThemeStyle,
}: {
  themePreference: ThemePreference; windowMaterial: WindowMaterialPreference;
  onWindowMaterialChange?: (value: WindowMaterialPreference) => void;
  language: AppLanguage; settings: AppSettingsState;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onImportFont: () => void; onResetFont: () => void; onImportThemeStyle: () => void; onResetImportedThemeStyle: () => void;
}) {
  const uiLanguage = language;
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
    <option key="system" value="system">{uiText(language)('settingsAppearancePanel.system')}</option>,
    <option key="sans" value="sans">{uiText(language)('settingsAppearancePanel.sansSerif')}</option>,
    <option key="serif" value="serif">{uiText(language)('settingsAppearancePanel.serif')}</option>,
    <option key="mono" value="mono">{uiText(language)('settingsAppearancePanel.monospace')}</option>,
    ...(settings.font.family ? [<option key="imported" value="imported">{settings.font.displayName}</option>] : []),
  ];
  const styles = [
    <option key="regular" value="regular">{uiText(language)('settingsAppearancePanel.regular')}</option>,
    <option key="medium" value="medium">{uiText(language)('settingsAppearancePanel.medium')}</option>,
    <option key="italic" value="italic">{uiText(language)('settingsAppearancePanel.italic')}</option>,
  ];
  return <div className="settings-stack appearance-settings-stack">
    <SettingsCard title={uiText(language)('settingsAppearancePanel.visualStyle')}>
      <div className="appearance-row">
        <strong>{uiText(language)('settingsAppearancePanel.mode')}</strong>
        <div className="appearance-modes" role="group" aria-label={uiText(language)('settingsAppearancePanel.mode')}>
          {(['system', 'light', 'dark'] as const).map(mode => {
            const Icon = mode === 'system' ? Monitor : mode === 'light' ? Sun : Moon;
            const title = mode === 'system' ? uiText(language)('settingsAppearancePanel.system_9916b02') : mode === 'light' ? uiText(language)('settingsAppearancePanel.light') : uiText(language)('settingsAppearancePanel.dark');
            return <button key={mode} type="button" name="theme-mode" value={mode} aria-label={title} aria-pressed={themePreference === mode}
              onClick={() => onThemePreferenceChange(mode)}>
              <span className={'appearance-mode-preview preview-' + mode} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
              <span><Icon size={13} />{title}</span>
            </button>;
          })}
        </div>
      </div>
    </SettingsCard>
    <SettingsCard title={uiText(language)('settingsAppearancePanel.themeAndColors')} subtitle={appearance.separateModes ? (uiText(language)(theme === 'bright' ? 'appearance.editingLight' : 'appearance.editingDark')) : undefined}>
      <SettingsSelect name="appearance-theme" title={uiText(language)('settingsAppearancePanel.theme')} value={profile.theme}
        onChange={value => updateProfile({ theme: value as AppearanceProfile['theme'] })}>
        <option value="default">{uiText(language)('aiEditingCursor.cardbush')}</option>
        {imported && <option value="imported">{imported.name}</option>}
      </SettingsSelect>
      {profile.theme === 'imported' && imported && !importedCompatible && <p className="appearance-hint">{uiText(language)('settingsAppearancePanel.theImportedPaletteAppliesToItsMatching')}</p>}
      <ColorRow name="accent" title={uiText(language)('settingsAppearancePanel.accent')} value={profile.accent} fallback={String(variables['--accent'] || THEME_ACCENTS[theme])} onChange={accent => updateProfile({ accent })} uiLanguage={uiLanguage} />
      <ColorRow name="background" title={uiText(language)('settingsAppearancePanel.background')} value={profile.background} fallback={String(variables['--bg'] || THEME_BACKGROUNDS[theme])} onChange={background => updateProfile({ background })} uiLanguage={uiLanguage} />
      <ColorRow name="foreground" title={uiText(language)('settingsAppearancePanel.foreground')} value={profile.foreground} fallback={String(variables['--text'] || THEME_FOREGROUNDS[theme])} onChange={foreground => updateProfile({ foreground })} uiLanguage={uiLanguage} />
      <SettingsSelect name="appearance-font" title={uiText(language)('settingsAppearancePanel.font')} value={profile.font} onChange={font => updateProfile({ font: font as AppearanceProfile['font'] })}>{fontOptions}</SettingsSelect>
      <div className="appearance-imports">
        <button className="secondary-button" type="button" onClick={onImportThemeStyle}><Upload size={14} />{uiText(language)('settingsAppearancePanel.importTheme')}</button>
        <button className="secondary-button" type="button" onClick={onImportFont}><Upload size={14} />{uiText(language)('settingsAppearancePanel.importFont')}</button>
        {imported && <button className="secondary-button" type="button" onClick={onResetImportedThemeStyle}>{uiText(language)('settingsAppearancePanel.removeImportedTheme')}</button>}
        {settings.font.family && <button className="secondary-button" type="button" onClick={onResetFont}>{uiText(language)('settingsAppearancePanel.removeImportedFont')}</button>}
      </div>
    </SettingsCard>
    <details className="settings-disclosure appearance-advanced">
      <summary>{uiText(language)('settingsAppearancePanel.advanced')}</summary>
      <div className="settings-disclosure-body">
        <SettingsCard title={uiText(language)('settingsAppearancePanel.textSize')}>
          <NumberRow name="interface-size" title={uiText(language)('settingsAppearancePanel.interfaceFontSize')} subtitle={uiText(language)('settingsAppearancePanel.baseSizeForTheInterfaceAndConversation')} value={appearance.interfaceSize} min={12} max={20} onChange={interfaceSize => update({ interfaceSize })} />
          <NumberRow name="code-size" title={uiText(language)('settingsAppearancePanel.codeFontSize')} subtitle={uiText(language)('settingsAppearancePanel.usedInChatSourceFilesAndDiffs')} value={appearance.codeSize} min={10} max={20} onChange={codeSize => update({ codeSize })} />
        </SettingsCard>
        <SettingsCard title={uiText(language)('settingsAppearancePanel.displayPreferences')}>
          <SettingsSelect name="reduced-motion" title={uiText(language)('settingsAppearancePanel.reduceMotion')} value={appearance.reducedMotion} onChange={value => update({ reducedMotion: value as AppearancePreferences['reducedMotion'] })}>
            <option value="system">{uiText(language)('settingsAppearancePanel.system_9916b02')}</option><option value="on">{uiText(language)('settingsAppearancePanel.on')}</option><option value="off">{uiText(language)('settingsAppearancePanel.off')}</option>
          </SettingsSelect>
          <SettingsSwitch title={uiText(language)('settingsAppearancePanel.separateLightAndDarkAppearance')} subtitle={uiText(language)('settingsAppearancePanel.chooseAThemeColorsAndFontsFor')} checked={appearance.separateModes}
            onChange={enabled => onSettingsChange(current => ({ ...current, appearance: setSeparateAppearanceModes(normalizeAppearance(current.appearance), enabled, theme) }))} />
          <SettingsSelect name="interface-style" title={uiText(language)('settingsAppearancePanel.interfaceFontStyle')} value={profile.fontStyle} onChange={value => updateProfile({ fontStyle: value as AppearanceProfile['fontStyle'] })}>{styles}</SettingsSelect>
          <SettingsSelect name="content-font" title={uiText(language)('settingsAppearancePanel.contentFont')} value={profile.contentFont} onChange={value => updateProfile({ contentFont: value as AppearanceProfile['contentFont'] })}><option value="inherit">{uiText(language)('settingsAppearancePanel.sameAsInterface')}</option>{fontOptions}</SettingsSelect>
          <SettingsSelect name="content-style" title={uiText(language)('settingsAppearancePanel.contentFontStyle')} value={profile.contentStyle} onChange={value => updateProfile({ contentStyle: value as AppearanceProfile['contentStyle'] })}>{styles}</SettingsSelect>
          <SettingsSelect name="code-font" title={uiText(language)('settingsAppearancePanel.codeFont')} value={profile.codeFont} onChange={value => updateProfile({ codeFont: value as AppearanceProfile['codeFont'] })}>
            <option value="system">{uiText(language)('settingsAppearancePanel.system')}</option><option value="consolas">{uiText(language)('settingsAppearancePanel.consolas')}</option><option value="cascadia">{uiText(language)('settingsAppearancePanel.cascadia_code')}</option><option value="courier">{uiText(language)('settingsAppearancePanel.courier_new')}</option>
          </SettingsSelect>
          <SettingsSelect name="code-style" title={uiText(language)('settingsAppearancePanel.codeFontStyle')} value={profile.codeStyle} onChange={value => updateProfile({ codeStyle: value as AppearanceProfile['codeStyle'] })}>{styles}</SettingsSelect>
          {onWindowMaterialChange && <SettingsSwitch title={uiText(language)('settingsAppearancePanel.windowGlassEffect')} subtitle={uiText(language)('settingsAppearancePanel.showTheDesktopBackdropWhenSupported')} checked={windowMaterial === 'auto'} onChange={enabled => onWindowMaterialChange(enabled ? 'auto' : 'solid')} />}
          <SettingsSwitch title={uiText(language)('settingsAppearancePanel.translucentSidebar')} checked={appearance.translucentSidebar} onChange={translucentSidebar => update({ translucentSidebar })} />
          <label className="appearance-row"><strong>{uiText(language)('settingsAppearancePanel.contrast')}</strong><span className="appearance-range"><input name="appearance-contrast" aria-label={uiText(language)('settingsAppearancePanel.contrast')} type="range" min="0" max="100" value={appearance.contrast} onChange={event => update({ contrast: Number(event.target.value) })} /><output>{appearance.contrast}</output></span></label>
          <SettingsSelect name="diff-indicators" title={uiText(language)('settingsAppearancePanel.diffIndicators')} value={appearance.diffIndicators} onChange={value => update({ diffIndicators: value as AppearancePreferences['diffIndicators'] })}><option value="color">{uiText(language)('settingsAppearancePanel.color')}</option><option value="symbols">+/−</option></SettingsSelect>
          <SettingsSwitch title={uiText(language)('settingsAppearancePanel.usePointerCursor')} subtitle={uiText(language)('settingsAppearancePanel.useAPointerWhenHoveringOverInteractive')} checked={appearance.pointerCursor} onChange={pointerCursor => update({ pointerCursor })} />
        </SettingsCard>
        <button type="button" className="secondary-button" onClick={() => onSettingsChange(current => ({ ...current, appearance: normalizeAppearance() }))}><RotateCcw size={14} />{uiText(language)('settingsAppearancePanel.resetAppearanceDefaults')}</button>
      </div>
    </details>
  </div>;
}

function ColorRow({ name, title, value, fallback, onChange, uiLanguage }: { name: string; title: string; value: string; fallback: string; onChange: (value: string) => void; uiLanguage: string }) {
  const [draft, setDraft] = useState(value || fallback);
  useEffect(() => setDraft(value || fallback), [value, fallback]);
  const commit = () => {
    const hex = draft.trim().replace(/^#?([\da-f]{3})$/i, (_, digits: string) => '#' + [...digits].map(char => char + char).join(''));
    if (/^#[\da-f]{6}$/i.test(hex)) onChange(hex.toUpperCase());
    else setDraft(value || fallback);
  };
  return <div className="appearance-row"><strong>{title}</strong><div className="appearance-color-control">
    <label className="appearance-color-field"><span style={{ background: value || fallback }} aria-hidden="true" /><input type="color" aria-label={title} value={/^#[\da-f]{6}$/i.test(value || fallback) ? value || fallback : COLOR_INPUT_FALLBACK} onChange={event => onChange(event.target.value)} />
      <input name={'appearance-' + name} aria-label={title + ' HEX'} value={draft} maxLength={96} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    </label><button type="button" title={uiText(uiLanguage)('settingsKeyboardPanel.reset')} aria-label={title + (uiText(uiLanguage)('settingsAppearancePanel.reset'))} disabled={!value} onClick={() => onChange('')}><RotateCcw size={13} /></button>
  </div></div>;
}

function NumberRow({ name, title, subtitle, value, min, max, onChange }: { name: string; title: string; subtitle: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const language = useUiLanguage();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="appearance-row"><span><strong>{title}</strong><small>{subtitle}</small></span><span className="appearance-number">
    <input name={name} aria-label={title} type="number" min={min} max={max} value={draft} onChange={event => { const next = event.target.value; setDraft(next); if (next && +next >= min && +next <= max) onChange(Math.round(+next)); }} onBlur={() => { const next = draft && Number.isFinite(+draft) ? Math.min(max, Math.max(min, Math.round(+draft))) : value; setDraft(String(next)); onChange(next); }} />{uiText(language)('settingsAppearancePanel.px')}</span></label>;
}
