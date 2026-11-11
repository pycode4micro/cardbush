import type { FriendsWorkEvent } from '@cardbush/bush-protocol';
import { confirmAction } from '../../../components/confirmAction';
import { uiText } from '../../../i18n';

export const eventActionLabels = {
  pause: 'yourFriends.pauseExecution', resume: 'yourFriends.resumeExecution',
  archive: 'yourFriends.archive', restore: 'yourFriends.restore', delete: 'assistant.events.delete',
  run: 'automationPanel.runNow', stop: 'automationPanel.stop',
} as const;
export type EventAction = keyof typeof eventActionLabels;

export function confirmEventDeletion(event: FriendsWorkEvent, language: string) {
  const t = uiText(language);
  return confirmAction({ title: t('assistant.events.delete'), message: t('assistant.events.confirmDelete', { title: event.title }),
    confirmLabel: t('assistant.events.delete'), cancelLabel: t('agentConnectionForm.cancel') });
}
