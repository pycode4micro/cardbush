import { useEffect, useState } from 'react';
import type { AssistantEventPreferences } from '@cardbush/bush-protocol';
import { uiText } from '../../../i18n';
import { eventBackend } from './eventBackend';
const fields = { context: 'yourFriends.reviewContext', judgment: 'yourFriends.reviewJudgment',
  communication: 'yourFriends.reviewCommunication', boundaries: 'yourFriends.reviewBoundaries', appearance: 'yourFriends.reviewAppearance' } as const;

export function EventPreferenceFields({ language, value, change }: { language: string; value: AssistantEventPreferences; change(value: AssistantEventPreferences): void }) {
  const t = uiText(language);
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof eventBackend.targets>>>([]);
  useEffect(() => { let mounted = true; void eventBackend.targets().then(items => { if (mounted) setTargets(items); }).catch(() => {}); return () => { mounted = false; }; }, []);
  return <details className="assistant-event-preferences"><summary>{t('assistant.events.preferences')}</summary>
    <label><input type="checkbox" checked={Boolean(value.confirmedAt)} onChange={e => change({ ...value, confirmedAt: e.target.checked ? new Date().toISOString() : undefined })}/>{t('assistant.events.initiative')}</label>
    {Object.entries(fields).map(([key, label]) => <label key={key}>{t(label)}<textarea rows={2} maxLength={8000} value={value.recognition[key] ?? ''}
      onChange={e => change({ ...value, recognition: { ...value.recognition, [key]: e.target.value } })}/></label>)}
    <label>{t('yourFriends.beforeLabel')}<select value={value.beforeExecution} onChange={e => change({ ...value, beforeExecution: e.target.value as typeof value.beforeExecution })}>
      <option value="ask">{t('yourFriends.askFirst')}</option><option value="within-scope">{t('yourFriends.withinScope')}</option></select></label>
    <label>{t('yourFriends.reportLabel')}<select value={value.report} onChange={e => change({ ...value, report: e.target.value as typeof value.report })}>
      <option value="important">{t('yourFriends.reportImportant')}</option><option value="always">{t('yourFriends.reportAlways')}</option></select></label>
    <label>{t('assistant.events.destination')}<select value={value.notificationSourceRef ?? ''} onChange={e => change({ ...value, notificationSourceRef: e.target.value || undefined })}>
      <option value="">{t('assistant.events.source')}</option>
      {value.notificationSourceRef && !targets.some(target => target.sourceRef === value.notificationSourceRef) && <option value={value.notificationSourceRef}>{t('assistant.events.savedDestination')}</option>}
      {targets.map(target => <option key={target.sourceRef} value={target.sourceRef}>{t('assistant.events.target', { bot: target.botName, conversation: target.conversationId, sender: target.senderId })}</option>)}
    </select></label>
  </details>;
}
