import type { MessageKey } from '../i18n';
import type { AppSection } from '../types';

export const sectionLabels: Record<AppSection, MessageKey> = {
  assistant: 'appSections.assistant',
  components: 'appCenterModel.components',
  chat: 'appSections.chat',
  plugins: 'appCenterModel.plugins',
  automations: 'appCenterModel.automations',
  skills: 'composer.skills',
  subagents: 'appSections.subagents',
  team: 'appCenterModel.workflows',
  'md-presentation': 'appCenterModel.create',
};
