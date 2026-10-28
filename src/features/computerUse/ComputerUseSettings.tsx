import { uiText } from '../../i18n';
import type { CoreCapabilityControls } from '../capabilities/CoreCapabilitySettings';
import { CoreCapabilitySettings } from '../capabilities/CoreCapabilitySettings';
import { SettingsCard, SettingsInput, SettingsSwitch } from '../settings/SettingsControls';
import type { AppLanguage } from '../../types';

export function ComputerUseSettings({ language, plugin, busy, onReplace, onPersist }: CoreCapabilityControls) {

  const update = (key: string, value: string | boolean) => onReplace({ ...plugin, config: { ...plugin.config, [key]: value } });
  return <SettingsCard title={uiText(language)('computerUseSettings.desktopControl')}>
    <SettingsInput label={uiText(language)('computerUseSettings.screenshotDirectory')} value={String(plugin.config.screenshotDirectory ?? '')}
      placeholder={uiText(language)('computerUseSettings.useTheSystemTempDirectoryWhenEmpty')} disabled={busy} onChange={value => update('screenshotDirectory', value)} />
    <SettingsSwitch title={uiText(language)('computerUseSettings.yieldToUserInput')} subtitle={uiText(language)('computerUseSettings.pauseWhenUserActivityIsDetected')}
      checked={plugin.config.yieldToUser !== false} disabled={busy} onChange={value => update('yieldToUser', value)} />
    <SettingsSwitch title={uiText(language)('computerUseSettings.restorePointerAfterMouseActions')} checked={plugin.config.restorePointer !== false} disabled={busy} onChange={value => update('restorePointer', value)} />
    <SettingsSwitch title={uiText(language)('computerUseSettings.allowOpeningApps')} checked={plugin.config.allowOpenApp !== false} disabled={busy} onChange={value => update('allowOpenApp', value)} />
    <SettingsSwitch title={uiText(language)('computerUseSettings.allowClosingWindows')} checked={plugin.config.allowWindowClose !== false} disabled={busy} onChange={value => update('allowWindowClose', value)} />
    <button className="primary-button compact" type="button" disabled={busy} onClick={() => onPersist(plugin, uiText(language)('computerUseSettings.settingsSaved'))}>{uiText(language)('computerUseSettings.saveSettings')}</button>
  </SettingsCard>;
}

export function ComputerUseSettingsPanel({ language }: { language: AppLanguage }) {
  return <CoreCapabilitySettings id="computer-use" language={language}>{controls => <ComputerUseSettings {...controls} />}</CoreCapabilitySettings>;
}
