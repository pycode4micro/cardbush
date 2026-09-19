import type { CoreCapabilityControls } from '../capabilities/CoreCapabilitySettings';
import { CoreCapabilitySettings } from '../capabilities/CoreCapabilitySettings';
import { SettingsCard, SettingsInput, SettingsSwitch } from '../settings/SettingsControls';
import type { AppLanguage } from '../../types';

export function ComputerUseSettings({ language, plugin, busy, onReplace, onPersist }: CoreCapabilityControls) {
  const zh = language === 'zh';
  const update = (key: string, value: string | boolean) => onReplace({ ...plugin, config: { ...plugin.config, [key]: value } });
  return <SettingsCard title={zh ? '桌面控制' : 'Desktop control'}>
    <SettingsInput label={zh ? '截图保存目录' : 'Screenshot directory'} value={String(plugin.config.screenshotDirectory ?? '')}
      placeholder={zh ? '留空时使用系统临时目录' : 'Use the system temp directory when empty'} disabled={busy} onChange={value => update('screenshotDirectory', value)} />
    <SettingsSwitch title={zh ? '用户输入优先' : 'Yield to user input'} subtitle={zh ? '检测到用户操作时主动让行。' : 'Pause when user activity is detected.'}
      checked={plugin.config.yieldToUser !== false} disabled={busy} onChange={value => update('yieldToUser', value)} />
    <SettingsSwitch title={zh ? '鼠标操作后恢复原位置' : 'Restore pointer after mouse actions'} checked={plugin.config.restorePointer !== false} disabled={busy} onChange={value => update('restorePointer', value)} />
    <SettingsSwitch title={zh ? '允许启动应用' : 'Allow opening apps'} checked={plugin.config.allowOpenApp !== false} disabled={busy} onChange={value => update('allowOpenApp', value)} />
    <SettingsSwitch title={zh ? '允许关闭窗口' : 'Allow closing windows'} checked={plugin.config.allowWindowClose !== false} disabled={busy} onChange={value => update('allowWindowClose', value)} />
    <button className="primary-button compact" type="button" disabled={busy} onClick={() => onPersist(plugin, zh ? '配置已保存' : 'Settings saved')}>{zh ? '保存配置' : 'Save settings'}</button>
  </SettingsCard>;
}

export function ComputerUseSettingsPanel({ language }: { language: AppLanguage }) {
  return <CoreCapabilitySettings id="computer-use" language={language}>{controls => <ComputerUseSettings {...controls} />}</CoreCapabilitySettings>;
}
