import { useEffect, useRef, useState } from 'react';
import type { PluginRuntime, PluginRuntimeAction, PluginRuntimeStatus } from '@cardbush/platform/contracts';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { SettingsCard, SettingsSelect } from './SettingsControls';
import { useSettingsHost } from './SettingsHostContext';

const runtimes = [{kind:'python', title:'Python', example:'3.12'}, {kind:'node', title:'Node.js', example:'24'}] as const;
export function PluginRuntimeSettings({language, visible}: {language: AppLanguage; visible: boolean}) {
  const api = window.cardbushDesktop?.managePluginRuntime;
  const {remote} = useSettingsHost();
  const t = uiText(language);
  const [status, setStatus] = useState<PluginRuntimeStatus[]>([]);
  const [busy, setBusy] = useState<PluginRuntime>();
  const [failed, setFailed] = useState(false);
  const [selectors, setSelectors] = useState({node:'', python:''});
  const generation = useRef(0);
  useEffect(() => {
    if (!api || remote || !visible) return;
    let mounted = true;
    const refresh = () => {
      const ticket = ++generation.current;
      void api('list').then(value => { if (mounted && ticket === generation.current) setStatus(value); },
        () => { if (mounted && ticket === generation.current) setFailed(true); });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { mounted = false; window.removeEventListener('focus', refresh); };
  }, [api, remote, visible]);
  if (!api || remote) return null;
  const apply = async (action: PluginRuntimeAction, kind: PluginRuntime, version?: string) => {
    setBusy(kind); setFailed(false);
    try { const next = await api(action, kind, version); ++generation.current; setStatus(next); }
    catch { setFailed(true); }
    finally { setBusy(undefined); }
  };
  return <SettingsCard title={t('pluginRuntimes.title')} subtitle={t('pluginRuntimes.description')}>
    {runtimes.map(({kind, title, example}) => {
      const item = status.find(entry => entry.kind === kind);
      const selector = selectors[kind].trim();
      return <div className="settings-stack" key={kind}>
        {item?.active ? <SettingsSelect name={'plugin-runtime-' + kind} title={title} value={item.active} disabled={!!busy}
          onChange={value => void apply('use', kind, value)}>
          {item.versions.map(version => <option key={version} value={version}>{version}</option>)}
        </SettingsSelect> : <strong>{t('pluginRuntimes.absent', {name:title})}</strong>}
        <div className="settings-actions">
          <label className="settings-field">{t('pluginRuntimes.version', {name:title})}
            <input type="text" placeholder={example} value={selectors[kind]} disabled={!!busy}
              onChange={event => setSelectors({...selectors, [kind]:event.target.value})}/>
          </label>
          <button type="button" className="secondary-button" disabled={!!busy || (!!selector && !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(selector))}
            onClick={() => void apply('install', kind, selector || undefined)}>{t('pluginRuntimes.install')}</button>
          {item?.active && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void apply('update', kind)}>{t('pluginRuntimes.update')}</button>}
        </div>
        {busy === kind && <small role="status">{t('pluginRuntimes.working', {name:title})}</small>}
      </div>;
    })}
    {failed && <p role="alert">{t('pluginRuntimes.failed')}</p>}
  </SettingsCard>;
}
