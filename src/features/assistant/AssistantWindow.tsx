import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { defaultBackendCapabilities, fetchBackendCapabilities, fetchModelConfigs, type ChatStreamRequest } from '../../backend/api';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import { uiText } from '../../i18n';
import { useRuntimeStartupStatus } from '../../shared/useRuntimeStartupStatus';
import type { ManagedModelConfig } from '../../types';
import { appearanceVariables, normalizeAppearance } from '../appearance/appearancePreferences';
import { readInitialThemePreference, resolveTheme, systemPrefersDark } from '../appearance/themePreferences';
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
  const [settings] = useState(readInitialAppSettings);
  const [language] = useState(() => resolveAppLanguage(readInitialLanguageMode(), readSystemLanguage()));
  const [dark, setDark] = useState(systemPrefersDark);
  const theme = resolveTheme(readInitialThemePreference(), dark);
  const appearance = useMemo(() => normalizeAppearance(settings.appearance), [settings]);
  useAppearanceRuntime(appearance);
  const startup = useRuntimeStartupStatus();
  const [models, setModels] = useState<ManagedModelConfig[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [capabilities, setCapabilities] = useState(defaultBackendCapabilities);
  const [disabledSkills] = useState(readDisabledSkillNames);
  const [permission] = useState(() => readInitialPermissionMode());
  const [routing] = useState(() => readInitialSubagentPermissionRouting());
  const [plan] = useState(() => readInitialReferencePlanMode());
  const [retainDraft, setRetainDraft] = useState(false);
  const [visualInput] = useState(readVisualInputEnabled);
  const voice = applicationVoiceSession();
  const usingVoice = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode !== 'idle');
  const team = useTeamChoices(capabilities.teamMode);
  const selectedModel = useAssistantModelSelection(models, defaultModel);

  useCapabilityCatalogRefresh(useCallback(async current => {
    if (startup.phase !== 'ready') return;
    await Promise.all([
      fetchModelConfigs().then(value => { if (current()) { setModels(effectiveModels(value.models)); setDefaultModel(value.defaultModelId); } }),
      fetchBackendCapabilities().then(value => { if (current()) setCapabilities(value); }),
    ]);
  }, [startup.phase]));
  const prepare = useCallback(async (): Promise<ChatStreamRequest> => {
    if (!selectedModel) throw Error(uiText(language)('useCardbushChat.configure_an_agent_model_first'));
    return { ...conversationAgentModel(models, selectedModel, PERSONAL_ASSISTANT_SESSION), uiLanguage: language,
      disabledSkills: [...disabledSkills], permissionMode: permission, subagentPermissionRouting: routing, referencePlanMode: plan,
      interactiveRequestsEnabled: capabilities.interactiveRequests, standardImageInputEnabled: capabilities.standardImageInputTool && visualInput,
      teamModeEnabled: capabilities.teamMode && Boolean(team.selectedId), teamId: team.selectedId, teamInstructions: team.instructions };
  }, [models, selectedModel, language, disabledSkills, permission, routing, plan, capabilities, visualInput, team.selectedId, team.instructions]);
  useLayoutEffect(() => {
    void window.cardbushDesktop?.retainAssistantWindow?.(retainDraft || usingVoice);
  }, [retainDraft, usingVoice]);
  useEffect(() => {
    const desktop = window.cardbushDesktop;
    void desktop?.setUiLanguage?.(language); void desktop?.rendererReady?.();
    void desktop?.setProxy?.(settings.proxy).catch(() => undefined);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [language, settings]);
  return <AssistantWindowView language={language} theme={themeClassNames(theme)}
    appearance={appearanceVariables(appearance, theme, settings.importedThemeStyle, settings.font.family)}
    prepare={prepare} retainDraft={setRetainDraft} enabled={Boolean(selectedModel) && startup.phase === 'ready'}/>;
}
