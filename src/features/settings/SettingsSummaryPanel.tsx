import { useEffect, useRef, useState } from 'react';
import { normalizeIndividuation, summaryTokenThresholdSchema, type PersonalizationStatus } from '@cardbush/bush-protocol';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage, AppSettingsState } from '../../types';
import { personalizationCommand, type MemoryManagementClient } from '../../backend/personalization';
import { MemoryRecordsPanel } from './MemoryRecordsPanel';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import './summarySettings.css';

export function SettingsSummaryPanel({language,settings,onSettingsChange,modelId='',connections=[],call=personalizationCommand,memoryApi}:{
  language:AppLanguage;settings:AppSettingsState;modelId?:string;connections?:AgentConnection[];
  onSettingsChange:(updater:(current:AppSettingsState)=>AppSettingsState)=>void;call?:typeof personalizationCommand;
  memoryApi?:MemoryManagementClient;
}) {
  const zh=language==='zh',memory=normalizeIndividuation(settings.individuation);
  const [connection,setConnection]=useState(''),[status,setStatus]=useState<PersonalizationStatus>();
  const [eventThreshold,setEventThreshold]=useState(String(memory.eventTokenThreshold));
  const [habitThreshold,setHabitThreshold]=useState(String(memory.habitTokenThreshold));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[recordsRefresh,setRecordsRefresh]=useState(0);
  const [reading,setReading]=useState(false);
  const generation=useRef(0),requestSequence=useRef(0),acting=useRef(false);
  const latestStatus=useRef<PersonalizationStatus|undefined>(undefined);
  const readScope=JSON.stringify([connection,memory.habits,memory.predictions]);
  useEffect(()=>{setEventThreshold(String(memory.eventTokenThreshold));},[memory.eventTokenThreshold]);
  useEffect(()=>{setHabitThreshold(String(memory.habitTokenThreshold));},[memory.habitTokenThreshold]);
  useEffect(()=>{
    generation.current++;latestStatus.current=undefined;setStatus(undefined);setError('');
    return ()=>{generation.current++;};
  },[readScope]);
  function acceptStatus(value:PersonalizationStatus) {
    const previous=latestStatus.current;
    latestStatus.current=value;setStatus(value);
    if(value.running&&!previous?.running)setError('');
    // Polling a running job does not invalidate the records/editor on every tick.
    if(previous&&(previous.running&&!value.running||previous.lastSummaryAt!==value.lastSummaryAt))setRecordsRefresh(v=>v+1);
  }
  useEffect(()=>{
    const version=generation.current,sequence=++requestSequence.current;
    setReading(true);
    void call({action:'status',settings:memory},connection).then(value=>{
      if(version===generation.current&&sequence===requestSequence.current)acceptStatus(value);
    },()=>{
      if(version===generation.current&&sequence===requestSequence.current)setError(zh?'无法读取此环境的记忆状态，请检查连接或更新 Agent。':'Cannot read memory status. Check the connection or update this Agent.');
    }).finally(()=>{if(version===generation.current&&sequence===requestSequence.current)setReading(false);});
  },[call,readScope,memory.eventTokenThreshold,memory.habitTokenThreshold,revision,zh]);
  // Poll only an observed running job, never an idle memory database.
  useEffect(()=>{if(reading||!status?.running&&!busy)return;const timer=setTimeout(()=>setRevision(v=>v+1),2000);return()=>clearTimeout(timer);},[status?.running,busy,reading,revision]);
  const update=(value:Partial<typeof memory>)=>onSettingsChange(current=>({...current,individuation:{...normalizeIndividuation(current.individuation),...value}}));
  function saveThreshold() {
    const events=summaryTokenThresholdSchema.safeParse(Number(eventThreshold)),habits=summaryTokenThresholdSchema.safeParse(Number(habitThreshold));
    if(!events.success||!habits.success) {setError(zh?'阈值需为 1,000–200,000 之间的整数。':'Use a whole number from 1,000 to 200,000.');return false;}
    setError('');if(events.data!==memory.eventTokenThreshold||habits.data!==memory.habitTokenThreshold)update({eventTokenThreshold:events.data,habitTokenThreshold:habits.data});return true;
  }
  async function summarize() {
    if(acting.current||!saveThreshold())return;
    const version=generation.current;acting.current=true;setBusy(true);setError('');
    try {
      const value=await call({action:'summarize',settings:{...memory,eventTokenThreshold:Number(eventThreshold),habitTokenThreshold:Number(habitThreshold)},modelId},connection);
      if(version===generation.current){requestSequence.current++;setReading(false);acceptStatus(value);setRecordsRefresh(value=>value+1);}
    } catch {
      if(version===generation.current){
        setError(zh?'本次整理未全部完成；已完成的阶段已保存，其余原记录保留。':'Consolidation did not fully complete. Finished stages were saved; remaining original memory was kept.');
        // Retrieve the persisted reason even if the command transport rejected.
        const sequence=++requestSequence.current;
        setReading(true);
        try {const value=await call({action:'status',settings:memory},connection);if(version===generation.current&&sequence===requestSequence.current)acceptStatus(value);} catch { /* Keep the last known snapshot and the error. */ }
        finally {if(version===generation.current&&sequence===requestSequence.current)setReading(false);}
      }
    }
    finally {acting.current=false;setBusy(false);}
  }
  const enabled=memory.habits||memory.predictions;
  return <div className="settings-stack summary-settings">
    <SettingsCard title="summary_for_user" subtitle={zh?'按需记录简洁的用户偏好与后续需求，在当前运行环境跨对话使用。工具调用由 Agent 自行决定。':'Keep concise preferences and possible follow-ups across conversations on this host. The agent decides when to use the tool.'}>
      <SettingsSwitch title={zh?'记住并参考用户习惯':'Remember and use habits'} checked={memory.habits} onChange={habits=>update({habits})}
        subtitle={zh?'按下方选项提供相关内容或数量提示，Agent 可用 check_habit 补查；关闭后暂停读取与写入。':'Use the recall mode below for relevant excerpts or candidate counts; check_habit can search further. Turning off pauses reads and writes.'}/>
      <SettingsSwitch title={zh?'预测下一步行为':'Predict next actions'} checked={memory.predictions} onChange={predictions=>update({predictions})}
        subtitle={zh?'用后续用户输入复盘预测。已验证的重复需求可归纳为习惯；预测不等于执行授权。':'Review predictions against later user input. Repeated verified needs can become habits; predictions do not authorize actions.'}/>
      <SettingsSelect name="memory-recall-mode" title={zh?'记忆提示方式':'Memory recall mode'} value={memory.recallMode} onChange={value=>update({recallMode:value==='hint'?'hint':'context'})}
        subtitle={zh?'显式检索始终可重复读取；仅自动参考会省略当前上下文里已有的记录。':'Explicit lookup always allows repeat reads. Only automatic references omit records already present in context.'}>
        <option value="context">{zh?'自动提供少量相关内容':'Include a few relevant excerpts'}</option>
        <option value="hint">{zh?'仅提示候选数量，按需读取':'Only hint at candidate counts'}</option>
      </SettingsSelect>
    </SettingsCard>
    <SettingsCard title={zh?'记忆整理':'Memory consolidation'} subtitle={zh?'事件与验证材料达到阈值时统一核验，将重复命中的需求提炼为习惯；习惯达到自己的阈值后再统一去重压缩。旧记录留在历史中，用户固定条目不会被改写。Token 数为本地估算。':'Review accumulated events and evidence at their threshold, promoting repeatedly verified needs to habits. Compact habits separately at their own threshold. Originals stay in history and pinned records remain unchanged. Token counts are local estimates.'}>
      <label className="summary-threshold"><span>{zh?'事件整理阈值（tokens）':'Event consolidation threshold (tokens)'}</span>
        <input aria-label={zh?'事件整理阈值':'Event consolidation threshold'} type="number" min={1000} max={200000} step={1000} value={eventThreshold}
          onChange={event=>setEventThreshold(event.target.value)} onBlur={saveThreshold} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveThreshold();}}}/></label>
      <label className="summary-threshold"><span>{zh?'习惯压缩阈值（tokens）':'Habit compaction threshold (tokens)'}</span>
        <input aria-label={zh?'习惯压缩阈值':'Habit compaction threshold'} type="number" min={1000} max={200000} step={1000} value={habitThreshold}
          onChange={event=>setHabitThreshold(event.target.value)} onBlur={saveThreshold} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveThreshold();}}}/></label>
      <SettingsSelect name="summary-host" title={zh?'记忆所在环境':'Memory host'} value={connection} onChange={setConnection} disabled={busy}
        subtitle={zh?'各环境独立保存，习惯不会自动复制到其他主机。':'Memory stays on its host and is not copied to other hosts.'}>
        <option value="">{zh?'本机':'This device'}</option>{connections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </SettingsSelect>
      <div className="summary-memory-status" aria-live="polite">
        {status?<><strong>{status.estimatedTokens.toLocaleString()} {zh?'tokens 有效记忆':'tokens of active memory'}</strong>
          <span>{zh?'事件与验证材料':'Events and evidence'} · {status.eventTokens.toLocaleString()} / {memory.eventTokenThreshold.toLocaleString()} tokens</span>
          <progress aria-label={zh?'事件整理进度':'Event consolidation progress'} max={memory.eventTokenThreshold} value={Math.min(status.eventTokens,memory.eventTokenThreshold)}/>
          <span>{zh?'习惯':'Habits'} · {status.habitTokens.toLocaleString()} / {memory.habitTokenThreshold.toLocaleString()} tokens</span>
          <progress aria-label={zh?'习惯压缩进度':'Habit compaction progress'} max={memory.habitTokenThreshold} value={Math.min(status.habitTokens,memory.habitTokenThreshold)}/>
          <span>{zh?`${status.habits} 条习惯 · ${status.predictions} 条预测 · ${status.notes} 条待整理笔记`:`${status.habits} habits · ${status.predictions} predictions · ${status.notes} notes`}</span>
          <span>{zh?`累计验证：${status.hits} 次命中 · ${status.misses} 次否定`:`Reviewed: ${status.hits} hits · ${status.misses} rejected`}</span>
          <span>{zh?`${status.inactiveRecords??0} 条失效记录 · ${status.historyChanges??0} 次历史变更`:`${status.inactiveRecords??0} inactive records · ${status.historyChanges??0} history changes`}</span>
          {status.records>status.habits+status.predictions+status.notes&&<small>{zh?`另有 ${status.records-status.habits-status.predictions-status.notes} 条验证材料，计入 Token 总量。`:`Includes ${status.records-status.habits-status.predictions-status.notes} evidence records in the token total.`}</small>}
          {status.lastSummaryAt&&<small>{zh?'最近完成：':'Last completed: '}{new Date(status.lastSummaryAt).toLocaleString(language==='zh'?'zh-CN':'en-US')}</small>}
          {status.lastError&&!status.running&&!busy&&<details className="summary-memory-error"><summary>{summaryFailureLabel(status.lastError,zh)}</summary><small>{zh?'已完成的阶段已保存；其余原记录保留，可手动重试。':'Finished stages were saved; remaining original records were kept. You can retry.'}</small><pre>{status.lastError}</pre></details>}</>:<span>{zh?'读取记忆状态…':'Reading memory status…'}</span>}
      </div>
      <div className="summary-memory-actions"><button className="primary-button" disabled={busy||status?.running||!enabled||!status?.records||!modelId} onClick={()=>void summarize()}>
        {busy||status?.running?zh?'正在总结…':'Summarizing…':zh?'立即总结':'Summarize now'}</button>
        <button className="secondary-button" disabled={busy} onClick={()=>{setRevision(v=>v+1);setRecordsRefresh(v=>v+1);}}>{zh?'刷新':'Refresh'}</button></div>
      <small>{zh?`手动总结使用当前模型${modelId?`：${modelId}`:'，请先配置并选择模型'}。会产生模型用量。`:`Manual summaries use the selected model${modelId?`: ${modelId}`:' (configure one first)'}. Model usage applies.`}</small>
      {error&&<p role="alert">{error}</p>}
    </SettingsCard>
    <MemoryRecordsPanel settings={memory} connection={connection} zh={zh} refresh={recordsRefresh} onChanged={()=>{setRevision(value=>value+1);setRecordsRefresh(value=>value+1);}} api={memoryApi}/>
  </div>;
}

function summaryFailureLabel(error:string,zh:boolean) {
  const code=/memory_summary_([a-z_]+):/.exec(error)?.[1];
  const labels:Record<string,[string,string]>={
    timeout:['本阶段总结超时','The last summary stage timed out'],
    cancelled:['总结被中断','Consolidation was interrupted'],
    output_limit:['模型输出达到上限，未返回完整总结','The model reached its output limit before completing the summary'],
    input_limit:['完整记忆超过模型输入预算，请选择更大上下文的模型','The complete snapshot exceeds the input budget; select a model with a larger context'],
    invalid_json:['模型没有返回完整、有效的 JSON','The model did not return complete, valid JSON'],
    invalid_summary:['模型总结未通过记忆校验','The model summary did not pass memory validation'],
    snapshot_changed:['相关记忆已发生修改，需要重新整理','The source memory changed and needs a fresh summary'],
    provider_failure:['模型请求失败，请检查模型连接','The model request failed; check the connection'],
  };
  return labels[code??'']?.[zh?0:1]??(zh?'上次总结未全部完成，查看原因':'The last consolidation did not fully complete; show details');
}
