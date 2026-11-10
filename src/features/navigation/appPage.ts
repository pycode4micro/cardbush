import type { AppSection } from '../../types';
import type { SettingsPage } from '../settings/settingsNavigation';
export type HomePage = { kind: 'overview' | 'events' | 'projects' | 'recent' } |
  { kind: 'project' | 'component'; id: string } | { kind: 'event'; id: string; page?: string };

// A workspace is a window destination. Its host identifies the conversation
// that owns its tabs, never the visibility or geometry of a side panel.
export type TabWorkspaceHost = 'chat' | 'assistant' | 'md-presentation' | 'team';
export type WorkspaceDestination = AppSection | { section: 'tabs'; host: TabWorkspaceHost };
export function tabWorkspaceDestination(from: AppSection): Exclude<WorkspaceDestination, AppSection> {
  return { section: 'tabs', host: from === 'assistant' || from === 'md-presentation' || from === 'team' ? from : 'chat' };
}
/** Library pages can browse the conversation's tabs without inheriting its open split. */
export function splitPage(section: AppSection) {
  return section === tabWorkspaceDestination(section).host ? undefined : section;
}

export type AppPage =
  | { section: 'tabs'; host: TabWorkspaceHost; conversationId?: string }
  | { section: 'home'; page: HomePage }
  | { section: 'chat'; conversationId: string }
  | { section: 'settings'; agentId: string; settingsSection: SettingsPage; pluginTab: 'plugins' | 'skills' }
  | { section: Exclude<AppSection, 'chat' | 'home'> };
