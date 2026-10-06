import type { AppLanguage } from '../../types';
import { SettingsCard } from '../settings/SettingsControls';
import { CoreCapabilitySettings } from '../capabilities/CoreCapabilitySettings';
import { BrowserConnectionSettings } from './BrowserConnectionSettings';

export function BrowserSettingsPanel({ language }: { language: AppLanguage }) {
  return <div className="settings-stack browser-settings-panel">
    <CoreCapabilitySettings id="chrome" language={language}>{controls => <BrowserConnectionSettings {...controls} />}</CoreCapabilitySettings>
    <SettingsCard title={language === 'zh' ? '浏览器扩展与个人配置' : 'Browser extensions and preferences'}>
      <p>{language === 'zh' ? '连接 Chrome 或 Edge 后，可继续使用对应浏览器中的扩展、登录状态和个人配置。扩展在各自浏览器的扩展管理器中安装和管理。' : 'Connected Chrome or Edge retains its extensions, sign-in and preferences. Manage extensions in each browser’s extension manager.'}</p>
      <p>{language === 'zh' ? 'CardBush 内置浏览器使用独立页面；外部浏览器的扩展和密码不会自动导入其中。' : 'The embedded browser is separate. External browser extensions and passwords are not automatically imported.'}</p>
    </SettingsCard>
  </div>;
}
