import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { defaultBackendCapabilities, fetchBackendCapabilities, fetchModelConfigs, fetchSkills, saveModelConfigs, saveModelReasoning, type ChatStreamRequest } from '../../backend/api';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import { uiText } from '../../i18n';
import { useRuntimeStartupStatus } from '../../shared/useRuntimeStartupStatus';
import type { ManagedModelConfig, SkillSummary } from '../../types';
import { appearanceVariables, normalizeAppearance } from '../appearance/appearancePreferences';
import { readInitialThemePreference, resolveTheme, systemPrefersDark } from '../appearance/themePreferences';
import { themeClassNames } from '../appearance/themeRuntime';
import { useAppearanceRuntime } from '../appearance/useAppearanceRuntime';
import { readInitialAppSettings } from '../settings/appSettingsStore';
import { conversationAgentModel, readInitialPermissionMode, readInitialReferencePlanMode, readInitialSubagentPermissionRouting } from '../settings/agentRequestPreferences';
import { effectiveModels } from '../settings/modelPreferences';
import { readInitialLanguageMode, readSystemLanguage, resolveAppLanguage, readDisabledSkillNames, persistDisabledSkillNames, readVisualInputEnabled, persistVisualInputEnabled } from '../settings/localPreferences';
import { useTeamChoices } from '../team/teamWorkspaceStore';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { AssistantWindowView } from './AssistantWindowView';
import { useAssistantProfile } from './assistantProfile';
import { useAssistantModel } from './useAssistantModel';
import { OPEN_WORK_SUMMARY_INSPECTOR_EVENT, type WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import './assistantWindow.css';

/** Own only the Assistant's inputs. Sessions, work and event timers belong to Runtime. */
export function AssistantWindow() {
  const [settings] = useState(readInitialAppSettings);
  const [language] = useState(() => resolveAppLanguage(readInitialLanguageMode(), readSystemLanguage()));
  const [dark, setDark] = useState(systemPrefersDark);
  const theme = resolveTheme(readInitialThemePreference(), dark);
  const appearance = useMemo(() => normalizeAppearance(settings.appearance), [settings]);
  useAppearanceRuntime(appearance);
  const profile = useAssistantProfile();
  const startup = useRuntimeStartupStatus();
  const [models, setModels] = useState<ManagedModelConfig[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [capabilities, setCapabilities] = useState(defaultBackendCapabilities);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [disabledSkills, setDisabledSkills] = useState(readDisabledSkillNames);
  const [permission, setPermission] = useState(() => readInitialPermissionMode());
  const [routing, setRouting] = useState(() => readInitialSubagentPermissionRouting());
  const [plan, setPlan] = useState(() => readInitialReferencePlanMode());
  const [retainDraft, setRetainDraft] = useState(false);
  const [editingModels, setEditingModels] = useState(false);
  const [detail, setDetail] = useState<WorkSummaryInspectorDetail>();
  const [visualInput, setVisualInput] = useState(readVisualInputEnabled);
  const voice = applicationVoiceSession();
  const usingVoice = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode !== 'idle');
  const team = useTeamChoices(capabilities.teamMode);
  const model = useAssistantModel(models, defaultModel, async (id, effort) => {
    const saved = await saveModelReasoning(id, effort); setModels(effectiveModels(saved.models));
  }, language);

  useCapabilityCatalogRefresh(useCallback(async current => {
    if (startup.phase !== 'ready') return;
    await Promise.all([
      fetchModelConfigs().then(value => { if (current()) { setModels(effectiveModels(value.models)); setDefaultModel(value.defaultModelId); } }),
      fetchBackendCapabilities().then(value => { if (current()) setCapabilities(value); }),
      fetchSkills().then(value => { if (current()) setSkills(value); }),
    ]);
  }, [startup.phase]));
  const prepare = useCallback(async (): Promise<ChatStreamRequest> => {
    if (!model.selectedModel) throw Error(uiText(language)('useCardbushChat.configure_an_agent_model_first'));
    return { ...conversationAgentModel(models, model.selectedModel, PERSONAL_ASSISTANT_SESSION), uiLanguage: language,
      disabledSkills: [...disabledSkills], permissionMode: permission, subagentPermissionRouting: routing, referencePlanMode: plan,
      interactiveRequestsEnabled: capabilities.interactiveRequests, standardImageInputEnabled: capabilities.standardImageInputTool && visualInput,
      teamModeEnabled: capabilities.teamMode && Boolean(team.selectedId), teamId: team.selectedId, teamInstructions: team.instructions };
  }, [models, model.selectedModel, language, disabledSkills, permission, routing, plan, capabilities, visualInput, team.selectedId, team.instructions]);
  useLayoutEffect(() => {
    void window.cardbushDesktop?.retainAssistantWindow?.(retainDraft || usingVoice || editingModels || Boolean(detail));
  }, [retainDraft, usingVoice, editingModels, detail]);
  useEffect(() => {
    const open = (event: Event) => setDetail((event as CustomEvent<WorkSummaryInspectorDetail>).detail);
    window.addEventListener(OPEN_WORK_SUMMARY_INSPECTOR_EVENT, open);
    return () => window.removeEventListener(OPEN_WORK_SUMMARY_INSPECTOR_EVENT, open);
  }, []);
  useEffect(() => {
    const desktop = window.cardbushDesktop;
    void desktop?.setUiLanguage?.(language); void desktop?.rendererReady?.();
    void desktop?.setProxy?.(settings.proxy).catch(() => undefined);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [language, settings]);
  useEffect(() => { document.title = profile.name; }, [profile.name]);

  return <AssistantWindowView theme={themeClassNames(theme)} appearance={appearanceVariables(appearance, theme, settings.importedThemeStyle, settings.font.family)}
    events={{ prepare, language, configuration: prepare, enabled: Boolean(model.selectedModel) && startup.phase === 'ready' }}
    modelPanel={editingModels ? { language, models: { models, defaultModelId: defaultModel }, defaultSelection: true,
      onRefresh: async () => { const value = await fetchModelConfigs(); setModels(value.models); setDefaultModel(value.defaultModelId); },
      onSave: async config => { const value = await saveModelConfigs(config); setModels(value.models); setDefaultModel(value.defaultModelId); return value; },
      discoverModels: window.cardbushDesktop?.listProviderModels, visualInputAvailable: capabilities.standardImageInputTool, visualInputEnabled: visualInput,
      onVisualInputEnabledChange: value => { persistVisualInputEnabled(value); setVisualInput(value); },
    } : undefined} closeModels={() => setEditingModels(false)} detail={detail} closeDetail={() => setDetail(undefined)}
    assistant={{ active: true, language, prepare, subagentObservabilityAvailable: capabilities.subagentObservability,
      onManageHosts: () => void window.cardbushDesktop?.openAssistantWorkspace?.('team'),
      composerControls: { ...model, availableModels: models, onConfigureModels: () => setEditingModels(true),
          reasoningLevelAvailable: capabilities.reasoningLevelSelection, reasoningLevels: capabilities.reasoningLevels, skills, disabledSkillNames: disabledSkills,
          permissionMode: permission, onPermissionModeChange: value => { localStorage.setItem('cardbush.permission_mode', value); setPermission(value); },
          referencePlanMode: plan, onReferencePlanModeChange: value => { localStorage.setItem('cardbush.reference_plan_mode', value); localStorage.setItem('cardbush.reference_plan_mode_explicit', 'true'); setPlan(value); },
          subagentPermissionRouting: routing, onSubagentPermissionRoutingChange: value => { localStorage.setItem('cardbush.subagent_permission_routing', value); setRouting(value); },
          onRetainDraft: setRetainDraft, onToggleSkill: (name, enabled) => {
            const next = new Set(disabledSkills); if (enabled) next.delete(name); else next.add(name);
            persistDisabledSkillNames(next); setDisabledSkills(next);
          } } }} />;
}
