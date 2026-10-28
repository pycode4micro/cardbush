import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { SettingsCard } from '../settings/SettingsControls';
import { CoreCapabilitySettings } from '../capabilities/CoreCapabilitySettings';
import { BrowserConnectionSettings } from './BrowserConnectionSettings';
import { BrowserBookmarkImport } from './BrowserLibraryDialog';

export function BrowserSettingsPanel({ language }: { language: AppLanguage }) {
  return <div className="settings-stack browser-settings-panel">
    <SettingsCard title={uiText(language)('browserLibraryDialog.importBookmarks')}>
      <BrowserBookmarkImport language={language}/>
    </SettingsCard>
    <CoreCapabilitySettings id="chrome" language={language}>{controls => <BrowserConnectionSettings {...controls} />}</CoreCapabilitySettings>
    <SettingsCard title={uiText(language)('browserSettingsPanel.browserExtensionsAndPreferences')}>
      <p>{uiText(language)('browserSettingsPanel.connectedChromeOrEdgeRetainsItsExtensions')}</p>
      <p>{uiText(language)('browserSettingsPanel.theEmbeddedBrowserIsSeparateExternalBrowser')}</p>
    </SettingsCard>
  </div>;
}
