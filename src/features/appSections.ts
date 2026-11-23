import type { MessageKey } from '../i18n';
import type { AppSection } from '../types';

export const sectionLabels: Record<AppSection, MessageKey> = {
  home: 'desktop.home',
  assistant: 'appSections.assistant',
  components: 'appCenterModel.components',
  chat: 'appSections.chat',
  plugins: 'appCenterModel.plugins',
  team: 'appCenterModel.workflows',
  'md-presentation': 'appCenterModel.create',
};
