import { useContext, useEffect, useEffectEvent } from 'react';
import { fetchCardbushAppsConfiguration } from '../../backend/api';
import { uiText } from '../../i18n';
import { showUiError } from '../../shared/showUiError';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { applicationCatalog, applicationLink, type ApplicationEntry } from './appCenterModel';
import { OPEN_APPLICATION_EVENT, useAppCenterPreferences, type ApplicationRequest } from './appCenterStore';

export function ApplicationLauncher({ language, onNavigate }: {
  language: AppLanguage;
  onNavigate: (app: ApplicationEntry, environmentId?: string) => void;
}) {
  const host = useContext(ConversationHostContext);
  const prefs = useAppCenterPreferences();
  const current = useEffectEvent(() => ({ host, prefs, onNavigate }));
  useEffect(() => {
    let revision = 0;
    const t = uiText(language);
    const launch = async (event: Event) => {
      const { id, environmentId, reference } = (event as CustomEvent<ApplicationRequest>).detail ?? {};
      const request = ++revision;
      const state = current();
      try {
        let plugins = state.host?.plugins ?? [];
        const remotePlugin = environmentId && reference?.applicationKind === 'plugin';
        if (remotePlugin) {
          const api = window.cardbushDesktop?.agents;
          if (!api) throw Error(t('appCenter.remoteAppsAreUnavailable'));
          await api.connect(environmentId);
          const config = await api.call(environmentId, 'product.command', { kind: 'apps.get' }) as { plugins: CardbushAppPlugin[] };
          plugins = config.plugins;
        } else if (!state.host && !environmentId && typeof id === 'string' && id.startsWith('plugin:')) {
          plugins = (await fetchCardbushAppsConfiguration()).plugins;
        }
        if (request !== revision) return;
        const app = applicationCatalog(language, plugins, remotePlugin ? { links: [] } : current().prefs)
          .find(item => item.id === id && (!remotePlugin || item.kind === 'plugin'));
        if (!app) throw Error(t('appCenter.thisAppWasRemovedDisabledOrHas'));
        if (app.kind === 'local') {
          if (!window.cardbushDesktop?.localApplications) throw Error(t('appCenter.openLocalAppsFromTheDesktopApp'));
          await window.cardbushDesktop.localApplications.open(app.target, language);
          return;
        }
        const external = app.kind === 'external' ? app.target : app.launch?.kind === 'url' ? app.launch.url : undefined;
        if (external) {
          if (!applicationLink(external)) throw Error(t('appCenter.invalidAppUrl'));
          if (window.cardbushDesktop?.openExternal) await window.cardbushDesktop.openExternal(external);
          else window.open(external, '_blank', 'noopener,noreferrer');
        } else if (app.kind === 'plugin' && (!app.launch || environmentId)) {
          throw Error(t('appCenter.thisAppHasNoPageAvailableOn'));
        } else {
          current().onNavigate(app, app.kind === 'web' ? undefined : environmentId);
        }
      } catch (cause) {
        if (request === revision) void showUiError(t('app.actionFailed'), cause instanceof Error ? cause.message : String(cause));
      }
    };
    window.addEventListener(OPEN_APPLICATION_EVENT, launch);
    return () => { revision++; window.removeEventListener(OPEN_APPLICATION_EVENT, launch); };
  }, [language]);
  return null;
}
