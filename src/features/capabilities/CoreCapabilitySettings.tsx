import { useEffect, useState, useRef, type ReactNode } from 'react';
import type { AppLanguage, CardbushAppPlugin, CardbushAppsConfiguration } from '../../types';
import { fetchCardbushAppsConfiguration, saveCardbushAppsConfiguration } from '../../backend/api';
import { SettingsCard, SettingsSwitch } from '../settings/SettingsControls';

export type CoreCapabilityControls = {
  language: AppLanguage; plugin: CardbushAppPlugin; busy: boolean;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
};

/** Adapter for existing bundled capability configuration; core UI does not depend on the plugin catalog UI. */
export function CoreCapabilitySettings({ id, language, children }: {
  id: 'chrome' | 'computer-use'; language: AppLanguage; children: (controls: CoreCapabilityControls) => ReactNode;
}) {
  const [configuration, setConfiguration] = useState<CardbushAppsConfiguration | null>(null);
  const [busy, setBusy] = useState(false), saving = useRef(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const zh = language === 'zh';
  const load = async () => {
    if (saving.current) return;
    try { setConfiguration(await fetchCardbushAppsConfiguration()); setError(''); }
    catch (error) { setError(String(error)); }
  };
  useEffect(() => {
    let active = true;
    void fetchCardbushAppsConfiguration().then(value => { if (active) setConfiguration(value); }, error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);
  const plugin = configuration?.plugins.find(item => item.id === id && item.source === 'bundled');
  const replace = (next: CardbushAppPlugin) => setConfiguration(current => current ? { ...current,
    plugins: current.plugins.map(item => item.id === id ? next : item) } : current);
  const persist = async (next: CardbushAppPlugin, message: string) => {
    if (!configuration || saving.current) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const saved = await saveCardbushAppsConfiguration({ ...configuration,
        plugins: configuration.plugins.map(item => item.id === id ? next : item) });
      setConfiguration(saved); setNotice(message);
    } catch (error) { setError(String(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="settings-stack core-capability-settings">
    {error && <p role="alert" className="settings-form-error">{error}<button type="button" className="secondary-button compact" disabled={busy} onClick={() => void load()}>{zh ? '刷新' : 'Refresh'}</button></p>}
    {notice && <p role="status">{notice}</p>}
    {plugin ? <>
      <SettingsCard title={id === 'chrome' ? (zh ? 'Chrome 自动化' : 'Chrome automation') : 'Computer Use'}>
        <SettingsSwitch title={zh ? '允许智能体使用' : 'Allow agent use'} checked={plugin.installed && plugin.enabled} disabled={busy}
          subtitle={zh ? 'CardBush 内置能力，由应用管理权限和会话隔离。' : 'A built-in capability with permissions and session isolation managed by CardBush.'}
          onChange={enabled => void persist({ ...plugin, installed: true, enabled }, zh ? '设置已保存' : 'Settings saved')} />
        {!configuration?.serviceEnabled && <p>{zh ? '工具服务总开关当前已关闭，请在插件设置中开启后使用。' : 'The tool service is disabled. Enable it in plugin settings to use this capability.'}</p>}
      </SettingsCard>
      {children({ language, plugin, busy, onReplace: replace, onPersist: (next, message) => void persist(next, message) })}
    </> : !error && <p>{configuration ? (zh ? '当前安装不包含此能力。' : 'This capability is unavailable in this installation.') : (zh ? '正在加载…' : 'Loading…')}</p>}
  </div>;
}
