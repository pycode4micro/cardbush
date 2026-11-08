import type { MessageKey } from '../../i18n';
import { uiText, uiLanguages } from '../../i18n';
import type { SettingsSection } from '../../types';

export type VisibleSettingsSection = Exclude<SettingsSection, 'subagents' | 'instructions' | 'about' | 'projects'>;
type LocalizedText = MessageKey;

export const settingsLabels: Record<VisibleSettingsSection, LocalizedText> = {
  general: 'settingsNavigation.general',
  notifications: 'settingsNavigation.notifications',
  voice: 'settingsNavigation.voice',
  ssh: 'agentConnectionForm.sshConnections',
  profile: 'settingsNavigation.personalization',
  summary_for_user: 'settingsNavigation.memoryPredictions',
  appearance: 'settingsNavigation.appearance',
  shortcuts: 'settingsNavigation.keyboardShortcuts',
  usage: 'settingsNavigation.usage',
  models: 'settingsNavigation.models',
  mcp: 'appCenterModel.plugins',
  browser: 'settingsNavigation.browser',
  'computer-use': 'settingsNavigation.computerUse',
  runtime: 'settingsNavigation.runtime',
  proxy: 'pluginManagementPanel.networkProxy',
  cache: 'settingsNavigation.dataMaintenance',
  diagnostics: 'settingsNavigation.diagnosticsAbout',
};

export const settingsDescriptions: Record<VisibleSettingsSection, LocalizedText> = {
  general: 'settingsNavigation.setTheInterfaceLanguageAndEverydayConversation',
  notifications: 'settingsNavigation.manageAlertsForCompletedResponsesRequestsFor',
  voice: 'settingsNavigation.configureTranscriptionVoiceCallsAndTheAgent',
  ssh: 'settingsNavigation.manageRemoteHostsForProjectsAndReferences',
  profile: 'settingsNavigation.setTheResponseStyleAndSharedInstructions',
  summary_for_user: 'settingsNavigation.manageHabitsNextStepPredictionsAndMemory',
  appearance: 'settingsNavigation.adjustThemesColorsTypographyAndDisplayEffects',
  shortcuts: 'settingsNavigation.viewAndCustomizeKeyboardShortcuts',
  usage: 'settingsNavigation.reviewRecordedTokenUsageAndActivity',
  models: 'settingsNavigation.manageModelServicesInputCapabilitiesAndContext',
  mcp: 'settingsNavigation.managePluginsSkillsAndAppConnections',
  browser: 'settingsNavigation.configureTheStartPageAndBrowserUse',
  'computer-use': 'settingsNavigation.manageDesktopControlScreenshotsAndUserInput',
  runtime: 'settingsNavigation.checkAndInstallTheSandboxManageCommand',
  proxy: 'settingsNavigation.manageConnectionsForModelsThePluginMarketplace',
  cache: 'settingsNavigation.restoreArchivedItemsAndManageDataLogs',
  diagnostics: 'settingsNavigation.checkRuntimeHealthVersionAndEnvironmentInformation',
};

export type SettingsCategoryId = 'preferences' | 'personal' | 'connections' | 'tools' | 'data';
export type SettingsPage = 'overview' | SettingsCategoryId | SettingsSection;
export type SettingsCategory = {
  id: SettingsCategoryId; label: MessageKey; description: MessageKey; sections: VisibleSettingsSection[];
};
export const settingsNavigationGroups: SettingsCategory[] = [
  { id: 'preferences', label: 'settingsNavigation.general', description: 'settingsDirectory.generalDescription',
    sections: ['general', 'notifications', 'voice', 'shortcuts'] },
  { id: 'personal', label: 'settingsNavigation.personalization', description: 'settingsDirectory.personalDescription',
    sections: ['appearance', 'profile', 'summary_for_user'] },
  { id: 'connections', label: 'settingsDirectory.connections', description: 'settingsDirectory.connectionsDescription',
    sections: ['models', 'mcp', 'ssh', 'proxy'] },
  { id: 'tools', label: 'settingsDirectory.tools', description: 'settingsDirectory.toolsDescription',
    sections: ['browser', 'computer-use', 'runtime'] },
  { id: 'data', label: 'settingsDirectory.data', description: 'settingsDirectory.dataDescription',
    sections: ['usage', 'cache', 'diagnostics'] },
];

export function settingsDestination(page: SettingsPage) {
  if (page === 'overview') return {};
  const category = settingsNavigationGroups.find(group => group.id === page);
  if (category) return { category };
  const section = visibleSettingsSection(page as SettingsSection);
  return { section, category: settingsNavigationGroups.find(group => group.sections.includes(section)) };
}

const keywords: Record<VisibleSettingsSection, MessageKey> = {
  general: 'settingsKeywords.english_general_language_interaction_guidance_queue_thinking',
  notifications: 'settingsKeywords.notification_sound_volume_alerts_response_approval_error',
  voice: 'settingsKeywords.voice_audio_speech_microphone_transcription_call_tts',
  summary_for_user: 'settingsKeywords.token_summary_for_user_check_habit_memory',
  ssh: 'settingsKeywords.ssh_remote_connection_server_key_project',
  profile: 'settingsKeywords.agents_md_instructions_tone_persona_style_natural',
  appearance: 'settingsKeywords.theme_font_size_color_background_foreground_accent',
  shortcuts: 'settingsKeywords.ctrl_enter_keyboard_shortcuts_hotkeys_guidance_queue',
  usage: 'settingsKeywords.token_usage_activity',
  models: 'settingsKeywords.api_key_provider_context_vision',
  mcp: 'settingsKeywords.chrome_mcp_skills_marketplace_accounts_oauth_search',
  browser: 'settingsKeywords.browser_use_chrome_edge_google_browser_home',
  'computer-use': 'settingsKeywords.computer_desktop_screenshot_pointer',
  runtime: 'settingsKeywords.powershell_wsl_bash_sandbox_install_permissions_terminal',
  proxy: 'settingsKeywords.mcp_http_https_socks_no_proxy_proxy',
  cache: 'settingsKeywords.archive_archived_chats_projects_cache_history_logs',
  diagnostics: 'settingsKeywords.runtime_product_host_version_about_health',
};

export function settingsSectionLabel(section: VisibleSettingsSection): MessageKey {
  if (section === 'general') return 'settingsDirectory.interaction';
  if (section === 'profile') return 'settingsDirectory.style';
  return settingsLabels[section];
}

export function settingsSectionMatchesQuery(section: VisibleSettingsSection, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = uiLanguages.flatMap(locale => [uiText(locale.locale)(settingsSectionLabel(section)), uiText(locale.locale)(settingsLabels[section]), uiText(locale.locale)(settingsDescriptions[section]), uiText(locale.locale)(keywords[section])]).join(' ').toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}

export function visibleSettingsSection(value: SettingsSection): VisibleSettingsSection {
  if (value === 'projects') return 'models';
  if (value === 'about') return 'diagnostics';
  if (value === 'instructions' || value === 'subagents') return 'profile';
  return value;
}
