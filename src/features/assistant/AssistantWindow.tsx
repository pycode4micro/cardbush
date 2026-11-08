import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { defaultBackendCapabilities, fetchBackendCapabilities, fetchModelConfigs, type ChatStreamRequest } from '../../backend/api';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import { uiText } from '../../i18n';
import { useRuntimeStartupStatus } from '../../shared/useRuntimeStartupStatus';
import type { ManagedModelConfig } from '../../types';
import { APPEARANCE_STORAGE_KEY, appearanceVariables, normalizeAppearance } from '../appearance/appearancePreferences';
import { importedThemeStyleStorageKey, readInitialThemePreference, resolveTheme, systemPrefersDark } from '../appearance/themePreferences';
import { themeClassNames } from '../appearance/themeRuntime';
import { useAppearanceRuntime } from '../appearance/useAppearanceRuntime';
import { readInitialAppSettings } from '../settings/appSettingsStore';
import { conversationAgentModel, readInitialPermissionMode, readInitialReferencePlanMode, readInitialSubagentPermissionRouting } from '../settings/agentRequestPreferences';
import { effectiveModels } from '../settings/modelPreferences';
import { readInitialLanguageMode, readSystemLanguage, resolveAppLanguage, readDisabledSkillNames, readVisualInputEnabled } from '../settings/localPreferences';
import { useTeamChoices } from '../team/teamWorkspaceStore';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { AssistantWindowView } from './AssistantWindowView';
import { useAssistantModelSelection } from './useAssistantModel';
import './assistantWindow.css';

/** Own only the Assistant's inputs. Sessions, work and event timers belong to Runtime. */
export function AssistantWindow() {
  const [ownsConfiguration, setOwnsConfiguration] = useState(false);
  useEffect(() => {
    const desktop = window.cardbushDesktop;
    let current = true;
    const off = desktop?.onWorkspacePresence?.(present => { current = false; setOwnsConfiguration(!present); });
    void desktop?.assistantMode?.('read').then(mode => { if (current) setOwnsConfiguration(!mode.hasWorkspace); });
    return () => { current = false; off?.(); };
  }, []);
  const [settings, setSettings] = useState(readInitialAppSettings);
  const [language, setLanguage] = useState(() => resolveAppLanguage(readInitialLanguageMode(), readSystemLanguage()));
  const [themePreference, setThemePreference] = useState(readInitialThemePreference);
  useEffect(() => {
    const sync = ({key}: StorageEvent) => {
      if (!key || key === 'cardbush_language_mode') setLanguage(resolveAppLanguage(readInitialLanguageMode(), readSystemLanguage()));
      if (!key || key === 'cardbush_theme_mode') setThemePreference(readInitialThemePreference());
      if (!key || key === APPEARANCE_STORAGE_KEY || key === importedThemeStyleStorageKey) setSettings(readInitialAppSettings());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const [dark, setDark] = useState(systemPrefersDark);
  const theme = resolveTheme(themePreference, dark);
  const appearance = useMemo(() => normalizeAppearance(settings.appearance), [settings]);
  useAppearanceRuntime(appearance);
  const startup = useRuntimeStartupStatus();
  const [models, setModels] = useState<ManagedModelConfig[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [capabilities, setCapabilities] = useState(defaultBackendCapabilities);
  const [retainDraft, setRetainDraft] = useState(false);
  const voice = applicationVoiceSession();
  const usingVoice = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode !== 'idle');
  const team = useTeamChoices(capabilities.teamMode);
  const selectedModel = useAssistantModelSelection(models, defaultModel);

  useCapabilityCatalogRefresh(useCallback(async current => {
    await Promise.all([
      fetchModelConfigs().then(value => { if (current()) { setModels(effectiveModels(value.models)); setDefaultModel(value.defaultModelId); } }),
      fetchBackendCapabilities().then(value => { if (current()) setCapabilities(value); }),
    ]);
  }, []), { enabled: startup.phase === 'ready', initial: true });
  const prepare = useCallback(async (): Promise<ChatStreamRequest> => {
    if (!selectedModel) throw Error(uiText(language)('useCardbushChat.configure_an_agent_model_first'));
    return { ...conversationAgentModel(models, selectedModel, PERSONAL_ASSISTANT_SESSION), uiLanguage: language,
      disabledSkills: [...readDisabledSkillNames()], permissionMode: readInitialPermissionMode(), subagentPermissionRouting: readInitialSubagentPermissionRouting(), referencePlanMode: readInitialReferencePlanMode(),
      interactiveRequestsEnabled: capabilities.interactiveRequests, standardImageInputEnabled: capabilities.standardImageInputTool && readVisualInputEnabled(),
      teamModeEnabled: capabilities.teamMode && Boolean(team.selectedId), teamId: team.selectedId, teamInstructions: team.instructions };
  }, [models, selectedModel, language, capabilities, team.selectedId, team.instructions]);
  useLayoutEffect(() => {
    void window.cardbushDesktop?.retainAssistantWindow?.(retainDraft || usingVoice);
  }, [retainDraft, usingVoice]);
  useEffect(() => {
    const desktop = window.cardbushDesktop;
    if (!ownsConfiguration) return;
    void desktop?.setUiLanguage?.(language);
    void desktop?.setProxy?.(settings.proxy).catch(() => undefined);
  }, [language, settings.proxy, ownsConfiguration]);
  useEffect(() => {
    void window.cardbushDesktop?.rendererReady?.();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return <AssistantWindowView language={language} theme={themeClassNames(theme)}
    appearance={appearanceVariables(appearance, theme, settings.importedThemeStyle, settings.font.family)}
    prepare={prepare} retainDraft={setRetainDraft} ownsConfiguration={ownsConfiguration} enabled={Boolean(selectedModel) && startup.phase === 'ready'}/>;
}
