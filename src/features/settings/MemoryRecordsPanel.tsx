import { useEffect, useRef, useState } from 'react';
import type { IndividuationSettings, MemoryChange, MemoryHistory, MemoryMutation, MemoryRecord } from '@cardbush/bush-protocol';
import { memoryManagementClient, type MemoryManagementClient } from '../../backend/personalization';
import { SettingsCard } from './SettingsControls';

const stateLabels={active:['有效','Active'],expired:['已过期','Expired'],retracted:['已撤销','Retracted'],disputed:['有争议','Disputed'],superseded:['已取代','Superseded'],consolidated:['已整理','Consolidated']} as const;
export function MemoryRecordsPanel({settings,connection,zh,refresh,onChanged,api=memoryManagementClient}:{
  settings:IndividuationSettings;connection:string;zh:boolean;refresh:number;onChanged:()=>void;api?:MemoryManagementClient;
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
    } catch {if(version===generation.current)setError(zh?'无法读取记忆，请检查连接或更新 Agent。':'Cannot read memory. Check the connection or update this Agent.');}
    finally {if(version===generation.current)setBusy(false);}
  }
  useEffect(()=>{
    const version=++generation.current;setRecords([]);setHistory([]);setNext(null);setEditing(undefined);setPurging(false);
    if(enabled)void load(0,version);else setBusy(false);
    return ()=>{generation.current++;};
  },[connection,settings.habits,settings.predictions,tab,inactive,refresh,api]);
  async function act(run:()=>Promise<MemoryMutation|unknown>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');const version=generation.current;
    try {
      const result=await run() as MemoryMutation;
      if(version!==generation.current)return;
      if(result.status&&result.status!=='ok')throw new Error(result.status==='conflict'?(zh?'记录已变化，请刷新后再操作。':'Record changed. Refresh before trying again.'):(result.reason??result.status));
      setEditing(undefined);setPurging(false);onChanged();
    } catch(error){if(version===generation.current)setError(error instanceof Error?error.message:String(error));}
    finally {lock.current=false;if(version===generation.current)setBusy(false);}
  }
  const date=(value:number|null)=>value===null?(zh?'未确认':'Not confirmed'):new Date(value).toLocaleString(zh?'zh-CN':'en-US');
  const label=(row:MemoryRecord)=>row.kind==='habit'?(zh?'习惯':'Habit'):row.kind==='prediction'?(zh?'预测':'Prediction'):(zh?'待整理笔记':'Unclassified note');
  function edit(row:MemoryRecord) {
    setEditing(row);setText(row.text);setCondition(row.applies_when);setKind(row.kind==='prediction'?'prediction':'habit');
    setExpiry(row.expires_at===null?'':new Date(row.expires_at-new Date(row.expires_at).getTimezoneOffset()*60000).toISOString().slice(0,16));
  }
  function change(row:MemoryRecord,action:MemoryChange['action']) {
    void act(()=>api.change(settings,connection,{id:row.id,revision:row.revision,action,reason:zh?'用户在记忆设置中'+(action==='confirm'?'确认并固定':'撤销记录'):'User '+(action==='confirm'?'confirmed and pinned':'retracted')+' this record in settings.'}));
  }
  return <SettingsCard title={zh?'记忆条目与变更历史':'Memory records and history'} subtitle={zh?'失效记录不再参与检索；纠错和总结均留痕，可在记录未再次变化时撤销。':'Inactive records are excluded from recall. Corrections and summaries keep history and can be undone until the affected records change again.'}>
    <div className="memory-record-toolbar">
      <button className={tab==='records'?'primary-button':'secondary-button'} onClick={()=>setTab('records')}>{zh?'记忆条目':'Records'}</button>
      <button className={tab==='history'?'primary-button':'secondary-button'} onClick={()=>setTab('history')}>{zh?'变更历史':'History'}</button>
      {tab==='records'&&<label><input type="checkbox" checked={inactive} onChange={event=>setInactive(event.target.checked)}/>{zh?'包括失效记录':'Include inactive'}</label>}
    </div>
    {!enabled?<p>{zh?'习惯和预测均已关闭。开启对应类别后可查看。':'Both categories are disabled. Enable a category to view its records.'}</p>:
      tab==='records'?<div className="memory-record-list">{records.map(row=><article key={row.id} className="memory-record" data-memory-id={row.id}>
        <div className="memory-record-heading"><strong>{label(row)}</strong><span>{stateLabels[row.state][zh?0:1]}{row.origin==='user'?(zh?' · 用户固定':' · User pinned'):''}</span><code>{row.id}</code></div>
        <p>{row.text||(zh?'此失效记录的原文已清理。':'The inactive record’s text was cleared.')}</p>
        {row.applies_when&&<p>{zh?'适用条件：':'Applies when: '}{row.applies_when}</p>}
        <small>{zh?`记录于 ${date(row.created_at)}（${row.age_days} 天前）`:`Recorded ${date(row.created_at)} (${row.age_days} days ago)`}</small>
        <small>{zh?'最后确认：':'Last confirmed: '}{date(row.last_confirmed_at)}{row.last_rejected_at!==null&&<> · {zh?'否认于：':'Rejected: '}{date(row.last_rejected_at)}</>}</small>
        {row.expires_at!==null&&<small>{zh?'过期时间：':'Expires: '}{date(row.expires_at)}</small>}
        {row.source&&<small>{zh?'来源会话：':'Source conversation: '}{row.source.session_id} · {row.source.turn_id}</small>}
        {row.source_ids.length>0&&<small>{zh?'整理来源：':'Consolidated from: '}{row.source_ids.join(', ')}</small>}
        {row.replaced_by.length>0&&<small>{zh?'替代条目：':'Replacements: '}{row.replaced_by.join(', ')}</small>}
        <div className="memory-record-actions">{row.state==='active'&&<>
          {row.origin!=='user'&&<button className="secondary-button" disabled={busy} onClick={()=>change(row,'confirm')}>{zh?'确认并固定':'Confirm and pin'}</button>}
          <button className="secondary-button" disabled={busy} onClick={()=>edit(row)}>{zh?'修正':'Correct'}</button>
          <button className="secondary-button" disabled={busy} onClick={()=>change(row,'retract')}>{zh?'撤销此条':'Retract'}</button>
        </>}</div>
      </article>)}{!busy&&!records.length&&<p>{zh?'暂无可显示的记忆。':'No records to display.'}</p>}</div>:
      <div className="memory-record-list">{history.map(change=><details className="memory-record memory-change" key={change.id}>
        <summary>{date(change.created_at)} · {change.actor==='user'?(zh?'用户':'User'):change.actor==='summary'?(zh?'后台总结':'Consolidation'):'Agent'} · {change.reason}</summary>
        <div className="memory-change-diff"><div><strong>{zh?'变更前':'Before'}</strong>{change.before.map(row=><p key={row.id}>{row.id} · {stateLabels[row.state][zh?0:1]}<br/>{row.text}</p>)}</div>
          <div><strong>{zh?'变更后':'After'}</strong>{change.after.map(row=><p key={row.id}>{row.id} · {stateLabels[row.state][zh?0:1]}<br/>{row.text}</p>)}</div></div>
        <button className="secondary-button" disabled={busy||!change.can_undo} onClick={()=>void act(()=>api.undo(settings,connection,change.id))}>{zh?'撤销这次变更':'Undo this change'}</button>
        {!change.can_undo&&<small>{zh?'已撤销或条目发生了后续变化，不能覆盖后续修改。':'Already undone or changed afterward; later edits cannot be overwritten.'}</small>}
      </details>)}{!busy&&!history.length&&<p>{zh?'暂无变更历史。':'No change history.'}</p>}</div>}
    {editing&&<form className="memory-record-editor" onSubmit={event=>{event.preventDefault();void act(()=>api.change(settings,connection,{id:editing.id,revision:editing.revision,action:'supersede',reason:zh?'用户修正记忆':'User corrected memory',
      replacement:{kind,text, ...(condition?{applies_when:condition}:{}),...(expiry?{expires_at:new Date(expiry).toISOString()}:{})}}));}}>
      <label>{zh?'类别':'Category'}<select value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="habit" disabled={!settings.habits}>{zh?'习惯':'Habit'}</option><option value="prediction" disabled={!settings.predictions}>{zh?'预测':'Prediction'}</option></select></label>
      <label>{zh?'简短内容':'Concise text'}<textarea required maxLength={1600} value={text} onChange={event=>setText(event.target.value)}/></label>
      <label>{zh?'适用条件（可选）':'Applies when (optional)'}<input maxLength={240} value={condition} onChange={event=>setCondition(event.target.value)}/></label>
      <label>{zh?'过期时间（可选）':'Expiry (optional)'}<input type="datetime-local" value={expiry} onChange={event=>setExpiry(event.target.value)}/></label>
      <div className="memory-record-actions"><button type="submit" className="primary-button" disabled={busy}>{zh?'保存修正':'Save correction'}</button><button type="button" className="secondary-button" onClick={()=>setEditing(undefined)}>{zh?'取消':'Cancel'}</button></div>
    </form>}
    {next!==null&&<button className="secondary-button" disabled={busy} onClick={()=>void load(next)}>{zh?'加载更多':'Load more'}</button>}
    {busy&&<small role="status">{zh?'处理中…':'Working…'}</small>}{error&&<p role="alert">{error}</p>}
    {tab==='history'&&enabled&&<div className="memory-history-purge">{purging?<>
      <p>{zh?'清理失效原文和变更历史后将无法撤销，当前有效记忆会保留。':'Clearing inactive text and history cannot be undone. Active memory will remain.'}</p>
      <button className="secondary-button" disabled={busy} onClick={()=>void act(()=>api.purge(settings,connection))}>{zh?'确认清理历史':'Clear history permanently'}</button>
      <button className="secondary-button" onClick={()=>setPurging(false)}>{zh?'取消':'Cancel'}</button>
    </>:<button className="secondary-button" disabled={busy} onClick={()=>setPurging(true)}>{zh?'清理失效历史…':'Clear inactive history…'}</button>}</div>}
  </SettingsCard>;
}
