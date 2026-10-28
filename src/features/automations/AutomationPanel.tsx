import { uiText } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Plus, RefreshCw, Play, Pause, Square, Pencil, Trash2, MessageSquare, Check, Mail, ChevronRight, Search } from 'lucide-react';
import { isAutomationResult } from '@cardbush/bush-protocol';
import { openAutomationRun } from './automationEvents';
import type { AutomationCommand, AutomationDefinition, AutomationJob, AutomationOverview, AutomationRun } from '@cardbush/bush-protocol';
import { usePageState } from '../navigation/PageNavigation';
import { AutomationPlanCard } from './AutomationPlanCard';
import './automations.css';

const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const errorText = (caught: unknown, uiLanguage: string) => {
  const text = String(caught).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': Error: /, '');

  return ({
    'Automation changed. Refresh before saving.': uiText(uiLanguage)('automationErrors.automation_changed_refresh_before_saving'),
    'Send a message in the target conversation before scheduling it.': uiText(uiLanguage)('automationErrors.send_a_message_in_the_target_conversation'),
    'Stop the queued or running automation before editing it.': uiText(uiLanguage)('automationErrors.stop_the_queued_or_running_automation_before'),
    'Stop the running automation before deleting it.': uiText(uiLanguage)('automationErrors.stop_the_running_automation_before_deleting_it'),
    'This automation is already queued or running.': uiText(uiLanguage)('automationErrors.this_automation_is_already_queued_or_running'),
    'The target conversation was removed.': uiText(uiLanguage)('automationErrors.the_target_conversation_was_removed'),
    'No conversation execution context is available.': uiText(uiLanguage)('automationErrors.no_conversation_execution_context_is_available'),
    'The originating plugin hook is disabled, changed, or no longer trusted.': uiText(uiLanguage)('automationErrors.the_originating_plugin_hook_is_disabled_changed'),
    'Runtime stopped before completion was recorded. Check the conversation before running again.': uiText(uiLanguage)('automationErrors.runtime_stopped_before_completion_was_recorded_check'),
    'The automation model was removed. Send a message in the target conversation with an available model.': uiText(uiLanguage)('automationErrors.the_automation_model_was_removed_send_a'),
  } as Record<string, string>)[text] ?? text;
};
export function AutomationPanel({ language, onOpenConversation, onCreateAutomation }: {
  language: string;
  onOpenConversation: (id: string) => void;
  onCreateAutomation: () => void;
}) {
  const uiLanguage = language;
  const [overview, setOverview] = useState<AutomationOverview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('');
  const [savedView, setView] = usePageState<'calendar' | 'unread' | 'today' | 'all' | 'plans'>('automation-view', 'plans');
  const view = savedView === 'calendar' ? 'plans' : savedView;
  const [form, setForm] = useState<{ id: string; revision: number; name: string; prompt: string; sessionId: string; executionMode: 'isolated' | 'conversation'; kind: 'once' | 'interval' | 'event'; at: string; minutes: number; event: 'Stop' | 'PostToolUse' | 'PostToolUseFailure'; tool: string; cooldown: number; timeZone: string }>();
  const generation = useRef(0), mutation = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    try {
      if (!window.cardbushDesktop?.automationCommand) throw new Error(uiText(language)('automationPanel.restartCardbushToLoadTheAutomationService'));
      const result = await window.cardbushDesktop.automationCommand({ action: 'list' }) as AutomationOverview;
      if (revision === generation.current) { setOverview(result); setError(''); }
    } catch (caught) { if (revision === generation.current) setError(errorText(caught, uiLanguage)); }
  }, [uiLanguage]);
  useEffect(() => {
    let timer = 0;
    const update = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 120); };
    void refresh();
    const unsubscribe = window.cardbushDesktop?.onAutomationChanged?.(update);
    window.addEventListener('focus', update);
    return () => { generation.current++; window.clearTimeout(timer); unsubscribe?.(); window.removeEventListener('focus', update); };
  }, [refresh]);
  const operate = async (command: AutomationCommand, key: string) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(key); setError('');
    try {
      await window.cardbushDesktop!.automationCommand(command);
      if (command.action === 'update') setForm(undefined);
      await refresh();
    } catch (caught) { setError(errorText(caught, uiLanguage)); }
    finally { mutation.current = false; setBusy(''); }
  };
  const edit = (job: AutomationJob) => {
    setError('');
    setForm({ id: job.id, revision: job.revision, name: job.name, prompt: job.prompt, sessionId: job.sessionId,
      executionMode: job.executionMode ?? 'conversation',
      kind: job.trigger.kind, at: localInput(job.trigger.kind !== 'event' ? job.trigger.at : new Date(Date.now() + 3600000).toISOString()),
      minutes: job.trigger.kind === 'interval' ? job.trigger.seconds / 60 : 60,
      event: job.trigger.kind === 'event' ? job.trigger.event : 'Stop', tool: job.trigger.kind === 'event' ? job.trigger.tool : '',
      cooldown: job.trigger.kind === 'event' ? job.trigger.cooldownSeconds : 60, timeZone: job.timeZone });
  };
  const save = () => {
    if (!form) return;
    try {
      const trigger: AutomationDefinition['trigger'] = form.kind === 'event' ? { kind: 'event', event: form.event, tool: form.tool.trim(), cooldownSeconds: form.cooldown }
        : form.kind === 'interval' ? { kind: 'interval', at: new Date(form.at).toISOString(), seconds: form.minutes * 60 } : { kind: 'once', at: new Date(form.at).toISOString() };
      void operate({ action: 'update', id: form.id, expectedRevision: form.revision,
        definition: { name: form.name, sessionId: form.sessionId, prompt: form.prompt, trigger, executionMode: form.kind === 'event' ? form.executionMode : 'isolated', timeZone: form.timeZone } }, 'form');
    } catch { setError(uiText(language)('automationPanel.enterAValidExecutionTime')); }
  };
  const runLabels: Record<AutomationRun['status'], string> = ({ queued: uiText(language)('automationPanel.queued'), running: uiText(language)('automationPanel.running'), completed: uiText(language)('automationPanel.completed'), failed: uiText(language)('automationPanel.failed'), stopped: uiText(language)('automationPanel.stopped'), interrupted: uiText(language)('automationPanel.interrupted'), awaiting_user_action: uiText(language)('automationPanel.needsAttention') });
  const eventLabel = (event: string) => ({ Stop: uiText(language)('automation.event.Stop'), PostToolUse: uiText(language)('automation.event.PostToolUse'), PostToolUseFailure: uiText(language)('automation.event.PostToolUseFailure') }[event] ?? event);
  const time = (value?: string) => value ? new Date(value).toLocaleString(language) : '—';
  const jobs = overview?.jobs.filter(job => `${job.name} ${job.prompt}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const unreadCount = overview?.jobs.reduce((count, job) => count + job.runs.filter(run => isAutomationResult(run) && !run.readAt).length, 0) ?? 0;
  const entries = jobs.flatMap(job => job.runs.map(run => ({ job, run })))
    .filter(({ run }) => view === 'all' || (view === 'unread' && !run.readAt) || (view === 'today' && new Date(run.finishedAt ?? run.queuedAt).toDateString() === new Date().toDateString()))
    .sort((a, b) => (b.run.finishedAt ?? b.run.queuedAt).localeCompare(a.run.finishedAt ?? a.run.queuedAt));
  const unreadIds = entries.filter(({ run }) => isAutomationResult(run) && !run.readAt).map(({ run }) => run.id).slice(0, 500);
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const date = new Date(entry.run.finishedAt ?? entry.run.queuedAt).toLocaleDateString(language, { month: 'long', day: 'numeric', weekday: 'short', year: 'numeric' });
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  const triggerLabel = (job: AutomationJob) => job.trigger.kind === 'event' ? `${eventLabel(job.trigger.event)}${job.trigger.tool ? ` · ${job.trigger.tool}` : ''}`
    : job.trigger.kind === 'interval' ? (uiText(language)('automationPanel.everyMinutes', { value1: job.trigger.seconds / 60 })) : (uiText(language)('automationPanel.oneTime'));
  const renderPlan = (job: AutomationJob) => {
    const latest = job.runs.at(-1), active = latest?.status === 'running' || latest?.status === 'queued';
    const state = active ? latest.status : job.state;
    const label = active ? runLabels[latest.status] : job.state === 'active' ? (uiText(language)('automationPanel.active')) : job.state === 'paused' ? (uiText(language)('automationPanel.paused')) : (uiText(language)('automationPanel.completed'));
    const runs = job.runs;
    const hint = `${triggerLabel(job)}${job.state === 'active' && job.nextRunAt ? ` · ${time(job.nextRunAt)}` : ''}`;
    const action = (action: AutomationCommand['action']) => void operate({ action, id: job.id, expectedRevision: job.revision }, job.id);
    return <AutomationPlanCard key={job.id} job={job} label={label} state={state} hint={hint}>
      <p className="automation-prompt">{job.prompt}</p>
      <p className="automation-hint">{triggerLabel(job)}{job.state === 'active' && job.nextRunAt && ` · ${uiText(language)('automationPanel.next')}${time(job.nextRunAt)}`}{job.plugin && ` · ${uiText(language)('automationPanel.plugin')}${job.plugin.id}`}</p>
      <div className="automation-actions"><button type="button" disabled={!overview?.sessions.some(session => session.id === job.sessionId)} onClick={() => onOpenConversation(job.sessionId)}><MessageSquare size={14}/>{overview?.sessions.some(session => session.id === job.sessionId) ? (uiText(language)('automationPanel.sourceConversation')) : (uiText(language)('automationPanel.sourceDeleted'))}</button>
        <button type="button" disabled={Boolean(busy) || active} onClick={() => edit(job)}><Pencil size={14}/>{uiText(language)('common.edit')}</button>
        <button type="button" disabled={Boolean(busy) || active} onClick={() => action('run')}><Play size={14}/>{uiText(language)('automationPanel.runNow')}</button>
        {active ? <button type="button" disabled={Boolean(busy)} onClick={() => action('stop')}><Square size={14}/>{uiText(language)('automationPanel.stop')}</button>
          : <button type="button" disabled={Boolean(busy)} onClick={() => action(job.state === 'active' ? 'pause' : 'resume')}><Pause size={14}/>{job.state === 'active' ? (uiText(language)('automationPanel.pause')) : (uiText(language)('automationPanel.enable'))}</button>}
        <button type="button" disabled={Boolean(busy) || latest?.status === 'running'} onClick={() => action('delete')}><Trash2 size={14}/>{uiText(language)('appCenter.delete')}</button></div>
      {runs.length > 0 && <details><summary>{uiText(language)('automationPanel.history', { value1: runLabels[runs.at(-1)!.status] })}</summary><ol>{[...runs].reverse().map(run => <li key={run.id}>
        <button className="automation-history-open" type="button" onClick={() => openAutomationRun(job.id, run.id, job.name)}><strong>{runLabels[run.status]}</strong> · {time(run.queuedAt)}{!run.readAt && isAutomationResult(run) && ` · ${uiText(language)('automationPanel.unread')}`}<ChevronRight size={14}/></button>{run.error && <p className="automation-error">{errorText(run.error, uiLanguage)}</p>}
      </li>)}</ol></details>}
    </AutomationPlanCard>;
  };
  return <div className="feature-content automation-panel">
    <header className="automation-heading">
      <nav className="automation-tabs" aria-label={uiText(language)('automationPanel.automationViews')}>
        {(['plans', 'unread', 'today', 'all'] as const).map(tab => <button type="button" key={tab} aria-pressed={view === tab} onClick={() => { setView(tab); setForm(undefined); }}>
          {{ unread: uiText(language)('automationPanel.unread'), today: uiText(language)('automationPanel.today'), all: uiText(language)('automationPanel.allResults'), plans: uiText(language)('automationPanel.plans') }[tab]}{tab === 'unread' && <span>{unreadCount}</span>}
        </button>)}
      </nav>
    </header>
    <div className="automation-command-bar">
      <label className="automation-search-field"><Search size={15}/><input className="automation-search" aria-label={uiText(language)('automationPanel.searchAutomations')} placeholder={uiText(language)('automationPanel.searchAutomations')} value={filter} onChange={event => setFilter(event.target.value)}/></label>
      <div className="automation-actions"><button type="button" aria-label={uiText(language)('automationPanel.refreshAutomations')} title={uiText(language)('automationPanel.refresh')} onClick={() => void refresh()}><RefreshCw size={15}/></button>
        <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={onCreateAutomation} title={uiText(language)('automationPanel.setUpAScheduledTaskInA')}><Plus size={15}/>{uiText(language)('automationPanel.newAutomation')}</button></div>
    </div>
    {error && <p className="automation-error" role="alert">{error}</p>}
    {form && <form className="automation-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <h2>{uiText(language)('automationPanel.editAutomation')}</h2>
      <fieldset disabled={Boolean(busy)}>
        <div className="automation-fields"><label>{uiText(language)('agentConnectionForm.name')}<input required maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          <label>{uiText(language)('automationPanel.configurationSource')}<select required value={form.sessionId} onChange={event => setForm({ ...form, sessionId: event.target.value })}><option value="">{uiText(language)('automationPanel.chooseAStartedConversation')}</option>
            {!overview?.sessions.some(session => session.id === form.sessionId) && <option value={form.sessionId}>{uiText(language)('automationPanel.sourceDeletedKeepSavedSettings')}</option>}
            {overview?.sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.model}</option>)}</select></label></div>
        <label>{uiText(language)('automationPanel.prompt')}<textarea required maxLength={32000} rows={4} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} placeholder={uiText(language)('automationPanel.forExampleInspectTheProjectBuildResults')}/></label>
        <div className="automation-fields"><label>{uiText(language)('automationPanel.trigger')}<select value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value as typeof form.kind })}>
          <option value="once">{uiText(language)('automationPanel.atATime')}</option><option value="interval">{uiText(language)('automationPanel.repeatingInterval')}</option><option value="event">{uiText(language)('automationPanel.conversationEvent')}</option></select></label>
          {form.kind !== 'event' && <label>{uiText(language)('automationPanel.firstRunLocalTime')}<input required type="datetime-local" value={form.at} onChange={event => setForm({ ...form, at: event.target.value })}/></label>}
          {form.kind === 'interval' && <label>{uiText(language)('automationPanel.intervalInMinutes')}<input required type="number" min={1} max={525600} step={1} value={form.minutes} onChange={event => setForm({ ...form, minutes: Number(event.target.value) })}/></label>}
          {form.kind === 'event' && <><label>{uiText(language)('automationPanel.event')}<select value={form.event} onChange={event => setForm({ ...form, event: event.target.value as typeof form.event })}>{['Stop', 'PostToolUse', 'PostToolUseFailure'].map(value => <option key={value} value={value}>{eventLabel(value)}</option>)}</select></label>
            {form.event !== 'Stop' && <label>{uiText(language)('automationPanel.toolNameBlankMatchesAll')}<input value={form.tool} onChange={event => setForm({ ...form, tool: event.target.value })}/></label>}
            <label>{uiText(language)('automationPanel.cooldownInSeconds')}<input required type="number" min={60} max={86400} value={form.cooldown} onChange={event => setForm({ ...form, cooldown: Number(event.target.value) })}/></label></>}
        </div>
        <p className="automation-hint">{form.kind === 'event'
          ? (uiText(language)('automationPanel.triggeredBySourceConversationEventsDeletingThe'))
          : (uiText(language)('automationPanel.eachRunUsesATemporaryConversationWith'))}</p>
        {form.kind === 'event' && <label>{uiText(language)('automationPanel.executionConversation')}<select value={form.executionMode} onChange={event => setForm({ ...form, executionMode: event.target.value as typeof form.executionMode })}>
          <option value="isolated">{uiText(language)('automationPanel.newConversationForEachRun')}</option><option value="conversation">{uiText(language)('automationPanel.continueTheOriginalConversation')}</option>
        </select></label>}
        <div className="automation-actions"><button type="button" onClick={() => setForm(undefined)}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit" className="primary-button">{busy === 'form' ? (uiText(language)('automationPanel.saving')) : (uiText(language)('automationPanel.saveAutomation'))}</button></div>
      </fieldset></form>}
    {!overview && !error && <p role="status">{uiText(language)('automationPanel.loadingAutomations')}</p>}
    {overview && !jobs.length && <div className="automation-empty"><CalendarClock size={32}/><p>{filter ? (uiText(language)('automationPanel.noMatchingAutomations')) : (uiText(language)('automationPanel.noAutomationsYetClickNewAutomationTo'))}</p></div>}
    {view !== 'plans' && <section className="automation-inbox">
      {unreadIds.length > 0 && <div className="automation-inbox-heading automation-actions"><button disabled={Boolean(busy)} type="button" onClick={() => void operate({ action: 'mark_read', runIds: unreadIds }, 'read-batch')}><Check size={14}/>{uiText(language)('automationPanel.markTheseRead', { value1: unreadIds.length })}</button></div>}
      {overview && jobs.length > 0 && !entries.length && <div className="automation-empty"><Check size={28}/><p>{view === 'unread' ? (uiText(language)('automationPanel.noUnreadResultsNewResultsWillAppear')) : (uiText(language)('automationPanel.noExecutionResultsYet'))}</p><button type="button" onClick={() => setView('plans')}>{uiText(language)('automationPanel.viewPlans')}</button></div>}
      {[...groups].map(([date, items]) => <section className="automation-day" key={date}><h2>{date}</h2>{items.map(({ job, run }) => <article key={run.id} className="automation-result" data-unread={!run.readAt && isAutomationResult(run)}>
        <button className="automation-result-open" type="button" onClick={() => openAutomationRun(job.id, run.id, job.name)}>
          <span className="automation-result-dot"/><span className="automation-result-content"><strong>{job.name}</strong><span className="automation-result-summary">{run.summary || run.error || (uiText(language)('automationPanel.viewThisExecutionConversation'))}</span><span className="automation-hint">{time(run.finishedAt ?? run.startedAt ?? run.queuedAt)} · {runLabels[run.status]}</span></span><ChevronRight size={16}/>
        </button>
        {isAutomationResult(run) && <button className="automation-read-toggle" type="button" disabled={Boolean(busy)} title={run.readAt ? (uiText(language)('automationPanel.markUnread')) : (uiText(language)('automationPanel.markRead'))} aria-label={run.readAt ? (uiText(language)('automationPanel.markUnread')) : (uiText(language)('automationPanel.markRead'))}
          onClick={() => void operate({ action: run.readAt ? 'mark_unread' : 'mark_read', id: job.id, runIds: [run.id] }, run.id)}>{run.readAt ? <Mail size={16}/> : <Check size={16}/>}</button>}
      </article>)}</section>)}
    </section>}
    {view === 'plans' && <div className="automation-list">{jobs.map(job => renderPlan(job))}</div>}
  </div>;
}
