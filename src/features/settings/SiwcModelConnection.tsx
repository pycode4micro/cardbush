import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { SiwcModel } from '@cardbush/bush-protocol';
import { useSiwc } from '../accounts/useSiwc';
import { ChatGptWelcome } from '../accounts/ChatGptWelcome';
import { ChatGptMark } from '../accounts/ChatGptMark';
import { SettingsDropdown } from './SettingsDropdown';
import { agentErrorText } from '../agents/agentErrorText';

export function SiwcModelConnection({ language, accountId, onAccountChange, modelName, onModelChange }: {
  language: string; accountId: string; onAccountChange: (id: string) => void;
  modelName: string; onModelChange: (name: string) => void;
}) {
  const { snapshot, error, action } = useSiwc();
  const [models, setModels] = useState<SiwcModel[]>([]), [modelError, setModelError] = useState('');
  const [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const account = snapshot?.accounts.find(item => item.id === accountId);
  useEffect(() => {
    let cancelled = false;
    setModels([]); setModelError(''); setLoading(false);
    if (!accountId || account?.state !== 'signed_in' || !account.planEnabled) return;
    setLoading(true);
    void window.cardbushDesktop!.siwcModels(accountId).then(result => {
      if (!cancelled) { setModels(result); if (!result.length) setModelError(uiText(language)('siwcModelConnection.noAvailableModelsWereReturnedForThis')); }
    }).catch(failure => { if (!cancelled) setModelError(agentErrorText(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, account?.state, account?.planEnabled, revision, language]);
  async function login(id?: string) {
    const existing = new Set(snapshot?.accounts.map(item => item.id));
    const next = await action({ action: 'login', ...(id ? { accountId: id } : {}) });
    if (!mounted.current || !next) return;
    const selected = next.accounts.find(item => item.id === (next.connectedAccountId ?? id)) ?? next.accounts.find(item => !existing.has(item.id) && item.state === 'signed_in');
    if (selected) { onAccountChange(selected.id); setRevision(value => value + 1); }
  }
  return <section className="siwc-model-connection settings-stack">
    <p className="model-connection-note">{uiText(language)('siwcModelConnection.useYourChatgptPlanThroughOfficialAuthorization')}</p>
    <label className="settings-field"><span>{uiText(language)('siwcModelConnection.chatgptAccount')}</span><SettingsDropdown label={uiText(language)('siwcModelConnection.chatgptAccount')} value={accountId}
      options={[{ value: '', label: uiText(language)('siwcModelConnection.chooseAnAccount') }, ...(snapshot?.accounts.map(item => ({ value: item.id,
        label: `${item.label}${item.state !== 'signed_in' ? uiText(language)('siwcModelConnection.signInRequired') : !item.planEnabled ? uiText(language)('siwcModelConnection.planNotAuthorized') : ''}` })) ?? [])]}
      onChange={id => { onAccountChange(id); onModelChange(''); }}/></label>
    <div className="settings-actions">{snapshot?.signingIn
      ? <button type="button" className="secondary-button" onClick={() => void action({ action: 'cancel_login' })}>{uiText(language)('pluginMcpSettings.cancelSignIn')}</button>
      : <><button type="button" className="secondary-button" onClick={() => void login(accountId || undefined)}><ChatGptMark/>{uiText(language)('siwcModelConnection.continue_with_chatgpt')}</button>
        {snapshot?.accounts.length ? <button type="button" className="secondary-button" onClick={() => void login()}>{uiText(language)('siwcModelConnection.addAnotherAccount')}</button> : null}
        {account && <button type="button" className="secondary-button" onClick={() => void action({ action: 'logout', accountId })}>{uiText(language)('siwcModelConnection.signOut')}</button>}</>}
      <button type="button" className="secondary-button" onClick={() => void action({ action: 'manage_usage' })}>{uiText(language)('siwcModelConnection.planUsage')}</button></div>
    {account?.state === 'signed_in' && account.planEnabled && <label className="settings-field"><span>{uiText(language)('siwcModelConnection.availableModels')}</span>
      <SettingsDropdown label={uiText(language)('siwcModelConnection.availableModels')} value={modelName} options={[
        { value: '', label: loading ? uiText(language)('siwcModelConnection.loading') : uiText(language)('siwcModelConnection.chooseAModel') },
        ...models.map(item => ({ value: item.id, label: item.name || item.id })),
      ]} onChange={onModelChange}/>
      <button type="button" className="model-advanced-disclosure" disabled={loading} onClick={() => setRevision(value => value + 1)}>{uiText(language)('siwcModelConnection.refreshModels')}</button>
    </label>}
    {(error || modelError || account?.lastError || snapshot?.lastError) && <p className="settings-inline-error" role="alert">{error || modelError || account?.lastError || snapshot?.lastError}</p>}
    <ChatGptWelcome language={language}/>
  </section>;
}
