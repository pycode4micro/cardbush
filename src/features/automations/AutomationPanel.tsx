import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Plus, RefreshCw, Play, Pause, Square, Pencil, Trash2, MessageSquare, Check, Mail, ChevronRight } from 'lucide-react';
import { isAutomationResult } from '@cardbush/bush-protocol';
import { openAutomationRun } from './automationEvents';
import type { AutomationCommand, AutomationDefinition, AutomationJob, AutomationOverview, AutomationRun } from '@cardbush/bush-protocol';
import './automations.css';

const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const errorText = (caught: unknown, zh: boolean) => {
  const text = String(caught).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': Error: /, '');
  if (!zh) return text;
  return ({
    'Automation changed. Refresh before saving.': '自动化已被其他操作修改，请刷新后重新编辑。',
    'Send a message in the target conversation before scheduling it.': '请先在目标会话发送一条消息，再创建自动化。',
    'Stop the queued or running automation before editing it.': '请先停止排队或执行中的任务，再进行编辑。',
    'Stop the running automation before deleting it.': '请先停止执行中的任务，再删除自动化。',
    'This automation is already queued or running.': '此自动化已在排队或执行中。',
    'The target conversation was removed.': '目标会话已删除，请重新选择会话。',
    'The originating plugin hook is disabled, changed, or no longer trusted.': '来源插件的 Hook 已停用、修改或撤销信任，请检查插件设置。',
    'Runtime stopped before completion was recorded. Check the conversation before running again.': '执行中途应用退出，未能确认最终结果。请先检查会话，再决定是否重新执行。',
    'The automation model was removed. Send a message in the target conversation with an available model.': '原模型已移除，请在目标会话选择可用模型并发送一条消息。',
  } as Record<string, string>)[text] ?? text;
};
export function AutomationPanel({ language, onOpenConversation, onCreateAutomation }: {
  language: 'zh' | 'en';
  onOpenConversation: (id: string) => void;
  onCreateAutomation: () => void;
}) {
  const zh = language === 'zh';
  const [overview, setOverview] = useState<AutomationOverview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'unread' | 'today' | 'all' | 'plans'>('unread');
  const [form, setForm] = useState<{ id: string; revision: number; name: string; prompt: string; sessionId: string; executionMode: 'isolated' | 'conversation'; kind: 'once' | 'interval' | 'event'; at: string; minutes: number; event: 'Stop' | 'PostToolUse' | 'PostToolUseFailure'; tool: string; cooldown: number; timeZone: string }>();
  const generation = useRef(0), mutation = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    try {
      if (!window.cardbushDesktop?.automationCommand) throw new Error(zh ? '请重启 CardBush 以加载定时服务。' : 'Restart CardBush to load the automation service.');
      const result = await window.cardbushDesktop.automationCommand({ action: 'list' }) as AutomationOverview;
      if (revision === generation.current) { setOverview(result); setError(''); }
    } catch (caught) { if (revision === generation.current) setError(errorText(caught, zh)); }
  }, [zh]);
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
    } catch (caught) { setError(errorText(caught, zh)); }
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
        definition: { name: form.name, sessionId: form.sessionId, prompt: form.prompt, trigger, executionMode: form.executionMode, timeZone: form.timeZone } }, 'form');
    } catch { setError(zh ? '请输入有效的执行时间。' : 'Enter a valid execution time.'); }
  };
  const runLabels: Record<AutomationRun['status'], string> = zh ? { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '执行中断', awaiting_user_action: '等待处理' }
    : { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', awaiting_user_action: 'Needs attention' };
  const eventLabel = (event: string) => zh ? ({ Stop: '任务完成', PostToolUse: '工具执行成功', PostToolUseFailure: '工具执行失败' }[event] ?? event) : event;
  const time = (value?: string) => value ? new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US') : '—';
  const jobs = overview?.jobs.filter(job => `${job.name} ${job.prompt}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const unreadCount = overview?.jobs.reduce((count, job) => count + job.runs.filter(run => isAutomationResult(run) && !run.readAt).length, 0) ?? 0;
  const entries = jobs.flatMap(job => job.runs.map(run => ({ job, run })))
    .filter(({ run }) => view === 'all' || (view === 'unread' && !run.readAt) || (view === 'today' && new Date(run.finishedAt ?? run.queuedAt).toDateString() === new Date().toDateString()))
    .sort((a, b) => (b.run.finishedAt ?? b.run.queuedAt).localeCompare(a.run.finishedAt ?? a.run.queuedAt));
  const unreadIds = entries.filter(({ run }) => isAutomationResult(run) && !run.readAt).map(({ run }) => run.id).slice(0, 500);
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const date = new Date(entry.run.finishedAt ?? entry.run.queuedAt).toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'short', year: 'numeric' });
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  return <div className="feature-content automation-panel">
    <header className="automation-heading"><div><h1><CalendarClock size={25} />{zh ? '定时与自动化' : 'Automations'}</h1><p>{zh ? '每天查看结果，处理后标记已读；需要时继续对话。' : 'Review daily results, mark them read, and continue the conversation.'}</p></div>
      <div className="automation-actions"><button type="button" aria-label={zh ? '刷新自动化' : 'Refresh automations'} onClick={() => void refresh()}><RefreshCw size={16}/></button>
        <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={onCreateAutomation} title={zh ? '在新会话中设置定时任务' : 'Set up a scheduled task in a new conversation'}><Plus size={16}/>{zh ? '新建自动化' : 'New automation'}</button></div></header>
    {error && <p className="automation-error" role="alert">{error}</p>}
    <nav className="automation-tabs" aria-label={zh ? '定时视图' : 'Automation views'}>
      {(['unread', 'today', 'all', 'plans'] as const).map(tab => <button type="button" key={tab} aria-pressed={view === tab} onClick={() => { setView(tab); setForm(undefined); }}>
        {{ unread: zh ? '未读' : 'Unread', today: zh ? '今天' : 'Today', all: zh ? '全部结果' : 'All results', plans: zh ? '计划管理' : 'Plans' }[tab]}{tab === 'unread' && <span>{unreadCount}</span>}
      </button>)}
    </nav>
    {form && <form className="automation-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <h2>{zh ? '编辑自动化' : 'Edit automation'}</h2>
      <fieldset disabled={Boolean(busy)}>
        <div className="automation-fields"><label>{zh ? '名称' : 'Name'}<input required maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          <label>{zh ? '目标会话' : 'Conversation'}<select required value={form.sessionId} onChange={event => setForm({ ...form, sessionId: event.target.value })}><option value="">{zh ? '选择一个已开始的会话' : 'Choose a started conversation'}</option>
            {overview?.sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.model}</option>)}</select></label></div>
        {!overview?.sessions.length && <p>{zh ? '先在目标会话发送一条消息，建立模型和工作区配置。' : 'Send a message in the target conversation to establish its model and workspace.'}</p>}
        <label>{zh ? '执行提示词' : 'Prompt'}<textarea required maxLength={32000} rows={4} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} placeholder={zh ? '例如：检查项目构建结果，整理失败原因并提出修复建议。' : 'For example: inspect the project build results and suggest fixes for failures.'}/></label>
        <div className="automation-fields"><label>{zh ? '触发方式' : 'Trigger'}<select value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value as typeof form.kind })}>
          <option value="once">{zh ? '指定时间' : 'At a time'}</option><option value="interval">{zh ? '重复间隔' : 'Repeating interval'}</option><option value="event">{zh ? '会话事件' : 'Conversation event'}</option></select></label>
          {form.kind !== 'event' && <label>{zh ? '首次执行时间（本机时区）' : 'First run (local time)'}<input required type="datetime-local" value={form.at} onChange={event => setForm({ ...form, at: event.target.value })}/></label>}
          {form.kind === 'interval' && <label>{zh ? '每隔多少分钟' : 'Interval in minutes'}<input required type="number" min={1} max={525600} step={1} value={form.minutes} onChange={event => setForm({ ...form, minutes: Number(event.target.value) })}/></label>}
          {form.kind === 'event' && <><label>{zh ? '事件' : 'Event'}<select value={form.event} onChange={event => setForm({ ...form, event: event.target.value as typeof form.event })}>{['Stop', 'PostToolUse', 'PostToolUseFailure'].map(value => <option key={value} value={value}>{eventLabel(value)}</option>)}</select></label>
            {form.event !== 'Stop' && <label>{zh ? '工具名称（留空匹配全部）' : 'Tool name (blank matches all)'}<input value={form.tool} onChange={event => setForm({ ...form, tool: event.target.value })}/></label>}
            <label>{zh ? '触发冷却时间（秒）' : 'Cooldown in seconds'}<input required type="number" min={60} max={86400} value={form.cooldown} onChange={event => setForm({ ...form, cooldown: Number(event.target.value) })}/></label></>}
        </div>
        <p className="automation-hint">{zh ? '沿用该会话最近使用的模型、工作区和权限。自动执行产生的事件不会再次触发自动化。' : 'Uses the conversation’s latest model, workspace and permissions. Automated runs do not trigger further automations.'}</p>
        <label>{zh ? '执行会话' : 'Execution conversation'}<select value={form.executionMode} onChange={event => setForm({ ...form, executionMode: event.target.value as typeof form.executionMode })}>
          <option value="isolated">{zh ? '每次新建会话' : 'New conversation for each run'}</option><option value="conversation">{zh ? '继续原会话' : 'Continue the original conversation'}</option>
        </select></label>
        <div className="automation-actions"><button type="button" onClick={() => setForm(undefined)}>{zh ? '取消' : 'Cancel'}</button><button type="submit" className="primary-button">{busy === 'form' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存自动化' : 'Save automation')}</button></div>
      </fieldset></form>}
    <input className="automation-search" aria-label={zh ? '搜索自动化' : 'Search automations'} placeholder={zh ? '搜索自动化' : 'Search automations'} value={filter} onChange={event => setFilter(event.target.value)}/>
    {!overview && !error && <p role="status">{zh ? '正在读取自动化…' : 'Loading automations…'}</p>}
    {overview && !jobs.length && <div className="automation-empty"><CalendarClock size={32}/><p>{filter ? (zh ? '没有匹配的自动化。' : 'No matching automations.') : (zh ? '还没有自动化。点击“新建自动化”，在对话中告诉 agent 你的安排。' : 'No automations yet. Click New automation and tell the agent what you have in mind.')}</p></div>}
    {view !== 'plans' && <section className="automation-inbox">
      {unreadIds.length > 0 && <div className="automation-inbox-heading automation-actions"><button disabled={Boolean(busy)} type="button" onClick={() => void operate({ action: 'mark_read', runIds: unreadIds }, 'read-batch')}><Check size={14}/>{zh ? `标记这 ${unreadIds.length} 条已读` : `Mark these ${unreadIds.length} read`}</button></div>}
      {overview && jobs.length > 0 && !entries.length && <div className="automation-empty"><Check size={28}/><p>{view === 'unread' ? (zh ? '未读结果已清空。下一次执行结束后会出现在这里。' : 'No unread results. New results will appear here after execution.') : (zh ? '暂时没有执行结果。' : 'No execution results yet.')}</p><button type="button" onClick={() => setView('plans')}>{zh ? '查看计划' : 'View plans'}</button></div>}
      {[...groups].map(([date, items]) => <section className="automation-day" key={date}><h2>{date}</h2>{items.map(({ job, run }) => <article key={run.id} className="automation-result" data-unread={!run.readAt && isAutomationResult(run)}>
        <button className="automation-result-open" type="button" onClick={() => openAutomationRun(job.id, run.id, job.name)}>
          <span className="automation-result-dot"/><span className="automation-result-content"><strong>{job.name}</strong><span className="automation-result-summary">{run.summary || run.error || (zh ? '查看本次执行对话' : 'View this execution conversation')}</span><span className="automation-hint">{time(run.finishedAt ?? run.startedAt ?? run.queuedAt)} · {runLabels[run.status]}</span></span><ChevronRight size={16}/>
        </button>
        {isAutomationResult(run) && <button className="automation-read-toggle" type="button" disabled={Boolean(busy)} title={run.readAt ? (zh ? '标记未读' : 'Mark unread') : (zh ? '标记已读' : 'Mark read')} aria-label={run.readAt ? (zh ? '标记未读' : 'Mark unread') : (zh ? '标记已读' : 'Mark read')}
          onClick={() => void operate({ action: run.readAt ? 'mark_unread' : 'mark_read', id: job.id, runIds: [run.id] }, run.id)}>{run.readAt ? <Mail size={16}/> : <Check size={16}/>}</button>}
      </article>)}</section>)}
    </section>}
    {view === 'plans' && <div className="automation-list">{jobs.map(job => {
      const latest = job.runs.at(-1), active = latest?.status === 'running' || latest?.status === 'queued';
      const label = active ? runLabels[latest.status] : job.state === 'active' ? (zh ? '已启用' : 'Active') : job.state === 'paused' ? (zh ? '已暂停' : 'Paused') : (zh ? '已完成' : 'Completed');
      const action = (action: AutomationCommand['action']) => void operate({ action, id: job.id, expectedRevision: job.revision }, job.id);
      return <article className="automation-card" key={job.id}>
        <header><h2>{job.name}</h2><span className="automation-state" data-state={active ? latest.status : job.state}>{label}</span></header>
        <p className="automation-prompt">{job.prompt}</p>
        <p className="automation-hint">{job.trigger.kind === 'event' ? `${eventLabel(job.trigger.event)}${job.trigger.tool ? ` · ${job.trigger.tool}` : ''}`
          : job.trigger.kind === 'interval' ? (zh ? `每 ${job.trigger.seconds / 60} 分钟` : `Every ${job.trigger.seconds / 60} minutes`) : (zh ? '单次执行' : 'One-time')}
          {job.state === 'active' && job.nextRunAt && ` · ${zh ? '下次：' : 'Next: '}${time(job.nextRunAt)}`}{job.plugin && ` · ${zh ? '插件：' : 'Plugin: '}${job.plugin.id}`}</p>
        <div className="automation-actions"><button type="button" onClick={() => onOpenConversation(job.sessionId)}><MessageSquare size={14}/>{zh ? '打开会话' : 'Conversation'}</button>
          <button type="button" disabled={Boolean(busy) || active} onClick={() => edit(job)}><Pencil size={14}/>{zh ? '编辑' : 'Edit'}</button>
          <button type="button" disabled={Boolean(busy) || active} onClick={() => action('run')}><Play size={14}/>{zh ? '立即执行' : 'Run now'}</button>
          {active ? <button type="button" disabled={Boolean(busy)} onClick={() => action('stop')}><Square size={14}/>{zh ? '停止' : 'Stop'}</button>
            : <button type="button" disabled={Boolean(busy)} onClick={() => action(job.state === 'active' ? 'pause' : 'resume')}><Pause size={14}/>{job.state === 'active' ? (zh ? '暂停' : 'Pause') : (zh ? '启用' : 'Enable')}</button>}
          <button type="button" disabled={Boolean(busy) || latest?.status === 'running'} onClick={() => action('delete')}><Trash2 size={14}/>{zh ? '删除' : 'Delete'}</button></div>
        {job.runs.length > 0 && <details><summary>{zh ? `执行记录 · ${runLabels[latest!.status]}` : `History · ${runLabels[latest!.status]}`}</summary><ol>{[...job.runs].reverse().map(run => <li key={run.id}>
          <button className="automation-history-open" type="button" onClick={() => openAutomationRun(job.id, run.id, job.name)}><strong>{runLabels[run.status]}</strong> · {time(run.startedAt ?? run.queuedAt)}{!run.readAt && isAutomationResult(run) && ` · ${zh ? '未读' : 'Unread'}`}<ChevronRight size={14}/></button>{run.error && <p className="automation-error">{errorText(run.error, zh)}</p>}
        </li>)}</ol></details>}
      </article>;
    })}</div>}
  </div>;
}
