import type { AppSection, SettingsSection } from '../../types';

export type AppPage =
  | { section: 'chat'; conversationId: string }
  | { section: 'agents'; agentId: string; sessionId: string; view: 'chat' | 'settings' }
  | { section: 'settings'; agentId: string; settingsSection: SettingsSection; pluginTab: 'plugins' | 'skills' }
  | { section: Exclude<AppSection, 'chat' | 'agents'> };
