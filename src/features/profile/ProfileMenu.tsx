import { createContext, useContext, useId, useRef } from 'react';
import { CalendarClock, ChevronUp, Monitor, PanelTop, Settings, Settings2, UserRound, Webhook } from 'lucide-react';
import { uiText } from '../../i18n';
import './profileMenu.css';

export type ProfileAction = 'edit' | 'webhook' | 'events' | 'assistant' | 'settings' | 'float' | 'startup';
export const ProfileMenuContext = createContext<{
  name: string; avatar?: string; startup?: boolean; floating?: boolean; webhookAvailable: boolean;
  open(): void; select(action: ProfileAction): void;
} | null>(null);

export function ProfileMenu({ language, compact = false }: { language: string; compact?: boolean }) {
  const model = useContext(ProfileMenuContext), t = uiText(language), id = useId();
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const name = model?.name || t('profile.title');
  const select = (action: ProfileAction) => {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
    model?.select(action);
  };
  return <div className="profile-menu" data-compact={compact || undefined}>
    <button type="button" className="profile-trigger" ref={trigger} popoverTarget={id} aria-label={t('profile.title')} title={t('profile.title')}>
      <span className="profile-symbol">{model?.avatar ? <img src={model.avatar} alt=""/> : <UserRound/>}</span>{!compact && <><span>{name}</span><ChevronUp/></>}
    </button>
    <div className="profile-popover" id={id} popover="auto" ref={panel} aria-label={t('profile.title')}
      onToggle={event => { if (event.newState === 'open') model?.open(); }}>
      <header><button type="button" data-profile-action="edit" onClick={() => select('edit')} aria-label={t('profile.edit')}>
        <span className="profile-avatar">{model?.avatar ? <img src={model.avatar} alt=""/> : <UserRound/>}</span><strong>{name}</strong><small>{t('profile.edit')}</small>
      </button><button type="button" className="profile-settings" aria-label={t('common.settings')} title={t('common.settings')} data-profile-action="settings" onClick={() => select('settings')}><Settings/></button></header>
      <div className="profile-menu-group">
        <button type="button" data-profile-action="webhook" onClick={() => select('webhook')} disabled={!model?.webhookAvailable} title={!model?.webhookAvailable ? t('webhook.unavailable') : undefined}><Webhook/>{t('profile.webhook')}</button>
        <button type="button" data-profile-action="events" onClick={() => select('events')}><CalendarClock/>{t('assistant.events.title')}</button>
        <button type="button" data-profile-action="assistant" onClick={() => select('assistant')}><Settings2/>{t('assistantSettingsDialog.assistantSettings')}</button>
      </div>
      <div className="profile-menu-group">
        <button type="button" disabled={model?.floating === undefined} role="switch" aria-checked={model?.floating ?? false} data-profile-action="float" onClick={() => select('float')}>
          <PanelTop/>{t('capsule.label')}<span className="profile-switch" aria-hidden="true"/>
        </button>
        <button type="button" disabled={model?.startup === undefined} title={t('resident.nextLaunch')} role="switch" aria-checked={model?.startup ?? false} data-profile-action="startup" onClick={() => select('startup')}>
          <Monitor/>{t('profile.startInTray')}<span className="profile-switch" aria-hidden="true"/>
        </button>
      </div>
    </div>
  </div>;
}
