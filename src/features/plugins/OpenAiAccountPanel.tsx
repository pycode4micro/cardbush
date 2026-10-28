import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import type { OpenAiAccountStatus } from '@cardbush/bush-protocol';
import './mcp-integration.css';

export function OpenAiAccountPanel({ language, onChanged, onStatusChange, onManageAccounts, navigationDisabled }: {
  language: string; onChanged?: () => void; onStatusChange?: (status: OpenAiAccountStatus | undefined) => void;
  onManageAccounts?: () => void; navigationDisabled?: boolean;
}) {

  const desktop = window.cardbushDesktop;
  const [status, setStatus] = useState<OpenAiAccountStatus>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!desktop?.openAiAccountStatus) return;
    let active = true;
    const refresh = () => { void desktop.openAiAccountStatus().then(value => { if (active) setStatus(value); }).catch(() => { if (active) setError(uiText(language)('openAiAccountPanel.couldNotReadOpenaiAccountStatus')); }); };
    refresh();
    const unsubscribe = desktop.onOpenAiAccountChanged?.(() => { refresh(); onChanged?.(); });
    return () => { active = false; unsubscribe?.(); };
  }, [desktop, language]);
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  if (!desktop?.openAiAccountStatus) return null;
  const signingIn = status?.state === 'signing_in' || busy === 'login';
  const connected = status?.state === 'signed_in';
  const labels = ({ signed_out: uiText(language)('accountsPanel.signedOut'), signing_in: uiText(language)('accountsPanel.waitingForBrowserSignIn'), signed_in: uiText(language)('accountsPanel.signedIn_21eb867'), reauth_required: uiText(language)('accountsPanel.signInAgain'), unavailable: uiText(language)('openAiAccountPanel.credentialStorageUnavailable') });
  const action = async (action: Parameters<typeof desktop.openAiAccountAction>[0]) => {
    if (action !== 'cancel_login') setBusy(action);
    setError('');
    try { setStatus(await desktop.openAiAccountAction(action)); onChanged?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (action !== 'cancel_login') setBusy(''); void desktop.openAiAccountStatus().then(setStatus).catch(() => {}); }
  };
  if (onManageAccounts) return <section className="openai-account-panel" aria-label={uiText(language)('openAiAccountPanel.openaiAccount')}><header>
    <div className="openai-account-identity"><strong>{uiText(language)('openAiAccountPanel.openaiAccount')}</strong><span role="status" data-connected={connected}>{status ? labels[status.state] : (uiText(language)('openAiAccountPanel.loading'))}</span></div>
    <button type="button" disabled={navigationDisabled} onClick={onManageAccounts}>{uiText(language)('openAiAccountPanel.manageAccounts')}</button>
  </header>{navigationDisabled && <p className="openai-account-hint">{uiText(language)('openAiAccountPanel.saveConnectionChangesOrFinishTheCurrent')}</p>}</section>;
  return <section className="openai-account-panel" aria-label={uiText(language)('openAiAccountPanel.openaiAccount')}>
    <header><div className="openai-account-identity"><strong>{uiText(language)('openAiAccountPanel.openaiAccount')}</strong><span role="status" data-connected={connected}>{status ? labels[status.state] : (uiText(language)('openAiAccountPanel.loading'))}</span></div>
      {signingIn ? <button type="button" onClick={() => void action('cancel_login')}>{uiText(language)('openAiAccountPanel.cancelOpenaiSignIn')}</button>
        : !connected && <button type="button" className="mcp-primary-action" disabled={!status || Boolean(busy) || status.state === 'unavailable'} onClick={() => void action('login')}>{status?.state === 'reauth_required' ? (uiText(language)('openAiAccountPanel.signInToOpenaiAgain')) : (uiText(language)('openAiAccountPanel.signInToOpenai'))}</button>}
    </header>
    {!connected && <p className="openai-account-hint">{signingIn ? (uiText(language)('openAiAccountPanel.finishSigningInInYourBrowser')) : (uiText(language)('openAiAccountPanel.signInOnceToConnectYourApps'))}</p>}
    <details className="openai-account-options"><summary>{uiText(language)('openAiAccountPanel.accountSettings')}</summary><div className="plugin-mcp-actions">
      {connected && <button type="button" disabled={Boolean(busy)} onClick={() => void action('login')}>{uiText(language)('openAiAccountPanel.signInToOpenaiAgain')}</button>}
      <button type="button" disabled={Boolean(busy)} onClick={() => void action('manage_apps')}>{uiText(language)('accountsPanel.manageAppsInChatgpt')}</button>
      {connected && <button type="button" disabled={Boolean(busy)} onClick={() => void action('reconnect')}>{uiText(language)('accountsPanel.refreshAppConnections')}</button>}
      {status && status.state !== 'signed_out' && !signingIn && <button type="button" disabled={Boolean(busy)} onClick={() => void action('logout')}>{uiText(language)('openAiAccountPanel.signOutOfOpenai')}</button>}
    </div>
    <p>{uiText(language)('openAiAccountPanel.appAuthorizationRequiresSigningInToIts')}</p>
    <details><summary>{uiText(language)('openAiAccountPanel.aboutThisExperimentalConnection')}</summary><p>{uiText(language)('openAiAccountPanel.usesOauthRegistrationFromOpenaiSPublic')}</p></details></details>
    {(error || status?.lastError) && <div role="alert" className="plugin-mcp-error"><p>{uiText(language)('openAiAccountPanel.theAccountActionCouldNotBeCompleted')}</p><details><summary>{uiText(language)('messageBubble.errorDetails')}</summary><p>{error || status?.lastError}</p></details></div>}
  </section>;
}
