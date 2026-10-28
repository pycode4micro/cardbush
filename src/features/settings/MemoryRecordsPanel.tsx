import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { IndividuationSettings, MemoryChange, MemoryHistory, MemoryMutation, MemoryRecord } from '@cardbush/bush-protocol';
import { memoryManagementClient, type MemoryManagementClient } from '../../backend/personalization';
import { SettingsCard } from './SettingsControls';

const stateLabels={active:'memoryRecordsPanel.active' as const,expired:'memoryRecordsPanel.expired' as const,retracted:'memoryRecordsPanel.retracted' as const,disputed:'memoryRecordsPanel.disputed' as const,superseded:'memoryRecordsPanel.superseded' as const,consolidated:'memoryRecordsPanel.consolidated' as const} as const;
export function MemoryRecordsPanel({settings,connection,uiLanguage,refresh,onChanged,api=memoryManagementClient}:{
  settings:IndividuationSettings;connection:string;uiLanguage:string;refresh:number;onChanged:()=>void;api?:MemoryManagementClient;
}) {
  const [tab,setTab]=useState<'records'|'history'>('records'),[inactive,setInactive]=useState(false);
  const [records,setRecords]=useState<MemoryRecord[]>([]),[history,setHistory]=useState<MemoryHistory['changes']>([]);
  const [next,setNext]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [editing,setEditing]=useState<MemoryRecord>(),[text,setText]=useState(''),[condition,setCondition]=useState(''),[expiry,setExpiry]=useState('');
  const [kind,setKind]=useState<'habit'|'prediction'>('habit'),[purging,setPurging]=useState(false);
  const generation=useRef(0),lock=useRef(false);
  const enabled=settings.habits||settings.predictions;
  async function load(cursor=0,version=generation.current) {
    setBusy(true);setError('');
    try {
      if(tab==='records') {
        const value=await api.list(settings,connection,cursor,inactive);if(version!==generation.current)return;
        setRecords(rows=>cursor?[...rows,...value.records]:value.records);setNext(value.next_cursor);
      } else {
        const value=await api.history(settings,connection,cursor);if(version!==generation.current)return;
        setHistory(rows=>cursor?[...rows,...value.changes]:value.changes);setNext(value.next_cursor);
      }
    } catch {if(version===generation.current)setError(uiText(uiLanguage)('memoryRecordsPanel.cannotReadMemoryCheckTheConnectionOr'));}
    finally {if(version===generation.current)setBusy(false);}
  }
  useEffect(()=>{
    const version=++generation.current;setRecords([]);setHistory([]);setNext(null);setEditing(undefined);setPurging(false);
    if(enabled)void load(0,version);else setBusy(false);
    return ()=>{generation.current++;};
  },[connection,settings.habits,settings.predictions,tab,inactive,api]);
  const lastRefresh=useRef(refresh);
  useEffect(()=>{
    if(lastRefresh.current===refresh)return;lastRefresh.current=refresh;
    const version=++generation.current;
    if(enabled)void load(0,version);
  },[refresh]);
  async function act(run:()=>Promise<MemoryMutation|unknown>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');const version=generation.current;
    try {
      const result=await run() as MemoryMutation;
      if(version!==generation.current)return;
      if(result.status&&result.status!=='ok')throw new Error(result.status==='conflict'?(uiText(uiLanguage)('memoryRecordsPanel.recordChangedRefreshBeforeTryingAgain')):(result.reason??result.status));
      setEditing(undefined);setPurging(false);onChanged();
    } catch(error){if(version===generation.current)setError(error instanceof Error?error.message:String(error));}
    finally {lock.current=false;if(version===generation.current)setBusy(false);}
  }
  const date=(value:number|null)=>value===null?(uiText(uiLanguage)('memoryRecordsPanel.notConfirmed')):new Date(value).toLocaleString(uiLanguage);
  const label=(row:MemoryRecord)=>row.kind==='habit'?(uiText(uiLanguage)('memoryRecordsPanel.habit')):row.kind==='prediction'?(uiText(uiLanguage)('memoryRecordsPanel.prediction')):row.kind==='feedback'?(uiText(uiLanguage)('memoryRecordsPanel.replyFeedback')):(uiText(uiLanguage)('memoryRecordsPanel.unclassifiedNote'));
  function edit(row:MemoryRecord) {
    setEditing(row);setText(row.text);setCondition(row.applies_when);setKind(row.kind==='prediction'?'prediction':'habit');
    setExpiry(row.expires_at===null?'':new Date(row.expires_at-new Date(row.expires_at).getTimezoneOffset()*60000).toISOString().slice(0,16));
  }
  function change(row:MemoryRecord,action:MemoryChange['action']) {
    void act(()=>api.change(settings,connection,{id:row.id,revision:row.revision,action,reason:uiText(uiLanguage)(action === 'confirm' ? 'memory.confirmReason' : 'memory.retractReason')}));
  }
  return <SettingsCard title={uiText(uiLanguage)('memoryRecordsPanel.memoryRecordsAndHistory')} subtitle={uiText(uiLanguage)('memoryRecordsPanel.inactiveRecordsAreExcludedFromRecallCorrections')}>
    <div className="memory-record-toolbar">
      <button className={tab==='records'?'primary-button':'secondary-button'} onClick={()=>setTab('records')}>{uiText(uiLanguage)('memoryRecordsPanel.records')}</button>
      <button className={tab==='history'?'primary-button':'secondary-button'} onClick={()=>setTab('history')}>{uiText(uiLanguage)('memoryRecordsPanel.history')}</button>
      {tab==='records'&&<label><input type="checkbox" checked={inactive} onChange={event=>setInactive(event.target.checked)}/>{uiText(uiLanguage)('memoryRecordsPanel.includeInactive')}</label>}
    </div>
    {!enabled?<p>{uiText(uiLanguage)('memoryRecordsPanel.bothCategoriesAreDisabledEnableACategory')}</p>:
      tab==='records'?<div className="memory-record-list">{records.map(row=><article key={row.id} className="memory-record" data-memory-id={row.id}>
        <div className="memory-record-heading"><strong>{label(row)}</strong><span>{uiText(uiLanguage)(stateLabels[row.state])}{row.origin==='user'?(uiText(uiLanguage)('memoryRecordsPanel.userPinned')):''}</span><code>{row.id}</code></div>
        <p>{row.text||(uiText(uiLanguage)('memoryRecordsPanel.theInactiveRecordSTextWasCleared'))}</p>
        {row.applies_when&&<p>{uiText(uiLanguage)('memoryRecordsPanel.appliesWhen')}{row.applies_when}</p>}
        <small>{uiText(uiLanguage)('memoryRecordsPanel.recordedDaysAgo', { value1: date(row.created_at), value2: row.age_days })}</small>
        <small>{uiText(uiLanguage)('memoryRecordsPanel.lastConfirmed')}{date(row.last_confirmed_at)}{row.last_rejected_at!==null&&<> · {uiText(uiLanguage)('memoryRecordsPanel.rejected')}{date(row.last_rejected_at)}</>}</small>
        {row.expires_at!==null&&<small>{uiText(uiLanguage)('memoryRecordsPanel.expires')}{date(row.expires_at)}</small>}
        {row.source&&<small>{uiText(uiLanguage)('memoryRecordsPanel.sourceConversation')}{row.source.session_id} · {row.source.turn_id}</small>}
        {row.source_ids.length>0&&<small>{uiText(uiLanguage)('memoryRecordsPanel.consolidatedFrom')}{row.source_ids.join(', ')}</small>}
        {row.replaced_by.length>0&&<small>{uiText(uiLanguage)('memoryRecordsPanel.replacements')}{row.replaced_by.join(', ')}</small>}
        <div className="memory-record-actions">{row.state==='active'&&<>
          {row.origin!=='user'&&row.kind!=='feedback'&&<button className="secondary-button" disabled={busy} onClick={()=>change(row,'confirm')}>{uiText(uiLanguage)('memoryRecordsPanel.confirmAndPin')}</button>}
          {row.kind!=='feedback'&&<button className="secondary-button" disabled={busy} onClick={()=>edit(row)}>{uiText(uiLanguage)('memoryRecordsPanel.correct')}</button>}
          <button className="secondary-button" disabled={busy} onClick={()=>change(row,'retract')}>{uiText(uiLanguage)('memoryRecordsPanel.retract')}</button>
        </>}</div>
      </article>)}{!busy&&!records.length&&<p>{uiText(uiLanguage)('memoryRecordsPanel.noRecordsToDisplay')}</p>}</div>:
      <div className="memory-record-list">{history.map(change=><details className="memory-record memory-change" key={change.id}>
        <summary>{date(change.created_at)} · {change.actor==='user'?(uiText(uiLanguage)('pluginManagementPanel.user')):change.actor==='summary'?(uiText(uiLanguage)('memoryRecordsPanel.consolidation')):'Agent'} · {change.reason}</summary>
        <div className="memory-change-diff"><div><strong>{uiText(uiLanguage)('memoryRecordsPanel.before')}</strong>{change.before.map(row=><p key={row.id}>{row.id} · {uiText(uiLanguage)(stateLabels[row.state])}<br/>{row.text}</p>)}</div>
          <div><strong>{uiText(uiLanguage)('memoryRecordsPanel.after')}</strong>{change.after.map(row=><p key={row.id}>{row.id} · {uiText(uiLanguage)(stateLabels[row.state])}<br/>{row.text}</p>)}</div></div>
        <button className="secondary-button" disabled={busy||!change.can_undo} onClick={()=>void act(()=>api.undo(settings,connection,change.id))}>{uiText(uiLanguage)('memoryRecordsPanel.undoThisChange')}</button>
        {!change.can_undo&&<small>{uiText(uiLanguage)('memoryRecordsPanel.alreadyUndoneOrChangedAfterwardLaterEdits')}</small>}
      </details>)}{!busy&&!history.length&&<p>{uiText(uiLanguage)('memoryRecordsPanel.noChangeHistory')}</p>}</div>}
    {editing&&<form className="memory-record-editor" onSubmit={event=>{event.preventDefault();void act(()=>api.change(settings,connection,{id:editing.id,revision:editing.revision,action:'supersede',reason:uiText(uiLanguage)('memoryRecordsPanel.userCorrectedMemory'),
      replacement:{kind,text, ...(condition?{applies_when:condition}:{}),...(expiry?{expires_at:new Date(expiry).toISOString()}:{})}}));}}>
      <label>{uiText(uiLanguage)('pluginManagementPanel.category')}<select value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="habit" disabled={!settings.habits}>{uiText(uiLanguage)('memoryRecordsPanel.habit')}</option><option value="prediction" disabled={!settings.predictions}>{uiText(uiLanguage)('memoryRecordsPanel.prediction')}</option></select></label>
      <label>{uiText(uiLanguage)('memoryRecordsPanel.conciseText')}<textarea required maxLength={1600} value={text} onChange={event=>setText(event.target.value)}/></label>
      <label>{uiText(uiLanguage)('memoryRecordsPanel.appliesWhenOptional')}<input maxLength={240} value={condition} onChange={event=>setCondition(event.target.value)}/></label>
      <label>{uiText(uiLanguage)('memoryRecordsPanel.expiryOptional')}<input type="datetime-local" value={expiry} onChange={event=>setExpiry(event.target.value)}/></label>
      <div className="memory-record-actions"><button type="submit" className="primary-button" disabled={busy}>{uiText(uiLanguage)('memoryRecordsPanel.saveCorrection')}</button><button type="button" className="secondary-button" onClick={()=>setEditing(undefined)}>{uiText(uiLanguage)('agentConnectionForm.cancel')}</button></div>
    </form>}
    {next!==null&&<button className="secondary-button" disabled={busy} onClick={()=>void load(next)}>{uiText(uiLanguage)('image.loadMore')}</button>}
    {busy&&<small role="status">{uiText(uiLanguage)('calendarDataControls.working')}</small>}{error&&<p role="alert">{error}</p>}
    {tab==='history'&&enabled&&<div className="memory-history-purge">{purging?<>
      <p>{uiText(uiLanguage)('memoryRecordsPanel.clearingInactiveTextAndHistoryCannotBe')}</p>
      <button className="secondary-button" disabled={busy} onClick={()=>void act(()=>api.purge(settings,connection))}>{uiText(uiLanguage)('memoryRecordsPanel.clearHistoryPermanently')}</button>
      <button className="secondary-button" onClick={()=>setPurging(false)}>{uiText(uiLanguage)('agentConnectionForm.cancel')}</button>
    </>:<button className="secondary-button" disabled={busy} onClick={()=>setPurging(true)}>{uiText(uiLanguage)('memoryRecordsPanel.clearInactiveHistory')}</button>}</div>}
  </SettingsCard>;
}
