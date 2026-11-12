import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { type PersonalProfile } from '@cardbush/bush-protocol';
import type { ChatStreamRequest } from '../../backend/api';
import { readPersonalProfile } from '../../backend/personalization';
import { uiText } from '../../i18n';
import { AssistantSettingsDialog } from '../assistant/AssistantSettingsDialog';
import { useAssistantProfile } from '../assistant/assistantProfile';
import { AssistantEventsDialog } from '../assistant/events/AssistantEventsDialog';
import { QuickWebhookDialog } from '../webhooks/QuickWebhookDialog';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';
import { ProfileMenuContext, type ProfileAction } from './ProfileMenu';
import { previousUserName } from '../settings/appSettingsStore';
import { ProfileEditor } from './ProfileEditor';

type Props = {
  language: string; ready: boolean; prepare(): Promise<ChatStreamRequest>;
  settings(): void | Promise<void>; onDialogChange?(open: boolean): void; children: ReactNode;
};
export function ProfileCenter({ language, ready, prepare, settings, onDialogChange, children }: Props) {
  const t = uiText(language), assistant = useAssistantProfile();
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [dialog, show] = useState<ProfileAction>();
  const [startup, setStartup] = useState<boolean>(), [error, setError] = useState<'profile.loadFailed'|'profile.modeFailed'>();
  const version = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const revision = ++version.current;
    void readPersonalProfile().then(value => { if (version.current === revision) setProfile(value); }).catch(() => {});
    return () => { version.current++; };
  }, [ready]);
  useEffect(() => {
    onDialogChange?.(Boolean(dialog));
    return () => { onDialogChange?.(false); };
  }, [dialog, onDialogChange]);
  const desktop = window.cardbushDesktop;
  const [floating, setFloating] = useState<boolean>();
  const floatingRevision = useRef(0);
  const refreshMode = useCallback(() => {
    const revision = ++floatingRevision.current;
    void desktop?.assistantMode?.('read').then(value => {
      setStartup(value.nextLaunch);
      if (revision === floatingRevision.current) setFloating(value.floating);
    }).catch(() => {});
  }, [desktop]);
  useEffect(() => {
    const off = desktop?.onAssistantFloatingChanged?.(value => { ++floatingRevision.current; setFloating(value); });
    refreshMode();
    return () => { ++floatingRevision.current; off?.(); };
  }, [desktop, refreshMode]);
  const select = async (action: ProfileAction) => {
    try {
      if (action === 'edit') {
        const revision = ++version.current, value = await readPersonalProfile();
        if (version.current !== revision) return;
        setProfile(value);
      }
      if (action === 'float') {
        if (floating !== undefined) await desktop?.assistantMode?.('float', !floating);
        return;
      }
      if (action === 'settings') { await settings(); return; }
      if (action === 'startup') {
        if (startup !== undefined) setStartup((await desktop!.assistantMode!('startup', !startup)).nextLaunch);
        return;
      }
      show(action);
    } catch { setError(action === 'edit' ? 'profile.loadFailed' : 'profile.modeFailed'); }
  };
  const close = () => show(undefined);
  return <ProfileMenuContext.Provider value={{name:profile?.preferredName ?? '', avatar:profile?.avatar, startup, floating, open:refreshMode, select,
    webhookAvailable:Boolean(desktop?.webhooks)}}>
    {children}
    {dialog === 'edit' && <ProfileEditor language={language} initial={profile} suggestion={assistant.proactive?.recognition.address || previousUserName()}
      close={close} saved={value => { version.current++; setProfile(value); }}/>}
    {dialog === 'events' && <AssistantEventsDialog language={language} close={close}/>}
    {dialog === 'assistant' && <AssistantSettingsDialog language={language} onClose={close}/>}
    {dialog === 'webhook' && <QuickWebhookDialog language={language} title={assistant.name} prepare={prepare} onClose={close}/>}
    {error && <SettingsFormDialog language={language} title={t('profile.title')} onCancel={()=>setError(undefined)} onSubmit={()=>setError(undefined)}
      footer={<button type="submit">{t('common.close')}</button>}><p role="alert">{t(error)}</p></SettingsFormDialog>}
  </ProfileMenuContext.Provider>;
}
