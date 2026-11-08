import type { AppSection, SettingsSection } from '../../types';
export type HomePage = { kind: 'overview' | 'events' | 'projects' | 'recent' } |
  { kind: 'project' | 'component'; id: string } | { kind: 'event'; id: string; page?: string };

export type AppPage =
  | { section: 'home'; page: HomePage }
  | { section: 'chat'; conversationId: string }
  | { section: 'settings'; agentId: string; settingsSection: SettingsSection; pluginTab: 'plugins' | 'skills' }
  | { section: Exclude<AppSection, 'chat' | 'home'> };
