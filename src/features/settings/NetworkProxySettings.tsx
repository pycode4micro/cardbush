import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { defaultPluginProxy, pluginProxySchema, type PluginProxySettings } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';
import { SettingsDropdown } from './SettingsDropdown';

export function proxyLabel(mode: string, uiLanguage: string): string {
  return ({ inherit: uiText(uiLanguage)('networkProxySettings.useDefault'), model: uiText(uiLanguage)('networkProxySettings.followAppDefault'),
    none: uiText(uiLanguage)('networkProxySettings.noProxy'), system: uiText(uiLanguage)('networkProxySettings.followSystem'), manual: uiText(uiLanguage)('networkProxySettings.manualProxy') })[mode] ?? mode;
}

export function NetworkProxySettings({ language, value, defaults, scope = 'plugins', individual = false, busy = false, onSave, label, caption, compact = false, resetRevision = 0, applyToAll }: {
  language: AppLanguage; value?: PluginProxySettings; defaults?: PluginProxySettings; individual?: boolean; busy?: boolean;
  scope?: 'application' | 'plugins';
  label?: string; caption?: string; compact?: boolean; resetRevision?: number;
  onSave: (value: PluginProxySettings | undefined) => Promise<boolean>;
  applyToAll?: { formId: string; save: (value: PluginProxySettings) => Promise<boolean> };
}) {
  const uiLanguage = language;
  const [draft, setDraft] = useState(value ?? defaultPluginProxy());
  const [inherit, setInherit] = useState(individual && !value);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const lastReset = useRef(resetRevision);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    if (!dirty || lastReset.current !== resetRevision) {
      setDraft(value ?? defaultPluginProxy()); setInherit(individual && !value);
      if (lastReset.current !== resetRevision) { lastReset.current = resetRevision; setDirty(false); setError(''); }
    }
  }, [serialized, individual, dirty, resetRevision]);
  const mode = inherit ? 'inherit' : draft.mode;
  const update = (patch: Partial<PluginProxySettings>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); setError(''); };
  const save = async (candidate = draft, useDefault = inherit, all = false) => {
    if (busy || savingRef.current) return;
    const result = pluginProxySchema.safeParse(candidate);
    if (!useDefault && !result.success) { setError(uiText(language)('networkProxySettings.enterAValidHttpHttpsOrSocks')); return; }
    if (!useDefault && candidate.mode === 'manual' && !candidate.httpProxy.trim() && !candidate.httpsProxy.trim()) {
      setError(uiText(language)('networkProxySettings.enterAtLeastOneProxyAddress')); return;
    }
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = all && applyToAll && result.success ? await applyToAll.save(result.data) : await onSave(useDefault ? undefined : result.data);
      if (saved) setDirty(false);
      else setError(all ? (uiText(language)('networkProxySettings.notAllSettingsWereAppliedPleaseRetry')) : (uiText(language)('networkProxySettings.saveDidNotCompletePleaseRetry')));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const Container = applyToAll ? 'form' : 'div';
  return <Container id={applyToAll?.formId} className={`plugin-proxy-settings${compact ? ' plugin-proxy-row' : ''}`}
    onSubmit={event => { event.preventDefault(); if (applyToAll) void save(draft, false, true); }}>
    {label && <div className="plugin-proxy-row-name"><strong>{label}</strong>{caption && <small>{caption}</small>}</div>}
    <label className="plugin-proxy-mode"><span>{uiText(language)('networkProxySettings.proxyMode')}</span>
      <SettingsDropdown label={label ? `${label} ${uiText(language)('networkProxySettings.proxyMode_c6e146e')}` : uiText(language)('networkProxySettings.proxyMode')} value={mode} disabled={busy || saving} onChange={mode => {
        setInherit(mode === 'inherit');
        if (mode !== 'inherit') {
          const next = { ...draft, mode: mode as PluginProxySettings['mode'] };
          update(next);
          // Discrete global choices take effect immediately. Manual addresses
          // stay editable until the complete configuration is saved/applied.
          if (!individual && mode !== 'manual') void save(next, false);
        } else { setDirty(true); setError(''); }
      }} options={(scope === 'application' ? ['none', 'system', 'manual'] : individual ? ['inherit', 'model', 'none', 'system', 'manual'] : ['model', 'none', 'system', 'manual']).map(mode => ({ value: mode, label: mode === 'inherit'
          ? `${proxyLabel(mode, uiLanguage)}${uiText(language)('networkProxySettings.message')}${proxyLabel(defaults?.mode ?? 'model', uiLanguage)}${uiText(language)('networkProxySettings.message_6e7f5ac')}`
          : proxyLabel(mode, uiLanguage) }))} />
    </label>
    {!compact && <p className="plugin-proxy-help">{inherit
      ? `${uiText(language)('networkProxySettings.currentPluginDefault')}${proxyLabel(defaults?.mode ?? 'model', uiLanguage)}`
      : mode === 'model' ? (uiText(language)('networkProxySettings.usesNetworkProxyAppDefaultAndFollows'))
      : mode === 'system' ? (uiText(language)('networkProxySettings.usesTheOperatingSystemProxyAndBypass'))
      : mode === 'none' ? (uiText(language)('networkProxySettings.connectsDirectlyWithoutInheritingEnvironmentProxies'))
      : (uiText(language)('networkProxySettings.supportsHttpHttpsAndSocksAnEmpty'))}</p>}
    {mode === 'manual' && <div className="plugin-proxy-fields">{(['httpProxy', 'httpsProxy', 'noProxy'] as const).map(field =>
      <label key={field}><span>{field === 'httpProxy' ? 'HTTP_PROXY' : field === 'httpsProxy' ? 'HTTPS_PROXY' : 'NO_PROXY'}</span>
        <input value={draft[field]} disabled={busy || saving} autoComplete="off" spellCheck={false}
          placeholder={field === 'noProxy' ? 'localhost,127.0.0.1,.internal' : 'http://127.0.0.1:7890'} onChange={event => update({ [field]: event.target.value })} />
      </label>)}</div>}
    {error && <p className="plugin-market-error" role="alert">{error}</p>}
    {!individual && <p className="plugin-proxy-help" role="status">{saving ? (uiText(language)('networkProxySettings.saving')) : dirty
      ? (applyToAll ? (uiText(language)('networkProxySettings.changesAreNotSavedSaveWhenReady'))
        : (uiText(language)('networkProxySettings.changesAreNotSavedSaveWhenReady_cbd7029')))
      : (uiText(language)('networkProxySettings.savedRetainedWhenReopeningOrRestarting'))}</p>}
    {dirty && <button type="button" className="plugin-install-button" disabled={busy || saving} onClick={() => void save()}>{saving ? (uiText(language)('automationPanel.saving')) : compact ? (uiText(language)('appCenter.save')) : (uiText(language)('networkProxySettings.saveProxySettings'))}</button>}
  </Container>;
}
